// Pre-Race Alerts MVP: Import Runners Edge Function
// Parses CSV and bulk inserts runners for a race

import { getSupabaseAdmin, getUserFromAuth } from "../_shared/supabase-client.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { ImportRunnersRequest, ImportRunnersResponse, Runner } from "../_shared/types.ts";

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // Only accept POST requests
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("Missing authorization header", 401);
    }

    const user = await getUserFromAuth(authHeader);
    if (!user) {
      return errorResponse("Invalid or expired token", 401);
    }

    // Parse request body
    const body: ImportRunnersRequest = await req.json();

    if (!body.race_id || !body.csv_content) {
      return errorResponse("Missing required fields: race_id, csv_content");
    }

    const supabase = getSupabaseAdmin();

    // Verify the user owns this race
    const { data: race, error: raceError } = await supabase
      .from("races")
      .select("id, name, director_id")
      .eq("id", body.race_id)
      .single();

    if (raceError || !race) {
      return errorResponse("Race not found", 404);
    }

    if (race.director_id !== user.id) {
      return errorResponse("Not authorized to import runners for this race", 403);
    }

    // Parse CSV
    const { runners, errors } = parseRunnersCsv(body.csv_content);

    if (runners.length === 0) {
      return errorResponse(`No valid runners found in CSV. Errors: ${errors.join(", ")}`);
    }

    // Prepare runners for insertion
    const runnersToInsert = runners.map((r) => ({
      race_id: body.race_id,
      name: r.name,
      email: r.email || null,
      phone: r.phone || null,
      notification_preferences: {
        sms: !!r.phone,
        email: !!r.email,
      },
    }));

    // Bulk insert runners
    const { data: insertedRunners, error: insertError } = await supabase
      .from("runners")
      .insert(runnersToInsert)
      .select("id");

    if (insertError) {
      console.error("Error inserting runners:", insertError);
      return errorResponse(`Failed to insert runners: ${insertError.message}`, 500);
    }

    const response: ImportRunnersResponse = {
      success: true,
      imported_count: insertedRunners?.length ?? 0,
      skipped_count: errors.length,
      errors: errors.length > 0 ? errors : undefined,
    };

    return jsonResponse(response);
  } catch (error) {
    console.error("Error in import-runners:", error);
    return errorResponse(
      error instanceof Error ? error.message : "Internal server error",
      500
    );
  }
});

// CSV parsing types
interface ParsedRunner {
  name: string;
  email: string | null;
  phone: string | null;
}

interface ParseResult {
  runners: ParsedRunner[];
  errors: string[];
}

// Parse CSV content into runner records
function parseRunnersCsv(csvContent: string): ParseResult {
  const runners: ParsedRunner[] = [];
  const errors: string[] = [];

  // Split into lines and filter empty lines
  const lines = csvContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    errors.push("CSV is empty");
    return { runners, errors };
  }

  // Parse header row
  const headerLine = lines[0].toLowerCase();
  const headers = parseCsvLine(headerLine);

  const nameIndex = findColumnIndex(headers, ["name", "full name", "runner name", "participant"]);
  const emailIndex = findColumnIndex(headers, ["email", "e-mail", "email address"]);
  const phoneIndex = findColumnIndex(headers, ["phone", "phone number", "mobile", "cell", "telephone"]);

  if (nameIndex === -1) {
    errors.push("CSV must have a 'name' column");
    return { runners, errors };
  }

  if (emailIndex === -1 && phoneIndex === -1) {
    errors.push("CSV must have either 'email' or 'phone' column");
    return { runners, errors };
  }

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const values = parseCsvLine(line);

    const name = values[nameIndex]?.trim();
    const email = emailIndex !== -1 ? values[emailIndex]?.trim() : null;
    const phone = phoneIndex !== -1 ? values[phoneIndex]?.trim() : null;

    // Validate runner
    if (!name) {
      errors.push(`Row ${i + 1}: Missing name`);
      continue;
    }

    if (!email && !phone) {
      errors.push(`Row ${i + 1}: Runner "${name}" has no email or phone`);
      continue;
    }

    // Basic email validation
    if (email && !isValidEmail(email)) {
      errors.push(`Row ${i + 1}: Invalid email for "${name}": ${email}`);
      continue;
    }

    runners.push({
      name,
      email: email || null,
      phone: phone || null,
    });
  }

  return { runners, errors };
}

// Parse a single CSV line, handling quoted values
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

// Find column index by trying multiple possible header names
function findColumnIndex(headers: string[], possibleNames: string[]): number {
  for (const name of possibleNames) {
    const index = headers.indexOf(name);
    if (index !== -1) {
      return index;
    }
  }
  return -1;
}

// Basic email validation
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

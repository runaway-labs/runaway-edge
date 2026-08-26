// Race Classification: deterministic classification of race directory entries
// Distinguishes races from non-race events and extracts standardized race lengths

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";

const BATCH_SIZE = 15;
const MAX_BATCHES = 5;

interface RaceLength {
  distance: number;
  unit: "mi" | "km";
  label: string;
}

interface ClassificationResult {
  source_race_id: string;
  event_type: "race" | "event";
  race_lengths: RaceLength[];
}

interface DirectoryRow {
  id: string;
  source_race_id: string;
  name: string;
  description: string | null;
  events: { event_id: number; name: string; distance: string; distance_units: string; start_time: string }[];
}

function classifyBatch(entries: DirectoryRow[]): ClassificationResult[] {
  return entries.map((entry) => {
    const race_lengths: RaceLength[] = [];
    const seen = new Set<string>();
    for (const event of entry.events ?? []) {
      const distance = Number.parseFloat(String(event.distance));
      const rawUnit = String(event.distance_units ?? "").toLowerCase();
      const unit: "mi" | "km" = rawUnit.startsWith("k") ? "km" : "mi";
      if (!Number.isFinite(distance) || distance <= 0) continue;
      const key = distance + ":" + unit;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = unit === "km" ? distance + "K" : distance === 13.1 ? "Half Marathon" : distance === 26.2 ? "Marathon" : distance + " Mile";
      race_lengths.push({ distance, unit, label });
    }
    const excluded = /expo|packet pickup|volunteer|festival|training program|gala/i.test(entry.name);
    return { source_race_id: entry.source_race_id, event_type: race_lengths.length > 0 && !excluded ? "race" : "event", race_lengths };
  });
}

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("Missing authorization header", 401);
    }

    let mode = "unclassified";
    try {
      const body = await req.json();
      if (body.mode === "all") {
        mode = "all";
      }
    } catch {
      // Default to unclassified mode
    }

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    let totalProcessed = 0;
    let totalClassified = 0;
    let totalErrors = 0;
    const errors: string[] = [];

    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      // Fetch next batch of unclassified rows
      let query = supabase
        .from("race_directory")
        .select("id, source_race_id, name, description, events")
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(BATCH_SIZE);

      if (mode === "unclassified") {
        query = query.is("classified_at", null);
      }

      if (mode === "all") {
        query = query.range(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE - 1);
      }

      const { data: rows, error: fetchError } = await query;

      if (fetchError) {
        errors.push(`Fetch error (batch ${batch}): ${fetchError.message}`);
        break;
      }

      if (!rows || rows.length === 0) {
        break; // No more rows to process
      }

      totalProcessed += rows.length;

      // Classify from structured event data
      let results: ClassificationResult[];
      try {
        results = classifyBatch(rows as DirectoryRow[]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Classification error (batch ${batch}): ${msg}`);
        console.error(`Classification error (batch ${batch}):`, err);
        continue;
      }

      // Build a lookup map from source_race_id to classification result
      const resultMap = new Map<string, ClassificationResult>();
      for (const result of results) {
        resultMap.set(result.source_race_id, result);
      }

      // Update each row individually to handle partial failures
      for (const row of rows) {
        const classification = resultMap.get(row.source_race_id);
        if (!classification) {
          errors.push(`No classification result for source_race_id ${row.source_race_id}`);
          totalErrors++;
          continue;
        }

        const { error: updateError } = await supabase
          .from("race_directory")
          .update({
            event_type: classification.event_type,
            race_lengths: classification.race_lengths,
            classified_at: now,
          })
          .eq("id", row.id);

        if (updateError) {
          errors.push(`Update error for ${row.source_race_id}: ${updateError.message}`);
          totalErrors++;
        } else {
          totalClassified++;
        }
      }

      // If we got fewer rows than the batch size in unclassified mode, we're done
      if (mode === "unclassified" && rows.length < BATCH_SIZE) {
        break;
      }
    }

    const response = {
      success: errors.length === 0,
      mode,
      total_processed: totalProcessed,
      total_classified: totalClassified,
      total_errors: totalErrors,
      errors,
    };

    console.log("Classification complete:", JSON.stringify(response));
    return jsonResponse(response);
  } catch (error) {
    console.error("Error in classify-races:", error);
    return errorResponse(
      error instanceof Error ? error.message : "Internal server error",
      500
    );
  }
});

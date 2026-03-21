// Race Classification: AI-powered classification of race directory entries
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

const SYSTEM_PROMPT = `You are a race classification engine. You receive batches of event entries from a race directory and must classify each one.

For each entry, determine:
1. **event_type**: "race" if this is an actual running/endurance race (5K, 10K, half marathon, marathon, ultra, trail run, etc.), or "event" if it is NOT a race (e.g., expo, volunteer signup, fun walk, festival, training program, virtual challenge with no specific race, packet pickup, fundraiser gala).
2. **race_lengths**: An array of standardized race distances. Empty array for non-races.

For race_lengths, use these standard labels when applicable:
- "1 Mile" (distance: 1, unit: "mi")
- "5K" (distance: 5, unit: "km")
- "10K" (distance: 10, unit: "km")
- "15K" (distance: 15, unit: "km")
- "Half Marathon" (distance: 13.1, unit: "mi")
- "Marathon" (distance: 26.2, unit: "mi")
- "50K" (distance: 50, unit: "km")
- "50 Mile" (distance: 50, unit: "mi")
- "100K" (distance: 100, unit: "km")
- "100 Mile" (distance: 100, unit: "mi")

For non-standard distances, create a descriptive label (e.g., "8K", "30K", "200 Mile Relay").

Use the entry name, description, and events array to make your determination. Most entries with distance-based events are races. Entries that are purely social, organizational, or non-competitive are events.

Respond with ONLY a JSON array. No markdown fencing, no explanation. Each element must have: source_race_id (string), event_type ("race" or "event"), race_lengths (array of {distance, unit, label}).`;

async function classifyBatch(entries: DirectoryRow[]): Promise<ClassificationResult[]> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY environment variable");
  }

  const batchInput = entries.map((e) => ({
    source_race_id: e.source_race_id,
    name: e.name,
    description: e.description ? e.description.slice(0, 200) : null,
    events: e.events.map((ev) => ({
      name: ev.name,
      distance: ev.distance,
      distance_units: ev.distance_units,
    })),
  }));

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Classify these ${entries.length} entries:\n\n${JSON.stringify(batchInput)}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const textContent = data.content
    .filter((block: { type: string }) => block.type === "text")
    .map((block: { text: string }) => block.text)
    .join("\n");

  if (!textContent) {
    throw new Error("Anthropic API returned empty content");
  }

  let parsed: ClassificationResult[]
  try {
    parsed = JSON.parse(textContent) as ClassificationResult[]
  } catch {
    throw new Error('Failed to parse AI classification response')
  }
  return parsed;
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

      // Classify via Anthropic API
      let results: ClassificationResult[];
      try {
        results = await classifyBatch(rows as DirectoryRow[]);
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

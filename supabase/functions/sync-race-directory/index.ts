// Race Directory Sync: Fetches race data from RunSignUp API
// Runs nightly via cron, authenticated with API key + secret

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { corsHeaders, handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import type {
  RunSignUpRace,
  RunSignUpApiResponse,
  RaceDirectoryEvent,
  SyncRaceDirectoryResponse,
} from "../_shared/types.ts";
import { createSyncRaceDirectoryHandler } from "./handler.ts";

const RUNSIGNUP_BASE_URL = "https://runsignup.com/rest/races";
const RESULTS_PER_PAGE = 100;
const MAX_PAGES = 25;
const BATCH_SIZE = 50;
const PAGE_DELAY_MS = 500;

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transformRace(race: RunSignUpRace) {
  const events: RaceDirectoryEvent[] = (race.events || []).map((e) => ({
    event_id: e.event_id,
    name: e.name,
    distance: e.distance,
    distance_units: e.distance_units,
    start_time: e.start_time,
  }));

  return {
    source: "runsignup" as const,
    source_race_id: String(race.race_id),
    name: race.name,
    description: race.description || null,
    next_date: race.next_date || null,
    city: race.address?.city || null,
    state: race.address?.state || null,
    zipcode: race.address?.zipcode || null,
    country_code: race.address?.country_code || "US",
    latitude: race.latitude || null,
    longitude: race.longitude || null,
    logo_url: race.logo_url || null,
    external_url: race.url || null,
    events: events,
    raw_data: race as unknown as Record<string, unknown>,
    last_synced_at: new Date().toISOString(),
    is_active: true,
  };
}

async function fetchPage(
  startDate: string,
  endDate: string,
  page: number
): Promise<RunSignUpRace[]> {
  const apiKey = Deno.env.get("RUNSIGNUP_API_KEY");
  const apiSecret = Deno.env.get("RUNSIGNUP_API_SECRET");

  if (!apiKey || !apiSecret) {
    throw new Error("Missing RUNSIGNUP_API_KEY or RUNSIGNUP_API_SECRET environment variables");
  }

  const params = new URLSearchParams({
    client_id: apiKey,
    client_secret: apiSecret,
    format: "json",
    events: "T",
    start_date: startDate,
    end_date: endDate,
    results_per_page: String(RESULTS_PER_PAGE),
    page: String(page),
    sort: "date asc",
  });

  const url = `${RUNSIGNUP_BASE_URL}?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`RunSignUp API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  // RunSignUp returns HTTP 200 with error body on auth failure
  if (data.error) {
    throw new Error(`RunSignUp API error: ${data.error.error_msg || JSON.stringify(data.error)}`);
  }

  const typedData = data as RunSignUpApiResponse;

  if (!typedData.races || !Array.isArray(typedData.races)) {
    return [];
  }

  return typedData.races.map((r) => r.race);
}

async function upsertBatch(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  rows: ReturnType<typeof transformRace>[]
): Promise<number> {
  const { data, error } = await supabase
    .from("race_directory")
    .upsert(rows, { onConflict: "source,source_race_id" })
    .select("id");

  if (error) {
    throw new Error(`Upsert error: ${error.message}`);
  }

  return data?.length || 0;
}

export const handler = createSyncRaceDirectoryHandler(async (_req: Request) => {
  try {
    const supabase = getSupabaseAdmin();

    const today = new Date();
    const sixMonthsOut = new Date(today);
    sixMonthsOut.setMonth(sixMonthsOut.getMonth() + 6);

    const startDate = formatDate(today);
    const endDate = formatDate(sixMonthsOut);

    let totalFetched = 0;
    let totalUpserted = 0;
    let pagesProcessed = 0;
    const errors: string[] = [];
    const seenSourceIds: Set<string> = new Set();

    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        const races = await fetchPage(startDate, endDate, page);

        if (races.length === 0) {
          break; // No more results
        }

        totalFetched += races.length;
        pagesProcessed++;

        const rows = races.map(transformRace);

        // Track seen source IDs for stale detection
        for (const row of rows) {
          seenSourceIds.add(row.source_race_id);
        }

        // Batch upsert
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          try {
            const upserted = await upsertBatch(supabase, batch);
            totalUpserted += upserted;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Batch upsert error (page ${page}): ${msg}`);
            console.error(`Batch upsert error:`, err);
          }
        }

        // If fewer results than page size, we've reached the end
        if (races.length < RESULTS_PER_PAGE) {
          break;
        }

        // Rate limiting courtesy delay
        await sleep(PAGE_DELAY_MS);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Page ${page} fetch error: ${msg}`);
        console.error(`Page ${page} error:`, err);

        // Continue to next page on fetch errors
        if (page < MAX_PAGES) {
          await sleep(PAGE_DELAY_MS);
          continue;
        }
        break;
      }
    }

    // Deactivate stale past races not seen in this sync
    if (seenSourceIds.size > 0) {
      try {
        const { error: deactivateError } = await supabase
          .from("race_directory")
          .update({ is_active: false })
          .eq("source", "runsignup")
          .lt("next_date", startDate)
          .eq("is_active", true);

        if (deactivateError) {
          errors.push(`Deactivate stale races error: ${deactivateError.message}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Deactivate stale races error: ${msg}`);
      }
    }

    // Fire-and-forget: trigger AI classification for newly synced rows
    let classifyTriggered = false;
    try {
      const classifyUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/classify-races`;
      const classifyResponse = await fetch(classifyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ mode: "unclassified" }),
      });
      classifyTriggered = classifyResponse.ok;
      if (!classifyResponse.ok) {
        const body = await classifyResponse.text();
        errors.push(`Classification trigger failed (${classifyResponse.status}): ${body}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Classification trigger error: ${msg}`);
      console.error("Classification trigger error:", err);
    }

    const response: SyncRaceDirectoryResponse = {
      success: errors.length === 0,
      races_fetched: totalFetched,
      races_upserted: totalUpserted,
      pages_processed: pagesProcessed,
      classify_triggered: classifyTriggered,
      errors,
    };

    console.log("Sync complete:", JSON.stringify(response));
    return jsonResponse(response);
  } catch (error) {
    console.error("Error in sync-race-directory:", error);
    return errorResponse(
      error instanceof Error ? error.message : "Internal server error",
      500
    );
  }
}, { headers: corsHeaders });

if (import.meta.main) {
  Deno.serve(handler);
}

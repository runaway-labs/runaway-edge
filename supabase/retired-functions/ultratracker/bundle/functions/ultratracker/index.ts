// Ultratracker: Discover and import UltraSignup races into race_directory
// Deno port of https://github.com/a12k/ultratracker

import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.48/deno-dom-wasm.ts";

// ── Types ────────────────────────────────────────────────────────────

interface ListingEvent {
  EventId: number;
  EventName: string;
  City: string;
  State: string;
  Latitude: string;
  Longitude: string;
  EventDate: string;
  EventDateEnd: string | null;
  Distances: string;
  DistanceCategories: string;
  EventWebsite: string | null;
  BannerId: string | null;
  Cancelled: boolean;
  Postponed: boolean;
  VirtualEvent: boolean;
  EventImages: Array<{ ImageId: string; ImageLabel: string | null }>;
}

interface ScrapedRace {
  uid: string;
  race_title: string;
  spots: string;
  registration_status: string;
  location: string;
  event_date: string;
}

// ── US region grid for discovery ─────────────────────────────────────
// 25 points across the continental US to ensure full coverage with
// 500-mile radius queries (the API caps at 100 results per query).

const US_GRID: Array<{ lat: number; lng: number }> = [
  { lat: 47.6, lng: -122.3 }, // Seattle
  { lat: 45.5, lng: -122.7 }, // Portland
  { lat: 37.8, lng: -122.4 }, // San Francisco
  { lat: 34.1, lng: -118.2 }, // Los Angeles
  { lat: 33.4, lng: -112.0 }, // Phoenix
  { lat: 39.7, lng: -105.0 }, // Denver
  { lat: 40.8, lng: -111.9 }, // Salt Lake City
  { lat: 46.9, lng: -110.4 }, // Montana
  { lat: 44.0, lng: -103.0 }, // South Dakota
  { lat: 41.3, lng: -96.0 },  // Omaha
  { lat: 38.6, lng: -90.2 },  // St. Louis
  { lat: 44.9, lng: -93.3 },  // Minneapolis
  { lat: 41.9, lng: -87.6 },  // Chicago
  { lat: 42.3, lng: -83.0 },  // Detroit
  { lat: 39.1, lng: -84.5 },  // Cincinnati
  { lat: 36.2, lng: -86.8 },  // Nashville
  { lat: 33.7, lng: -84.4 },  // Atlanta
  { lat: 30.3, lng: -81.7 },  // Jacksonville
  { lat: 25.8, lng: -80.2 },  // Miami
  { lat: 29.8, lng: -95.4 },  // Houston
  { lat: 32.8, lng: -96.8 },  // Dallas
  { lat: 35.2, lng: -80.8 },  // Charlotte
  { lat: 38.9, lng: -77.0 },  // DC
  { lat: 40.7, lng: -74.0 },  // NYC
  { lat: 42.4, lng: -71.1 },  // Boston
];

// ── Discovery via listing API ────────────────────────────────────────

async function discoverEvents(): Promise<Map<number, ListingEvent>> {
  const allEvents = new Map<number, ListingEvent>();

  for (const point of US_GRID) {
    try {
      const url =
        `https://ultrasignup.com/service/events.svc/closestevents` +
        `?virtual=0&open=0&past=0&lat=${point.lat}&lng=${point.lng}&mi=500&mo=12`;

      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        console.error(`Discovery query failed for (${point.lat},${point.lng}): ${res.status}`);
        continue;
      }

      const events: ListingEvent[] = await res.json();
      for (const e of events) {
        if (!allEvents.has(e.EventId)) {
          allEvents.set(e.EventId, e);
        }
      }
    } catch (err) {
      console.error(`Discovery error at (${point.lat},${point.lng}):`, err);
    }
  }

  return allEvents;
}

// ── Transform listing event directly (no per-page scrape needed) ────

function parseListingDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return null;
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, "0");
  const d = String(parsed.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Known distance aliases → { distance, unit, label }
const KNOWN_DISTANCES: Record<string, { distance: number; unit: "mi" | "km"; label: string }> = {
  "1 mile": { distance: 1, unit: "mi", label: "1 Mile" },
  "1 mi": { distance: 1, unit: "mi", label: "1 Mile" },
  "5k": { distance: 5, unit: "km", label: "5K" },
  "10k": { distance: 10, unit: "km", label: "10K" },
  "15k": { distance: 15, unit: "km", label: "15K" },
  "18k": { distance: 18, unit: "km", label: "18K" },
  "20k": { distance: 20, unit: "km", label: "20K" },
  "25k": { distance: 25, unit: "km", label: "25K" },
  "30k": { distance: 30, unit: "km", label: "30K" },
  "50k": { distance: 50, unit: "km", label: "50K" },
  "100k": { distance: 100, unit: "km", label: "100K" },
  "200k": { distance: 200, unit: "km", label: "200K" },
  "half marathon": { distance: 13.1, unit: "mi", label: "Half Marathon" },
  "marathon": { distance: 26.2, unit: "mi", label: "Marathon" },
  "50 mile": { distance: 50, unit: "mi", label: "50 Mile" },
  "50 mi": { distance: 50, unit: "mi", label: "50 Mile" },
  "100 mile": { distance: 100, unit: "mi", label: "100 Mile" },
  "100 mi": { distance: 100, unit: "mi", label: "100 Mile" },
  "200 mile": { distance: 200, unit: "mi", label: "200 Mile" },
  "200 mi": { distance: 200, unit: "mi", label: "200 Mile" },
};

function parseSingleDistance(raw: string): { distance: number; unit: "mi" | "km"; label: string } | null {
  const normalized = raw.toLowerCase().trim();

  // Exact match
  if (KNOWN_DISTANCES[normalized]) return KNOWN_DISTANCES[normalized];

  // Pattern: "<number>K" (e.g. "8K", "40K")
  const kmMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*k$/);
  if (kmMatch) {
    const d = parseFloat(kmMatch[1]);
    return { distance: d, unit: "km", label: `${kmMatch[1]}K` };
  }

  // Pattern: "<number> Mile(s)" or "<number> Mi"
  const miMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*(?:mile|miles|mi)$/);
  if (miMatch) {
    const d = parseFloat(miMatch[1]);
    return { distance: d, unit: "mi", label: `${miMatch[1]} Mile` };
  }

  // Pattern: just a number with "M" (ambiguous but UltraSignup usually means miles)
  const mMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*m$/);
  if (mMatch) {
    const d = parseFloat(mMatch[1]);
    return { distance: d, unit: "mi", label: `${mMatch[1]} Mile` };
  }

  // Pattern: "<number> Miler" (e.g. "50 Miler", "4 Miler")
  const milerMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*miler$/);
  if (milerMatch) {
    const d = parseFloat(milerMatch[1]);
    return { distance: d, unit: "mi", label: `${milerMatch[1]} Mile` };
  }

  // Pattern: "<number> Miles" (e.g. "50 Miles")
  const milesMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*miles$/);
  if (milesMatch) {
    const d = parseFloat(milesMatch[1]);
    return { distance: d, unit: "mi", label: `${milesMatch[1]} Mile` };
  }

  // Pattern: timed events — "<number> Hour/Hr/Hrs" or "<number>HR"
  const timedMatch = normalized.match(/^(\d+)\s*(?:hour|hours|hr|hrs)$/);
  if (timedMatch) {
    const hours = parseInt(timedMatch[1]);
    return { distance: 0, unit: "mi", label: `${hours} Hour` };
  }

  // Backyard ultra / Last Person Standing
  if (normalized.includes("backyard") || normalized.includes("last person standing")) {
    return { distance: 0, unit: "mi", label: "Backyard Ultra" };
  }

  // Pattern: "1/2 Marathon" or "Half-Marathon"
  if (normalized === "1/2 marathon" || normalized === "half-marathon") {
    return { distance: 13.1, unit: "mi", label: "Half Marathon" };
  }

  return null;
}

function parseDistances(
  distances: string
): { parsed: Array<{ distance: number; unit: "mi" | "km"; label: string }>; hasUnparsed: boolean } {
  if (!distances) return { parsed: [], hasUnparsed: false };
  const segments = distances.split(",").map((s) => s.trim()).filter(Boolean);
  const parsed: Array<{ distance: number; unit: "mi" | "km"; label: string }> = [];
  let hasUnparsed = false;

  for (const seg of segments) {
    const result = parseSingleDistance(seg);
    if (result) {
      parsed.push(result);
    } else {
      // Keep the raw label but flag for classification
      parsed.push({ distance: 0, unit: "mi", label: seg });
      hasUnparsed = true;
    }
  }

  return { parsed, hasUnparsed };
}

function listingToDirectoryRow(event: ListingEvent) {
  const nextDate = parseListingDate(event.EventDate);
  const lat = parseFloat(event.Latitude);
  const lng = parseFloat(event.Longitude);
  const logoUrl = event.BannerId
    ? `https://s3.amazonaws.com/img.ultrasignup.com/event/banner/${event.BannerId}.jpg`
    : null;

  const { parsed: raceLengths, hasUnparsed } = parseDistances(event.Distances);
  // If all distances parsed cleanly, mark as classified. Otherwise leave for classify-races.
  const classifiedAt = hasUnparsed ? null : new Date().toISOString();

  return {
    source: "ultrasignup",
    source_race_id: String(event.EventId),
    name: event.EventName,
    description: [
      event.Distances ? `Distances: ${event.Distances}` : null,
      event.DistanceCategories?.trim() ? `Categories: ${event.DistanceCategories.trim()}` : null,
    ].filter(Boolean).join(". ") || null,
    next_date: nextDate,
    city: event.City || null,
    state: event.State || null,
    zipcode: null,
    country_code: "US",
    latitude: isNaN(lat) ? null : lat,
    longitude: isNaN(lng) ? null : lng,
    logo_url: logoUrl,
    external_url: event.EventWebsite || `https://ultrasignup.com/register.aspx?did=${event.EventId}`,
    events: [],
    event_type: "race",
    race_lengths: raceLengths,
    classified_at: classifiedAt,
    raw_data: {
      event_id: event.EventId,
      distances_raw: event.Distances,
      distances_parsed: parseDistances(event.Distances),
      distance_categories: event.DistanceCategories,
      event_website: event.EventWebsite,
      banner_id: event.BannerId,
      ultrasignup_url: `https://ultrasignup.com/register.aspx?did=${event.EventId}`,
      cancelled: event.Cancelled,
      postponed: event.Postponed,
      virtual: event.VirtualEvent,
      event_date_end: event.EventDateEnd,
    },
    last_synced_at: new Date().toISOString(),
    is_active: !event.Cancelled,
  };
}

// ── Per-page scrape (for single UID lookups) ────────────────────────

function textBySelector(
  doc: ReturnType<DOMParser["parseFromString"]>,
  selector: string
): string {
  return doc?.querySelector(selector)?.textContent?.trim() ?? "";
}

async function scrapeRace(uid: string): Promise<ScrapedRace> {
  const url = `https://ultrasignup.com/register.aspx?did=${encodeURIComponent(uid)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Ultratracker/1.0)",
    },
  });

  if (!res.ok) {
    throw new Error(`UltraSignup returned ${res.status} for uid ${uid}`);
  }

  const html = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  if (!doc) {
    throw new Error(`Failed to parse HTML for uid ${uid}`);
  }

  return {
    uid,
    race_title: textBySelector(doc, ".event-title"),
    spots: textBySelector(doc, ".spots-remaining"),
    registration_status: textBySelector(
      doc,
      "#ContentPlaceHolder1_EventInfo1_lblRegistrationStatus"
    ),
    location: textBySelector(doc, ".subtitle"),
    event_date: textBySelector(doc, ".event-date"),
  };
}

function parseLocation(location: string): {
  city: string | null;
  state: string | null;
  distanceInfo: string | null;
} {
  if (!location) return { city: null, state: null, distanceInfo: null };
  const [geo, distanceInfo] = location.split("•").map((s) => s.trim());
  const parts = geo?.split(",").map((s) => s.trim()) ?? [];
  return {
    city: parts[0] || null,
    state: parts[1] || null,
    distanceInfo: distanceInfo || null,
  };
}

function parseEventDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const withoutTime = dateStr.split("@")[0].trim();
  const withoutDay = withoutTime.replace(/^\w+,\s*/, "");
  const parsed = new Date(withoutDay);
  if (isNaN(parsed.getTime())) return null;
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, "0");
  const d = String(parsed.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function scrapeToDirectoryRow(scraped: ScrapedRace) {
  const { city, state, distanceInfo } = parseLocation(scraped.location);
  const nextDate = parseEventDate(scraped.event_date);

  return {
    source: "ultrasignup",
    source_race_id: scraped.uid,
    name: scraped.race_title || `UltraSignup Race ${scraped.uid}`,
    description: null,
    next_date: nextDate,
    city,
    state,
    zipcode: null,
    country_code: "US",
    latitude: null,
    longitude: null,
    logo_url: null,
    external_url: `https://ultrasignup.com/register.aspx?did=${scraped.uid}`,
    events: [],
    event_type: "race",
    race_lengths: [],
    classified_at: null,
    raw_data: {
      uid: scraped.uid,
      spots: scraped.spots,
      registration_status: scraped.registration_status,
      location_raw: scraped.location,
      event_date_raw: scraped.event_date,
    },
    last_synced_at: new Date().toISOString(),
    is_active: true,
  };
}

// ── Database upsert ──────────────────────────────────────────────────

async function upsertRows(rows: Record<string, unknown>[]): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey =
    Deno.env.get("SUPABASE_SECRET_KEY") ??
    "";

  // PostgREST supports batch inserts — send all rows in one request
  const res = await fetch(
    `${supabaseUrl}/rest/v1/race_directory?on_conflict=source,source_race_id`,
    {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upsert failed (${res.status}): ${body}`);
  }
}

// ── HTTP handler ─────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode");

    // ── Discover mode: pull all races from UltraSignup ──
    if (mode === "discover") {
      console.log("Starting UltraSignup discovery across US grid...");
      const events = await discoverEvents();
      console.log(`Discovered ${events.size} unique events`);

      if (events.size === 0) {
        return jsonResponse({ success: true, discovered: 0, upserted: 0 });
      }

      const rows = Array.from(events.values()).map(listingToDirectoryRow);

      // Batch upsert in chunks of 100
      let upserted = 0;
      const chunkSize = 100;
      const errors: string[] = [];

      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        try {
          await upsertRows(chunk);
          upserted += chunk.length;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Chunk ${i}-${i + chunk.length}: ${msg}`);
        }
      }

      // Trigger classify-races to process newly upserted rows
      let classified = null;
      try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
        const serviceKey =
          Deno.env.get("SUPABASE_SECRET_KEY") ??
          "";
        const classifyRes = await fetch(
          `${supabaseUrl}/functions/v1/classify-races`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${serviceKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ mode: "unclassified" }),
          }
        );
        if (classifyRes.ok) {
          classified = await classifyRes.json();
        } else {
          console.error(`classify-races returned ${classifyRes.status}`);
        }
      } catch (err) {
        console.error("Failed to trigger classify-races:", err);
      }

      return jsonResponse({
        success: errors.length === 0,
        discovered: events.size,
        upserted,
        classified,
        errors: errors.length > 0 ? errors : undefined,
      });
    }

    // ── Single/batch UID mode (original behavior) ──
    let uids: string[] = [];

    if (req.method === "GET") {
      const uid = url.searchParams.get("uid");
      if (uid) uids = uid.split(",").map((u) => u.trim());
    } else if (req.method === "POST") {
      const body = await req.json();
      if (body.uid) {
        uids = Array.isArray(body.uid) ? body.uid : [body.uid];
      } else if (body.uids) {
        uids = body.uids;
      }
    } else {
      return errorResponse("Method not allowed", 405);
    }

    if (uids.length === 0) {
      return errorResponse(
        "Missing required parameter. Use ?mode=discover to pull all races, or ?uid=<id> for specific races."
      );
    }

    const results: Array<{
      uid: string;
      name: string;
      status: "upserted" | "error";
      error?: string;
    }> = [];

    for (const uid of uids) {
      try {
        const scraped = await scrapeRace(uid);

        if (!scraped.race_title) {
          results.push({
            uid,
            name: "",
            status: "error",
            error:
              "Could not find race data — invalid uid or page structure changed",
          });
          continue;
        }

        const row = scrapeToDirectoryRow(scraped);
        await upsertRows([row]);

        results.push({ uid, name: scraped.race_title, status: "upserted" });
      } catch (err) {
        results.push({
          uid,
          name: "",
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const upserted = results.filter((r) => r.status === "upserted").length;
    const errored = results.filter((r) => r.status === "error").length;

    return jsonResponse({
      success: errored === 0,
      total: uids.length,
      upserted,
      errored,
      results,
    });
  } catch (error) {
    console.error("Error in ultratracker:", error);
    return errorResponse(
      error instanceof Error ? error.message : "Internal server error",
      500
    );
  }
});

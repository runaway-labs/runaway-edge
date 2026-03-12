// get-race-course: Fetches GPX course data for a race and caches it in race_courses.
//
// Strategy (waterfall — stops at first hit):
//   1. Check race_courses table for cached data
//   2. Call RunSignUp /race/{race_id} for gpx_file_url / course_map_url
//   3. Fetch race website HTML + ask Claude to find the GPX download URL
//   4. Parse GPX → encoded polyline + elevation data + tactical insights
//   5. Store in race_courses and return

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { corsHeaders } from "../_shared/cors.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const RUNSIGNUP_API_KEY = Deno.env.get("RUNSIGNUP_API_KEY");
const RUNSIGNUP_API_SECRET = Deno.env.get("RUNSIGNUP_API_SECRET");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

// Encode a sequence of lat/lng pairs as a Google-format encoded polyline.
function encodePolyline(coords: { lat: number; lng: number }[]): string {
  let prevLat = 0;
  let prevLng = 0;
  let result = "";

  function encodeValue(value: number): string {
    let v = Math.round(value * 1e5);
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (v >= 0x20) {
      s += String.fromCharCode(((v & 0x1f) | 0x20) + 63);
      v >>= 5;
    }
    s += String.fromCharCode(v + 63);
    return s;
  }

  for (const c of coords) {
    result += encodeValue(c.lat - prevLat);
    result += encodeValue(c.lng - prevLng);
    prevLat = c.lat;
    prevLng = c.lng;
  }
  return result;
}

// Parse a GPX XML string into coordinate + elevation arrays.
function parseGpx(xml: string): { coords: { lat: number; lng: number }[]; elevations: number[] } {
  const coords: { lat: number; lng: number }[] = [];
  const elevations: number[] = [];

  // Match <trkpt lat="..." lon="..."> ... <ele>...</ele> ... </trkpt>
  const trkptRe = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  const eleRe = /<ele>([^<]+)<\/ele>/;

  let m: RegExpExecArray | null;
  while ((m = trkptRe.exec(xml)) !== null) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (isNaN(lat) || isNaN(lng)) continue;
    coords.push({ lat, lng });

    const eleMatch = eleRe.exec(m[3]);
    elevations.push(eleMatch ? parseFloat(eleMatch[1]) : 0);
  }

  return { coords, elevations };
}

// Build elevation_data array (distance_mi, elevation_m, grade) sampled every ~0.25 mi.
function buildElevationData(
  coords: { lat: number; lng: number }[],
  elevations: number[],
): { distance: number; elevation: number; grade: number }[] {
  if (coords.length < 2) return [];

  const R = 6371000; // earth radius in metres
  function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);
    const c =
      sinLat * sinLat +
      Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * sinLng * sinLng;
    return 2 * R * Math.asin(Math.sqrt(c));
  }

  const SAMPLE_EVERY_M = 400; // ~0.25 mi
  const result: { distance: number; elevation: number; grade: number }[] = [];
  let totalM = 0;
  let lastSampleM = 0;

  result.push({ distance: 0, elevation: elevations[0], grade: 0 });

  for (let i = 1; i < coords.length; i++) {
    const seg = haversine(coords[i - 1], coords[i]);
    totalM += seg;

    if (totalM - lastSampleM >= SAMPLE_EVERY_M) {
      const grade =
        seg > 0 ? ((elevations[i] - elevations[i - 1]) / seg) * 100 : 0;
      result.push({
        distance: Math.round((totalM / 1609.34) * 100) / 100, // miles
        elevation: Math.round(elevations[i] * 10) / 10, // metres
        grade: Math.round(grade * 10) / 10,
      });
      lastSampleM = totalM;
    }
  }

  return result;
}

// Ask Claude to derive tactical crux points from elevation data.
async function deriveTacticalInsights(
  raceName: string,
  elevationData: { distance: number; elevation: number; grade: number }[],
): Promise<{ mile: number; description: string }[]> {
  if (!ANTHROPIC_API_KEY) return [];

  const prompt = `You are an elite running coach analyzing a race course. Here is the elevation profile for "${raceName}" sampled every quarter mile.

Data (distance_miles, elevation_meters, grade_%):
${elevationData.map((p) => `${p.distance}mi: ${p.elevation}m, grade ${p.grade}%`).join("\n")}

Identify 3-5 tactical crux points — the segments that will most likely determine race outcome. For each, specify the mile marker and a 1-2 sentence tactical recommendation. Return ONLY a JSON array like:
[{"mile": 6.2, "description": "The steepest sustained climb begins here. Shorten stride, maintain effort not pace — runners who blow up here never recover."}]`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) return [];
  const data = await res.json();
  const text = data.content?.[0]?.text ?? "";

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {
    // ignore parse failures
  }
  return [];
}

// Ask Claude to find the GPX download URL buried in a race website's HTML.
async function findGpxInHtml(html: string, raceName: string): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;

  // Trim to 30k chars to stay within context limits
  const truncated = html.length > 30000 ? html.slice(0, 30000) + "..." : html;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: `This is HTML from the official ${raceName} website. Find the URL of any GPX route file or downloadable course map. Return ONLY the URL string, nothing else. If none exists, return the word null.\n\n${truncated}`,
        },
      ],
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  const text = (data.content?.[0]?.text ?? "").trim();
  if (text === "null" || !text.startsWith("http")) return null;
  return text;
}

// Ask Claude to guess the official race website URL, then scrape it.
async function findGpxViaClaudeSearch(raceName: string): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;

  // Step 1: Ask Claude for the likely official website URL
  const siteRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: `What is the official website URL for the "${raceName}" running race? Return ONLY the URL, nothing else. If unknown, return null.`,
        },
      ],
    }),
  });

  if (!siteRes.ok) return null;
  const siteData = await siteRes.json();
  const siteUrl = (siteData.content?.[0]?.text ?? "").trim();
  console.log("Claude guessed official website:", siteUrl);

  if (siteUrl === "null" || !siteUrl.startsWith("http")) return null;

  // Step 2: Fetch and scrape that website
  try {
    const webRes = await fetch(siteUrl, {
      headers: { "User-Agent": "RunawayApp/1.0 (course-recon)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!webRes.ok) return null;
    const html = await webRes.text();
    console.log("Official site HTML length:", html.length);
    return await findGpxInHtml(html, raceName);
  } catch (e) {
    console.log("Official site fetch failed:", e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// RunSignUp API
// ---------------------------------------------------------------------------

interface RunSignUpRaceDetail {
  race_id: number;
  name: string;
  url?: string;
  events?: {
    event_id: number;
    gpx_file_url?: string;
    course_map_url?: string;
  }[];
}

async function fetchRunSignUpRaceDetail(raceId: number): Promise<RunSignUpRaceDetail | null> {
  if (!RUNSIGNUP_API_KEY || !RUNSIGNUP_API_SECRET) return null;

  const params = new URLSearchParams({
    client_id: RUNSIGNUP_API_KEY,
    client_secret: RUNSIGNUP_API_SECRET,
    format: "json",
    events: "T",
    event_details: "T",
  });

  const res = await fetch(
    `https://runsignup.com/rest/race/${raceId}?${params}`,
  );
  if (!res.ok) return null;

  const data = await res.json();
  return (data?.race as RunSignUpRaceDetail) ?? null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const raceIdStr = url.searchParams.get("race_id");
    const eventIdStr = url.searchParams.get("event_id");

    if (!raceIdStr) {
      return errorResponse("race_id is required", 400);
    }

    const raceId = parseInt(raceIdStr, 10);
    // event_id is NOT NULL in the schema; use 0 as sentinel for "no specific event"
    const eventId = eventIdStr ? parseInt(eventIdStr, 10) : 0;

    if (isNaN(raceId)) {
      return errorResponse("race_id must be a number", 400);
    }

    const supabase = getSupabaseAdmin();

    // -------------------------------------------------------------------
    // Tier 0: Check cache
    // -------------------------------------------------------------------
    const { data: cached } = await supabase
      .from("race_courses")
      .select("*")
      .eq("runsignup_race_id", raceId)
      .eq("event_id", eventId)
      .maybeSingle();
    if (cached) {
      return jsonResponse({ course: cached });
    }

    // -------------------------------------------------------------------
    // Tier 1: RunSignUp /race/{race_id} — look for gpx_file_url
    // -------------------------------------------------------------------
    let gpxUrl: string | null = null;
    let raceName = `Race ${raceId}`;
    let raceWebsiteUrl: string | null = null;

    const raceDetail = await fetchRunSignUpRaceDetail(raceId);
    console.log("RunSignUp detail:", JSON.stringify(raceDetail?.events?.map(e => ({ id: e.event_id, gpx: e.gpx_file_url, map: e.course_map_url })), null, 2));
    if (raceDetail) {
      raceName = raceDetail.name ?? raceName;
      raceWebsiteUrl = raceDetail.url ?? null;
      console.log("Race website URL:", raceWebsiteUrl);

      const targetEvent = eventId !== 0
        ? raceDetail.events?.find((e) => e.event_id === eventId)
        : raceDetail.events?.[0];

      gpxUrl = targetEvent?.gpx_file_url ?? targetEvent?.course_map_url ?? null;
      console.log("GPX URL from RunSignUp:", gpxUrl);
    }

    // -------------------------------------------------------------------
    // Tier 2: Scrape race website + ask Claude to find GPX link
    // -------------------------------------------------------------------
    if (!gpxUrl && raceWebsiteUrl) {
      console.log("Scraping race website for GPX link...");
      try {
        const webRes = await fetch(raceWebsiteUrl, {
          headers: { "User-Agent": "RunawayApp/1.0 (course-recon)" },
          signal: AbortSignal.timeout(10000),
        });
        console.log("Website fetch status:", webRes.status);
        if (webRes.ok) {
          const html = await webRes.text();
          console.log("HTML length:", html.length);
          gpxUrl = await findGpxInHtml(html, raceName);
          console.log("GPX URL from Claude scrape:", gpxUrl);
        }
      } catch (e) {
        console.log("Website fetch failed:", e);
      }
    }

    // -------------------------------------------------------------------
    // Tier 3: Ask Claude for the official website, then scrape it
    // -------------------------------------------------------------------
    if (!gpxUrl) {
      console.log("Trying Claude-guided website search for:", raceName);
      gpxUrl = await findGpxViaClaudeSearch(raceName);
      console.log("GPX URL from Claude search:", gpxUrl);
    }

    // -------------------------------------------------------------------
    // No GPX found — return null course
    // -------------------------------------------------------------------
    if (!gpxUrl) {
      return jsonResponse({ course: null, debug: { raceName, raceWebsiteUrl } });
    }

    // -------------------------------------------------------------------
    // Fetch + parse the GPX file
    // -------------------------------------------------------------------
    const gpxRes = await fetch(gpxUrl, {
      signal: AbortSignal.timeout(15000),
    });

    if (!gpxRes.ok) {
      return jsonResponse({ course: null });
    }

    const gpxXml = await gpxRes.text();
    const { coords, elevations } = parseGpx(gpxXml);

    if (coords.length < 2) {
      return jsonResponse({ course: null });
    }

    const polyline = encodePolyline(coords);
    const elevationData = buildElevationData(coords, elevations);
    const tacticalInsights = await deriveTacticalInsights(raceName, elevationData);

    // -------------------------------------------------------------------
    // Store in race_courses
    // -------------------------------------------------------------------
    const courseRecord = {
      runsignup_race_id: raceId,
      event_id: eventId,
      polyline,
      elevation_data: elevationData,
      tactical_insights: tacticalInsights,
      source: gpxUrl,
    };

    const { data: inserted, error: insertError } = await supabase
      .from("race_courses")
      .upsert(courseRecord, { onConflict: "runsignup_race_id,event_id" })
      .select()
      .single();

    if (insertError) {
      console.error("race_courses insert error:", insertError);
      // Return the course data even if we couldn't store it
      return jsonResponse({ course: courseRecord });
    }

    return jsonResponse({ course: inserted });
  } catch (err) {
    console.error("get-race-course error:", err);
    return errorResponse(err instanceof Error ? err.message : "Internal error");
  }
});

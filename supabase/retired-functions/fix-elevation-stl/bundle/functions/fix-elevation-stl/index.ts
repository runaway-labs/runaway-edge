import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function decodePolyline(polylineStr: string) {
    let index = 0, lat = 0, lng = 0;
    const coordinates = [];
    while (index < polylineStr.length) {
        let b, shift = 0, result = 0;
        do {
            b = polylineStr.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        lat += (result & 1) ? ~(result >> 1) : (result >> 1);
        shift = 0; result = 0;
        do {
            b = polylineStr.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        lng += (result & 1) ? ~(result >> 1) : (result >> 1);
        coordinates.push([lat / 1e5, lng / 1e5]);
    }
    return coordinates;
}

function haversine(coord1: number[], coord2: number[]) {
    const R = 6371000;
    const lat1 = coord1[0] * Math.PI / 180;
    const lat2 = coord2[0] * Math.PI / 180;
    const dlat = (coord2[0] - coord1[0]) * Math.PI / 180;
    const dlon = (coord2[1] - coord1[1]) * Math.PI / 180;
    const a = Math.sin(dlat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon/2)**2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

Deno.serve(async (req) => {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(url!, key!);

    const { data: course, error } = await supabase
      .from("race_courses")
      .select("*")
      .eq("runsignup_race_id", 81794)
      .single();

    if (error || !course) return new Response("Not found", { status: 404 });

    const coords = decodePolyline(course.polyline);
    const sampled = [];
    let dist_so_far = 0;
    if (coords.length > 0) {
        sampled.push(coords[0]);
        for (let i = 1; i < coords.length; i++) {
            const d = haversine(coords[i-1], coords[i]);
            dist_so_far += d;
            if (dist_so_far >= 500) {
                sampled.push(coords[i]);
                dist_so_far = 0;
            }
        }
        if (coords[coords.length-1] !== sampled[sampled.length-1]) sampled.push(coords[coords.length-1]);
    }

    // Limit to 95 points just in case
    const finalSampled = sampled.length > 95 ? sampled.filter((_, i) => i % Math.ceil(sampled.length / 95) === 0) : sampled;

    const lats = finalSampled.map(c => c[0]).join(",");
    const lons = finalSampled.map(c => c[1]).join(",");
    
    const elRes = await fetch("https://api.open-meteo.com/v1/elevation?latitude=" + lats + "&longitude=" + lons);
    const elData = await elRes.json();
    const elevations = elData.elevation;

    if (!elevations) return new Response("No elevations: " + JSON.stringify(elData), { status: 500 });

    const elevation_points = [];
    let total_dist = 0;
    for (let i = 0; i < finalSampled.length; i++) {
        if (i > 0) total_dist += haversine(finalSampled[i-1], finalSampled[i]);
        let grade = 0;
        if (i > 0) {
            const dz = elevations[i] - elevations[i-1];
            const dx = haversine(finalSampled[i-1], finalSampled[i]);
            if (dx > 0) grade = (dz / dx) * 100;
        }
        elevation_points.push({
            distance: Math.round(total_dist * 100) / 100,
            elevation: Math.round(elevations[i] * 100) / 100,
            grade: Math.round(grade * 100) / 100
        });
    }

    const insights = [];
    for (let i = 1; i < elevation_points.length; i++) {
        const p = elevation_points[i];
        const mile = p.distance / 1609.34;
        const mileStr = (Math.round(mile * 10) / 10).toFixed(1);
        if (p.grade > 1.5 && !insights.find(ins => Math.abs(ins.mile - mile) < 1.0)) {
            insights.push({ mile: parseFloat(mileStr), type: "climb", description: "Steady climb at mile " + mileStr + ". Lock in your pace." });
        } else if (p.grade < -3.0 && !insights.find(ins => Math.abs(ins.mile - mile) < 1.0)) {
            insights.push({ mile: parseFloat(mileStr), type: "descent", description: "Steep drop at mile " + mileStr + ". Lean in, relax the legs." });
        }
    }
    insights.push({ mile: 18.2, type: "fuel", description: "Forest Park entry. Final fuel phase." });

    const { error: upErr } = await supabase
      .from("race_courses")
      .update({
          elevation_data: elevation_points,
          tactical_insights: insights
      })
      .eq("runsignup_race_id", 81794);

    return new Response(JSON.stringify({ success: !upErr, error: upErr, count: elevation_points.length, insights: insights.length }));
  } catch (e) {
    return new Response(e.message, { status: 500 });
  }
});

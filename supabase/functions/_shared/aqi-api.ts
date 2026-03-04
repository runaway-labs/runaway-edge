// Pre-Race Alerts MVP: Google Air Quality API Wrapper
// Uses Google Maps Air Quality API for real-time AQI data

import { AqiData } from "./types.ts";

const GOOGLE_AQI_BASE_URL = "https://airquality.googleapis.com/v1/currentConditions:lookup";

interface GoogleAqiResponse {
  dateTime: string;
  regionCode: string;
  indexes: {
    code: string;
    displayName: string;
    aqi: number;
    aqiDisplay: string;
    color: {
      red?: number;
      green?: number;
      blue?: number;
    };
    category: string;
    dominantPollutant: string;
  }[];
  pollutants?: {
    code: string;
    displayName: string;
    fullName: string;
    concentration: {
      value: number;
      units: string;
    };
    additionalInfo?: {
      sources: string;
      effects: string;
    };
  }[];
  healthRecommendations?: {
    generalPopulation: string;
    elderly: string;
    lungDiseasePopulation: string;
    heartDiseasePopulation: string;
    athletes: string;
    pregnantWomen: string;
    children: string;
  };
}

// Map Google's dominant pollutant codes to readable names
const POLLUTANT_NAMES: Record<string, string> = {
  pm25: "PM2.5",
  pm10: "PM10",
  o3: "Ozone",
  no2: "Nitrogen Dioxide",
  so2: "Sulfur Dioxide",
  co: "Carbon Monoxide",
};

export async function getCurrentAqi(
  latitude: number,
  longitude: number
): Promise<AqiData | null> {
  const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");

  if (!apiKey) {
    console.error("Missing GOOGLE_MAPS_API_KEY environment variable");
    return null;
  }

  const url = `${GOOGLE_AQI_BASE_URL}?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location: {
          latitude,
          longitude,
        },
        extraComputations: [
          "DOMINANT_POLLUTANT_CONCENTRATION",
          "POLLUTANT_CONCENTRATION",
          "LOCAL_AQI",
          "HEALTH_RECOMMENDATIONS",
        ],
        languageCode: "en",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Google Air Quality API error: ${response.status} - ${errorText}`);
      return null;
    }

    const data: GoogleAqiResponse = await response.json();

    if (!data.indexes || data.indexes.length === 0) {
      console.log("No AQI data available for location");
      return null;
    }

    // Prefer US EPA AQI (uaqi), fall back to first available index
    const usAqi = data.indexes.find((idx) => idx.code === "uaqi") ?? data.indexes[0];

    const dominantPollutant = usAqi.dominantPollutant
      ? POLLUTANT_NAMES[usAqi.dominantPollutant] ?? usAqi.dominantPollutant
      : "Unknown";

    return {
      aqi: usAqi.aqi,
      category: usAqi.category,
      dominant_pollutant: dominantPollutant,
      fetched_at: data.dateTime ?? new Date().toISOString(),
    };
  } catch (error) {
    console.error("Error fetching AQI data:", error);
    return null;
  }
}

// Helper to get AQI category from value (US EPA scale)
export function getAqiCategory(aqi: number): string {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

// Helper to check if AQI is concerning for outdoor exercise
export function isAqiConcerning(aqi: number): boolean {
  return aqi > 100; // Above "Moderate" level
}

// Pre-Race Alerts MVP: Google Weather API Wrapper
// Uses Google Maps Weather API for current conditions and forecasts

import { WeatherData, WeatherForecast } from "./types.ts";

const GOOGLE_WEATHER_BASE_URL = "https://weather.googleapis.com/v1";

interface GoogleCurrentConditionsResponse {
  currentTime: string;
  timeZone: { id: string };
  isDaytime: boolean;
  weatherCondition: {
    iconBaseUri: string;
    description: { text: string; languageCode: string };
    type: string;
  };
  temperature: { degrees: number; unit: string };
  feelsLikeTemperature: { degrees: number; unit: string };
  relativeHumidity: number;
  precipitation: {
    probability: { percent: number; type: string };
  };
  wind: {
    direction: { degrees: number; cardinal: string };
    speed: { value: number; unit: string };
    gust?: { value: number; unit: string };
  };
}

interface GoogleForecastHour {
  interval: { startTime: string; endTime: string };
  displayDateTime: {
    year: number;
    month: number;
    day: number;
    hours: number;
    minutes: number;
  };
  isDaytime: boolean;
  weatherCondition: {
    iconBaseUri: string;
    description: { text: string; languageCode: string };
    type: string;
  };
  temperature: { degrees: number; unit: string };
  feelsLikeTemperature: { degrees: number; unit: string };
  relativeHumidity: number;
  precipitation: {
    probability: { percent: number; type: string };
  };
  wind: {
    direction: { degrees: number; cardinal: string };
    speed: { value: number; unit: string };
    gust?: { value: number; unit: string };
  };
}

interface GoogleForecastResponse {
  forecastHours: GoogleForecastHour[];
}

// Convert Celsius to Fahrenheit
function celsiusToFahrenheit(celsius: number): number {
  return Math.round(celsius * 9 / 5 + 32);
}

// Convert km/h to mph
function kmhToMph(kmh: number): number {
  return Math.round(kmh * 0.621371);
}

export async function getWeatherForecast(
  latitude: number,
  longitude: number
): Promise<WeatherForecast | null> {
  const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");

  if (!apiKey) {
    console.error("Missing GOOGLE_MAPS_API_KEY environment variable");
    return null;
  }

  const url = `${GOOGLE_WEATHER_BASE_URL}/forecast/hours:lookup?key=${apiKey}&location.latitude=${latitude}&location.longitude=${longitude}&hours=48`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Google Weather API error: ${response.status} - ${errorText}`);
      return null;
    }

    const data: GoogleForecastResponse = await response.json();
    const now = new Date().toISOString();

    if (!data.forecastHours || data.forecastHours.length === 0) {
      console.error("No forecast data returned from Google Weather API");
      return null;
    }

    // Transform hourly data
    const hourly: WeatherData[] = data.forecastHours.map((hour) => ({
      temperature: celsiusToFahrenheit(hour.temperature.degrees),
      feels_like: celsiusToFahrenheit(hour.feelsLikeTemperature.degrees),
      humidity: hour.relativeHumidity,
      wind_speed: kmhToMph(hour.wind.speed.value),
      wind_gust: hour.wind.gust ? kmhToMph(hour.wind.gust.value) : null,
      precipitation_chance: hour.precipitation.probability.percent,
      conditions: hour.weatherCondition.description.text,
      icon: hour.weatherCondition.iconBaseUri,
      fetched_at: now,
    }));

    // Aggregate daily data from hourly forecasts
    const dailyMap = new Map<string, {
      date: string;
      temps: number[];
      precipChances: number[];
      conditions: string;
    }>();

    for (const hour of data.forecastHours) {
      const dt = hour.displayDateTime;
      const dateStr = `${dt.year}-${String(dt.month).padStart(2, "0")}-${String(dt.day).padStart(2, "0")}`;

      if (!dailyMap.has(dateStr)) {
        dailyMap.set(dateStr, {
          date: dateStr,
          temps: [],
          precipChances: [],
          conditions: hour.weatherCondition.description.text,
        });
      }

      const dayData = dailyMap.get(dateStr)!;
      dayData.temps.push(hour.temperature.degrees);
      dayData.precipChances.push(hour.precipitation.probability.percent);

      // Use midday conditions as representative (around 12pm)
      if (dt.hours >= 11 && dt.hours <= 13) {
        dayData.conditions = hour.weatherCondition.description.text;
      }
    }

    const daily = Array.from(dailyMap.values()).map((day) => ({
      date: day.date,
      high: celsiusToFahrenheit(Math.max(...day.temps)),
      low: celsiusToFahrenheit(Math.min(...day.temps)),
      precipitation_chance: Math.max(...day.precipChances),
      conditions: day.conditions,
    }));

    return { hourly, daily };
  } catch (error) {
    console.error("Error fetching weather forecast:", error);
    return null;
  }
}

// Get current conditions using the dedicated endpoint
export async function getCurrentWeather(
  latitude: number,
  longitude: number
): Promise<WeatherData | null> {
  const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");

  if (!apiKey) {
    console.error("Missing GOOGLE_MAPS_API_KEY environment variable");
    return null;
  }

  const url = `${GOOGLE_WEATHER_BASE_URL}/currentConditions:lookup?key=${apiKey}&location.latitude=${latitude}&location.longitude=${longitude}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Google Weather API error: ${response.status} - ${errorText}`);
      return null;
    }

    const data: GoogleCurrentConditionsResponse = await response.json();
    const now = new Date().toISOString();

    return {
      temperature: celsiusToFahrenheit(data.temperature.degrees),
      feels_like: celsiusToFahrenheit(data.feelsLikeTemperature.degrees),
      humidity: data.relativeHumidity,
      wind_speed: kmhToMph(data.wind.speed.value),
      wind_gust: data.wind.gust ? kmhToMph(data.wind.gust.value) : null,
      precipitation_chance: data.precipitation.probability.percent,
      conditions: data.weatherCondition.description.text,
      icon: data.weatherCondition.iconBaseUri,
      fetched_at: now,
    };
  } catch (error) {
    console.error("Error fetching current weather:", error);
    return null;
  }
}

// Pre-Race Alerts MVP: TypeScript type definitions

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  organization_name: string | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
}

export interface Race {
  id: string;
  director_id: string;
  name: string;
  description: string | null;
  race_date: string;
  race_time: string;
  location_name: string;
  latitude: number;
  longitude: number;
  timezone: string;
  status: "upcoming" | "active" | "completed" | "cancelled";
  created_at: string;
  updated_at: string;
}

export interface Runner {
  id: string;
  race_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notification_preferences: {
    sms: boolean;
    email: boolean;
  };
  created_at: string;
  updated_at: string;
}

export type MetricType = "temperature" | "aqi" | "wind_speed" | "precipitation_chance";
export type Operator = ">" | ">=" | "<" | "<=" | "=";

export interface AlertThreshold {
  id: string;
  race_id: string;
  metric_type: MetricType;
  operator: Operator;
  threshold_value: number;
  unit: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Alert {
  id: string;
  race_id: string;
  alert_type: "manual" | "automatic";
  triggered_by_threshold_id: string | null;
  subject: string;
  message: string;
  conditions_snapshot: WeatherConditions | null;
  created_at: string;
}

export type DeliveryStatus = "pending" | "processing" | "submitting" | "ambiguous" | "sent" | "delivered" | "retryable" | "failed";
export type DeliveryChannel = "sms" | "email";

export interface AlertDelivery {
  id: string;
  alert_id: string;
  runner_id: string;
  channel: DeliveryChannel;
  recipient: string;
  status: DeliveryStatus;
  idempotency_key: string;
  attempt_count: number;
  processing_started_at: string | null;
  claim_generation: number;
  lease_expires_at: string | null;
  provider_message_id: string | null;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConditionCheck {
  id: string;
  race_id: string;
  weather_data: WeatherData | null;
  aqi_data: AqiData | null;
  thresholds_evaluated: AlertThreshold[] | null;
  thresholds_triggered: AlertThreshold[] | null;
  alert_created: boolean;
  alert_id: string | null;
  created_at: string;
}

// Weather API types
export interface WeatherData {
  temperature: number; // Fahrenheit
  feels_like: number;
  humidity: number;
  wind_speed: number; // mph
  wind_gust: number | null;
  precipitation_chance: number; // 0-100
  conditions: string;
  icon: string;
  fetched_at: string;
}

export interface WeatherForecast {
  hourly: WeatherData[];
  daily: {
    date: string;
    high: number;
    low: number;
    precipitation_chance: number;
    conditions: string;
  }[];
}

// AQI API types
export interface AqiData {
  aqi: number;
  category: string;
  dominant_pollutant: string;
  fetched_at: string;
}

// Combined conditions for threshold evaluation
export interface WeatherConditions {
  temperature: number;
  aqi: number;
  wind_speed: number;
  precipitation_chance: number;
  fetched_at: string;
}

// API request/response types
export interface SendAlertRequest {
  race_id: string;
  subject: string;
  message: string;
}

export interface SendAlertResponse {
  success: boolean;
  alert_id?: string;
  deliveries_queued?: number;
  error?: string;
}

export interface ImportRunnersRequest {
  race_id: string;
  csv_content: string;
}

export interface ImportRunnersResponse {
  success: boolean;
  imported_count?: number;
  skipped_count?: number;
  errors?: string[];
}

// Threshold evaluation result
export interface ThresholdEvaluationResult {
  threshold: AlertThreshold;
  current_value: number;
  triggered: boolean;
}

// Delivery result
export interface DeliveryResult {
  success: boolean;
  provider_message_id?: string;
  error?: string;
  retryable: boolean;
  outcome:
    | "accepted"
    | "pre_provider_failure"
    | "provider_rejected"
    | "ambiguous_submission";
}

// RunSignUp API types
export interface RunSignUpRace {
  race_id: number;
  name: string;
  last_date: string;
  next_date: string;
  address: {
    street: string;
    city: string;
    state: string;
    zipcode: string;
    country_code: string;
  };
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  logo_url: string | null;
  url: string;
  events: RunSignUpEvent[];
}

export interface RunSignUpEvent {
  event_id: number;
  name: string;
  distance: string;
  distance_units: string;
  start_time: string;
}

export interface RunSignUpApiResponse {
  races: { race: RunSignUpRace }[];
}

// Race Directory types
export interface RaceLength {
  distance: number;
  unit: "mi" | "km";
  label: string;
}

export interface RaceDirectoryEntry {
  id: string;
  source: string;
  source_race_id: string;
  name: string;
  description: string | null;
  next_date: string | null;
  city: string | null;
  state: string | null;
  zipcode: string | null;
  country_code: string;
  latitude: number | null;
  longitude: number | null;
  logo_url: string | null;
  external_url: string | null;
  events: RaceDirectoryEvent[];
  event_type: "race" | "event";
  race_lengths: RaceLength[];
  classified_at: string | null;
  raw_data: Record<string, unknown>;
  last_synced_at: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RaceDirectoryEvent {
  event_id: number;
  name: string;
  distance: string;
  distance_units: string;
  start_time: string;
}

export interface SyncRaceDirectoryResponse {
  success: boolean;
  races_fetched: number;
  races_upserted: number;
  pages_processed: number;
  classify_triggered: boolean;
  errors: string[];
}

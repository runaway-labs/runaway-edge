// Supabase Edge Function: pre-run-brief
// Type definitions — CoachingCue schema, request/response, and assembled athlete context.

export type CueTone = "motivational" | "tactical" | "informational" | "warning";

export type TriggerType =
  | "distance_mile"
  | "time_elapsed"
  | "hr_zone_change"
  | "run_start"
  | "run_end"
  | "custom";

// Cue priority: 1 is highest, 5 is lowest.
// Conflict resolution per FR-4 decisions: lower number wins; on equal priority,
// tone tie-breaker is warning > tactical > motivational > informational.
export type CuePriority = 1 | 2 | 3 | 4 | 5;

export interface CueConditions {
  min_hr: number | null;
  max_hr: number | null;
  pace_delta_threshold: number | null;
}

export interface CoachingCue {
  id: string;
  trigger_type: TriggerType;
  trigger_value: number | null;
  script: string;
  tone: CueTone;
  priority: CuePriority;
  conditions: CueConditions;
}

export interface PreRunBriefRequest {
  athlete_id: number;
  planned_distance?: number; // miles
  planned_route?: string;
}

export interface PreRunBriefResponse {
  cues: CoachingCue[];
  context_summary: {
    activities_count: number;
    has_ai_profile: boolean;
    days_since_last_run: number | null;
    used_fallback: boolean;
    validation_retries: number;
  };
  generated_at: string;
}

// ---------- Internal context assembled from Supabase ----------

export interface AthleteRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  garmin_fitness_stats: Record<string, unknown> | null;
  health_consent_status: string | null;
}

export interface ActivityRow {
  id: number;
  athlete_id: number;
  activity_date: string;
  distance: number; // meters
  moving_time: number; // seconds
  average_speed: number; // m/s
  average_heart_rate: number | null;
  elevation_gain: number | null;
  perceived_exertion: number | null;
  training_load: number | null;
  activity_types: { id: number; name: string } | null;
}

export interface AIProfileRow {
  athlete_id: number;
  core_memory: Record<string, unknown> | null;
  preferences: Record<string, unknown> | null;
  version: number | null;
}

export interface OnboardingRow {
  athlete_id: number;
  coach_personality: "balanced" | "motivational" | "data-driven" | "gentle" | null;
  experience_level: string | null;
}

export interface GoalRow {
  id: number;
  athlete_id: number;
  goal_type: string;
  target_value: number | null;
  deadline: string | null;
  current_progress: number | null;
}

export interface RestDayRow {
  date: string;
  recovery_benefit: number | null;
}

export interface PersonalBestRow {
  distance_label: string;
  time_seconds: number;
}

export interface AthleteContext {
  athlete: AthleteRow | null;
  recent_activities: ActivityRow[];
  ai_profile: AIProfileRow | null;
  onboarding: OnboardingRow | null;
  goals: GoalRow[];
  rest_days_recent: RestDayRow[];
  personal_bests: PersonalBestRow[];
  // Numeric whitelist built during context assembly — every number here is
  // safe for the model to reference. Anything outside this set is treated
  // as a hallucination by the validator.
  numeric_whitelist: Set<string>;
}

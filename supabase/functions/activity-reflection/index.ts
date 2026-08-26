import { corsHeaders } from "../_shared/cors.ts";
import {
  resolveUserEndpointDependencies,
  userGuardErrorResponse,
  type RequireUser,
} from "../_shared/user-endpoint.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";

export type ActivityReflectionRow = {
  id: string;
  local_id: string;
  activity_id: number;
  athlete_id: number;
  auth_user_id: string;
  effort: number;
  body_status: string;
  mood: string;
  condition_tags: string[];
  note: string | null;
  local_debrief: string;
  server_debrief: string | null;
  reflected_at: string;
  local_version: number;
  server_version: number;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ReflectionWrite = Record<string, unknown> & {
  local_id: string;
  activity_id: number;
  athlete_id: number;
  auth_user_id: string;
  effort: number;
  body_status: string;
  mood: string;
  condition_tags: string[];
  note: string | null;
  local_debrief: string;
  server_debrief?: string | null;
  reflected_at: string;
  local_version: number;
  server_version: number;
  last_synced_at: string;
  updated_at: string;
};

interface OwnedActivity {
  id: number;
  athlete_id: number;
  auth_user_id: string;
}

export interface ReflectionStore {
  findOwnedActivity(activityId: number, athleteId: number, authUserId: string): Promise<OwnedActivity | null>;
  findReflection(activityId: number, authUserId: string): Promise<ActivityReflectionRow | null>;
  upsertReflection(value: ReflectionWrite): Promise<ActivityReflectionRow>;
}

interface HandlerDependencies {
  requireUser: RequireUser;
  store: ReflectionStore;
}

function createStore(): ReflectionStore {
  const admin = getSupabaseAdmin();

  return {
    async findOwnedActivity(activityId, athleteId, authUserId) {
      const { data, error } = await admin
        .from("activities")
        .select("id, athlete_id, auth_user_id")
        .eq("id", activityId)
        .eq("athlete_id", athleteId)
        .eq("auth_user_id", authUserId)
        .maybeSingle();
      if (error) throw new Error("Unable to verify activity ownership");
      return data as OwnedActivity | null;
    },

    async findReflection(activityId, authUserId) {
      const { data, error } = await admin
        .from("activity_reflections")
        .select("*")
        .eq("activity_id", activityId)
        .eq("auth_user_id", authUserId)
        .maybeSingle();
      if (error) throw new Error("Unable to load activity reflection");
      return data as ActivityReflectionRow | null;
    },

    async upsertReflection(value) {
      const { data, error } = await admin
        .from("activity_reflections")
        .upsert(value, { onConflict: "auth_user_id,activity_id" })
        .select("*")
        .single();
      if (error || !data) throw new Error("Unable to save activity reflection");
      return data as ActivityReflectionRow;
    },
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanRequiredText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned.length > 0 && cleaned.length <= maxLength ? cleaned : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

type ParsedReflection = Omit<
  ReflectionWrite,
  "athlete_id" | "auth_user_id" | "server_version" | "last_synced_at" | "updated_at"
>;

function parseReflection(value: unknown): ParsedReflection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const activityId = positiveInteger(body.activity_id);
  const localVersion = positiveInteger(body.local_version);
  const effort = positiveInteger(body.effort);
  const bodyStatus = cleanRequiredText(body.body_status, 50);
  const mood = cleanRequiredText(body.mood, 50);
  const localDebrief = cleanRequiredText(body.local_debrief, 1000);
  const serverDebrief = body.server_debrief == null
    ? null
    : cleanRequiredText(body.server_debrief, 1000);
  const reflectedAt = typeof body.reflected_at === "string" && !Number.isNaN(Date.parse(body.reflected_at))
    ? new Date(body.reflected_at).toISOString()
    : null;

  if (
    !activityId || !localVersion || !effort || effort > 10 || !isUuid(body.local_id) ||
    !bodyStatus || !mood || !localDebrief || !reflectedAt ||
    (body.server_debrief != null && !serverDebrief)
  ) return null;

  if (!Array.isArray(body.condition_tags) || body.condition_tags.length > 12) return null;
  if (body.condition_tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.trim().length > 40)) {
    return null;
  }
  const conditionTags = [...new Set((body.condition_tags as string[]).map((tag) => tag.trim()))];

  let note: string | null = null;
  if (body.note != null) {
    if (typeof body.note !== "string" || body.note.length > 1000) return null;
    note = body.note.trim() || null;
  }

  return {
    local_id: body.local_id,
    activity_id: activityId,
    effort,
    body_status: bodyStatus,
    mood,
    condition_tags: conditionTags,
    note,
    local_debrief: localDebrief,
    server_debrief: serverDebrief,
    reflected_at: reflectedAt,
    local_version: localVersion,
  };
}

export function createHandler(overrides: Partial<HandlerDependencies> = {}) {
  const userDependencies = resolveUserEndpointDependencies(overrides);
  const dependencies: HandlerDependencies = {
    requireUser: userDependencies.requireUser,
    store: overrides.store ?? createStore(),
  };

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      const context = await dependencies.requireUser(req);
      const url = new URL(req.url);

      if (req.method === "GET") {
        const activityId = positiveInteger(url.searchParams.get("activity_id"));
        if (!activityId) return errorResponse("INVALID_ACTIVITY_ID", "A valid activity_id is required", 400);
        const activity = await dependencies.store.findOwnedActivity(activityId, context.athleteId, context.authUserId);
        if (!activity) return errorResponse("ACTIVITY_NOT_FOUND", "Activity not found", 404);
        const reflection = await dependencies.store.findReflection(activityId, context.authUserId);
        return jsonResponse({ reflection });
      }

      if (req.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", "Method not allowed", 405);

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return errorResponse("INVALID_JSON", "A valid JSON body is required", 400);
      }

      const reflection = parseReflection(body);
      if (!reflection) return errorResponse("INVALID_REFLECTION", "The reflection payload is invalid", 400);

      const activity = await dependencies.store.findOwnedActivity(
        reflection.activity_id,
        context.athleteId,
        context.authUserId,
      );
      if (!activity) return errorResponse("ACTIVITY_NOT_FOUND", "Activity not found", 404);

      const now = new Date().toISOString();
      const saved = await dependencies.store.upsertReflection({
        ...reflection,
        athlete_id: context.athleteId,
        auth_user_id: context.authUserId,
        server_version: reflection.local_version,
        last_synced_at: now,
        updated_at: now,
      });
      return jsonResponse({ reflection: saved });
    } catch (error) {
      const guardResponse = userGuardErrorResponse(error, corsHeaders);
      if (guardResponse) return guardResponse;
      console.error("ACTIVITY_REFLECTION_FAILED", {
        operation: "activity_reflection",
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return errorResponse("INTERNAL_ERROR", "Unable to process activity reflection", 500);
    }
  };
}

if (import.meta.main) Deno.serve(createHandler());

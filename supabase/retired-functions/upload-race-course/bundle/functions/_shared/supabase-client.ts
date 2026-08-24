// Pre-Race Alerts MVP: Supabase Admin Client
// Uses service role key for full database access in Edge Functions

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

let supabaseAdmin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (supabaseAdmin) {
    return supabaseAdmin;
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables");
  }

  supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return supabaseAdmin;
}

// Get a client with the user's JWT for RLS-protected queries
export function getSupabaseClient(authHeader: string): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !anonKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables");
  }

  return createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// Extract user ID from JWT
export async function getUserFromAuth(authHeader: string): Promise<{ id: string; email: string } | null> {
  const client = getSupabaseClient(authHeader);
  const { data: { user }, error } = await client.auth.getUser();

  if (error || !user) {
    return null;
  }

  return { id: user.id, email: user.email ?? "" };
}

// Admin helpers
export async function adminUpdate(table: string, values: any, filter: { column: string, value: any }) {
  const admin = getSupabaseAdmin();
  const { error } = await admin.from(table).update(values).eq(filter.column, filter.value);
  if (error) throw error;
}

export async function adminSelect(table: string, columns: string, filter: { column: string, value: any }) {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.from(table).select(columns).eq(filter.column, filter.value);
  if (error) throw error;
  return data;
}

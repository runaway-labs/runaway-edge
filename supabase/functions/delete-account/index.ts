// Supabase Edge Function: delete-account
// Permanently deletes a user's account and all associated data
// Required for App Store compliance (Guideline 5.1.1v)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Verify the request has authorization
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Missing authorization header' } }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Create admin client for deletions
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Create user client to verify the requesting user
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: authHeader }
        }
      }
    )

    // Get the authenticated user
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser()

    if (userError || !user) {
      console.error('Auth error:', userError)
      return new Response(
        JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const userId = user.id
    console.log(`Starting account deletion for user: ${userId}`)

    // Get the athlete ID associated with this auth user
    const { data: athlete } = await supabaseAdmin
      .from('athletes')
      .select('id')
      .eq('auth_user_id', userId)
      .single()

    const athleteId = athlete?.id

    // Delete in order to respect foreign key constraints
    // 1. Delete app_logs
    if (athleteId) {
      const { error: logsError } = await supabaseAdmin
        .from('app_logs')
        .delete()
        .eq('athlete_id', athleteId)

      if (logsError) console.warn('Error deleting app_logs:', logsError.message)
    }

    // Also delete logs by user_id (UUID)
    const { error: logsUserError } = await supabaseAdmin
      .from('app_logs')
      .delete()
      .eq('user_id', userId)

    if (logsUserError) console.warn('Error deleting app_logs by user_id:', logsUserError.message)

    // 2. Delete activities
    if (athleteId) {
      const { error: activitiesError } = await supabaseAdmin
        .from('activities')
        .delete()
        .eq('athlete_id', athleteId)

      if (activitiesError) console.warn('Error deleting activities:', activitiesError.message)
    }

    // 3. Delete training plans
    if (athleteId) {
      const { error: plansError } = await supabaseAdmin
        .from('training_plans')
        .delete()
        .eq('athlete_id', athleteId)

      if (plansError) console.warn('Error deleting training_plans:', plansError.message)
    }

    // 4. Delete daily workouts
    if (athleteId) {
      const { error: workoutsError } = await supabaseAdmin
        .from('daily_workouts')
        .delete()
        .eq('athlete_id', athleteId)

      if (workoutsError) console.warn('Error deleting daily_workouts:', workoutsError.message)
    }

    // 5. Delete commitments
    if (athleteId) {
      const { error: commitmentsError } = await supabaseAdmin
        .from('commitments')
        .delete()
        .eq('athlete_id', athleteId)

      if (commitmentsError) console.warn('Error deleting commitments:', commitmentsError.message)
    }

    // 6. Delete goals
    if (athleteId) {
      const { error: goalsError } = await supabaseAdmin
        .from('goals')
        .delete()
        .eq('athlete_id', athleteId)

      if (goalsError) console.warn('Error deleting goals:', goalsError.message)
    }

    // 7. Delete chat messages
    if (athleteId) {
      const { error: chatError } = await supabaseAdmin
        .from('chat_messages')
        .delete()
        .eq('athlete_id', athleteId)

      if (chatError) console.warn('Error deleting chat_messages:', chatError.message)
    }

    // 8. Delete journal entries
    if (athleteId) {
      const { error: journalError } = await supabaseAdmin
        .from('journal_entries')
        .delete()
        .eq('athlete_id', athleteId)

      if (journalError) console.warn('Error deleting journal_entries:', journalError.message)
    }

    // 9. Delete sync jobs
    if (athleteId) {
      const { error: syncError } = await supabaseAdmin
        .from('sync_jobs')
        .delete()
        .eq('athlete_id', athleteId)

      if (syncError) console.warn('Error deleting sync_jobs:', syncError.message)
    }

    // 10. Delete analytics events
    if (athleteId) {
      const { error: analyticsError } = await supabaseAdmin
        .from('analytics_events')
        .delete()
        .eq('athlete_id', athleteId)

      if (analyticsError) console.warn('Error deleting analytics_events:', analyticsError.message)
    }

    // 11. Delete the athlete record
    if (athleteId) {
      const { error: athleteError } = await supabaseAdmin
        .from('athletes')
        .delete()
        .eq('id', athleteId)

      if (athleteError) {
        console.error('Error deleting athlete:', athleteError)
        return new Response(
          JSON.stringify({ error: { code: 'DELETE_FAILED', message: 'Failed to delete athlete record' } }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    // 12. Finally, delete the auth user
    const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(userId)

    if (authDeleteError) {
      console.error('Error deleting auth user:', authDeleteError)
      return new Response(
        JSON.stringify({ error: { code: 'AUTH_DELETE_FAILED', message: 'Failed to delete authentication account' } }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`Successfully deleted account for user: ${userId}`)

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Account and all associated data have been permanently deleted'
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Error in delete-account:', error)
    return new Response(
      JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: error.message } }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

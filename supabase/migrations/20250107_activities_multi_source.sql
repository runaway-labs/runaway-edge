-- Migration: Add multi-source support to activities table
-- Allows activities from Strava, Garmin, and manual recording

-- Add source column to distinguish activity origin
ALTER TABLE activities ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'strava';

-- Add auth_user_id to link directly to our users (for non-Strava sources)
ALTER TABLE activities ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id);

-- Add raw_data column to store original API response
ALTER TABLE activities ADD COLUMN IF NOT EXISTS raw_data JSONB;

-- Add device_name column
ALTER TABLE activities ADD COLUMN IF NOT EXISTS device_name TEXT;

-- Create index for source-based queries
CREATE INDEX IF NOT EXISTS idx_activities_source ON activities(source);

-- Create index for auth_user_id queries
CREATE INDEX IF NOT EXISTS idx_activities_auth_user_id ON activities(auth_user_id);

-- Create unique constraint to prevent duplicate activities from same source
-- This allows the same external_id from different sources
CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_source_external_id
ON activities(source, external_id)
WHERE external_id IS NOT NULL;

-- Update RLS policies to allow users to see activities linked by auth_user_id
CREATE POLICY IF NOT EXISTS "Users can view own activities by auth_user_id"
ON activities
FOR SELECT
TO authenticated
USING (auth_user_id = auth.uid());

-- Allow service role to insert activities from webhooks
CREATE POLICY IF NOT EXISTS "Service role can manage all activities"
ON activities
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Add comment for documentation
COMMENT ON COLUMN activities.source IS 'Activity source: strava, garmin, manual';
COMMENT ON COLUMN activities.auth_user_id IS 'Direct link to auth.users for non-Strava activities';
COMMENT ON COLUMN activities.raw_data IS 'Original API response from source';

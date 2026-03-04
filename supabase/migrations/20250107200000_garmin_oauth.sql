-- Migration: Add Garmin OAuth support
-- Creates temporary token storage and updates athletes table

-- Table to temporarily store OAuth request tokens during the auth flow
CREATE TABLE IF NOT EXISTS garmin_oauth_tokens (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    oauth_token TEXT UNIQUE NOT NULL,
    token_secret TEXT NOT NULL,
    auth_user_id UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_garmin_oauth_tokens_oauth_token ON garmin_oauth_tokens(oauth_token);

-- Auto-cleanup expired tokens (optional - can be done via cron)
-- This creates a function to clean up expired tokens
CREATE OR REPLACE FUNCTION cleanup_expired_garmin_tokens()
RETURNS void AS $$
BEGIN
    DELETE FROM garmin_oauth_tokens WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Add Garmin columns to athletes table if they don't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'athletes' AND column_name = 'garmin_access_token') THEN
        ALTER TABLE athletes ADD COLUMN garmin_access_token TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'athletes' AND column_name = 'garmin_token_secret') THEN
        ALTER TABLE athletes ADD COLUMN garmin_token_secret TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'athletes' AND column_name = 'garmin_refresh_token') THEN
        ALTER TABLE athletes ADD COLUMN garmin_refresh_token TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'athletes' AND column_name = 'garmin_token_expires_at') THEN
        ALTER TABLE athletes ADD COLUMN garmin_token_expires_at TIMESTAMPTZ;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'athletes' AND column_name = 'garmin_connected') THEN
        ALTER TABLE athletes ADD COLUMN garmin_connected BOOLEAN DEFAULT FALSE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'athletes' AND column_name = 'garmin_connected_at') THEN
        ALTER TABLE athletes ADD COLUMN garmin_connected_at TIMESTAMPTZ;
    END IF;
END $$;

-- Optional: Create a dedicated garmin_connections table for cleaner separation
CREATE TABLE IF NOT EXISTS garmin_connections (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    auth_user_id UUID UNIQUE REFERENCES auth.users(id),
    access_token TEXT NOT NULL,
    token_secret TEXT NOT NULL,
    garmin_user_id TEXT,
    connected_at TIMESTAMPTZ DEFAULT NOW(),
    last_sync_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS policies
ALTER TABLE garmin_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE garmin_connections ENABLE ROW LEVEL SECURITY;

-- Allow service role full access to oauth tokens
CREATE POLICY "Service role can manage garmin_oauth_tokens"
ON garmin_oauth_tokens
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Users can only see their own connections
CREATE POLICY "Users can view own garmin connection"
ON garmin_connections
FOR SELECT
TO authenticated
USING (auth_user_id = auth.uid());

-- Service role can manage all connections
CREATE POLICY "Service role can manage garmin_connections"
ON garmin_connections
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

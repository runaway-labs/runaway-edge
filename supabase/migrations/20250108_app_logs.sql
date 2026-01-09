-- Migration: Create centralized logging table
-- Stores logs from iOS app and Edge Functions

CREATE TABLE IF NOT EXISTS app_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- Source identification
    source TEXT NOT NULL, -- 'ios', 'edge-function', 'web'
    function_name TEXT, -- Edge function name or iOS service name

    -- Log details
    level TEXT NOT NULL DEFAULT 'info', -- 'debug', 'info', 'warn', 'error'
    message TEXT NOT NULL,

    -- Context
    user_id UUID REFERENCES auth.users(id),
    athlete_id BIGINT,
    session_id TEXT,

    -- Request/Response details
    request_method TEXT,
    request_path TEXT,
    request_body JSONB,
    response_status INTEGER,
    response_body JSONB,
    duration_ms INTEGER,

    -- Error details
    error_message TEXT,
    error_stack TEXT,

    -- Device/Environment info
    device_info JSONB, -- iOS: model, OS version, app version
    environment TEXT DEFAULT 'production', -- 'development', 'staging', 'production'

    -- Additional metadata
    metadata JSONB
);

-- Index for fast queries
CREATE INDEX idx_app_logs_created_at ON app_logs(created_at DESC);
CREATE INDEX idx_app_logs_user_id ON app_logs(user_id);
CREATE INDEX idx_app_logs_level ON app_logs(level);
CREATE INDEX idx_app_logs_source ON app_logs(source);
CREATE INDEX idx_app_logs_function_name ON app_logs(function_name);

-- RLS policies
ALTER TABLE app_logs ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY "Service role full access to logs"
ON app_logs FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Users can insert their own logs
CREATE POLICY "Users can insert own logs"
ON app_logs FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

-- Users can view their own logs (optional - remove if you don't want users seeing logs)
CREATE POLICY "Users can view own logs"
ON app_logs FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Anon can insert logs (for pre-auth logging)
CREATE POLICY "Anon can insert logs"
ON app_logs FOR INSERT
TO anon
WITH CHECK (true);

-- Function to clean up old logs (keep 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS void AS $$
BEGIN
    DELETE FROM app_logs WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE app_logs IS 'Centralized logging for iOS app, Edge Functions, and web';

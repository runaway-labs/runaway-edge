-- Migration: Add web_redirect_url to garmin_oauth_tokens
-- Allows storing redirect URL for web OAuth flow

ALTER TABLE garmin_oauth_tokens
ADD COLUMN IF NOT EXISTS web_redirect_url TEXT;

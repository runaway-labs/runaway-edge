-- Replace Firebase Cloud Messaging token with native APNs device token
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS apns_token TEXT;

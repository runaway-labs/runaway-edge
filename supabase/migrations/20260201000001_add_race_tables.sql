-- Database Merge: Add race-director tables to edge DB
-- Consolidates platform DB (qautecujfjolspecsswp) into edge DB (nkxvjcdxiyjbndjvfmqy)
--
-- Prerequisites:
--   - pg_cron and pg_net extensions enabled
--   - Vault secrets configured:
--     SELECT vault.create_secret('https://nkxvjcdxiyjbndjvfmqy.supabase.co', 'supabase_url');
--     SELECT vault.create_secret('<service-role-key>', 'service_role_key');

-- ============================================================
-- Step 1: Add race-director columns to athletes
-- ============================================================

ALTER TABLE athletes
  ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'athlete',
  ADD COLUMN IF NOT EXISTS organization TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT;

-- Add constraints separately to handle existing columns
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'athletes_auth_user_id_key'
  ) THEN
    ALTER TABLE athletes ADD CONSTRAINT athletes_auth_user_id_key UNIQUE (auth_user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'athletes_role_check'
  ) THEN
    ALTER TABLE athletes ADD CONSTRAINT athletes_role_check
      CHECK (role IN ('athlete', 'race_director', 'both'));
  END IF;
END $$;

-- Set NOT NULL with default for existing rows
UPDATE athletes SET role = 'athlete' WHERE role IS NULL;
ALTER TABLE athletes ALTER COLUMN role SET NOT NULL;

-- ============================================================
-- Step 2: Create race tables
-- ============================================================

-- Races table
CREATE TABLE races (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    director_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    race_date DATE NOT NULL,
    race_time TIME NOT NULL,
    location_name TEXT NOT NULL,
    latitude DECIMAL(10, 7) NOT NULL,
    longitude DECIMAL(10, 7) NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'America/Chicago',
    status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'active', 'completed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Runners table
CREATE TABLE runners (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    race_id UUID NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    notification_preferences JSONB NOT NULL DEFAULT '{"sms": true, "email": true}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT runner_contact_required CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

-- Alert thresholds table
CREATE TABLE alert_thresholds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    race_id UUID NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    metric_type TEXT NOT NULL CHECK (metric_type IN ('temperature', 'aqi', 'wind_speed', 'precipitation_chance')),
    operator TEXT NOT NULL CHECK (operator IN ('>', '>=', '<', '<=', '=')),
    threshold_value DECIMAL(10, 2) NOT NULL,
    unit TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Alerts table (both manual and automatic)
CREATE TABLE alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    race_id UUID NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    alert_type TEXT NOT NULL CHECK (alert_type IN ('manual', 'automatic')),
    triggered_by_threshold_id UUID REFERENCES alert_thresholds(id) ON DELETE SET NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    conditions_snapshot JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Alert deliveries table
CREATE TABLE alert_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    runner_id UUID NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
    recipient TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),
    provider_message_id TEXT,
    error_message TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Condition checks table (audit log of weather monitoring)
CREATE TABLE condition_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    race_id UUID NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    weather_data JSONB,
    aqi_data JSONB,
    thresholds_evaluated JSONB,
    thresholds_triggered JSONB,
    alert_created BOOLEAN NOT NULL DEFAULT FALSE,
    alert_id UUID REFERENCES alerts(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Race directory table (public, synced from RunSignUp)
CREATE TABLE race_directory (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'runsignup',
    source_race_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    next_date DATE,
    city TEXT,
    state TEXT,
    zipcode TEXT,
    country_code TEXT DEFAULT 'US',
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    logo_url TEXT,
    external_url TEXT,
    events JSONB DEFAULT '[]'::jsonb,
    raw_data JSONB DEFAULT '{}'::jsonb,
    event_type TEXT NOT NULL DEFAULT 'event' CHECK (event_type IN ('race', 'event')),
    race_lengths JSONB DEFAULT '[]'::jsonb,
    classified_at TIMESTAMPTZ,
    last_synced_at TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE race_directory
    ADD CONSTRAINT race_directory_source_unique UNIQUE (source, source_race_id);

-- ============================================================
-- Step 3: Indexes
-- ============================================================

CREATE INDEX idx_races_director_id ON races(director_id);
CREATE INDEX idx_races_race_date ON races(race_date);
CREATE INDEX idx_races_status ON races(status);
CREATE INDEX idx_runners_race_id ON runners(race_id);
CREATE INDEX idx_alert_thresholds_race_id ON alert_thresholds(race_id);
CREATE INDEX idx_alerts_race_id ON alerts(race_id);
CREATE INDEX idx_alerts_created_at ON alerts(created_at);
CREATE INDEX idx_alert_deliveries_alert_id ON alert_deliveries(alert_id);
CREATE INDEX idx_alert_deliveries_status ON alert_deliveries(status);
CREATE INDEX idx_condition_checks_race_id ON condition_checks(race_id);
CREATE INDEX idx_condition_checks_created_at ON condition_checks(created_at);

-- Race directory indexes
CREATE INDEX idx_race_directory_next_date ON race_directory(next_date);
CREATE INDEX idx_race_directory_state ON race_directory(state);
CREATE INDEX idx_race_directory_source ON race_directory(source);
CREATE INDEX idx_race_directory_is_active ON race_directory(is_active);
CREATE INDEX idx_race_directory_name_search ON race_directory USING gin(to_tsvector('english', name));
CREATE INDEX idx_race_directory_event_type ON race_directory(event_type);
CREATE INDEX idx_race_directory_race_lengths ON race_directory USING gin(race_lengths jsonb_path_ops);
CREATE INDEX idx_race_directory_active_races ON race_directory(is_active, event_type) WHERE is_active = true;

-- ============================================================
-- Step 4: updated_at trigger function + triggers
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_races_updated_at
    BEFORE UPDATE ON races
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_runners_updated_at
    BEFORE UPDATE ON runners
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_alert_thresholds_updated_at
    BEFORE UPDATE ON alert_thresholds
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_alert_deliveries_updated_at
    BEFORE UPDATE ON alert_deliveries
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_race_directory_updated_at
    BEFORE UPDATE ON race_directory
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Step 5: Profiles compatibility view + INSTEAD OF triggers
-- ============================================================

CREATE VIEW profiles AS
SELECT
    auth_user_id AS id,
    email,
    COALESCE(first_name || ' ' || last_name, first_name, last_name, '') AS full_name,
    organization AS organization_name,
    phone,
    created_at,
    updated_at,
    -- RunSignUp OAuth tokens are not in athletes yet; return NULLs for compat
    NULL::text AS runsignup_access_token,
    NULL::text AS runsignup_refresh_token,
    NULL::timestamptz AS runsignup_token_expires_at
FROM athletes
WHERE auth_user_id IS NOT NULL;

-- INSTEAD OF INSERT: create/update athletes row when server actions INSERT into profiles
CREATE OR REPLACE FUNCTION profiles_insert_trigger()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO athletes (id, auth_user_id, email, first_name, role)
    VALUES (
        -- Use a generated bigint for the athletes PK (Strava ID slot)
        -- nextval from a sequence or abs(hashtext) as placeholder
        abs(('x' || left(md5(NEW.id::text), 15))::bit(60)::bigint),
        NEW.id,
        COALESCE(NEW.email, ''),
        COALESCE(NEW.full_name, ''),
        'athlete'
    )
    ON CONFLICT (auth_user_id) DO UPDATE SET
        email = COALESCE(EXCLUDED.email, athletes.email),
        first_name = COALESCE(EXCLUDED.first_name, athletes.first_name),
        updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER profiles_on_insert
    INSTEAD OF INSERT ON profiles
    FOR EACH ROW EXECUTE FUNCTION profiles_insert_trigger();

-- INSTEAD OF UPDATE: update athletes row when server actions UPDATE profiles
CREATE OR REPLACE FUNCTION profiles_update_trigger()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE athletes SET
        email = COALESCE(NEW.email, athletes.email),
        first_name = COALESCE(NEW.full_name, athletes.first_name),
        organization = COALESCE(NEW.organization_name, athletes.organization),
        phone = COALESCE(NEW.phone, athletes.phone),
        updated_at = NOW()
    WHERE auth_user_id = NEW.id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER profiles_on_update
    INSTEAD OF UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION profiles_update_trigger();

-- ============================================================
-- Step 6: handle_new_user() trigger
-- ============================================================

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO athletes (id, auth_user_id, email, first_name, role)
    VALUES (
        abs(('x' || left(md5(NEW.id::text), 15))::bit(60)::bigint),
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
        'athlete'
    )
    ON CONFLICT (auth_user_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- Step 7: RLS policies
-- ============================================================

-- Enable RLS on new tables
ALTER TABLE races ENABLE ROW LEVEL SECURITY;
ALTER TABLE runners ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE condition_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE race_directory ENABLE ROW LEVEL SECURITY;

-- Athletes: users can update their own role/org/phone
DROP POLICY IF EXISTS "Users can update own athlete profile" ON athletes;
CREATE POLICY "Users can update own athlete profile"
    ON athletes FOR UPDATE
    TO authenticated
    USING (auth_user_id = auth.uid());

DROP POLICY IF EXISTS "Users can view own athlete profile" ON athletes;
CREATE POLICY "Users can view own athlete profile"
    ON athletes FOR SELECT
    TO authenticated
    USING (auth_user_id = auth.uid());

-- Races policies
CREATE POLICY "Directors can view own races"
    ON races FOR SELECT
    USING (auth.uid() = director_id);

CREATE POLICY "Directors can create races"
    ON races FOR INSERT
    WITH CHECK (auth.uid() = director_id);

CREATE POLICY "Directors can update own races"
    ON races FOR UPDATE
    USING (auth.uid() = director_id);

CREATE POLICY "Directors can delete own races"
    ON races FOR DELETE
    USING (auth.uid() = director_id);

-- Runners policies
CREATE POLICY "Directors can view runners for their races"
    ON runners FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM races WHERE races.id = runners.race_id AND races.director_id = auth.uid()
    ));

CREATE POLICY "Directors can create runners for their races"
    ON runners FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM races WHERE races.id = runners.race_id AND races.director_id = auth.uid()
    ));

CREATE POLICY "Directors can update runners for their races"
    ON runners FOR UPDATE
    USING (EXISTS (
        SELECT 1 FROM races WHERE races.id = runners.race_id AND races.director_id = auth.uid()
    ));

CREATE POLICY "Directors can delete runners for their races"
    ON runners FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM races WHERE races.id = runners.race_id AND races.director_id = auth.uid()
    ));

-- Alert thresholds policies
CREATE POLICY "Directors can view thresholds for their races"
    ON alert_thresholds FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM races WHERE races.id = alert_thresholds.race_id AND races.director_id = auth.uid()
    ));

CREATE POLICY "Directors can create thresholds for their races"
    ON alert_thresholds FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM races WHERE races.id = alert_thresholds.race_id AND races.director_id = auth.uid()
    ));

CREATE POLICY "Directors can update thresholds for their races"
    ON alert_thresholds FOR UPDATE
    USING (EXISTS (
        SELECT 1 FROM races WHERE races.id = alert_thresholds.race_id AND races.director_id = auth.uid()
    ));

CREATE POLICY "Directors can delete thresholds for their races"
    ON alert_thresholds FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM races WHERE races.id = alert_thresholds.race_id AND races.director_id = auth.uid()
    ));

-- Alerts policies
CREATE POLICY "Directors can view alerts for their races"
    ON alerts FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM races WHERE races.id = alerts.race_id AND races.director_id = auth.uid()
    ));

CREATE POLICY "Directors can create alerts for their races"
    ON alerts FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM races WHERE races.id = alerts.race_id AND races.director_id = auth.uid()
    ));

-- Alert deliveries policies
CREATE POLICY "Directors can view deliveries for their races"
    ON alert_deliveries FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM alerts
        JOIN races ON races.id = alerts.race_id
        WHERE alerts.id = alert_deliveries.alert_id AND races.director_id = auth.uid()
    ));

-- Condition checks policies
CREATE POLICY "Directors can view condition checks for their races"
    ON condition_checks FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM races WHERE races.id = condition_checks.race_id AND races.director_id = auth.uid()
    ));

-- Race directory: public read for active races
CREATE POLICY "Anyone can view active directory races"
    ON race_directory FOR SELECT
    USING (is_active = true);

-- Service role policies for Edge Functions
CREATE POLICY "Service role can manage all races"
    ON races FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role can manage all runners"
    ON runners FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role can manage all thresholds"
    ON alert_thresholds FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role can manage all alerts"
    ON alerts FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role can manage all deliveries"
    ON alert_deliveries FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role can manage all condition checks"
    ON condition_checks FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role has full access to race_directory"
    ON race_directory FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ============================================================
-- Step 8: Helper functions
-- ============================================================

-- Safe numeric cast for JSONB distance values
CREATE OR REPLACE FUNCTION safe_to_numeric(val text)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  RETURN val::numeric;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION safe_to_numeric TO anon, authenticated;

-- Search directory races function (with ultra subcategories)
CREATE OR REPLACE FUNCTION search_directory_races(
  p_search text DEFAULT NULL,
  p_state text DEFAULT NULL,
  p_date_from text DEFAULT NULL,
  p_date_to text DEFAULT NULL,
  p_distances text DEFAULT NULL,
  p_show_events boolean DEFAULT false
) RETURNS SETOF race_directory
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_categories text[];
BEGIN
  IF p_distances IS NOT NULL AND p_distances <> '' THEN
    v_categories := string_to_array(p_distances, ',');
  END IF;

  RETURN QUERY
  SELECT rd.*
  FROM race_directory rd
  WHERE rd.is_active = true
    AND (p_show_events OR rd.classified_at IS NULL OR rd.event_type = 'race')
    AND (p_search IS NULL OR to_tsvector('english', rd.name) @@ websearch_to_tsquery('english', p_search))
    AND (p_state IS NULL OR rd.state = p_state)
    AND (p_date_from IS NULL OR rd.next_date >= p_date_from::date)
    AND (p_date_to IS NULL OR rd.next_date <= p_date_to::date)
    AND (v_categories IS NULL OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(rd.race_lengths) elem
      WHERE
        ('5k' = ANY(v_categories) AND (
          (safe_to_numeric(elem->>'distance') BETWEEN 4.5 AND 5.5 AND elem->>'unit' = 'km')
          OR (safe_to_numeric(elem->>'distance') BETWEEN 2.8 AND 3.4 AND elem->>'unit' = 'mi')
        ))
        OR ('10k' = ANY(v_categories) AND (
          (safe_to_numeric(elem->>'distance') BETWEEN 9 AND 11 AND elem->>'unit' = 'km')
          OR (safe_to_numeric(elem->>'distance') BETWEEN 5.5 AND 6.9 AND elem->>'unit' = 'mi')
        ))
        OR ('half' = ANY(v_categories) AND (
          (safe_to_numeric(elem->>'distance') BETWEEN 20 AND 22 AND elem->>'unit' = 'km')
          OR (safe_to_numeric(elem->>'distance') BETWEEN 12.5 AND 14 AND elem->>'unit' = 'mi')
        ))
        OR ('marathon' = ANY(v_categories) AND (
          (safe_to_numeric(elem->>'distance') BETWEEN 41 AND 43 AND elem->>'unit' = 'km')
          OR (safe_to_numeric(elem->>'distance') BETWEEN 25.5 AND 27 AND elem->>'unit' = 'mi')
        ))
        OR ('ultra' = ANY(v_categories) AND (
          (safe_to_numeric(elem->>'distance') >= 50 AND elem->>'unit' = 'km')
          OR (safe_to_numeric(elem->>'distance') >= 31 AND elem->>'unit' = 'mi')
          OR (lower(elem->>'label') ~ '(hour|hr|hrs|backyard|last person standing|timed)')
        ))
        OR ('ultra50k' = ANY(v_categories) AND (
          (safe_to_numeric(elem->>'distance') BETWEEN 49 AND 55 AND elem->>'unit' = 'km')
        ))
        OR ('ultra50mi' = ANY(v_categories) AND (
          (safe_to_numeric(elem->>'distance') BETWEEN 49 AND 55 AND elem->>'unit' = 'mi')
        ))
        OR ('ultra100k' = ANY(v_categories) AND (
          (safe_to_numeric(elem->>'distance') BETWEEN 95 AND 105 AND elem->>'unit' = 'km')
        ))
        OR ('ultra100mi' = ANY(v_categories) AND (
          (safe_to_numeric(elem->>'distance') BETWEEN 95 AND 105 AND elem->>'unit' = 'mi')
        ))
        OR ('ultratimed' = ANY(v_categories) AND (
          lower(elem->>'label') ~ '(hour|hr|hrs|timed|\d+\s*h\b)'
        ))
        OR ('ultrabackyard' = ANY(v_categories) AND (
          lower(elem->>'label') ~ '(backyard|last person standing)'
        ))
    ))
  ORDER BY rd.next_date ASC NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION search_directory_races TO anon, authenticated;

-- ============================================================
-- Step 9: Cron jobs (using Vault secrets)
-- ============================================================

-- Check race conditions every 30 minutes
SELECT cron.schedule(
    'check-conditions-job',
    '*/30 * * * *',
    $$
    SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1) || '/functions/v1/check-conditions',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
        ),
        body := '{}'::jsonb
    ) AS request_id;
    $$
);

-- Process alert deliveries every minute
SELECT cron.schedule(
    'process-deliveries-job',
    '* * * * *',
    $$
    SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1) || '/functions/v1/process-deliveries',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
        ),
        body := '{}'::jsonb
    ) AS request_id;
    $$
);

-- Sync race directory nightly at 2 AM UTC
SELECT cron.schedule(
    'sync-race-directory-job',
    '0 2 * * *',
    $$
    SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1) || '/functions/v1/sync-race-directory',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
        ),
        body := '{}'::jsonb
    ) AS request_id;
    $$
);

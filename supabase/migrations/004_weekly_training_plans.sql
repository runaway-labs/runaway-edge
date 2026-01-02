-- Migration: Create weekly_training_plans table
-- Stores AI-generated weekly training plans for athletes
-- Idempotent: safe to run multiple times

-- Create table if not exists
CREATE TABLE IF NOT EXISTS weekly_training_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id BIGINT NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
    week_start_date DATE NOT NULL,
    week_end_date DATE NOT NULL,
    workouts JSONB NOT NULL DEFAULT '[]',
    week_number INTEGER,
    total_mileage DECIMAL(5,2) DEFAULT 0,
    focus_area TEXT,
    notes TEXT,
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    goal_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(athlete_id, week_start_date)
);

-- Add columns that might be missing (for existing tables)
DO $$
BEGIN
    -- Add is_regenerated if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'weekly_training_plans' AND column_name = 'is_regenerated') THEN
        ALTER TABLE weekly_training_plans ADD COLUMN is_regenerated BOOLEAN DEFAULT FALSE;
    END IF;

    -- Add regeneration_reason if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'weekly_training_plans' AND column_name = 'regeneration_reason') THEN
        ALTER TABLE weekly_training_plans ADD COLUMN regeneration_reason TEXT;
    END IF;

    -- Add goal_id if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'weekly_training_plans' AND column_name = 'goal_id') THEN
        ALTER TABLE weekly_training_plans ADD COLUMN goal_id INTEGER;
    END IF;

    -- Add focus_area if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'weekly_training_plans' AND column_name = 'focus_area') THEN
        ALTER TABLE weekly_training_plans ADD COLUMN focus_area TEXT;
    END IF;

    -- Add notes if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'weekly_training_plans' AND column_name = 'notes') THEN
        ALTER TABLE weekly_training_plans ADD COLUMN notes TEXT;
    END IF;
END $$;

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_weekly_plans_athlete_week
    ON weekly_training_plans(athlete_id, week_start_date);

CREATE INDEX IF NOT EXISTS idx_weekly_plans_generated_at
    ON weekly_training_plans(generated_at DESC);

-- Enable RLS
ALTER TABLE weekly_training_plans ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (for clean re-run)
DROP POLICY IF EXISTS "Service role full access" ON weekly_training_plans;
DROP POLICY IF EXISTS "Authenticated read access" ON weekly_training_plans;
DROP POLICY IF EXISTS "Athletes can view own plans" ON weekly_training_plans;
DROP POLICY IF EXISTS "Service role can manage plans" ON weekly_training_plans;

-- Policy: Service role can do everything (used by edge functions)
CREATE POLICY "Service role full access" ON weekly_training_plans
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Policy: Authenticated users can read all plans (athlete verification at app level)
CREATE POLICY "Authenticated read access" ON weekly_training_plans
    FOR SELECT
    TO authenticated
    USING (true);

-- Trigger function for updated_at
CREATE OR REPLACE FUNCTION update_weekly_plan_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists, then create
DROP TRIGGER IF EXISTS trigger_update_weekly_plan_timestamp ON weekly_training_plans;

CREATE TRIGGER trigger_update_weekly_plan_timestamp
    BEFORE UPDATE ON weekly_training_plans
    FOR EACH ROW
    EXECUTE FUNCTION update_weekly_plan_updated_at();

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON weekly_training_plans TO service_role;
GRANT SELECT ON weekly_training_plans TO authenticated;

-- Add comments for documentation
COMMENT ON TABLE weekly_training_plans IS 'AI-generated weekly training plans that adapt based on completed activities';
COMMENT ON COLUMN weekly_training_plans.workouts IS 'JSONB array of DailyWorkout objects';

ALTER TABLE public.athlete_races
    ADD COLUMN IF NOT EXISTS source text,
    ADD COLUMN IF NOT EXISTS distance_miles numeric;

UPDATE public.athlete_races
SET source = 'runsignup'
WHERE source IS NULL;

ALTER TABLE public.athlete_races
    ALTER COLUMN source SET DEFAULT 'runsignup',
    ALTER COLUMN source SET NOT NULL,
    ALTER COLUMN runsignup_race_id DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'athlete_races_source_check'
          AND conrelid = 'public.athlete_races'::regclass
    ) THEN
        ALTER TABLE public.athlete_races
            ADD CONSTRAINT athlete_races_source_check
            CHECK (source IN ('runsignup', 'manual'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'athlete_races_source_identifier_check'
          AND conrelid = 'public.athlete_races'::regclass
    ) THEN
        ALTER TABLE public.athlete_races
            ADD CONSTRAINT athlete_races_source_identifier_check
            CHECK (
                (source = 'runsignup' AND runsignup_race_id IS NOT NULL)
                OR (source = 'manual' AND runsignup_race_id IS NULL)
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'athlete_races_distance_miles_check'
          AND conrelid = 'public.athlete_races'::regclass
    ) THEN
        ALTER TABLE public.athlete_races
            ADD CONSTRAINT athlete_races_distance_miles_check
            CHECK (distance_miles IS NULL OR distance_miles > 0);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_athlete_races_athlete_date
    ON public.athlete_races (athlete_id, race_date);

COMMENT ON COLUMN public.athlete_races.source IS
    'Origin of the athlete race: runsignup import or manual entry.';
COMMENT ON COLUMN public.athlete_races.distance_miles IS
    'Selected race distance in miles when known.';

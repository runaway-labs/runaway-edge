-- Migration: add runner_identity_milestones table
CREATE TABLE runner_identity_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id bigint NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  milestone_key text NOT NULL,
  label text NOT NULL,
  description text NOT NULL,
  earned boolean NOT NULL DEFAULT false,
  earned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(athlete_id, milestone_key)
);

CREATE INDEX idx_milestones_athlete ON runner_identity_milestones(athlete_id);

ALTER TABLE runner_identity_milestones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Athletes see own milestones" ON runner_identity_milestones
  FOR ALL USING (
    athlete_id = (SELECT id FROM athletes WHERE auth_user_id = auth.uid())
  );

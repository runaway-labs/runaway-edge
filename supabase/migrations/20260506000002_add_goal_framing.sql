-- Migration: add goal_framing column to running_goals
ALTER TABLE IF EXISTS running_goals ADD COLUMN IF NOT EXISTS goal_framing text;

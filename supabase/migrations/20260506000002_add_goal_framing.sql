-- Migration: add goal_framing column to running_goals
ALTER TABLE running_goals ADD COLUMN goal_framing text;

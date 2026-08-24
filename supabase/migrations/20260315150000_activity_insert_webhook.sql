-- The legacy activity webhook embedded a bearer credential in database source.
-- Keep fresh migration replays fail-closed; the containment migration repeats
-- this cleanup for databases where the unsafe migration was already applied.
drop trigger if exists on_activity_insert on public.activities;
drop function if exists public.notify_activity_insert();

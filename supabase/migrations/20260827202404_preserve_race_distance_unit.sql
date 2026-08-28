alter table public.athlete_races
add column if not exists distance_unit text;

alter table public.athlete_races
drop constraint if exists athlete_races_distance_unit_check;

alter table public.athlete_races
add constraint athlete_races_distance_unit_check
check (distance_unit is null or distance_unit in ('miles', 'kilometers'));

comment on column public.athlete_races.distance_unit is
'Display unit selected for this race. distance_miles remains the normalized storage value.';

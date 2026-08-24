-- Goals table RLS policies
-- Enables authenticated athletes to manage their own goals

DO $migration$
BEGIN
  IF to_regclass('public.goals') IS NULL THEN
    RAISE NOTICE 'public.goals is not present; skipping optional goals RLS policies';
    RETURN;
  END IF;

  EXECUTE $policy$
    CREATE POLICY "goals_select_own"
    ON public.goals FOR SELECT
    TO authenticated
    USING (
      athlete_id IN (
        SELECT id FROM public.athletes WHERE auth_user_id = auth.uid()
      )
    )
  $policy$;

  EXECUTE $policy$
    CREATE POLICY "goals_insert_own"
    ON public.goals FOR INSERT
    TO authenticated
    WITH CHECK (
      athlete_id IN (
        SELECT id FROM public.athletes WHERE auth_user_id = auth.uid()
      )
    )
  $policy$;

  EXECUTE $policy$
    CREATE POLICY "goals_update_own"
    ON public.goals FOR UPDATE
    TO authenticated
    USING (athlete_id IN (SELECT id FROM public.athletes WHERE auth_user_id = auth.uid()))
    WITH CHECK (athlete_id IN (SELECT id FROM public.athletes WHERE auth_user_id = auth.uid()))
  $policy$;

  EXECUTE $policy$
    CREATE POLICY "goals_delete_own"
    ON public.goals FOR DELETE
    TO authenticated
    USING (
      athlete_id IN (
        SELECT id FROM public.athletes WHERE auth_user_id = auth.uid()
      )
    )
  $policy$;
END
$migration$;

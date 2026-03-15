CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION notify_activity_insert()
RETURNS TRIGGER AS $trigger$
BEGIN
  PERFORM net.http_post(
    url := 'https://nkxvjcdxiyjbndjvfmqy.supabase.co/functions/v1/notify-activity-insert',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5reHZqY2R4aXlqYm5kanZmbXF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkwNjM4MjYsImV4cCI6MjA3NDYzOTgyNn0.hGwJNTA21QdiqKXVdjK-IHu02RGCWnkOIzWpNA5y96I'
    ),
    body := jsonb_build_object(
      'record', row_to_json(NEW)::jsonb,
      'type', 'INSERT',
      'table', 'activities',
      'schema', 'public'
    )
  );
  RETURN NEW;
END;
$trigger$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_activity_insert ON public.activities;

CREATE TRIGGER on_activity_insert
  AFTER INSERT ON public.activities
  FOR EACH ROW
  EXECUTE FUNCTION notify_activity_insert();

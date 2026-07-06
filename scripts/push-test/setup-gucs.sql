-- ---------------------------------------------------------------------------
-- push-test/setup-gucs.sql
--
-- One-time GUC sets. The cron body reads app.send_push_url and
-- app.send_push_key via current_setting(...) so the function URL and
-- shared secret never end up in the schema file.
--
-- Run this in the Supabase SQL editor AFTER migrate.sql and AFTER
-- you've deployed the send-push Edge Function (or before — pg_net
-- is async, the GUC is only read when the cron ticks).
--
-- The shared secret below MUST match the SHARED_CRON_SECRET you've
-- set as a Supabase Function secret. If you regenerate the secret,
-- run this file again with the new value.
-- ---------------------------------------------------------------------------

-- Function URL. Replace <project-ref> with your project's ref id
-- (the subdomain of your Supabase dashboard URL).
alter database postgres set app.send_push_url =
  'https://<project-ref>.supabase.co/functions/v1/send-push';

-- Shared bearer token the cron uses to authorize with the function.
-- MUST equal Deno.env.get('SHARED_CRON_SECRET') inside the function.
alter database postgres set app.send_push_key =
  '<SHARED_CRON_SECRET>';

-- The ALTER DATABASE only takes effect for NEW connections. The
-- next cron tick will pick it up; if you want it applied right
-- now (e.g. for an immediate test), also run:
select set_config('app.send_push_url',
  'https://<project-ref>.supabase.co/functions/v1/send-push', false);
select set_config('app.send_push_key',
  '<SHARED_CRON_SECRET>', false);

-- ---------------------------------------------------------------------------
-- push-test/inject-log-row.sql
--
-- Manually insert a row into notification_log for a task you want to
-- test, then run `node scripts/push-test/send-once.mjs` to send it.
--
-- The cron won't fire for 60 minutes; this is the manual escape hatch.
--
-- Usage: replace the <task_id> and <user_id> with real UUIDs from
-- your tasks + auth.users tables. Pick the tier you want to test
-- ('3d' / '1d' / '1h'). The on-conflict clause is a no-op the second
-- time you run this for the same (task_id, tier).
-- ---------------------------------------------------------------------------

insert into notification_log (task_id, user_id, tier)
  values (
    '<task_id>'::uuid,    -- e.g. 'a1b2c3d4-...'
    '<user_id>'::uuid,    -- your user id from auth.users
    '1d'                  -- '3d' | '1d' | '1h'
  )
  on conflict (task_id, tier) do nothing;

-- Verify what got queued:
-- select nl.task_id, nl.tier, nl.sent_at, t.title
--   from notification_log nl
--   join tasks t on t.id = nl.task_id
--   where nl.sent_at is null;

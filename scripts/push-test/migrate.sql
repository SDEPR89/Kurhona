-- ---------------------------------------------------------------------------
-- push-test/migrate.sql
--
-- The subset of `supabase/schema.sql` you need to apply manually via
-- the Supabase SQL editor to test Web Push end-to-end. This mirrors
-- lines 362-468 of the full schema file (push_subscriptions,
-- notification_log, pg_cron + pg_net extension enables, and the
-- queue-due-reminders schedule).
--
-- This file is safe to re-run (all DDL is `if not exists` or wrapped
-- in drop/replace, the cron schedule is dropped before re-scheduled).
--
-- After running this, also execute the two GUC sets (one-shot, not
-- stored in schema) — see push-test/setup-gucs.sql.
-- ---------------------------------------------------------------------------

create table if not exists push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);
alter table push_subscriptions enable row level security;
drop policy if exists "push_subscriptions: own rows" on push_subscriptions;
create policy "push_subscriptions: own rows" on push_subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists notification_log (
  task_id    uuid not null,
  user_id    uuid not null,
  tier       text not null check (tier in ('3d','1d','1h')),
  sent_at    timestamptz,
  created_at timestamptz not null default now(),
  primary key (task_id, tier),
  foreign key (task_id) references tasks(id) on delete cascade
);
alter table notification_log enable row level security;
drop policy if exists "notification_log: read own" on notification_log;
create policy "notification_log: read own" on notification_log
  for select using (user_id = auth.uid());
create index if not exists notification_log_unsent_idx
  on notification_log (sent_at) where sent_at is null;

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  perform cron.unschedule('queue-due-reminders');
exception
  when others then
    null;
end $$;
select cron.schedule(
  'queue-due-reminders',
  '7 * * * *',
  $cron$
    with target_times as (
      select
        t.id, t.user_id, t.title, t.due_date, t.due_time,
        ((t.due_date::timestamp) + coalesce(t.due_time, time '00:00'))
          at time zone 'UTC' as due_at
      from tasks t
      where t.completed_at is null
    ),
    hits as (
      select id, user_id, '3d' as tier
        from target_times
        where due_at - now() between interval '69 hours' and interval '75 hours'
      union all
      select id, user_id, '1d' as tier
        from target_times
        where due_at - now() between interval '21 hours' and interval '27 hours'
      union all
      select id, user_id, '1h' as tier
        from target_times
        where due_time is not null
          and due_at - now() between interval '55 minutes' and interval '65 minutes'
    )
    insert into notification_log (task_id, user_id, tier)
      select h.id, h.user_id, h.tier from hits h
      on conflict (task_id, tier) do nothing;

    do $$
    declare
      send_push_url text := nullif(current_setting('app.send_push_url', true), '');
      send_push_key text := nullif(current_setting('app.send_push_key', true), '');
    begin
      if send_push_url is null or send_push_key is null then
        raise notice 'Skipping send-push call: app.send_push_url or app.send_push_key is not configured';
      else
        perform net.http_post(
          url     := send_push_url,
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || send_push_key
          ),
          body    := '{}'::jsonb
        );
      end if;
    end $$;
  $cron$
);

-- Force PostgREST to pick up the new tables immediately, instead of
-- making the user wait for the ~30s schema-cache TTL. Without this,
-- the first call from the browser/PostgREST gets "could not find
-- the table 'public.push_subscriptions' in the schema cache".
NOTIFY pgrst, 'reload schema';

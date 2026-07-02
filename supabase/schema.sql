-- Homework tracker schema
-- Run this in the Supabase SQL Editor (Database -> SQL Editor -> New query).
-- It is safe to re-run: it uses `if not exists` where it can. The trigger
-- function is created with `create or replace`.

-- ---------------------------------------------------------------------------
-- Subjects (per user)
-- ---------------------------------------------------------------------------
create table if not exists subjects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  name        text not null,
  color       text,
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------
do $$ begin
  create type quadrant as enum ('do_first', 'schedule', 'delegate', 'eliminate');
exception
  when duplicate_object then null;
end $$;

create table if not exists tasks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade not null,
  title         text not null,
  description   text,
  subject_id    uuid references subjects(id) on delete set null,
  due_date      date,
  quadrant      quadrant not null,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Per-task workflow status (Not started / In progress / Ready to submit /
-- Submitted). Stored as text (not enum) so future values can be added
-- without a migration. The CHECK constraint below keeps the value space
-- closed at the database layer; the client enum in src/types.ts mirrors
-- these four values. `not_started` is the default so rows that pre-date
-- this column read back with a sensible value automatically.
-- ---------------------------------------------------------------------------
alter table tasks
  add column if not exists status text not null default 'not_started';

-- Optional due time of day. time without timezone so the user enters
-- and reads it in their local time, matching how due_date works.
-- The HTML <input type="time"> sends 'HH:MM' which Postgres coerces to
-- 'HH:MM:SS' on the way in; we read it back as 'HH:MM:SS' over PostgREST.
alter table tasks
  add column if not exists due_time time;

-- CHECK constraint: drop + re-add so re-running the schema is a no-op
-- if the constraint already exists with the right definition.
alter table tasks drop constraint if exists tasks_status_check;
alter table tasks
  add constraint tasks_status_check
  check (status in ('not_started','in_progress','ready_to_submit','submitted'));

create index if not exists tasks_user_quadrant
  on tasks (user_id, quadrant, completed_at);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tasks_set_updated_at on tasks;
create trigger tasks_set_updated_at
  before update on tasks
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table subjects enable row level security;
alter table tasks    enable row level security;

drop policy if exists "subjects: own rows" on subjects;
create policy "subjects: own rows" on subjects
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "tasks: own rows" on tasks;
create policy "tasks: own rows" on tasks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Realtime (so the UI updates live if you edit from the Supabase dashboard).
-- Wrapped in a DO block so re-running the schema is a no-op — Postgres
-- has no `add table if not member`, so without this guard the second
-- run fails with `42710: relation "..." is already member of publication`.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'subjects'
  ) then
    alter publication supabase_realtime add table subjects;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table tasks;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Profiles (per user) — stores the username shown in the dashboard header
-- and used for "username or email" sign-in. The email itself stays in
-- auth.users; this table is just a username -> user_id map.
-- ---------------------------------------------------------------------------
create extension if not exists citext;

create table if not exists profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  -- citext makes uniqueness case-insensitive ("Alice" and "alice" collide).
  -- This column is the canonical lookup key — sign-in by username and
  -- the email_for_username RPC both match against the lowercased value.
  username   citext not null unique,
  created_at timestamptz not null default now()
);

-- display_username was added in a later migration. `create table if
-- not exists` is a no-op for an existing table, so we add the column
-- separately with `if not exists` so re-running the schema upgrades
-- older projects without erroring out.
alter table profiles
  add column if not exists display_username text;

-- Comment to document the column on the database side. `if not exists`
-- isn't supported for `comment on column`, but it's also idempotent in
-- practice — re-running just rewrites the comment to the same text.
comment on column profiles.display_username is
  'Case-preserving copy of username, used only for display in the UI header. Sign-in / uniqueness checks still go through `username` (citext).';

-- Backfill display_username for any rows that predate the column. Run
-- before the trigger rewrite below so the trigger is the only path that
-- ever sets these fields after this point.
update profiles
  set display_username = username
  where display_username is null;

alter table profiles enable row level security;

drop policy if exists "profiles: own row" on profiles;
create policy "profiles: own row" on profiles
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Public read so the sign-in screen can render "username already taken"
-- errors during signup. The RPC below is the only path that exposes an
-- email to anonymous callers, and only for the single matched row.
drop policy if exists "profiles: public read" on profiles;
create policy "profiles: public read" on profiles
  for select using (true);

-- ---------------------------------------------------------------------------
-- username -> email lookup (used by the sign-in form when the user types
-- a username instead of an email). Security definer so it can read
-- auth.users, and the only field it returns is the email.
-- ---------------------------------------------------------------------------
create or replace function public.email_for_username(p_username text)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select u.email
  from auth.users u
  join public.profiles p on p.user_id = u.id
  where p.username = lower(p_username)
  limit 1;
$$;

revoke all on function public.email_for_username(text) from public;
grant execute on function public.email_for_username(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Trigger: copy the username from auth.users.raw_user_meta_data into
-- profiles the moment a user is created (i.e. on signup confirmation).
-- The signup form passes the username via signUp({ options: { data } }).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_username text := new.raw_user_meta_data->>'username';
begin
  -- Skip the profile insert for anonymous users (signInAnonymously).
  -- They have no username, and `profiles.username` is NOT NULL, so
  -- an insert would fail and block the auth.users insert. Anonymous
  -- users never get a profiles row — their tasks / subjects still
  -- belong to them via the auth.uid() RLS check, and they can
  -- upgrade to a real account via Settings → Upgrade account,
  -- which calls supabase.auth.updateUser() to attach an email +
  -- password. The upgrade path inserts the profile row separately
  -- (see handle_user_upgrade() below).
  if raw_username is null or raw_username = '' then
    return new;
  end if;

  -- Insert with the case-preserving form into `display_username` and
  -- the lowercased form into `username` (citext, uniqueness key).
  -- on conflict (user_id) do nothing so re-running the trigger or
  -- backfilling doesn't clobber an existing row.
  insert into public.profiles (user_id, username, display_username)
  values (new.id, lower(raw_username), raw_username)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Account self-deletion (Settings → Delete account).
-- SECURITY DEFINER so the function can touch auth.users — clients don't
-- have direct access to that table. The auth.users -> profiles /
-- subjects / tasks cascades are already in place, so a single delete
-- wipes the account, the username, every subject, and every task.
-- The function is granted only to `authenticated`; `anon` is intentionally
-- excluded so a public caller can never delete anyone.
-- ---------------------------------------------------------------------------
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;

-- ---------------------------------------------------------------------------
-- Manual drag-and-drop order within a quadrant. Null = sort by
-- created_at desc (the prior default). Sparse per (user, quadrant) —
-- any gap between two rows means a card was just created and hasn't
-- been touched; the client backfills on the next reorder.
-- ---------------------------------------------------------------------------
alter table tasks add column if not exists sort_order integer;
create index if not exists tasks_user_quadrant_sort
  on tasks (user_id, quadrant, sort_order);

-- ---------------------------------------------------------------------------
-- User's preferred sort mode for their tasks. Defaults to due-date so
-- existing users keep their current behavior. Validated by the client
-- — the column is `text` (not an enum) so we can add modes without a
-- migration.
-- ---------------------------------------------------------------------------
alter table profiles
  add column if not exists task_sort_mode text not null default 'due_date';

-- ---------------------------------------------------------------------------
-- Bulk reorder (drag-and-drop). One round-trip per affected quadrant;
-- the function rewrites every row's sort_order in a single transaction
-- so partial failures can't leave the list half-sorted. SECURITY DEFINER
-- so the client doesn't need a per-row UPDATE grant.
--
-- p_ids is the final display order, top to bottom. Indices are 1-based
-- (Postgres array convention); we write sort_order = i-1 so the column
-- is 0-based for the client. The function also writes quadrant =
-- p_quadrant for every id — this is what makes cross-quadrant drops
-- persist: the card whose quadrant is changing gets its new quadrant
-- in the destination RPC, so a separate updateTask isn't needed.
-- The `where` clause only filters on user_id (not quadrant), because
-- for the card moving from one quadrant to another the old filter
-- would silently update zero rows. The user_id filter plus the
-- `forbidden` auth check above already gate access; RLS is the
-- second line of defense. Rows that don't match (wrong user) are
-- silently skipped — the update just affects 0 rows for them.
-- ---------------------------------------------------------------------------
create or replace function public.reorder_tasks(
  p_user     uuid,
  p_quadrant quadrant,
  p_ids      uuid[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  i int;
begin
  -- Auth check: only the owner may reorder their tasks. RLS would also
  -- gate this, but failing fast here gives the client a clear error.
  if auth.uid() is null or auth.uid() <> p_user then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for i in 1..array_length(p_ids, 1) loop
    update public.tasks
       set sort_order = i - 1,
           quadrant   = p_quadrant
     where id = p_ids[i]
       and user_id = p_user;
  end loop;
end;
$$;

revoke all on function public.reorder_tasks(uuid, quadrant, uuid[]) from public;
grant execute on function public.reorder_tasks(uuid, quadrant, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Tell PostgREST to reload its schema cache. Adding a column doesn't
-- auto-refresh PostgREST's introspection, so without this the REST API
-- keeps returning "could not find column in schema cache" until the
-- cache TTL expires (or until the project restarts). `notify pgrst`
-- is the official Supabase-documented way to nudge it.
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Push subscriptions — stores Web Push subscription objects per user.
-- One row per (user_id, endpoint) pair; endpoint is globally unique
-- because each browser/device produces a distinct push endpoint URL.
-- ---------------------------------------------------------------------------
create table if not exists push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete cascade not null,
  endpoint     text not null unique,
  p256dh       text not null,   -- client public key (base64url)
  auth_key     text not null,   -- client auth secret (base64url)
  created_at   timestamptz not null default now()
);

alter table push_subscriptions enable row level security;

-- Users can only read/write their own subscriptions
create policy if not exists "push_subscriptions: owner select"
  on push_subscriptions for select using (auth.uid() = user_id);
create policy if not exists "push_subscriptions: owner insert"
  on push_subscriptions for insert with check (auth.uid() = user_id);
create policy if not exists "push_subscriptions: owner delete"
  on push_subscriptions for delete using (auth.uid() = user_id);

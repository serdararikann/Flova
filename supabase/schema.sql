-- =====================================================================================================
-- FLOVA AUDIO STUDIO - SUPABASE SCHEMA
--
-- Run in Supabase Dashboard > SQL Editor, the whole file at once. Safe to run again: existing rows are copied
-- to the `flova_backup` schema first, then the tables are rebuilt.
--
-- Model (shared by the web app and the mobile app):
--   flova_profiles        one row per user (created by a trigger on sign-up)
--   flova_assets          every audio file in storage, once per user (deduplicated by sha256); derived files
--                         (stems, denoised audio) point at their source with a recipe, so they can be reused
--   flova_projects        a project is a small JSON document (`state`): asset references + edit list + effects,
--                         not rendered audio. `revision` gives optimistic concurrency between devices
--   flova_project_assets  which assets a project uses (storage accounting, safe cleanup of unused files)
--   flova_presets         user presets (EQ, effects, mastering, export, converter), optionally public
--
-- Storage: bucket `flova-media` is private; objects live under `<user id>/...` and each user can only touch
-- their own folder.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 0. Back up whatever exists, then remove the old tables
-- -----------------------------------------------------------------------------------------------------
create schema if not exists flova_backup;
revoke all on schema flova_backup from public, anon, authenticated;

do $$
declare
  t text;
  stamp text := to_char(now(), 'YYYYMMDD_HH24MISS');
begin
  foreach t in array array['flova_profiles', 'flova_projects', 'flova_presets', 'flova_assets', 'flova_project_assets'] loop
    if to_regclass('public.' || t) is not null then
      execute format('create table flova_backup.%I as table public.%I', t || '_' || stamp, t);
    end if;
  end loop;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists on_auth_user_created_flova on auth.users; -- an earlier sign-up trigger
drop table if exists public.flova_project_assets, public.flova_projects, public.flova_assets, public.flova_presets cascade;

-- Profiles are rebuilt below; keep the old rows (with `tier`) in a temp table to restore them.
do $$
begin
  drop table if exists pg_temp.old_profiles;
  if to_regclass('public.flova_profiles') is not null then
    create temp table old_profiles as select * from public.flova_profiles;
  else
    create temp table old_profiles (id uuid, display_name text, tier text);
  end if;
end $$;
drop table if exists public.flova_profiles cascade;

-- -----------------------------------------------------------------------------------------------------
-- 1. Helpers
-- -----------------------------------------------------------------------------------------------------
create or replace function public.flova_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- -----------------------------------------------------------------------------------------------------
-- 2. Profiles
-- -----------------------------------------------------------------------------------------------------
create table public.flova_profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  display_name       text check (char_length(display_name) <= 60),
  avatar_url         text check (char_length(avatar_url) <= 500),
  -- Written only by the server / database (see the column grants below), never by the user.
  tier               text not null default 'free' check (tier in ('free', 'pro', 'studio')),
  storage_used_bytes bigint not null default 0 check (storage_used_bytes >= 0),
  -- Preferences that follow the user between devices (theme, transfer format, export defaults...).
  settings           jsonb not null default '{}'::jsonb check (octet_length(settings::text) <= 16384),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger flova_profiles_touch before update on public.flova_profiles
  for each row execute function public.flova_touch_updated_at();

-- Every new user gets a profile.
create or replace function public.flova_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.flova_profiles (id, display_name)
  values (
    new.id,
    left(coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)), 60)
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.flova_handle_new_user();

-- Profiles for the users that already exist (keeping their old name and tier where there was one).
insert into public.flova_profiles (id, display_name)
select u.id, left(coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), split_part(u.email, '@', 1)), 60)
from auth.users u
on conflict (id) do nothing;

do $$
begin
  update public.flova_profiles p
  set display_name = coalesce(nullif(o.display_name, ''), p.display_name),
      tier = case when o.tier in ('free', 'pro', 'studio') then o.tier else p.tier end
  from old_profiles o
  where o.id = p.id;
exception when undefined_column then null; -- the old table had no display_name / tier
end $$;

-- -----------------------------------------------------------------------------------------------------
-- 3. Assets (audio files in storage)
-- -----------------------------------------------------------------------------------------------------
create table public.flova_assets (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sha256           text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage          text not null default 'supabase' check (storage in ('supabase', 'r2')),
  storage_key      text not null check (storage_key like user_id::text || '/%'),
  mime             text not null check (mime like 'audio/%'),
  bytes            bigint not null check (bytes > 0),
  duration_seconds real check (duration_seconds >= 0),
  sample_rate      integer check (sample_rate > 0),
  channels         smallint check (channels between 1 and 8),
  title            text check (char_length(title) <= 200),
  -- Where it came from: a file the user added, a YouTube video (origin_ref = video id), or a server result.
  origin           text not null default 'upload' check (origin in ('upload', 'youtube', 'derived')),
  origin_ref       text check (char_length(origin_ref) <= 200),
  -- Derived files: the source and how they were made (e.g. 'demucs:4s:vocals', 'denoise:0.8'), so the same
  -- separation of the same song can be reused instead of running again.
  source_asset_id  uuid references public.flova_assets (id) on delete cascade,
  recipe           text check (char_length(recipe) <= 100),
  created_at       timestamptz not null default now(),
  unique (user_id, sha256),
  check ((origin = 'derived') = (source_asset_id is not null and recipe is not null))
);

create index flova_assets_derived_idx on public.flova_assets (source_asset_id, recipe);

-- Keeps profiles.storage_used_bytes up to date.
create or replace function public.flova_track_storage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.flova_profiles set storage_used_bytes = storage_used_bytes + new.bytes where id = new.user_id;
  elsif tg_op = 'DELETE' then
    update public.flova_profiles set storage_used_bytes = greatest(0, storage_used_bytes - old.bytes) where id = old.user_id;
  end if;
  return null;
end $$;

create trigger flova_assets_storage after insert or delete on public.flova_assets
  for each row execute function public.flova_track_storage();

-- -----------------------------------------------------------------------------------------------------
-- 4. Projects
-- -----------------------------------------------------------------------------------------------------
create table public.flova_projects (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind             text not null default 'editor' check (kind in ('editor', 'merger', 'vocal', 'stems')),
  title            text not null default 'Adsız Proje' check (char_length(title) between 1 and 120),
  description      text not null default '' check (char_length(description) <= 2000),
  -- Asset references, edit list, effects, selection, markers, lyrics... (format described by format_version).
  state            jsonb not null default '{}'::jsonb check (octet_length(state::text) <= 2000000),
  format_version   integer not null default 1 check (format_version > 0),
  -- Raised by the database on every update. Save with `... where id = $1 and revision = <last seen>`:
  -- no row updated means another device changed the project in the meantime.
  revision         bigint not null default 1,
  -- ~100 peak values for the waveform thumbnail in the project list.
  preview          jsonb check (octet_length(preview::text) <= 16384),
  duration_seconds real not null default 0 check (duration_seconds >= 0),
  sample_rate      integer check (sample_rate > 0),
  bpm              real check (bpm > 0),
  is_favorite      boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Deleted projects stay as tombstones (and in a trash) so the deletion reaches the other devices.
  deleted_at       timestamptz
);

create index flova_projects_user_idx on public.flova_projects (user_id, updated_at desc);

create or replace function public.flova_projects_bump()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.revision := old.revision + 1;
  new.updated_at := now();
  new.created_at := old.created_at;
  new.user_id := old.user_id;
  return new;
end $$;

create trigger flova_projects_bump before update on public.flova_projects
  for each row execute function public.flova_projects_bump();

create table public.flova_project_assets (
  project_id uuid not null references public.flova_projects (id) on delete cascade,
  -- A file can't be deleted while a project uses it.
  asset_id   uuid not null references public.flova_assets (id) on delete restrict,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  primary key (project_id, asset_id)
);

create index flova_project_assets_asset_idx on public.flova_project_assets (asset_id);

-- -----------------------------------------------------------------------------------------------------
-- 5. Presets
-- -----------------------------------------------------------------------------------------------------
create table public.flova_presets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  category   text not null check (category in ('eq', 'effects', 'mastering', 'export', 'convert')),
  settings   jsonb not null check (octet_length(settings::text) <= 16384),
  is_public  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index flova_presets_user_idx on public.flova_presets (user_id, category);
create index flova_presets_public_idx on public.flova_presets (category) where is_public;

create trigger flova_presets_touch before update on public.flova_presets
  for each row execute function public.flova_touch_updated_at();

-- -----------------------------------------------------------------------------------------------------
-- 6. Privileges: nothing for anonymous visitors; signed-in users only the columns they may write
-- -----------------------------------------------------------------------------------------------------
revoke all on public.flova_profiles, public.flova_assets, public.flova_projects, public.flova_project_assets, public.flova_presets from anon, authenticated;

grant select on public.flova_profiles to authenticated;
grant update (display_name, avatar_url, settings) on public.flova_profiles to authenticated; -- not tier / storage

grant select, delete on public.flova_assets to authenticated;
grant insert (sha256, storage, storage_key, mime, bytes, duration_seconds, sample_rate, channels, title, origin, origin_ref, source_asset_id, recipe)
  on public.flova_assets to authenticated;
grant update (title) on public.flova_assets to authenticated;

grant select, insert, delete on public.flova_projects to authenticated;
grant update (kind, title, description, state, format_version, preview, duration_seconds, sample_rate, bpm, is_favorite, deleted_at)
  on public.flova_projects to authenticated;

grant select, insert, delete on public.flova_project_assets to authenticated;

grant select, insert, delete on public.flova_presets to authenticated;
grant update (name, category, settings, is_public) on public.flova_presets to authenticated;

revoke execute on function public.flova_handle_new_user(), public.flova_track_storage() from public, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 7. Row level security: every row belongs to its user
-- -----------------------------------------------------------------------------------------------------
alter table public.flova_profiles enable row level security;
alter table public.flova_assets enable row level security;
alter table public.flova_projects enable row level security;
alter table public.flova_project_assets enable row level security;
alter table public.flova_presets enable row level security;

create policy "own profile: read" on public.flova_profiles for select to authenticated
  using (id = (select auth.uid()));
create policy "own profile: update" on public.flova_profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "own assets: read" on public.flova_assets for select to authenticated
  using (user_id = (select auth.uid()));
-- Checking the source asset inside the policy would query flova_assets under its own policy (infinite recursion),
-- so it goes through a function that reads the table directly.
create or replace function public.flova_owns_asset(asset uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.flova_assets where id = asset and user_id = auth.uid())
$$;
revoke execute on function public.flova_owns_asset(uuid) from public, anon;
grant execute on function public.flova_owns_asset(uuid) to authenticated;

create policy "own assets: add" on public.flova_assets for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (source_asset_id is null or public.flova_owns_asset(source_asset_id))
  );
create policy "own assets: rename" on public.flova_assets for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own assets: delete" on public.flova_assets for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "own projects: read" on public.flova_projects for select to authenticated
  using (user_id = (select auth.uid()));
create policy "own projects: add" on public.flova_projects for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "own projects: update" on public.flova_projects for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own projects: delete" on public.flova_projects for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "own project assets: read" on public.flova_project_assets for select to authenticated
  using (user_id = (select auth.uid()));
create policy "own project assets: link" on public.flova_project_assets for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.flova_projects p where p.id = project_id and p.user_id = (select auth.uid()))
    and exists (select 1 from public.flova_assets a where a.id = asset_id and a.user_id = (select auth.uid()))
  );
create policy "own project assets: unlink" on public.flova_project_assets for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "presets: own or public" on public.flova_presets for select to authenticated
  using (is_public or user_id = (select auth.uid()));
create policy "own presets: add" on public.flova_presets for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "own presets: update" on public.flova_presets for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own presets: delete" on public.flova_presets for delete to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------------------------------
-- 7b. Trash and cleanup
-- -----------------------------------------------------------------------------------------------------
--
-- A deleted project stays in the trash (deleted_at) for 30 days, where it can be restored. flova_purge() removes
-- the caller's projects that have been in the trash longer than that, and returns the caller's audio files that no
-- project uses any more; the app and the site then delete each file's row and its object in the flova-media bucket.
-- Files added in the last hour are left alone: a save registers a file just before it links it to its project.

create or replace function public.flova_purge(trash_days integer default 30)
returns table (asset_id uuid, asset_key text, asset_bytes bigint)
language plpgsql
security invoker
set search_path = ''
as $
begin
  delete from public.flova_projects p
   where p.user_id = (select auth.uid())
     and p.deleted_at is not null
     and p.deleted_at < now() - make_interval(days => greatest(trash_days, 0));

  return query
    select a.id, a.storage_key, a.bytes
      from public.flova_assets a
     where a.user_id = (select auth.uid())
       and a.created_at < now() - interval '1 hour'
       and not exists (select 1 from public.flova_project_assets l where l.asset_id = a.id);
end $;

revoke execute on function public.flova_purge(integer) from public, anon;
grant execute on function public.flova_purge(integer) to authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 8. Storage: private bucket, audio only, 50 MB per file (the free plan's limit), one folder per user
-- -----------------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('flova-media', 'flova-media', false, 52428800, array['audio/*'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Remove the earlier rules for this bucket (one of them let anonymous visitors list every user's files).
do $$
declare
  p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (coalesce(qual, '') like '%flova-media%' or coalesce(with_check, '') like '%flova-media%')
  loop
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;
end $$;

create policy "flova-media: read own folder" on storage.objects for select to authenticated
  using (bucket_id = 'flova-media' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "flova-media: upload to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'flova-media' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "flova-media: replace in own folder" on storage.objects for update to authenticated
  using (bucket_id = 'flova-media' and (storage.foldername(name))[1] = (select auth.uid()::text))
  with check (bucket_id = 'flova-media' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "flova-media: delete in own folder" on storage.objects for delete to authenticated
  using (bucket_id = 'flova-media' and (storage.foldername(name))[1] = (select auth.uid()::text));

-- -----------------------------------------------------------------------------------------------------
-- 9. Checks to run afterwards (separately): every table should show relrowsecurity = true; the storage list
--    must show no other rule that opens `objects` to everyone (e.g. qual = 'true'); auth.users should only
--    have the triggers you expect.
-- -----------------------------------------------------------------------------------------------------
-- select relname, relrowsecurity from pg_class where relname like 'flova\_%' and relkind = 'r';
-- select policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'storage' and tablename = 'objects';
-- select tgname, tgfoid::regproc from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;

-- Trash and storage cleanup. Run once in the SQL editor (also included in schema.sql).
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
as $$
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
end $$;

revoke execute on function public.flova_purge(integer) from public, anon;
grant execute on function public.flova_purge(integer) to authenticated;

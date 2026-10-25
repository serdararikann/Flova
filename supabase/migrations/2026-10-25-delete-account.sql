-- Account deletion (Google Play requires it in the app and on the web). Run once in the SQL editor (also in schema.sql).
--
-- The app and the site first delete the caller's files in the flova-media bucket through the Storage API (storage
-- objects can't be deleted with SQL), then call flova_delete_account(), which removes the caller's rows and their
-- auth user. Rows are deleted explicitly, links first, because flova_project_assets → flova_assets is "on delete
-- restrict".

create or replace function public.flova_delete_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  delete from public.flova_project_assets where user_id = uid;
  delete from public.flova_projects where user_id = uid;
  delete from public.flova_presets where user_id = uid;
  delete from public.flova_assets where user_id = uid;
  delete from public.flova_profiles where id = uid;
  delete from auth.users where id = uid;
end $$;

revoke execute on function public.flova_delete_account() from public, anon;
grant execute on function public.flova_delete_account() to authenticated;

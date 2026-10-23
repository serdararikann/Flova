-- Fix: "infinite recursion detected in policy for relation flova_assets" when adding an asset.
-- The insert policy checked the source asset with a subquery on flova_assets itself; that check now goes through a
-- security definer function. (Already included in schema.sql; run this once on a database set up before the fix.)

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

drop policy if exists "own assets: add" on public.flova_assets;
create policy "own assets: add" on public.flova_assets for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (source_asset_id is null or public.flova_owns_asset(source_asset_id))
  );

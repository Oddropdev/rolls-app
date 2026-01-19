-- 0005_day5_pick_and_saved.sql
-- Day 5: Pick endpoint support + Saved toggle RPC (safe, append-only)

-- 1) Public function: get_game_by_slug (safe allowlist projection)
create or replace function public.get_game_by_slug(p_slug text)
returns table (
  id uuid,
  slug text,
  title text,
  promoted boolean
)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select g.id, g.slug, g.title, g.promoted
  from public.games g
  where g.slug = p_slug
  limit 1
$$;

revoke all on function public.get_game_by_slug(text) from anon, authenticated;
grant execute on function public.get_game_by_slug(text) to anon, authenticated;

-- 2) Helper: current saved state for a user/game (derived from events)
-- Rule: last event among ('save','unsave') wins.
create or replace function public.is_game_saved(p_user uuid, p_game uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select (ui.event_type = 'save')
    from public.user_interactions ui
    where ui.user_id = p_user
      and ui.game_id = p_game
      and ui.event_type in ('save','unsave')
    order by ui.created_at desc, ui.id desc
    limit 1
  ), false)
$$;

revoke all on function public.is_game_saved(uuid, uuid) from anon, authenticated;

-- 3) RPC: set_saved(game_id, saved) -> writes save/unsave via log_interaction
-- This keeps client from hand-crafting event payload types later if you want stricter UX semantics.
create or replace function public.set_saved(p_game_id uuid, p_saved boolean, p_event_uuid uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
  v_event_type text;
  v_ok jsonb;
begin
  v_user := auth.uid();
  if v_user is null then
    return jsonb_build_object('ok', false);
  end if;

  if p_game_id is null or p_event_uuid is null then
    return jsonb_build_object('ok', false);
  end if;

  v_event_type := case when p_saved then 'save' else 'unsave' end;

  -- Reuse Day 4 intake; it already does allowlist + idempotency + shadowban
  v_ok := public.log_interaction(p_event_uuid, v_event_type, p_game_id, jsonb_build_object('surface','pick'));
  return v_ok;
exception
  when others then
    return jsonb_build_object('ok', false);
end;
$$;

revoke all on function public.set_saved(uuid, boolean, uuid) from anon, authenticated;
grant execute on function public.set_saved(uuid, boolean, uuid) to authenticated;

-- 4) RPC: get_pick(slug) returns allowlisted projection + saved boolean (for authenticated)
create or replace function public.get_pick(p_slug text)
returns table (
  id uuid,
  slug text,
  title text,
  promoted boolean,
  saved boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
begin
  return query
  select
    g.id, g.slug, g.title, g.promoted,
    case when v_user is null then false else public.is_game_saved(v_user, g.id) end as saved
  from public.games g
  where g.slug = p_slug
  limit 1;
end;
$$;

revoke all on function public.get_pick(text) from anon, authenticated;
grant execute on function public.get_pick(text) to anon, authenticated;

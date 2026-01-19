-- 0006_day6_saved_list_and_privacy.sql
-- Day 6: Saved list RPC (no raw events) + privacy guard

-- 1) Indexes to make saved derivation fast
create index if not exists user_interactions_user_game_time_idx
on public.user_interactions (user_id, game_id, created_at desc, id desc)
where event_type in ('save','unsave');

-- 2) Helper: latest save state per game for current user
-- Returns one row per game that has at least one save/unsave event,
-- with last event deciding saved flag and saved_at timestamp.
create or replace function public.get_saved_state()
returns table (
  game_id uuid,
  saved boolean,
  saved_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with last_events as (
    select distinct on (ui.game_id)
      ui.game_id,
      ui.event_type,
      ui.created_at
    from public.user_interactions ui
    where ui.user_id = auth.uid()
      and ui.event_type in ('save','unsave')
      and ui.game_id is not null
    order by ui.game_id, ui.created_at desc, ui.id desc
  )
  select
    game_id,
    (event_type = 'save') as saved,
    case when event_type = 'save' then created_at else null end as saved_at
  from last_events
$$;

revoke all on function public.get_saved_state() from anon, authenticated;
grant execute on function public.get_saved_state() to authenticated;

-- 3) Saved list RPC: returns ONLY saved games (allowlisted projection)
-- Cursor/ordering: newest saved first
create or replace function public.get_saved(p_limit int default 50)
returns table (
  id uuid,
  slug text,
  title text,
  promoted boolean,
  saved_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    g.id, g.slug, g.title, g.promoted,
    s.saved_at
  from public.get_saved_state() s
  join public.games g on g.id = s.game_id
  where s.saved = true
  order by s.saved_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 50), 200))
$$;

revoke all on function public.get_saved(int) from anon, authenticated;
grant execute on function public.get_saved(int) to authenticated;

-- 4) Privacy guard: never allow arbitrary meta to persist even if some path bypasses sanitize.
-- This trigger enforces "meta must be exactly sanitize_interaction_meta(meta)".
create or replace function public.enforce_sanitized_meta()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- normalize
  new.meta := public.sanitize_interaction_meta(new.meta);
  return new;
end;
$$;

revoke all on function public.enforce_sanitized_meta() from anon, authenticated;

drop trigger if exists trg_enforce_sanitized_meta on public.user_interactions;
create trigger trg_enforce_sanitized_meta
before insert on public.user_interactions
for each row
execute function public.enforce_sanitized_meta();

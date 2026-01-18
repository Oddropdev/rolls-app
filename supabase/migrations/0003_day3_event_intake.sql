-- 0003_day3_event_intake.sql
-- Day 3: event intake RPC (idempotent, allowlisted, no reason leaks)

-- 1) (Optional but recommended) constrain event_type values (allowlist)
-- You can expand this list later.
do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname='public' and t.typname='interaction_event_type'
  ) then
    create type public.interaction_event_type as enum (
      'card_shown',
      'swipe_left',
      'swipe_right',
      'save',
      'unsave',
      'clickout'
    );
  end if;
end $$;

-- If you want to enforce enum at column level later:
-- alter table public.user_interactions alter column event_type type public.interaction_event_type using event_type::public.interaction_event_type;

-- 2) Helper: sanitize meta (allowlist keys + size limits)
create or replace function public.sanitize_interaction_meta(p_meta jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  m jsonb := coalesce(p_meta, '{}'::jsonb);
  out jsonb := '{}'::jsonb;
begin
  -- Allowlist keys only. Keep minimal / no PII.
  -- Add keys later as needed.
  if jsonb_typeof(m) <> 'object' then
    return '{}'::jsonb;
  end if;

  if m ? 'cadence_bucket' then
    out := out || jsonb_build_object('cadence_bucket', m->'cadence_bucket');
  end if;

  if m ? 'ttfa_bucket' then
    out := out || jsonb_build_object('ttfa_bucket', m->'ttfa_bucket');
  end if;

  if m ? 'surface' then
    out := out || jsonb_build_object('surface', m->'surface');
  end if;

  -- Hard cap: prevent huge payloads
  if length(out::text) > 1000 then
    return '{}'::jsonb;
  end if;

  return out;
end;
$$;

revoke all on function public.sanitize_interaction_meta(jsonb) from anon, authenticated;

-- 3) RPC: log_interaction (idempotent insert, generic responses)
create or replace function public.log_interaction(
  p_event_uuid uuid,
  p_event_type text,
  p_game_id uuid default null,
  p_meta jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
  v_disabled boolean := false;
  v_meta jsonb;
begin
  v_user := auth.uid();
  if v_user is null then
    return jsonb_build_object('ok', false);
  end if;

  -- Kill switch
  select coalesce((value->>'disabled')::boolean, false)
    into v_disabled
  from public.runtime_config
  where key = 'disable_event_intake';

  if v_disabled then
    return jsonb_build_object('ok', false);
  end if;

  -- Required invariants
  if p_event_uuid is null then
    return jsonb_build_object('ok', false);
  end if;

  if p_event_type is null or length(p_event_type) < 1 or length(p_event_type) > 40 then
    return jsonb_build_object('ok', false);
  end if;

  -- Allowlist event_type (string-based for now; you can switch to enum later)
  if p_event_type not in ('card_shown','swipe_left','swipe_right','save','unsave','clickout') then
    return jsonb_build_object('ok', false);
  end if;

  v_meta := public.sanitize_interaction_meta(p_meta);

  insert into public.user_interactions (user_id, event_uuid, event_type, game_id, meta)
  values (v_user, p_event_uuid, p_event_type, p_game_id, v_meta)
  on conflict (user_id, event_uuid) do nothing;

  -- Generic success
  return jsonb_build_object('ok', true);
exception
  when others then
    -- Generic fail (no reason leaks)
    return jsonb_build_object('ok', false);
end;
$$;

revoke all on function public.log_interaction(uuid, text, uuid, jsonb) from anon, authenticated;
grant execute on function public.log_interaction(uuid, text, uuid, jsonb) to authenticated;

-- 4) Lock down direct client inserts to user_interactions (optional now, recommended now)
-- Client should use RPC only from Day 3 onward.
revoke insert on public.user_interactions from authenticated;

-- Keep select for authenticated (RLS still applies). If you want to keep select:
grant select on public.user_interactions to authenticated;

-- 5) Make sure sequence usage isn't needed for client anymore (harmless to keep, but can revoke)
-- revoke usage, select on sequence public.user_interactions_id_seq from authenticated;

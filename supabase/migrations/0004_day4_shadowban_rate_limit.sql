-- 0004_day4_shadowban_rate_limit.sql
-- Day 4: shadowban rate limit (silent discard) + minimal abuse counters

-- 1) Counter table (no PII beyond user_id)
create table if not exists public.interaction_rate_counters (
  user_id uuid not null,
  window_start timestamptz not null, -- minute bucket
  cnt integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, window_start)
);

alter table public.interaction_rate_counters enable row level security;
alter table public.interaction_rate_counters force row level security;

-- No client access
revoke all on public.interaction_rate_counters from anon, authenticated;

-- 2) Helper: floor timestamp to minute
create or replace function public.floor_minute(ts timestamptz)
returns timestamptz
language sql
immutable
as $$
  select date_trunc('minute', ts)
$$;

revoke all on function public.floor_minute(timestamptz) from anon, authenticated;

-- 3) Helper: increment counter and return new count (atomic-ish via upsert)
create or replace function public.bump_rate_counter(p_user uuid, p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bucket timestamptz := public.floor_minute(p_now);
  v_cnt integer;
begin
  insert into public.interaction_rate_counters(user_id, window_start, cnt)
  values (p_user, v_bucket, 1)
  on conflict (user_id, window_start)
  do update set cnt = public.interaction_rate_counters.cnt + 1,
                updated_at = now()
  returning cnt into v_cnt;

  return v_cnt;
exception
  when others then
    -- If counter fails, don't break user flow; treat as "low count"
    return 0;
end;
$$;

revoke all on function public.bump_rate_counter(uuid, timestamptz) from anon, authenticated;

-- 4) Update log_interaction(): add silent discard rate limit
-- Convention:
-- runtime_config key='event_intake_rate_limit', value={"per_minute": 60}
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
  v_limit int := 60;
  v_cnt int := 0;
begin
  v_user := auth.uid();
  if v_user is null then
    -- keep generic; caller will see ok:false for unauth
    return jsonb_build_object('ok', false);
  end if;

  -- Kill switch (from Day 3)
  select coalesce((value->>'disabled')::boolean, false)
    into v_disabled
  from public.runtime_config
  where key = 'disable_event_intake';

  if v_disabled then
    return jsonb_build_object('ok', false);
  end if;

  -- Rate limit config (silent discard)
  select coalesce((value->>'per_minute')::int, 60)
    into v_limit
  from public.runtime_config
  where key = 'event_intake_rate_limit';

  -- Required invariants
  if p_event_uuid is null then
    return jsonb_build_object('ok', false);
  end if;

  if p_event_type is null or length(p_event_type) < 1 or length(p_event_type) > 40 then
    return jsonb_build_object('ok', false);
  end if;

  -- Allowlist
  if p_event_type not in ('card_shown','swipe_left','swipe_right','save','unsave','clickout') then
    return jsonb_build_object('ok', false);
  end if;

  -- Bump counter first (counts attempts, even if dropped)
  v_cnt := public.bump_rate_counter(v_user, now());

  -- If over limit, silently discard DB write but respond ok:true
  if v_limit is not null and v_limit > 0 and v_cnt > v_limit then
    return jsonb_build_object('ok', true);
  end if;

  v_meta := public.sanitize_interaction_meta(p_meta);

  insert into public.user_interactions (user_id, event_uuid, event_type, game_id, meta)
  values (v_user, p_event_uuid, p_event_type, p_game_id, v_meta)
  on conflict (user_id, event_uuid) do nothing;

  return jsonb_build_object('ok', true);
exception
  when others then
    -- No reason leaks: return generic success? or ok:false?
    -- For Day 4 shadowban profile, we keep ok:true to avoid teaching signals.
    return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.log_interaction(uuid, text, uuid, jsonb) from anon, authenticated;
grant execute on function public.log_interaction(uuid, text, uuid, jsonb) to authenticated;

-- 5) Default config (optional): set 60/min if not present
insert into public.runtime_config(key, value)
values ('event_intake_rate_limit', jsonb_build_object('per_minute', 60))
on conflict (key) do nothing;

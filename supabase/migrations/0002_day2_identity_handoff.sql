-- 0002_day2_identity_handoff.sql
-- Day 2: Identity Handoff (atomic redeem + merge)
-- Preconditions:
-- - auth_transfer_codes has RLS enabled + FORCE RLS
-- - user_interactions has RLS enabled (NO FORCE) so SECURITY DEFINER can merge
-- - anon/authenticated have NO direct privileges to auth_transfer_codes

-- 1) helper: base64url encode (for nice transfer codes)
create or replace function public.base64url(b bytea)
returns text
language sql
immutable
as $$
  select rtrim(translate(encode(b, 'base64'), '+/', '-_'), '=')
$$;

revoke all on function public.base64url(bytea) from anon, authenticated;

-- 2) audit table (recommended)
create table if not exists public.identity_merge_audit (
  id bigint generated always as identity primary key,
  source_user_id uuid not null,
  target_user_id uuid not null,
  transfer_code_id bigint,
  merged_at timestamptz not null default now()
);

alter table public.identity_merge_audit enable row level security;
alter table public.identity_merge_audit force row level security;

revoke all on public.identity_merge_audit from anon, authenticated;

-- 3) create_transfer_code(): returns plaintext code ONCE, stores only sha256 hash
-- Kill switch convention:
-- runtime_config row: key='disable_transfer_codes', value={"disabled": true}
create or replace function public.create_transfer_code()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_hash bytea;
  v_expires timestamptz := now() + interval '5 minutes';
  v_disabled boolean := false;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false);
  end if;

  select coalesce((value->>'disabled')::boolean, false)
    into v_disabled
  from public.runtime_config
  where key = 'disable_transfer_codes';

  if v_disabled then
    return jsonb_build_object('ok', false);
  end if;

 v_code := public.base64url(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'));

  v_hash := decode(md5(v_code), 'hex');

  insert into public.auth_transfer_codes (code_hash, source_anon_user_id, expires_at)
  values (v_hash, auth.uid(), v_expires);

  return jsonb_build_object('ok', true, 'code', v_code, 'expires_at', v_expires);
exception
  when others then
    return jsonb_build_object('ok', false);
end;
$$;

revoke all on function public.create_transfer_code() from anon, authenticated;
grant execute on function public.create_transfer_code() to authenticated;

-- 4) redeem_transfer_code(code): atomic claim + merge
create or replace function public.redeem_transfer_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target uuid;
  v_hash bytea;
  v_claim record;
  v_disabled boolean := false;
begin
  v_target := auth.uid();
  if v_target is null then
    return jsonb_build_object('ok', false);
  end if;

  if p_code is null or length(p_code) < 10 or length(p_code) > 200 then
    return jsonb_build_object('ok', false);
  end if;

  select coalesce((value->>'disabled')::boolean, false)
    into v_disabled
  from public.runtime_config
  where key = 'disable_transfer_codes';

  if v_disabled then
    return jsonb_build_object('ok', false);
  end if;

  v_hash := decode(md5(p_code), 'hex');


  -- Atomic claim: only one redeem can win
  update public.auth_transfer_codes
     set redeemed_at = now(),
         target_user_id = v_target
   where code_hash = v_hash
     and redeemed_at is null
     and expires_at > now()
  returning id, source_anon_user_id
    into v_claim;

  if v_claim is null then
    return jsonb_build_object('ok', false);
  end if;

  if v_claim.source_anon_user_id = v_target then
    return jsonb_build_object('ok', true);
  end if;

  -- Merge interactions: copy source -> target, idempotent on (user_id, event_uuid)
  insert into public.user_interactions (user_id, event_uuid, event_type, game_id, meta, created_at)
  select
    v_target,
    ui.event_uuid,
    ui.event_type,
    ui.game_id,
    ui.meta,
    ui.created_at
  from public.user_interactions ui
  where ui.user_id = v_claim.source_anon_user_id
  on conflict (user_id, event_uuid) do nothing;

  -- Cleanup source after successful copy
  delete from public.user_interactions
  where user_id = v_claim.source_anon_user_id;

  -- Audit (best-effort)
  insert into public.identity_merge_audit (source_user_id, target_user_id, transfer_code_id)
values (v_claim.source_anon_user_id, v_target, v_claim.id)
on conflict (source_user_id, target_user_id) do nothing;

  return jsonb_build_object('ok', true);
exception
  when others then
    return jsonb_build_object('ok', false);
end;
$$;

revoke all on function public.redeem_transfer_code(text) from anon, authenticated;
grant execute on function public.redeem_transfer_code(text) to authenticated;

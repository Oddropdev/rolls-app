-- 0001_day1_fort_knox.sql

-- 0) EXTENSIONS
create extension if not exists pgcrypto;

-- 1) GAMES
create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null,
  affiliate_link text,
  promoted boolean not null default false,
  created_at timestamptz not null default now()
);

-- 2) TAGS
create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  label text not null
);

-- 3) GAME_TAGS
create table if not exists public.game_tags (
  game_id uuid not null references public.games(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (game_id, tag_id)
);

-- 4) USER_INTERACTIONS (append-only)
create table if not exists public.user_interactions (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  event_uuid uuid not null,
  event_type text not null,
  game_id uuid references public.games(id),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint user_interactions_event_uuid_uniq unique (user_id, event_uuid)
);

-- 5) AUTH_TRANSFER_CODES (sensitive)
create table if not exists public.auth_transfer_codes (
  id bigint generated always as identity primary key,
  code_hash bytea not null unique,
  source_anon_user_id uuid not null,
  target_user_id uuid,
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists auth_transfer_codes_expires_idx on public.auth_transfer_codes (expires_at);
create index if not exists auth_transfer_codes_redeemed_idx on public.auth_transfer_codes (redeemed_at);

-- 6) NONCES (anti-replay)
create table if not exists public.nonces (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  nonce text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint nonces_user_nonce_uniq unique (user_id, nonce)
);
create index if not exists nonces_expires_idx on public.nonces (expires_at);

-- 7) RUNTIME_CONFIG (kill switches)
create table if not exists public.runtime_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- 8) RLS ENABLE
alter table public.games enable row level security;
alter table public.tags enable row level security;
alter table public.game_tags enable row level security;
alter table public.user_interactions enable row level security;
alter table public.auth_transfer_codes enable row level security;
alter table public.nonces enable row level security;
alter table public.runtime_config enable row level security;

-- FORCE RLS: only on sensitive tables that never need controlled bypass
alter table public.auth_transfer_codes force row level security;
alter table public.nonces force row level security;
alter table public.runtime_config force row level security;

-- IMPORTANT: allow controlled bypass for Day 2 merge
alter table public.user_interactions no force row level security;

-- 9) POLICIES (idempotent drop/create)
drop policy if exists games_select_public on public.games;
create policy games_select_public
on public.games for select
to anon, authenticated
using (true);

drop policy if exists tags_select_public on public.tags;
create policy tags_select_public
on public.tags for select
to anon, authenticated
using (true);

drop policy if exists game_tags_select_public on public.game_tags;
create policy game_tags_select_public
on public.game_tags for select
to anon, authenticated
using (true);

drop policy if exists user_interactions_select_own on public.user_interactions;
create policy user_interactions_select_own
on public.user_interactions for select
to authenticated
using (user_id = auth.uid());

drop policy if exists user_interactions_insert_own on public.user_interactions;
create policy user_interactions_insert_own
on public.user_interactions for insert
to authenticated
with check (
  user_id = auth.uid()
  and event_uuid is not null
  and length(event_type) > 0
);

-- 10) PRIVILEGES (clean room)
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.games to anon, authenticated;
grant select on public.tags to anon, authenticated;
grant select on public.game_tags to anon, authenticated;

grant select, insert on public.user_interactions to authenticated;
grant usage, select on sequence public.user_interactions_id_seq to authenticated;

-- 11) SCHEMA LOCKDOWN
revoke create on schema public from public;

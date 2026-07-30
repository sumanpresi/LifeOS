-- ============================================================
-- LifeOS v0.2 — Supabase setup
-- Run this once in your Supabase project's SQL Editor.
-- ============================================================

-- One row per user; the whole LifeOS state is stored as JSON.
create table if not exists public.lifeos_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Row Level Security: each user can only ever touch their own row.
alter table public.lifeos_data enable row level security;

create policy "select own data" on public.lifeos_data
  for select using (auth.uid() = user_id);

create policy "insert own data" on public.lifeos_data
  for insert with check (auth.uid() = user_id);

create policy "update own data" on public.lifeos_data
  for update using (auth.uid() = user_id);

-- Enable live cross-device sync (Realtime).
alter publication supabase_realtime add table public.lifeos_data;

-- ============================================================
-- Google Calendar sync (added later — see /api/google-oauth-callback.js
-- and /api/google-calendar-sync.js). One row per user, holding the
-- long-lived Google refresh token needed to mint short-lived access
-- tokens for Calendar API calls. This table has RLS enabled but NO
-- policies defined for the anon/authenticated roles — meaning it is
-- reachable ONLY via the Supabase service-role key, which the two
-- serverless functions use, and which is never exposed to the browser.
-- The client never reads or writes this table directly.
-- ============================================================
create table if not exists public.google_calendar_tokens (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  updated_at    timestamptz not null default now()
);
alter table public.google_calendar_tokens enable row level security;
-- Deliberately no policies here — service-role access bypasses RLS
-- entirely, and that's the only access path this table should ever have.

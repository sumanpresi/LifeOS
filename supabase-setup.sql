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

-- ============================================================
-- LifeOS — per-section cloud storage (run ONCE, after supabase-setup.sql)
--
-- Paste this whole file into Supabase → SQL Editor → Run.
-- Safe to run more than once. Nothing existing is deleted or altered:
-- `lifeos_data` keeps its row; from now on it holds a small "head"
-- (a list of section fingerprints) instead of the whole document.
--
-- Why: the whole LifeOS document used to travel on every save and on
-- every pull (~650 KB compressed). With this, a save sends only the
-- sections that changed (e.g. just `tasks`), and a pull downloads only
-- the sections this device doesn't already hold.
--
-- Until this file has been run, the app keeps working exactly as before
-- (it detects the missing functions and falls back to whole-document
-- sync), so there is no ordering problem between deploying and running.
-- ============================================================

create table if not exists public.lifeos_sections (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  key        text        not null,           -- top-level key of the LifeOS document, e.g. 'tasks'
  hash       text        not null,           -- fingerprint of the section's JSON
  enc        text        not null default 'json' check (enc in ('json', 'gz')),
  body       text        not null,           -- JSON text, or base64 gzip of it when enc = 'gz'
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.lifeos_sections enable row level security;

drop policy if exists "select own sections" on public.lifeos_sections;
drop policy if exists "insert own sections" on public.lifeos_sections;
drop policy if exists "update own sections" on public.lifeos_sections;
drop policy if exists "delete own sections" on public.lifeos_sections;
create policy "select own sections" on public.lifeos_sections
  for select using (auth.uid() = user_id);
create policy "insert own sections" on public.lifeos_sections
  for insert with check (auth.uid() = user_id);
create policy "update own sections" on public.lifeos_sections
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own sections" on public.lifeos_sections
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- PULL: the head plus only the sections whose fingerprint differs
-- from what the caller already holds (p_have = { key: hash }).
-- One request, one consistent view: FOR SHARE waits for an in-flight
-- push to finish, so the head and the sections always match.
-- If the row is still in the old whole-document format it is returned
-- as-is, so the caller can handle both layouts with one call.
-- ------------------------------------------------------------
create or replace function public.lifeos_pull(p_have jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_row  public.lifeos_data%rowtype;
  v_secs jsonb;
begin
  if v_uid is null then
    raise exception 'lifeos_pull: not signed in' using errcode = '28000';
  end if;

  select * into v_row from public.lifeos_data where user_id = v_uid for share;
  if not found then
    return null;
  end if;

  if (v_row.data ->> '_layout') is distinct from 'lifeos-sections-v1' then
    return jsonb_build_object('updated_at', v_row.updated_at, 'data', v_row.data, 'sections', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('key', s.key, 'hash', s.hash, 'enc', s.enc, 'body', s.body)), '[]'::jsonb)
    into v_secs
    from public.lifeos_sections s
   where s.user_id = v_uid
     and (v_row.data -> 'm') ? s.key
     and s.hash is distinct from (coalesce(p_have, '{}'::jsonb) ->> s.key);

  return jsonb_build_object('updated_at', v_row.updated_at, 'data', v_row.data, 'sections', v_secs);
end
$$;

-- ------------------------------------------------------------
-- PUSH: write the changed sections and the new head in ONE transaction,
-- but only if the cloud is still at the version the caller last merged
-- (p_base). If another device saved in between, nothing is written and
-- the caller is told to pull and merge first — so one device can no
-- longer silently overwrite another device's newer save.
-- ------------------------------------------------------------
create or replace function public.lifeos_push(
  p_base     timestamptz,
  p_stamp    timestamptz,
  p_head     jsonb,
  p_sections jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_cur     timestamptz;
  v_missing integer;
begin
  if v_uid is null then
    raise exception 'lifeos_push: not signed in' using errcode = '28000';
  end if;
  if p_stamp is null or p_head is null
     or (p_head ->> '_layout') is distinct from 'lifeos-sections-v1'
     or jsonb_typeof(p_head -> 'm') is distinct from 'object' then
    raise exception 'lifeos_push: invalid head' using errcode = '22023';
  end if;

  select updated_at into v_cur from public.lifeos_data where user_id = v_uid for update;
  if found and (p_base is null
                or date_trunc('milliseconds', v_cur) <> date_trunc('milliseconds', p_base)) then
    return jsonb_build_object('ok', false, 'conflict', true, 'updated_at', v_cur);
  end if;

  insert into public.lifeos_sections as s (user_id, key, hash, enc, body, updated_at)
  select v_uid, e.key, e.value ->> 'hash', coalesce(e.value ->> 'enc', 'json'), e.value ->> 'body', p_stamp
    from jsonb_each(coalesce(p_sections, '{}'::jsonb)) e
  on conflict (user_id, key) do update
     set hash = excluded.hash, enc = excluded.enc, body = excluded.body, updated_at = excluded.updated_at;

  delete from public.lifeos_sections s
   where s.user_id = v_uid and not ((p_head -> 'm') ? s.key);

  -- Every section the head names must now exist with that exact
  -- fingerprint. If the caller assumed the cloud already had one it
  -- doesn't, refuse (everything above rolls back) and let it resend.
  select count(*) into v_missing
    from jsonb_each_text(p_head -> 'm') m
    left join public.lifeos_sections s on s.user_id = v_uid and s.key = m.key
   where s.hash is distinct from m.value;
  if v_missing > 0 then
    raise exception 'lifeos_push: % section(s) missing for this head', v_missing
      using errcode = 'P0001', hint = 'resend all sections';
  end if;

  insert into public.lifeos_data (user_id, data, updated_at)
  values (v_uid, p_head, p_stamp)
  on conflict (user_id) do update set data = excluded.data, updated_at = excluded.updated_at;

  return jsonb_build_object('ok', true, 'updated_at', p_stamp);
end
$$;

revoke all on function public.lifeos_pull(jsonb) from public, anon;
revoke all on function public.lifeos_push(timestamptz, timestamptz, jsonb, jsonb) from public, anon;
grant execute on function public.lifeos_pull(jsonb) to authenticated;
grant execute on function public.lifeos_push(timestamptz, timestamptz, jsonb, jsonb) to authenticated;
grant select, insert, update, delete on public.lifeos_sections to authenticated;

-- Ask the API layer to pick up the two new functions straight away.
notify pgrst, 'reload schema';

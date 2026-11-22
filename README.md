# LifeOS v0.3

A personal operating system: daily planner, habit tracker, goals, meditation,
GSI workspace, universal search — with GitHub sign-in and live cloud sync.

## Structure
```
index.html          — layout & pages
css/style.css       — all styling
js/config.js        — ← the ONLY file you edit (Supabase URL + anon key)
js/state.js         — data model, defaults, persistence
js/ui.js            — navigation, toasts, header, sync pill
js/tasks.js         — Top 5 tasks
js/goals.js         — goal progress
js/habits.js        — habit tracker, streaks, weekly view, donut
js/widgets.js       — links, news, quotes, meditation, Day Of + journal
js/sections.js      — generic life spaces (Communication, Finance, …)
js/gsi.js                   — GSI workspace (NGDR tracker, work log, meetings)
js/search.js                — universal search (Ctrl/Cmd + K)
js/supabase.js               — GitHub auth, database sync, realtime
js/communication-bridge.js  — postMessage bridge: routes Communication's data
                               through shared state + Supabase while its UI
                               stays isolated in its own iframe (see below)
js/app.js                   — boot / wiring
pages/communication.html    — Communication module: own CSS/JS/DOM (avoids
                               id/class clashes with the rest of LifeOS), but
                               its data flows through the bridge above, so it
                               saves locally + syncs via Supabase like every
                               other module, and shows up in universal search
js/cloud-sections.js        — per-section cloud transport (split / fingerprint / reassemble)
supabase-setup.sql          — run once in Supabase SQL Editor
supabase-sections.sql       — run once after it: per-section sync (see below)
tools/release.mjs           — stamps every ?v= cache-buster; run before each upload
tests/sync.test.mjs         — end-to-end sync tests against a real Postgres
```

## Run locally
ES modules need a server (not file://):
```
python -m http.server 8000
# open http://localhost:8000
```

## Deploy free (GitHub Pages)
1. Push this folder to a GitHub repo.
2. Repo → Settings → Pages → Deploy from branch → main → / (root).
3. Your site: https://YOURNAME.github.io/REPO/

## Cloud sync setup (once, ~10 min, free)
1. Create a project at supabase.com.
2. SQL Editor → run `supabase-setup.sql`.
3. GitHub → Settings → Developer settings → OAuth Apps → New.
   Callback URL: `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
4. Supabase → Authentication → Providers → GitHub → paste Client ID + Secret.
5. Supabase → Authentication → URL Configuration → set your Pages URL as Site URL.
6. Edit `js/config.js` with your project URL and anon key. Push. Done.
7. SQL Editor → run `supabase-sections.sql` (safe to re-run).

## Keeping inside the free tiers
- **Per-section sync.** The document is stored as one small head row in
  `lifeos_data` plus one row per top-level section in `lifeos_sections`.
  A save sends only the sections that changed; a pull downloads only the
  sections this device doesn't already hold. Saves are conditional
  (`lifeos_push` refuses if another device saved first), so one device
  can no longer silently overwrite another's newer save. Until
  `supabase-sections.sql` has been run the app falls back to
  whole-document sync automatically.
- **Idle tabs cost a timestamp.** Polls and realtime only fetch
  `updated_at`; documents move only when something changed.
- **Static files are cached for a year.** Every `/js` and `/css` request
  carries `?v=<fingerprint>` and is served `immutable`, so a page load
  makes ~2 requests to Vercel instead of ~65. This is only safe because
  the fingerprint is computed from the files themselves:

  ```
  node tools/release.mjs          # after ANY change to index.html, js/ or css/
  node tools/release.mjs --check  # fails if a ?v= is stale or missing
  ```
- **No scheduled server job.** The Google Calendar catch-up runs on the
  device, once a day, after the first sync.

## Tests
```
# needs a local Postgres (any 14+) and: npm install --no-save jsdom@26 pg@8
LIFEOS_TEST_PG='postgresql://postgres@localhost:5433/postgres?host=/tmp/pg' node tests/sync.test.mjs
# optional: compare egress with an older checkout
node tests/sync.test.mjs --baseline /path/to/old/checkout
```

Without config, LifeOS runs in local-only mode (data stays in the browser).

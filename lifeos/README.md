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
supabase-setup.sql  — run once in Supabase SQL Editor
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

Without config, LifeOS runs in local-only mode (data stays in the browser).

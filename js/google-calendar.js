/* Google Calendar sync — pushes LifeOS tasks with a due date to Google
   Calendar as all-day events. The heavy lifting (token exchange, token
   refresh, the actual Calendar API calls) all happens in
   /api/google-oauth-callback.js and /api/google-calendar-sync.js,
   since those need GOOGLE_CLIENT_SECRET, which must never reach the
   browser. This module only ever does two things: send the user to
   Google's consent screen, and call the two serverless functions.

   Scope of what this does (v1):
   - One-directional: LifeOS tasks -> Google Calendar. A task created,
     edited, completed, or deleted here updates its Calendar event
     accordingly.
   - It does NOT pull changes made directly in Google Calendar back
     into LifeOS — true two-way sync needs either polling Calendar's
     sync tokens or a push-notification webhook, which is a
     substantially bigger follow-up, not included here.
   - Only tasks with a due date sync — tasks without one have nothing
     to put on a calendar.
   - "Ongoing" beyond the app being open is handled by
     api/google-calendar-cron.js on a schedule (see vercel.json) —
     without that, sync would only ever happen at the moment you're
     actively using LifeOS. */
import { GOOGLE_CLIENT_ID } from './config.js?v=202609041800';
import { state, persist } from './state.js?v=202609041800';
import { toast } from './ui.js?v=202609041800';
import { getAccessToken } from './supabase.js?v=202609041800';

let warnedThisSession = false; // see syncTaskToGoogle — one toast per session for Google-side rejections
const REDIRECT_URI = () => location.origin + location.pathname;
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

export function googleCalendarConfigured() {
  return !!GOOGLE_CLIENT_ID;
}

export function connectGoogleCalendar() {
  if (!googleCalendarConfigured()) {
    toast("Google Calendar isn't configured yet — see js/config.js");
    return;
  }
  const state_param = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
  sessionStorage.setItem("gcal_oauth_state", state_param);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("access_type", "offline"); // needed to get a refresh_token, not just a short-lived access_token
  url.searchParams.set("prompt", "consent");       // forces a refresh_token on EVERY connect, not just the very first ever — otherwise reconnecting after a revoke would silently get none
  url.searchParams.set("state", state_param);
  location.href = url.toString();
}

// Local-only display flag — whether the *last known* connect attempt
// succeeded. The real source of truth (the refresh token) lives only
// server-side; this just drives the UI without a round trip on every
// page load. If a sync call later reports the connection is dead
// (revoked/expired), this gets cleared and the UI reflects that.
export function isGoogleCalendarConnected() {
  return !!state.googleCalendarConnected;
}

export async function handleGoogleCalendarCallback() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const returnedState = params.get("state");
  if (!code) return; // not a callback landing — nothing to do
  history.replaceState(null, "", location.pathname); // strip the code/state out of the URL either way, so a refresh can't replay it

  const expectedState = sessionStorage.getItem("gcal_oauth_state");
  sessionStorage.removeItem("gcal_oauth_state");
  if (!expectedState || returnedState !== expectedState) {
    toast("Google Calendar connection failed — please try again");
    return;
  }

  const token = await getAccessToken();
  if (!token) { toast("Sign in to LifeOS first, then connect Google Calendar"); return; }

  try {
    const res = await fetch("/api/google-oauth-callback", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code, redirectUri: REDIRECT_URI() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Unknown error");
    state.googleCalendarConnected = true;
    persist(false); // connection status is local UI state, not content — same reasoning as which tab/section is open elsewhere in the app
    toast("Google Calendar connected");
    renderGoogleCalendarStatus();
  } catch (e) {
    toast("Google Calendar connection failed: " + e.message);
  }
}

export function disconnectGoogleCalendar() {
  // This only forgets the connection on LifeOS's side. It does not
  // revoke the stored refresh token server-side or delete it from
  // Supabase — a small gap, called out rather than silently left
  // implemented halfway. To fully revoke, remove access from
  // https://myaccount.google.com/permissions as well.
  state.googleCalendarConnected = false;
  persist(false);
  toast("Disconnected. To fully revoke access, also remove LifeOS at myaccount.google.com/permissions");
  renderGoogleCalendarStatus();
}
export function renderGoogleCalendarStatus() {
  const connectBtn = document.getElementById("gcalConnectBtn");
  const disconnectBtn = document.getElementById("gcalDisconnectBtn");
  const syncNowBtn = document.getElementById("gcalSyncNowBtn");
  const statusEl = document.getElementById("gcalStatus");
  if (!connectBtn || !disconnectBtn || !statusEl) return;
  const connected = isGoogleCalendarConnected();
  connectBtn.style.display = connected ? "none" : "";
  disconnectBtn.style.display = connected ? "" : "none";
  if (syncNowBtn) syncNowBtn.style.display = connected ? "" : "none";
  if (!googleCalendarConfigured()) statusEl.textContent = "Not configured yet — see js/config.js";
  else statusEl.textContent = connected
    ? "Connected — tasks with a due date sync automatically"
    : "Tasks with a due date can sync as calendar events";
}

// Called from tasks.js whenever a due-dated task is created, edited,
// completed, un-completed, or deleted. Fire-and-forget from the
// caller's perspective — this updates task.googleEventId itself once
// the server responds, rather than making every call site in tasks.js
// juggle that.
export async function syncTaskToGoogle(task, action) {
  if (!isGoogleCalendarConnected()) return;
  if (action !== "delete" && !task.dueDate) return; // nothing to put on a calendar without a date
  if (action === "delete" && !task.googleEventId) return; // never synced — nothing to remove

  const token = await getAccessToken();
  if (!token) return;

  try {
    const res = await fetch("/api/google-calendar-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action,
        task: { text: task.text, dueDate: task.dueDate },
        eventId: task.googleEventId || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409 || res.status === 401) {
        // Not connected (anymore) or the refresh token is dead — reflect that locally instead of silently retrying forever.
        state.googleCalendarConnected = false; persist(false);
        toast("Google Calendar sync stopped: " + data.error);
      } else if (!warnedThisSession) {
        /* Anything else means Google rejected the request itself. This
           used to return silently, which is how a malformed event body
           (all-day events need an exclusive end date — see
           api/google-calendar-sync.js) went unnoticed indefinitely: the
           app looked connected, and not one event was ever created.
           Once per session, so a bad state can't spam every edit. */
        warnedThisSession = true;
        toast("Google Calendar rejected a task: " + (data.error || res.status));
      }
      return;
    }
    if (action === "delete") { task.googleEventId = null; }
    else if (data.eventId) { task.googleEventId = data.eventId; }
    persist();
  } catch (e) {
    // Network error, cron will catch it later — not surfacing every
    // transient failure as a toast, since task edits can be frequent.
  }
}


/* Catch-up sync on demand. The daily cron (api/google-calendar-cron.js)
   does the same job, but once a day on Vercel's Hobby limit — which is a
   long wait when you've just connected, or just fixed something, and want
   to see whether it works. This walks the same candidates the cron does:
   anything with a date, not done, never given a googleEventId. */
export async function syncAllPendingToGoogle() {
  if (!googleCalendarConfigured()) { toast("Google Calendar isn't configured yet — see js/config.js"); return; }
  if (!isGoogleCalendarConnected()) { toast("Connect Google Calendar first"); return; }

  // GSI project tasks use date/status where native tasks use dueDate/done.
  // Shimmed to one shape so syncTaskToGoogle sees what it expects, with
  // the real object kept alongside so googleEventId lands on it.
  const pending = [
    ...(state.tasks || [])
      .filter(t => t.dueDate && !t.done && !t.googleEventId)
      .map(t => ({ ref: t, shim: t })),
    ...((state.gsi?.projects || []).flatMap(p => (p.tasks || [])
      .filter(t => t.date && t.status !== "done" && !t.googleEventId)
      .map(t => ({ ref: t, shim: { text: t.text, dueDate: t.date, googleEventId: null } })))),
  ];
  if (!pending.length) { toast("Nothing left to sync — every dated task already has an event"); return; }

  toast(`Syncing ${pending.length} task${pending.length > 1 ? "s" : ""} to Google Calendar…`);
  let done = 0;
  for (const { ref, shim } of pending) {
    await syncTaskToGoogle(shim, "create");
    if (shim.googleEventId) { ref.googleEventId = shim.googleEventId; done++; }
    if (!isGoogleCalendarConnected()) break; // the connection died mid-run; syncTaskToGoogle has already said so
  }
  persist();
  toast(done === pending.length
    ? `Synced ${done} task${done > 1 ? "s" : ""} to Google Calendar`
    : `Synced ${done} of ${pending.length} — the rest failed`);
}

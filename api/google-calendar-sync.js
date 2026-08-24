/* Creates/updates/deletes ONE Google Calendar event for ONE LifeOS
   task. Called from js/google-calendar.js whenever a due-dated task is
   created, its date/title changes, or it's deleted/completed.

   LifeOS tasks only have a due DATE (no time), so every event created
   here is an all-day event — there's no time-of-day to sync because
   the app doesn't track one.

   Required environment variables — see google-oauth-callback.js for
   the full list; this function additionally needs nothing new.
*/

/* Google's all-day events use an EXCLUSIVE end date: a one-day event on
   16 Oct is start 2026-10-16, end 2026-10-17. Sending the same date for
   both — which this file did — is rejected outright with 400
   "The specified time range is empty" (reason: timeRangeEmpty), so not a
   single event was ever created. Parsed as UTC so the +1 can't be
   shifted by the server's local timezone or a DST boundary. */
function dayAfter(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const SUPABASE_URL = "https://hgsqpvvneudwwfemdirc.supabase.co";

async function getSupabaseUser(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getStoredRefreshToken(userId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/google_calendar_tokens?user_id=eq.${userId}&select=refresh_token`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] ? rows[0].refresh_token : null;
}

async function getFreshAccessToken(refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error === "invalid_grant"
    ? "Google Calendar connection has expired or been revoked — reconnect from LifeOS."
    : (data.error_description || data.error || "Could not refresh Google access token"));
  return data.access_token;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const supabaseToken = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const { action, task, eventId } = req.body || {};
  if (!supabaseToken) return res.status(401).json({ error: "Missing LifeOS session token" });
  if (!["create", "update", "delete"].includes(action)) return res.status(400).json({ error: "action must be create, update, or delete" });

  const user = await getSupabaseUser(supabaseToken);
  if (!user || !user.id) return res.status(401).json({ error: "Invalid or expired LifeOS session" });

  const refreshToken = await getStoredRefreshToken(user.id);
  if (!refreshToken) return res.status(409).json({ error: "Google Calendar isn't connected yet" });

  let accessToken;
  try { accessToken = await getFreshAccessToken(refreshToken); }
  catch (e) { return res.status(401).json({ error: e.message }); }

  const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  const authHeaders = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };

  try {
    if (action === "delete") {
      if (!eventId) return res.status(400).json({ error: "eventId required for delete" });
      const r = await fetch(`${base}/${eventId}`, { method: "DELETE", headers: authHeaders });
      // Google 404s if it's already gone (e.g. deleted directly in Calendar) — treat that as success, not a failure to report.
      if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(`Google Calendar returned ${r.status}`);
      return res.status(200).json({ ok: true });
    }

    if (!task || !task.dueDate) return res.status(400).json({ error: "task with a dueDate is required for create/update" });
    const body = JSON.stringify({
      summary: task.text,
      description: "Synced from LifeOS",
      start: { date: task.dueDate },
      end: { date: dayAfter(task.dueDate) },
    });

    if (action === "create") {
      const r = await fetch(base, { method: "POST", headers: authHeaders, body });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || `Google Calendar returned ${r.status}`);
      return res.status(200).json({ ok: true, eventId: data.id });
    }

    // update
    if (!eventId) return res.status(400).json({ error: "eventId required for update" });
    const r = await fetch(`${base}/${eventId}`, { method: "PATCH", headers: authHeaders, body });
    if (r.status === 404 || r.status === 410) {
      // The event LifeOS thought it owned is gone on Google's side (deleted directly in Calendar) — recreate it instead of failing silently.
      const r2 = await fetch(base, { method: "POST", headers: authHeaders, body });
      const data2 = await r2.json();
      if (!r2.ok) throw new Error(data2.error?.message || `Google Calendar returned ${r2.status}`);
      return res.status(200).json({ ok: true, eventId: data2.id, recreated: true });
    }
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || `Google Calendar returned ${r.status}`);
    return res.status(200).json({ ok: true, eventId: data.id });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};

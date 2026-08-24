/* Scheduled catch-up sync (see vercel.json's "crons" entry).

   The in-app sync in js/google-calendar.js only fires while LifeOS is
   open and a task actually changes — it can't do anything for a
   change made while the browser's closed, or a sync call that failed
   partway. This is the catch-up pass for that gap: it looks for tasks
   with a due date and no googleEventId yet, and creates the missing
   events.

   What this deliberately does NOT do (kept simple on purpose):
   - It doesn't handle edits to a task that already has a
     googleEventId (the in-app sync already covers that in real time),
     and it doesn't delete events for tasks that were completed/removed
     while the app was closed — building a full two-way diff here is a
     meaningfully bigger job than "catch anything that never got its
     first sync." Worth building later if the gap turns out to matter
     in practice.
   - It writes back the whole lifeos_data JSON blob after adding
     googleEventIds, same as the rest of the app already does for
     syncing. If this cron happens to run at the exact moment the user
     is actively editing something else, there's a small chance of a
     race with that save — acceptable for a personal, low-concurrency
     app, but worth knowing about.

   Runs once/day on Vercel's Hobby plan (their hard limit, not a choice
   made here — see vercel.json). On Pro, this could run much more
   often by changing the cron schedule there. */

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
const SR_HEADERS = {
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
};

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
  if (!res.ok) throw new Error(data.error_description || data.error || "refresh failed");
  return data.access_token;
}

module.exports = async (req, res) => {
  // Vercel auto-injects CRON_SECRET and sends it as this header on its
  // own scheduled invocations — checking it stops this (service-role-
  // powered, multi-user-scanning) endpoint from being triggerable by
  // anyone who just requests its URL.
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const tokenRowsRes = await fetch(`${SUPABASE_URL}/rest/v1/google_calendar_tokens?select=user_id,refresh_token`, { headers: SR_HEADERS });
  const tokenRows = tokenRowsRes.ok ? await tokenRowsRes.json() : [];

  const results = [];
  for (const row of tokenRows) {
    try {
      const dataRes = await fetch(`${SUPABASE_URL}/rest/v1/lifeos_data?user_id=eq.${row.user_id}&select=data`, { headers: SR_HEADERS });
      const dataRows = dataRes.ok ? await dataRes.json() : [];
      const lifeos = dataRows[0]?.data;
      if (!lifeos) continue;

      // Native Overview tasks use dueDate/done; GSI project tasks use
      // date/status — normalized to one shape here so the sync loop
      // below doesn't need two near-identical branches. gsiRef lets a
      // synced GSI task's googleEventId be written back to the right
      // place (nested inside a specific project), unlike native tasks
      // which sit directly in the top-level array.
      const candidates = [
        ...(Array.isArray(lifeos.tasks) ? lifeos.tasks.map(t => ({ ref: t, text: t.text, date: t.dueDate, done: !!t.done, googleEventId: t.googleEventId })) : []),
        ...((lifeos.gsi?.projects || []).flatMap(p => (p.tasks || []).map(t =>
          ({ ref: t, text: t.text, date: t.date, done: t.status === "done", googleEventId: t.googleEventId })))),
      ];
      const needsSync = candidates.filter(c => c.date && !c.done && !c.googleEventId);
      if (!needsSync.length) { results.push({ user_id: row.user_id, created: 0 }); continue; }

      const accessToken = await getFreshAccessToken(row.refresh_token);
      let created = 0, failed = 0, firstError = null;
      for (const c of needsSync) {
        const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ summary: c.text, description: "Synced from LifeOS", start: { date: c.date }, end: { date: dayAfter(c.date) } }),
        });
        if (r.ok) { const d = await r.json(); c.ref.googleEventId = d.id; created++; }
        else {
          /* `if (r.ok)` alone meant a request Google rejected left no
             trace anywhere — the run still reported success with a count
             of 0, indistinguishable from "nothing to do". That is how a
             malformed event body went unnoticed for months. */
          failed++;
          if (!firstError) {
            const body = await r.json().catch(() => null);
            firstError = body?.error?.message || `Google Calendar returned ${r.status}`;
          }
        }
      }

      if (created > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/lifeos_data?user_id=eq.${row.user_id}`, {
          method: "PATCH",
          headers: { ...SR_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({ data: lifeos, updated_at: new Date().toISOString() }),
        });
      }
      results.push({ user_id: row.user_id, created, failed, error: firstError });
    } catch (e) {
      results.push({ user_id: row.user_id, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, results });
};

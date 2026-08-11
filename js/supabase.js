/* GitHub sign-in (via Supabase Auth), cloud storage, live sync. */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { state, replaceState, persist, setRemoteSaver, uid, esc, rerender, flushPendingSave } from './state.js';
import { setSyncPill, nowTime, toast } from './ui.js';
import { pushCommunicationUpdate } from './communication-bridge.js';
import { pushNgdrTrackerUpdate } from './ngdr-tracker-bridge.js';
import { mergeBoardData } from './whiteboard.js';

const CLIENT_ID = uid() + uid();
const GH_SVG = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 .5A11.5 11.5 0 0 0 .5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.87-1.54-3.87-1.54-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.26.72-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12v3.14c0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z"/></svg>';

let sb = null, rtChannel = null;
export let user = null;

/* ---------- auth diagnostics ----------
   Sign-in problems have been hard to pin down because they show up on
   phones, where there's no practical way to open a console. This keeps a
   short in-memory log of what auth actually did and renders it inside
   the sign-in modal, so the real reason is visible on the device where
   it's failing rather than inferred from the symptom. */
const authLog = [];
export function authDiag(msg) {
  authLog.push(new Date().toLocaleTimeString() + " · " + msg);
  if (authLog.length > 10) authLog.shift();
  const el = document.getElementById("ghDiag");
  if (el) { el.textContent = authLog.join("\n"); el.style.display = "block"; }
}
/* supabase-js keeps the session in localStorage. If that's unavailable —
   Private Browsing, or "Block All Cookies"/strict tracking prevention on
   iOS Safari — the session is created and then immediately lost on the
   next read, which looks exactly like "signed in for a second, then
   signed out." Worth detecting explicitly rather than guessing. */
function storageWritable() {
  try {
    const k = "__lifeos_probe__";
    localStorage.setItem(k, "1");
    localStorage.removeItem(k);
    return true;
  } catch (e) { return false; }
}
/* Supabase reports OAuth failures back on the URL (in the hash for
   implicit errors, query for others) — surface them instead of letting
   them disappear silently. */
function reportOauthUrlError() {
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.replace(/^#/, ""));
  const err = q.get("error") || h.get("error");
  const desc = q.get("error_description") || h.get("error_description");
  if (err) authDiag("OAuth error from Supabase: " + err + (desc ? " — " + decodeURIComponent(desc) : ""));
  return !!err;
}

export async function getAccessToken() {
  if (!sb) return null;
  try { const { data } = await sb.auth.getSession(); return data?.session?.access_token || null; }
  catch (e) { return null; }
}
export const configured = () =>
  SUPABASE_URL.startsWith("https://") && SUPABASE_ANON_KEY.length > 20;

/* ---------- modal ---------- */
export function openGhModal() {
  document.getElementById("ghModal").classList.add("open");
  document.getElementById("ghErr").style.display = "none";
  const diagEl = document.getElementById("ghDiag");
  if (diagEl && authLog.length) { diagEl.textContent = authLog.join("\n"); diagEl.style.display = "block"; }
  document.getElementById("ghModalSetup").style.display = configured() ? "none" : "block";
  document.getElementById("ghModalSignin").style.display = (configured() && !user) ? "block" : "none";
  document.getElementById("ghModalAccount").style.display = user ? "block" : "none";
  document.getElementById("signInBtn").style.display = (configured() && !user) ? "" : "none";
  document.getElementById("signOutBtn").style.display = user ? "" : "none";
  if (user) {
    const m = user.user_metadata || {};
    document.getElementById("accountInfo").innerHTML =
      "Signed in as <b>" + esc(m.full_name || m.user_name || user.email || "you") + "</b>" +
      (m.user_name ? " (@" + esc(m.user_name) + ")" : "");
  }
}
export function closeGhModal() { document.getElementById("ghModal").classList.remove("open"); }

/* header button: sign in directly when possible, otherwise open the modal */
export function ghButton() {
  if (user || !configured()) openGhModal();
  else signIn();
}

/* ---------- auth ---------- */
export async function signIn() {
  const err = document.getElementById("ghErr");
  if (location.protocol === "file:") {
    openGhModal();
    err.textContent = "GitHub sign-in needs a hosted URL (GitHub Pages / Vercel / local server) — it can't redirect back to a file opened from disk.";
    err.style.display = "block"; return;
  }
  if (!sb) {
    // The Supabase client never finished initializing — most likely its
    // CDN script (supabase-js) was slow, blocked by an ad/script blocker,
    // or briefly unreachable. Try once to set it up now rather than
    // immediately failing with a confusing null-pointer error, since the
    // library may well be available by now even though it wasn't at
    // page load.
    trySetupClient();
    if (!sb) {
      openGhModal();
      err.textContent = window.supabase
        ? "Sync isn't set up yet — check the GSI portal setup instructions."
        : "Couldn't load the sign-in library (Supabase). This is usually a blocked script — check any ad/script blocker for this site, then try again.";
      err.style.display = "block";
      return;
    }
  }
  try {
    const back = location.origin + location.pathname;
    authDiag("starting GitHub sign-in, will return to: " + back);
    await sb.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: back }
    });
  } catch (e) {
    openGhModal();
    err.textContent = "Sign-in failed: " + (e.message || e);
    err.style.display = "block";
  }
}
export async function signOut() {
  try { await sb.auth.signOut(); } catch (e) {}
  closeGhModal();
  toast("Signed out — data stays safe in the cloud");
}

function renderIdentity() {
  const chip = document.getElementById("ghChip");
  const btnT = document.getElementById("ghBtnText");
  if (user) {
    const m = user.user_metadata || {};
    chip.innerHTML = (m.avatar_url ? '<img src="' + esc(m.avatar_url) + '" alt="">' : GH_SVG) +
      '<span><span class="gh-name">' + esc(m.full_name || m.user_name || "Signed in") + '</span><br>' +
      '<span class="gh-sub">@' + esc(m.user_name || "github") + ' · synced</span></span>';
    btnT.textContent = "@" + (m.user_name || "account");
  } else {
    chip.innerHTML = GH_SVG +
      '<span><span class="gh-name">Sign in with GitHub</span><br><span class="gh-sub">Sync across devices</span></span>';
    btnT.textContent = "GitHub Login";
  }
}

/* ---------- database ---------- */
let hasReconciled = false;      // has this session checked the cloud at least once?
let pendingSaveAfterReconcile = false;

/* ---------- deciding who is newer ----------

   This used to be decided by comparing state.updatedAt on each side —
   that is, by comparing two *clock readings taken on different devices*.
   That fails in a way that looks exactly like "sync is broken": if one
   device's clock is even a minute fast, that device's data always looks
   newer, so it never pulls anything down and pushes its own older copy
   up over the good one. Phones and desktops routinely disagree by more
   than that, and nothing about it is visible to the person using it.

   The replacement doesn't consult a clock at all. Two facts are enough:

     • Did I edit anything since the last time I agreed with the cloud?
       (state.rev differs from the rev recorded at that moment)
     • Has the cloud changed since then?
       (its syncToken differs from the one recorded at that moment)

   Only when BOTH are true is there a genuine conflict needing a
   tie-break. In every other case the answer is unambiguous, which is
   what makes "I saved on the computer and the phone won't update"
   impossible rather than merely unlikely. */
const SYNC_META_KEY = "lifeos-sync-meta"; // device-local; deliberately NOT part of synced state
function readSyncMeta() {
  try { return JSON.parse(localStorage.getItem(SYNC_META_KEY)) || {}; }
  catch (e) { return {}; }
}
function writeSyncMeta(meta) {
  try { localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta)); } catch (e) {}
}
function newSyncToken() { return uid() + uid(); }
function agreedWithCloud() { return readSyncMeta().rev !== undefined; }
function hasLocalEdits() {
  const meta = readSyncMeta();
  if (meta.rev === undefined) return true; // never synced — assume local work matters
  return (state.rev || 0) !== meta.rev;
}
function cloudChangedSinceLastSync(remote) {
  const meta = readSyncMeta();
  if (meta.token === undefined) return true;
  return (remote.syncToken || "") !== meta.token;
}
function markAgreed(token) { writeSyncMeta({ rev: state.rev || 0, token: token || "" }); }

/* A wrong device clock no longer breaks syncing, but it still misdates
   entries, so it's worth saying out loud once rather than leaving it to
   be discovered later. */
let skewWarned = false;
function checkClockSkew(serverStampIso) {
  if (skewWarned || !serverStampIso) return;
  const drift = Math.abs(Date.now() - new Date(serverStampIso).getTime());
  if (drift < 5 * 60 * 1000) return;
  skewWarned = true;
  const mins = Math.round(drift / 60000);
  authDiag("this device's clock is about " + mins + " min away from the last save's timestamp");
  toast("This device's clock looks about " + mins + " min off — worth checking date & time settings");
}

// The reconciliation used by both loadRemote() and the realtime
// subscription below resolves conflicts by comparing one timestamp for
// the *entire* saved state — whichever side's overall timestamp is
// newer replaces everything, field by field, discarding the other
// side's version wholesale. For most data that's an acceptable
// simplification, but for whiteboards it silently erased real drawings
// whenever the *other* side happened to be ahead on something
// unrelated. Merging here, before either caller decides a winner,
// means it doesn't matter afterward which side "wins" — board data
// from both is already combined by that point.
function mergeIncomingWhiteboards(remote) {
  const mergedBoards = {};
  Object.keys(Object.assign({}, state.whiteboards, remote.whiteboards)).forEach(boardId => {
    mergedBoards[boardId] = mergeBoardData(state.whiteboards[boardId], remote.whiteboards?.[boardId]);
  });
  state.whiteboards = mergedBoards;
  remote.whiteboards = mergedBoards;
}
// Same reasoning as mergeIncomingWhiteboards above, extended to the
// Brainstorming board's tabs: each tab is merged individually by id,
// reusing the exact same per-board stroke/sticky-note merge a single
// board already uses, instead of letting one device's whole tab list
// wholesale-replace the other's. A tab's own updatedAt decides whose
// name/archived/zoom "wins" when both sides touched it — the content
// (strokes/notes) is combined either way, never dropped.
/* Runs for every tabbed board surface, not just GSI's.
   dayofBoards (the Scratch board) was never passed through here, and
   commBoards would have inherited the same gap: without per-record
   merging those lists fall back to whole-state last-write-wins, so
   drawing on the Scratch board on the phone and again on the laptop
   loses one side's strokes outright instead of combining them. Same
   code, three lists — the keys mirror TAB_SURFACES in whiteboard.js. */
const BOARD_LISTS = [
  { list: "brainstormBoards", active: "activeBrainstormBoard" },
  { list: "dayofBoards",      active: "activeDayofBoard" },
  { list: "commBoards",       active: "activeCommBoard" },
];
function mergeIncomingBoardList(remote, listKey, activeKey) {
  const localBoards = state[listKey] || [];
  const remoteBoards = remote[listKey] || [];
  const byId = new Map();
  localBoards.forEach(b => byId.set(b.id, b));
  remoteBoards.forEach(rb => {
    const lb = byId.get(rb.id);
    if (!lb) { byId.set(rb.id, rb); return; }
    const mergedContent = mergeBoardData(lb, rb);
    const newerMeta = (lb.updatedAt || 0) >= (rb.updatedAt || 0) ? lb : rb;
    byId.set(rb.id, Object.assign({}, newerMeta, mergedContent));
  });
  let mergedBoards = Array.from(byId.values());
  const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // same pruning window as sticky notes
  mergedBoards = mergedBoards.filter(b => !b.deleted || Date.now() - (b.updatedAt || 0) < TOMBSTONE_MAX_AGE_MS);
  state[listKey] = mergedBoards;
  remote[listKey] = mergedBoards;
  if (!mergedBoards.some(b => b.id === state[activeKey] && !b.archived && !b.deleted)) {
    const fallback = mergedBoards.find(b => !b.archived && !b.deleted) || mergedBoards[0];
    if (fallback) state[activeKey] = fallback.id;
  }
}
/* Section notes, merged per note by id rather than letting one device's
   whole list replace the other's.

   Without this, two devices editing DIFFERENT notes in the same section
   still lose one of them: the loser's entire noteList is discarded, not
   just the note that actually clashed. That is far more destructive than
   the conflict warrants, and it is silent.

   Where the SAME note was touched on both sides, the newer `updated`
   wins — the same rule the board tabs use for their metadata. This is
   still last-write-wins at the level of one note's body; merging two
   people's edits inside a single rich-text document needs real operational
   transforms, which is a different project. But the blast radius drops
   from "every note in the section" to "the one note you both had open". */
function mergeIncomingSectionNotes(remote) {
  const keys = new Set([...Object.keys(state.sections || {}), ...Object.keys(remote.sections || {})]);
  remote.sections = remote.sections || {};
  keys.forEach(key => {
    const localSec = state.sections?.[key];
    const remoteSec = remote.sections[key];
    if (!localSec && !remoteSec) return;
    if (!remoteSec) { remote.sections[key] = localSec; return; }
    if (!localSec) return;
    const byId = new Map();
    (localSec.noteList || []).forEach(n => byId.set(n.id, n));
    (remoteSec.noteList || []).forEach(rn => {
      const ln = byId.get(rn.id);
      if (!ln) { byId.set(rn.id, rn); return; }
      byId.set(rn.id, (rn.updated || 0) >= (ln.updated || 0) ? rn : ln);
    });
    /* Remote order first — it is the more recently agreed view — with any
       note this device has that the cloud hasn't seen yet appended. */
    const order = [];
    (remoteSec.noteList || []).forEach(n => order.push(byId.get(n.id)));
    (localSec.noteList || []).forEach(n => { if (!order.includes(byId.get(n.id))) order.push(byId.get(n.id)); });
    remoteSec.noteList = order.filter(Boolean);
    localSec.noteList = remoteSec.noteList;
  });
}

function mergeIncomingBrainstormBoards(remote) {
  BOARD_LISTS.forEach(({ list, active }) => mergeIncomingBoardList(remote, list, active));
}
function applyRemote(remote) {
  const token = remote.syncToken || "";
  replaceState(remote);
  // Recorded after replaceState so it reflects the rev that actually
  // landed — this is the point where this device and the cloud agree.
  markAgreed(token);
  rerender();
  pushCommunicationUpdate();
  pushNgdrTrackerUpdate();
}
export async function loadRemote(preferRemote = false) {
  if (!sb || !user) return;
  setSyncPill("busy", "Syncing…");
  try {
    const { data, error } = await sb.from("lifeos_data")
      .select("data, updated_at").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    if (data && data.data && Object.keys(data.data).length) {
      const remote = data.data;
      checkClockSkew(data.updated_at);
      mergeIncomingWhiteboards(remote);
      mergeIncomingBrainstormBoards(remote);
      mergeIncomingSectionNotes(remote);
      // The merge just changed local state (possibly pulling in board
      // data from the remote side) independent of whatever the win/lose
      // branching below decides — make sure that's actually reflected
      // here, not just in the payload that eventually gets pushed back.
      persist(false); rerender();

      const mine = hasLocalEdits();
      const theirs = cloudChangedSinceLastSync(remote);

      if (preferRemote) { applyRemote(remote); }
      else if (!agreedWithCloud()) {
        /* First run after upgrading, so there's no record of a previous
           agreement to reason from. Fall back to the old timestamp
           comparison this once; from the next successful sync onward the
           clock is out of the picture for good. */
        if ((remote.updatedAt || 0) > (state.updatedAt || 0)) applyRemote(remote);
        else { hasReconciled = true; await saveRemote(); return; }
      }
      else if (!mine && theirs) {
        applyRemote(remote);                       // cloud moved, this device didn't — take it
      }
      else if (mine && !theirs) {
        hasReconciled = true; await saveRemote(); return;  // only this device moved — send it
      }
      else if (mine && theirs) {
        /* Both sides changed since they last agreed. There is no correct
           automatic answer, so take the newer one but say so — silently
           discarding one side is how people lose work without noticing. */
        if ((remote.updatedAt || 0) >= (state.updatedAt || 0)) {
          applyRemote(remote);
          toast("Another device had newer changes — its version is now shown");
        } else {
          hasReconciled = true; await saveRemote();
          toast("This device had newer changes — they've been sent up");
          return;
        }
      }
      // neither side moved: nothing to do
    } else {
      hasReconciled = true; await saveRemote(); return;      /* first device: seed the cloud copy */
    }
    hasReconciled = true;
    if (pendingSaveAfterReconcile) { pendingSaveAfterReconcile = false; await saveRemote(); return; }
    setSyncPill("ok", "Synced · " + nowTime());
  } catch (e) {
    hasReconciled = true; // don't block saves forever over one failed check — the person can retry via Sync
    authDiag("LOAD failed: " + (e.message || e) + (e.code ? " [code " + e.code + "]" : "") + (e.hint ? " — " + e.hint : ""));
    setSyncPill("err", "Sync failed — tap Sync");
  }
}
export async function saveRemote() {
  /* Nothing to send if this device holds exactly what the cloud already
     has. rev is the same counter the reconcile uses, so this is the same
     question ("have I edited since we agreed?") asked before spending an
     upload of the entire document. Without it, a manual Sync press or the
     one-minute poll re-uploads the whole state — whiteboard drawings and
     all — to change nothing. */
  if (agreedWithCloud() && !hasLocalEdits()) {
    setSyncPill("ok", "Synced · " + nowTime());
    return;
  }
  if (!sb || !user) return;
  /* Never push this device's data up before it has checked what's already in
     the cloud — otherwise a stale local copy (e.g. a laptop that's been
     asleep for days) can silently overwrite a newer edit made on another
     device. Queue the save; it fires automatically once loadRemote() has
     run at least once this session. */
  if (!hasReconciled) { pendingSaveAfterReconcile = true; return; }
  setSyncPill("busy", "Saving…");
  try {
    const token = newSyncToken();
    state.syncToken = token; // stored in state so every device sees the same value
    const payload = Object.assign({}, state, { _client: CLIENT_ID });
    const { error } = await sb.from("lifeos_data").upsert({
      user_id: user.id, data: payload, updated_at: new Date().toISOString()
    });
    if (error) throw error;
    markAgreed(token); // this device and the cloud now hold the same thing
    setSyncPill("ok", "Synced · " + nowTime());
  } catch (e) {
    let size = "?";
    try { size = Math.round(JSON.stringify(state).length / 1024) + " KB"; } catch (_) {}
    authDiag("SAVE failed (payload " + size + "): " + (e.message || e) + (e.code ? " [code " + e.code + "]" : "") + (e.hint ? " — " + e.hint : ""));
    setSyncPill("err", "Save failed — tap Sync");
  }
}
export async function syncNow() {
  if (!user) {
    /* The local `user` variable is only populated once onAuthStateChange
       has fired, which can take a moment after page load. Don't assume
       "signed out" from that alone — check Supabase's own session
       directly, since wrongly triggering a fresh sign-in here means a
       real browser redirect to GitHub and back, which resets the page. */
    try {
      const { data } = await sb.auth.getSession();
      if (data && data.session) { user = data.session.user; renderIdentity(); }
    } catch (e) { /* fall through */ }
  }
  if (!user) { ghButton(); return; }
  // Load before save, not the other way around — pushing first would
  // overwrite whatever's in the cloud with this device's own (possibly
  // stale) copy before ever getting a chance to pull down something
  // newer from another device. loadRemote() reconciles first: if the
  // cloud is newer, it's applied locally; if this device is newer, it
  // schedules a save itself. Either way, saveRemote() afterward is a
  // safe no-op or a genuine push of what's actually newest.
  await loadRemote(); await saveRemote();
  toast("Synced");
}

/* ---------- live cross-device updates ---------- */
/* Realtime delivery depends on the lifeos_data table being added to the
   database's realtime publication — a setting in the Supabase dashboard,
   not something this code can switch on. If it was never enabled, the
   subscription below silently delivers nothing forever and cross-device
   updates only ever arrive when a tab is re-focused. Rather than depend
   on a setting that can't be verified from here, poll gently as well:
   once a minute, only while the tab is actually visible, and only when
   this device has nothing unsaved to lose. */
let pollTimer = null;
const POLL_MS = 60_000;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.hidden || !user || !sb) return;
    if (hasLocalEdits()) return; // loadRemote would handle it, but don't interrupt typing
    loadRemote();
  }, POLL_MS);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function startRealtime() {
  stopRealtime();
  startPolling();
  rtChannel = sb.channel("lifeos-" + user.id)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "lifeos_data", filter: "user_id=eq." + user.id },
      payload => {
        const row = payload.new;
        if (!row || !row.data || row.data._client === CLIENT_ID) return;
        if (!cloudChangedSinceLastSync(row.data)) return; // already have it
        if (hasLocalEdits()) {
          // Don't overwrite something being typed right now. loadRemote()
          // handles it properly on the next sync, conflict warning included.
          setSyncPill("busy", "Changes waiting — tap Sync");
          return;
        }
        mergeIncomingWhiteboards(row.data);
        mergeIncomingBrainstormBoards(row.data);
        mergeIncomingSectionNotes(row.data);
        applyRemote(row.data);
        toast("Updated from another device");
      })
    .subscribe(status => {
      // Visible on the device where it's failing — the whole point of
      // authDiag. "CHANNEL_ERROR"/"TIMED_OUT" here means realtime isn't
      // enabled for the table, and the poll above is doing the work.
      authDiag("realtime: " + status);
    });
}
function stopRealtime() {
  stopPolling();
  if (rtChannel && sb) { sb.removeChannel(rtChannel); rtChannel = null; }
}

/* ---------- init ---------- */
function trySetupClient() {
  if (sb || !window.supabase) return; // already set up, or the library genuinely isn't available yet
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  setRemoteSaver(saveRemote);
  sb.auth.onAuthStateChange((event, session) => {
    user = session ? session.user : null;
    authDiag("auth event: " + event + (user ? " (user ok)" : " (no session)"));
    renderIdentity();
    if (user) {
      loadRemote(); startRealtime();
      /* A session that arrives and then disappears a moment later is the
         exact symptom of storage being unavailable — verify it's really
         still there shortly after, and say so plainly if it isn't. */
      setTimeout(async () => {
        try {
          const { data } = await sb.auth.getSession();
          if (!data?.session) {
            authDiag("session vanished right after sign-in — the browser isn't keeping it. Usually Private Browsing, or blocked cookies/storage for this site.");
            setSyncPill("err", "Sign-in didn't stick");
          }
        } catch (e) { authDiag("getSession failed: " + (e.message || e)); }
      }, 2000);
    }
    else { stopRealtime(); hasReconciled = false; pendingSaveAfterReconcile = false; setSyncPill("", "Local only"); }
  });
}
export function initSupabase() {
  renderIdentity();
  document.getElementById("ghModal").addEventListener("click", e => {
    if (e.target.id === "ghModal") closeGhModal();
  });
  if (!configured()) { setSyncPill("", "Local only · set up sync"); return; }
  reportOauthUrlError();
  if (!storageWritable()) {
    authDiag("localStorage is BLOCKED in this browser — a session can't be saved, so sign-in will not stick. Turn off Private Browsing / allow cookies & site data for this site.");
    setSyncPill("err", "Browser storage blocked");
  }
  const finishSetup = () => {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flushPendingSave();
      else if (user) loadRemote();
    });
    /* A second, independent safety net: on some platforms (especially
       mobile) visibilitychange doesn't fire reliably right before an
       actual tab close, but pagehide does. */
    window.addEventListener("pagehide", flushPendingSave);
  };
  trySetupClient();
  if (sb) { finishSetup(); return; }
  // supabase-js (loaded via CDN <script> in <head>, before this module
  // runs) isn't available yet — this shouldn't normally happen since
  // that script is render-blocking, but a slow/flaky CDN response can
  // still land after this point. Retry a few times before actually
  // giving up, rather than failing permanently on one check taken the
  // instant the page loaded.
  let attempts = 0;
  const retry = setInterval(() => {
    attempts++;
    trySetupClient();
    if (sb) { clearInterval(retry); setSyncPill("", "Local only"); finishSetup(); }
    else if (attempts >= 6) { clearInterval(retry); setSyncPill("err", "Couldn't load Supabase library"); }
  }, 500);
}

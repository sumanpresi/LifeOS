/* GitHub sign-in (via Supabase Auth), cloud storage, live sync. */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { state, replaceState, persist, setRemoteSaver, uid, esc, rerender, flushPendingSave } from './state.js';
import { setSyncPill, nowTime, toast, isUserTyping } from './ui.js';
import { pushCommunicationUpdate } from './communication-bridge.js';
import { pushNgdrTrackerUpdate } from './ngdr-tracker-bridge.js';
import { mergeBoardData } from './whiteboard.js';
import { takeSnapshot } from './backup.js';
import { moveToTrash } from './trash.js';
import { hasUnsavedComposerDraft } from './composer.js';
import { flushJournalEditor } from './widgets.js';

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
  if (!err) return false;
  const detail = desc ? decodeURIComponent(desc).replace(/\+/g, " ") : "";
  authDiag("OAuth error from Supabase: " + err + (detail ? " — " + detail : ""));
  /* Previously this only wrote to the in-memory diagnostic log, which is
     hidden unless the modal happens to be opened afterwards. So a failed
     sign-in returned you to a normal-looking page with no indication that
     anything had gone wrong. Show it. */
  setTimeout(() => {
    const box = document.getElementById("ghErr");
    if (!box) return;
    openGhModal();
    box.innerHTML = "GitHub sign-in didn't complete: <b>" + esc(detail || err) + "</b>" +
      "<br><br>If this says the redirect isn't allowed, add <code>" +
      esc(location.origin + location.pathname) + "</code> to <b>Redirect URLs</b> in " +
      "Supabase → Authentication → URL Configuration.";
    box.style.display = "block";
  }, 0);
  return true;
}

/* A leftover #access_token in the address bar is diagnostic gold.

   Supabase's redirect delivers the session as a URL fragment, and
   detectSessionInUrl consumes it and strips it from the address bar. So
   if that fragment is STILL there, the sign-in itself worked perfectly —
   GitHub authorised, Supabase issued a token — and the failure is
   entirely local: the supabase-js library never ran to pick it up.

   It also needs clearing on sight. A URL carrying a bearer token and a
   refresh token is a credential: it sits in history, gets copied into
   chat windows, and is enough for anyone holding it to read the account
   until it expires. */
function handleStrandedAuthFragment() {
  const h = new URLSearchParams((location.hash || "").replace(/^#/, ""));
  if (!h.get("access_token")) return false;
  authDiag("found an unconsumed access_token in the URL — the library never processed it");

  // Strip it immediately, whatever else happens next.
  try {
    history.replaceState(null, "", location.origin + location.pathname + location.search);
  } catch (_) {}

  const box = document.getElementById("ghErr");
  if (box) {
    openGhModal();
    box.innerHTML =
      "<b>Sign-in worked, but this page couldn't finish it.</b>" +
      "<br><br>GitHub authorised you and Supabase issued a session — the address bar came back " +
      "carrying it. But the Supabase library never loaded here, so nothing picked it up." +
      "<br><br>That points at the library being blocked rather than anything wrong with your account: " +
      "check any ad-blocker, script-blocker or strict privacy mode for <code>cdn.jsdelivr.net</code> " +
      "on this site, then reload and sign in once more." +
      "<br><br>The credentials have been cleared from the address bar. If you copied that URL anywhere, " +
      "treat it as a password and sign out of GitHub&rsquo;s authorised apps to invalidate it.";
    box.style.display = "block";
  }
  return true;
}

/* Sign-in bounced you back but you're still signed out. Without this the
   app looks exactly as it did before you clicked — which invites clicking
   again, and repeated authorization attempts are what make GitHub show
   "Reauthorization required / unusually high number of requests". Explain
   it once, and clear the marker so it says so only after a real attempt. */
function checkReturnedWithoutSession() {
  let started = null;
  try { started = sessionStorage.getItem("lifeos-signin-started"); } catch (_) { return; }
  if (!started) return;
  // Only meaningful for a few minutes; a stale marker shouldn't nag.
  if (Date.now() - Number(started) > 5 * 60 * 1000) {
    try { sessionStorage.removeItem("lifeos-signin-started"); } catch (_) {}
    return;
  }
  setTimeout(async () => {
    // initSupabase() can run before the CDN script has finished, so the
    // client may not exist yet. No client means no verdict — leave the
    // marker in place and let a later pass decide.
    if (!sb) return;
    try {
      const { data } = await sb.auth.getSession();
      if (data?.session) { try { sessionStorage.removeItem("lifeos-signin-started"); } catch (_) {} return; }
    } catch (_) {}
    try { sessionStorage.removeItem("lifeos-signin-started"); } catch (_) {}
    const box = document.getElementById("ghErr");
    if (!box) return;
    const here = location.origin + location.pathname;
    authDiag("returned from sign-in with no session at " + here);
    openGhModal();
    box.innerHTML =
      "You came back from GitHub, but no session was created — so you're still signed out." +
      "<br><br><b>Check these two, in order:</b>" +
      "<br>1. In Supabase &rarr; <b>Authentication &rarr; URL Configuration</b>, is <code>" + esc(here) +
      "</code> listed under <b>Redirect URLs</b>? If Supabase sent you back to a different address than the one " +
      "you started from, the sign-in cannot complete." +
      "<br>2. On the GitHub screen, was the green <b>Authorize</b> button actually clicked? " +
      "GitHub sometimes asks again and simply returns you here if it isn't." +
      "<br><br>Please don't retry repeatedly &mdash; GitHub temporarily blocks apps that ask too often.";
    box.style.display = "block";
  }, 1500); // give detectSessionInUrl time to finish
}

export async function getAccessToken() {
  if (!sb) return null;
  try { const { data } = await sb.auth.getSession(); return data?.session?.access_token || null; }
  catch (e) { return null; }
}
export const configured = () =>
  SUPABASE_URL.startsWith("https://") && SUPABASE_ANON_KEY.length > 20;

/* ---------- modal ---------- */
/* Same defensive treatment as renderIdentity: a missing element in the
   markup must not throw and take the sign-in flow down with it. */
const el = id => document.getElementById(id);
const show = (id, v) => { const n = el(id); if (n) n.style.display = v; };

export function openGhModal() {
  el("ghModal")?.classList.add("open");
  show("ghErr", "none");
  const diagEl = el("ghDiag");
  if (diagEl && authLog.length) { diagEl.textContent = authLog.join("\n"); diagEl.style.display = "block"; }
  show("ghModalSetup", configured() ? "none" : "block");
  show("ghModalSignin", (configured() && !user) ? "block" : "none");
  show("ghModalAccount", user ? "block" : "none");
  show("signInBtn", (configured() && !user) ? "" : "none");
  show("signOutBtn", user ? "" : "none");
  if (user) {
    const m = user.user_metadata || {};
    const info = el("accountInfo");
    if (info) info.innerHTML =
      "Signed in as <b>" + esc(m.full_name || m.user_name || user.email || "you") + "</b>" +
      (m.user_name ? " (@" + esc(m.user_name) + ")" : "");
  }
}
export function closeGhModal() { el("ghModal")?.classList.remove("open"); }

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
    /* Remember that a sign-in was actually attempted from this page, so
       the code that runs after the redirect can tell "came back from
       GitHub with no session" (a real failure worth explaining) apart
       from "just opened the app signed out" (completely normal). */
    try { sessionStorage.setItem("lifeos-signin-started", String(Date.now())); } catch (_) {}
    /* signInWithOAuth RESOLVES with { data, error } — it does not throw.
       The error was previously only handled by the catch below, which
       therefore never ran: a rejected provider, a redirect URL missing
       from Supabase's allow-list, or a disabled GitHub provider all made
       the button appear to do nothing at all. Check the returned error
       explicitly and say what happened. */
    const { data, error } = await sb.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: back }
    });
    if (error) {
      authDiag("sign-in refused: " + (error.message || error));
      openGhModal();
      err.innerHTML = "GitHub sign-in was refused: <b>" + esc(error.message || String(error)) + "</b>" +
        "<br><br>The usual cause is that this address isn't on the allow-list. In Supabase → " +
        "<b>Authentication → URL Configuration</b>, add <code>" + esc(back) + "</code> to " +
        "<b>Redirect URLs</b> (and set <b>Site URL</b> if it's blank).";
      err.style.display = "block";
      return;
    }
    /* A successful call navigates away. If we're still here a moment
       later, the redirect was blocked — by a popup/redirect blocker, or
       by an extension — and silence would look identical to a dead
       button. */
    setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      authDiag("still on the page after sign-in call — redirect likely blocked");
      openGhModal();
      err.innerHTML = "The sign-in redirect didn't happen. If a browser extension or " +
        "pop-up blocker is active for this site, allow redirects and try again — " +
        "or use the <b>Sign in with GitHub</b> button below.";
      err.style.display = "block";
    }, 2500);
  } catch (e) {
    authDiag("sign-in threw: " + (e.message || e));
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

/* Every element is optional here, deliberately.

   renderIdentity() is the FIRST thing initSupabase() calls. When the
   sidebar's #ghChip was accidentally removed from index.html, this threw
   a TypeError on chip.innerHTML — which aborted initSupabase() before the
   Supabase client was ever created. The visible result was an app stuck
   on "Local only" with a sign-in button that did nothing, and a valid
   session left stranded in the URL, none of which points anywhere near a
   missing <div>. A rendering helper must never be able to take down
   authentication. */
function renderIdentity() {
  const chip = document.getElementById("ghChip");
  const btnT = document.getElementById("ghBtnText");
  if (!chip && !btnT) { authDiag("identity elements missing from the page — skipping identity render"); return; }
  if (user) {
    const m = user.user_metadata || {};
    if (chip) chip.innerHTML = (m.avatar_url ? '<img src="' + esc(m.avatar_url) + '" alt="">' : GH_SVG) +
      '<span><span class="gh-name">' + esc(m.full_name || m.user_name || "Signed in") + '</span><br>' +
      '<span class="gh-sub">@' + esc(m.user_name || "github") + ' · synced</span></span>';
    if (btnT) btnT.textContent = "@" + (m.user_name || "account");
  } else {
    if (chip) chip.innerHTML = GH_SVG +
      '<span><span class="gh-name">Sign in with GitHub</span><br><span class="gh-sub">Sync across devices</span></span>';
    if (btnT) btnT.textContent = "GitHub Login";
  }
}

/* ---------- database ---------- */
let hasReconciled = false;      // has this session checked the cloud at least once?
/* Saving is whole-document, so payload size IS the save time. Tracked so
   it can be surfaced rather than guessed at. */
export let lastPayloadBytes = 0;
/* 1.0 MB, not 1.5. The warning existed to say "this is getting large",
   but the number that actually matters is the ~1 MB request-body limit
   where uploads start being rejected outright — and the banner text says
   1 MB. Warning after the point of failure, in different words from the
   message itself, is worse than not warning at all. */
const BIG_PAYLOAD_BYTES = 1_000_000;
let bigPayloadWarned = false;
/* One explanation per session; the pill keeps showing the short reason. */
let saveErrorShown = false;
/* Whether the realtime socket is currently up. Used to tell a genuine
   network failure apart from a rejected over-sized request. */
let realtimeConnected = false;
let lastSizeCheck = 0;
/* Set while an upload is in flight. A second save arriving mid-upload
   used to start its own request, so a burst of edits could put several
   full-document uploads on the wire at once — each slowing the others,
   and the last to finish deciding what the cloud holds. Now the newer
   edit simply re-arms a single follow-up save. */
let saveInFlight = false;
let saveAgainAfter = false;
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
  // state.rev only moves once something is actually saved. An open task
  // composer with typed text hasn't been saved yet by design (see
  // composer.js) — without this it looks exactly like "nothing going on
  // here" and a background sync is free to pull in remote state and
  // redraw the board mid-sentence, discarding whatever was typed with no
  // trace left for Undo or Trash to recover.
  return (state.rev || 0) !== meta.rev || hasUnsavedComposerDraft();
}
/* Whether it is safe for a BACKGROUND pull (the poll, a realtime push, the
   tab coming back into view) to replace state and repaint right now.

   Two separate questions, deliberately kept apart:
     - hasLocalEdits(): is there saved-but-not-yet-uploaded work here?
       That is a data question, and it also gates saveRemote().
     - isUserTyping(): is a person mid-entry this instant? That is a UI
       question, and it must never make saveRemote() think there is
       something to upload — nothing has been typed into `state` yet.

   Anything a person triggers on purpose (the Sync button, sign-in) still
   pulls unconditionally; only unprompted background pulls defer. */
function safeToPullNow() {
  return !hasLocalEdits() && !isUserTyping();
}

/* A deferred pull must not simply be dropped — otherwise a realtime push
   that arrives while you're typing is silently skipped and the poll then
   waits out a whole minute before trying again. Re-check every few
   seconds instead, so the update lands moments after typing stops. */
let deferredPullTimer = null;
function scheduleDeferredPull() {
  if (deferredPullTimer) return;
  deferredPullTimer = setInterval(() => {
    if (!user || !sb) { clearInterval(deferredPullTimer); deferredPullTimer = null; return; }
    if (document.hidden || !safeToPullNow()) return; // still busy — wait for the next tick
    clearInterval(deferredPullTimer); deferredPullTimer = null;
    loadRemote();
  }, 4000);
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
  /* Keys either side has recorded as deliberately removed. Without this
     the union below resurrects them: a device that still holds the old
     legacy copy re-adds it, and "Reclaim space" is undone by the next
     sync. Both sides' tombstones are honoured, so it doesn't matter which
     device ran the cleanup. */
  const removed = new Set([
    ...(Array.isArray(state.removedWhiteboards) ? state.removedWhiteboards : []),
    ...(Array.isArray(remote.removedWhiteboards) ? remote.removedWhiteboards : [])
  ]);
  state.removedWhiteboards = [...removed];
  remote.removedWhiteboards = [...removed];

  const mergedBoards = {};
  Object.keys(Object.assign({}, state.whiteboards, remote.whiteboards)).forEach(boardId => {
    if (removed.has(boardId)) return;   // deleted on purpose — never revive
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

/* ============================================================
   Item-level merge for tasks
   ============================================================
   The last thing in LifeOS still resolved by replacing one device's copy
   wholesale — and the one that actually costs work, because tasks are
   what people add throughout the day on whichever device is to hand.

   Boards and section notes already merge per record. Tasks did not, so
   two devices that each added a different task still produced a winner
   and a loser: the loser's task vanished from the active state (into a
   Restore snapshot, but gone from view). Adding a task on the phone at
   lunch could erase a morning's worth of desktop entries.

   THE DELETION PROBLEM, and why this can be done safely here.
   A naive union of both sides resurrects anything deleted: the device
   that still has the task simply re-adds it. Merging needs to know the
   difference between "you never had this" and "you deleted this", which
   normally means tombstones — a schema change.

   LifeOS already has them. Every delete routes through moveToTrash(),
   which keeps the whole payload, so state.trash IS a tombstone log keyed
   by the original item's id. Merging trash first and then treating those
   ids as deleted gives correct deletion semantics with no new fields.

   SAME ITEM EDITED ON BOTH SIDES is still last-write-wins, but now scoped
   to that one task instead of the whole document. Per-task updatedAt
   decides it where present; where absent (tasks created before this
   change) it falls back to whichever device's document is newer, which is
   exactly the old behaviour — but applied to one task rather than all of
   them. */

function mergeTrashLog(remote) {
  const byId = new Map();
  (state.trash || []).forEach(e => e && e.id && byId.set(e.id, e));
  (remote.trash || []).forEach(e => { if (e && e.id && !byId.has(e.id)) byId.set(e.id, e); });
  const merged = [...byId.values()].sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  state.trash = merged;
  remote.trash = merged;
  // Ids of items deleted on EITHER device, so neither side can revive them.
  const gone = new Set();
  merged.forEach(e => { const pid = e?.payload?.id; if (pid) gone.add(pid); });
  return gone;
}

function mergeTaskArray(localArr, remoteArr, gone, remoteWins) {
  const out = new Map();
  const put = (t, fromRemote) => {
    if (!t || !t.id || gone.has(t.id)) return;
    const existing = out.get(t.id);
    if (!existing) { out.set(t.id, t); return; }
    const a = existing.updatedAt || 0, b = t.updatedAt || 0;
    if (a || b) { if (b > a) out.set(t.id, t); return; }
    // Neither carries a timestamp — defer to the document-level verdict.
    if (fromRemote === remoteWins) out.set(t.id, t);
  };
  (localArr || []).forEach(t => put(t, false));
  (remoteArr || []).forEach(t => put(t, true));
  return [...out.values()];
}

/* workDocGroups ("Work documents" tabs, and the links inside each) used
   to be entirely absent from this merge — mergeProjectTrees only ever
   touched tasks/archivedTasks/name/workDocsLabel on the matched project,
   so a same-id project kept whichever workDocGroups it already had
   locally, forever, no matter which device actually added or edited a
   tab or a link. A device that had never touched Work documents (or
   whose local copy predates them) would sit on its own stale/default
   groups indefinitely, even after every other field of the same project
   synced correctly. That's the exact shape of the bug: same project,
   same tasks, but a completely different (usually empty, default
   "General") set of Work-document tabs on one device.

   Merged per tab by id, and per link within a tab by id — the same
   union-by-id shape mergeTaskArray already uses — so a tab or link added
   on either device survives, instead of one side's whole list silently
   replacing the other's. Neither carries an updatedAt yet, so a tab/link
   edited (renamed, archived) on both sides falls back to the same
   document-level `remoteWins` verdict used for the project's own name. */
function mergeWorkDocGroups(lp, rp, gone, remoteWins) {
  const byId = new Map();
  (lp.workDocGroups || []).forEach(g => g && g.id && byId.set(g.id, g));
  (rp.workDocGroups || []).forEach(rg => {
    if (!rg || !rg.id || gone.has(rg.id)) return;
    const lg = byId.get(rg.id);
    if (!lg) { byId.set(rg.id, rg); return; }
    const docsById = new Map();
    (lg.docs || []).forEach(d => d && d.id && docsById.set(d.id, d));
    (rg.docs || []).forEach(rd => { if (rd && rd.id && !gone.has(rd.id)) docsById.set(rd.id, rd); });
    const mergedGroup = remoteWins ? Object.assign({}, lg, rg) : lg;
    mergedGroup.docs = [...docsById.values()].filter(d => !gone.has(d.id));
    byId.set(rg.id, mergedGroup);
  });
  const merged = [...byId.values()].filter(g => !gone.has(g.id));
  lp.workDocGroups = merged;
  rp.workDocGroups = merged;
}
/* Personal-workspace projects don't have workDocGroups at all — they use
   a flat p.workDocs list instead (a different, older shape that was
   never migrated for that page). Same bug, same fix: union by id rather
   than one side's whole array silently replacing the other's. */
function mergeFlatDocList(lp, rp, gone) {
  if (!Array.isArray(lp.workDocs) && !Array.isArray(rp.workDocs)) return;
  const byId = new Map();
  (lp.workDocs || []).forEach(d => d && d.id && byId.set(d.id, d));
  (rp.workDocs || []).forEach(d => { if (d && d.id && !gone.has(d.id)) byId.set(d.id, d); });
  const merged = [...byId.values()].filter(d => !gone.has(d.id));
  lp.workDocs = merged;
  rp.workDocs = merged;
}
function mergeProjectTrees(localProjects, remoteProjects, gone, remoteWins) {
  const byId = new Map();
  (localProjects || []).forEach(p => p && p.id && byId.set(p.id, p));
  (remoteProjects || []).forEach(rp => {
    if (!rp || !rp.id) return;
    const lp = byId.get(rp.id);
    if (!lp) { byId.set(rp.id, rp); return; }
    // Same project on both sides: merge its task lists rather than
    // picking one project object and discarding the other's tasks.
    lp.tasks = mergeTaskArray(lp.tasks, rp.tasks, gone, remoteWins);
    lp.archivedTasks = mergeTaskArray(lp.archivedTasks, rp.archivedTasks, gone, remoteWins);
    mergeWorkDocGroups(lp, rp, gone, remoteWins);
    mergeFlatDocList(lp, rp, gone);
    if (remoteWins) { lp.name = rp.name ?? lp.name; lp.workDocsLabel = rp.workDocsLabel ?? lp.workDocsLabel; }
    byId.set(rp.id, lp);
  });
  return [...byId.values()];
}

/* ============================================================
   Item-level merge for the journal
   ============================================================
   The journal was the last thing in LifeOS still resolved by replacing
   one device's copy wholesale. state.journal is a flat map of date → HTML
   with no per-entry timestamps, so applyRemote() simply swapped in the
   cloud's map: a day written on the phone and a day written on the
   desktop could not both survive, and the losing day vanished from view
   with nothing on screen to say so. Writing today's entry on one device
   and finding it absent on the other is exactly that.

   Merged per DATE instead:
     - a day only one side has is kept, unless the other side's trash log
       holds that same text as a deliberate deletion (widgets.js records
       one on "journalEntry" whenever an entry is emptied);
     - a day both sides have with identical text needs no decision;
     - a day where one text CONTAINS the other is an append — the longer,
       newer-by-construction version wins. This is the ordinary case for a
       running daily log continued on a second device;
     - anything genuinely divergent keeps the document-level winner and
       files the other version in Trash, so a conflict costs a click to
       recover rather than the text itself.
   ============================================================ */
function journalPlainForCompare(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function mergeIncomingJournal(remote) {
  const localJ = state.journal || {};
  const remoteJ = remote.journal = (remote.journal && typeof remote.journal === "object") ? remote.journal : {};
  const remoteWins = (remote.updatedAt || 0) >= (state.updatedAt || 0);

  /* Deliberate deletions, by date. Compared on text as well as date so a
     day that was deleted and then written afresh isn't mistaken for the
     old deletion and thrown away again. */
  const deletedText = new Map(); // date -> Set of plain texts trashed for that date
  (remote.trash || []).forEach(e => {
    if (!e || e.type !== "journalEntry" || !e.payload || !e.payload.date) return;
    const key = e.payload.date;
    if (!deletedText.has(key)) deletedText.set(key, new Set());
    deletedText.get(key).add(journalPlainForCompare(e.payload.html));
  });
  const wasDeleted = (date, html) => {
    const set = deletedText.get(date);
    return !!set && set.has(journalPlainForCompare(html));
  };

  /* Per-day edit times (state.journalUpdated, written by widgets.js).
     This is what lets one day be settled on its own merits rather than by
     which whole document is newer — the difference between "the newest
     version of Monday wins" and "whichever device saved last wins
     everything", which is how two devices end up taking turns replacing
     each other's copy of the same day. */
  const localStamps = (state.journalUpdated && typeof state.journalUpdated === "object") ? state.journalUpdated : {};
  const remoteStamps = (remote.journalUpdated && typeof remote.journalUpdated === "object") ? remote.journalUpdated : {};

  /* A day one side has never seen at all is not a deletion: a stamp only
     beats the other side's CONTENT when that side actually has a stamp of
     its own, or when the day is present on both. Otherwise a device that
     has simply never opened that day could erase it. */
  const mergedStamps = {};
  const merged = {};
  const conflicts = [];
  new Set([...Object.keys(localJ), ...Object.keys(remoteJ), ...Object.keys(localStamps), ...Object.keys(remoteStamps)]).forEach(date => {
    const mine = localJ[date], theirs = remoteJ[date];
    const hasMine = !!(mine && journalPlainForCompare(mine));
    const hasTheirs = !!(theirs && journalPlainForCompare(theirs));
    const ts = Math.max(localStamps[date] || 0, remoteStamps[date] || 0);
    if (ts) mergedStamps[date] = ts;

    if (!hasMine && !hasTheirs) return;

    if (hasMine && !hasTheirs) {
      if (wasDeleted(date, mine)) return;
      // The other side stamped this day more recently while holding no
      // text for it — that is a deliberate clear, not a device that has
      // never seen it. Only an explicit stamp can win this way.
      if ((remoteStamps[date] || 0) > (localStamps[date] || 0)) return;
      merged[date] = mine;
      return;
    }
    if (hasTheirs && !hasMine) {
      if (wasDeleted(date, theirs)) return;
      if ((localStamps[date] || 0) > (remoteStamps[date] || 0)) return;
      merged[date] = theirs;
      return;
    }

    const a = journalPlainForCompare(mine), b = journalPlainForCompare(theirs);
    if (a === b) { merged[date] = remoteWins ? theirs : mine; return; }
    // One text containing the other is an append — keeping the longer
    // loses nothing, and is right regardless of what the clocks say.
    if (a.includes(b)) { merged[date] = mine; return; }   // this device continued the day
    if (b.includes(a)) { merged[date] = theirs; return; } // the other device did

    // Genuinely different text on both sides. Settle on this day's own
    // edit time where both are known; fall back to the document-level
    // verdict for entries written before stamps existed.
    const lt = localStamps[date] || 0, rt = remoteStamps[date] || 0;
    const takeRemote = (lt || rt) ? (rt > lt) : remoteWins;
    merged[date] = takeRemote ? theirs : mine;
    conflicts.push({ date, losing: takeRemote ? mine : theirs });
  });

  /* Nothing is dropped silently: the version that didn't win goes to
     Trash, where Restore appends it under that day's text rather than
     replacing it (see trash.js). */
  conflicts.forEach(c => {
    try {
      moveToTrash("journalEntry", { id: "journal-conflict-" + c.date + "-" + uid(), date: c.date, html: c.losing }, { date: c.date });
    } catch (e) { console.warn("[sync] could not file journal conflict copy", e); }
  });
  if (conflicts.length) {
    toast(conflicts.length === 1
      ? "Two versions of one journal day — the other copy is in Trash"
      : conflicts.length + " journal days had two versions — the other copies are in Trash");
  }

  state.journal = merged;
  remote.journal = merged;
  state.journalUpdated = mergedStamps;
  remote.journalUpdated = mergedStamps;
}

function mergeIncomingTasks(remote) {
  const gone = mergeTrashLog(remote);
  const remoteWins = (remote.updatedAt || 0) >= (state.updatedAt || 0);

  state.tasks = mergeTaskArray(state.tasks, remote.tasks, gone, remoteWins);
  remote.tasks = state.tasks;

  if (state.gsi && remote.gsi) {
    state.gsi.projects = mergeProjectTrees(state.gsi.projects, remote.gsi.projects, gone, remoteWins);
    remote.gsi.projects = state.gsi.projects;
  }
  if (state.personal && remote.personal) {
    state.personal.projects = mergeProjectTrees(state.personal.projects, remote.personal.projects, gone, remoteWins);
    remote.personal.projects = state.personal.projects;
  }
}

function mergeIncomingBrainstormBoards(remote) {
  BOARD_LISTS.forEach(({ list, active }) => mergeIncomingBoardList(remote, list, active));
}
function applyRemote(remote) {
  const token = remote.syncToken || "";
  /* If this device is holding edits the cloud hasn't seen, replacing state
     destroys them. Snapshot first so "the other device won" is always
     undoable from Restore instead of final. Gated on hasLocalEdits() so a
     device that is merely catching up doesn't fill the snapshot budget
     with identical copies. */
  if (hasLocalEdits()) {
    try { takeSnapshot("replaced-by-" + (remote._client ? "another device" : "cloud")); }
    catch (e) { console.warn("[sync] pre-apply snapshot failed", e); }
  }
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
  /* Anything still sitting in the journal editor's debounce belongs in
     `state` before a pull reads it — otherwise the merge below compares
     the cloud against a local copy that is a sentence out of date, and
     that sentence loses. */
  try { flushJournalEditor(); } catch (e) { /* editor not mounted */ }
  setSyncPill("busy", "Syncing…");
  try {
    const { data, error } = await sb.from("lifeos_data")
      .select("data, updated_at").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    if (data && data.data && Object.keys(data.data).length) {
      const remote = await decodeCloudRow(data.data);
      /* A decode that yields nothing usable must never reach the merges:
         they would read absent keys as "the other side deleted everything"
         and this device would then helpfully write that emptiness back. */
      if (!remote || typeof remote !== "object" || !Object.keys(remote).length) {
        throw new Error("cloud data could not be read");
      }
      checkClockSkew(data.updated_at);
      mergeIncomingWhiteboards(remote);
      mergeIncomingBrainstormBoards(remote);
      mergeIncomingSectionNotes(remote);
      mergeIncomingTasks(remote);
      mergeIncomingJournal(remote); // after the trash log has been merged, which mergeIncomingTasks does
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
        else {
          // Same reasoning as the conflict branch below: don't let a
          // clock comparison be the only thing standing between the
          // cloud's copy and oblivion.
          try { takeSnapshot("cloud-version-overwritten", remote); } catch (e) {}
          hasReconciled = true; await saveRemote(); return;
        }
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
           discarding one side is how people lose work without noticing.

           This is the ONE place a clock still decides anything, and the
           header above explains why that is dangerous: updatedAt on each
           side is a reading from a DIFFERENT device's clock. A phone
           running a couple of minutes fast looks permanently newer, so it
           wins every tie and pushes its copy over the desktop's — which is
           exactly the "I edited on the desktop and the phone overwrote it"
           report this comment now exists because of.

           It cannot be replaced by comparing rev, because rev counters are
           per-device and not comparable. What it CAN be is non-destructive:
           both branches below snapshot the side that loses before it is
           discarded, so a wrong guess costs a trip to Restore rather than
           the work itself. The tolerance stops a small skew from deciding
           anything — inside it, the cloud (the copy both devices share)
           wins rather than whichever clock happens to run fast. */
        const skewTolerance = 2 * 60 * 1000;
        const localIsClearlyNewer = (state.updatedAt || 0) - (remote.updatedAt || 0) > skewTolerance;
        if (!localIsClearlyNewer) {
          applyRemote(remote);
          toast("Another device had newer changes — its version is now shown. Yours is in Restore.");
        } else {
          /* This device is about to overwrite a cloud version it never
             merged — the other device's work is one upsert from being
             gone. Keep the incoming payload as a snapshot first, so it can
             be recovered from Restore rather than existing nowhere. */
          try { takeSnapshot("cloud-version-overwritten", remote); }
          catch (e) { console.warn("[sync] pre-overwrite snapshot failed", e); }
          hasReconciled = true; await saveRemote();
          toast("This device had newer changes — sent up. The other device's version is in Restore.");
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
/* Turns a Supabase/PostgREST failure into something actionable.

   The save error was previously written only to the in-memory diagnostic
   log and the pill just said "Save failed — tap Sync". That is the least
   useful thing it could say: tapping Sync retries the identical upload,
   so a table that does not exist or a policy that rejects the write
   produces an endless loop of the same failure with no clue why. Each
   cause below needs a completely different fix, so the message names it. */
/* A persistent banner for a document that has grown past the point where
   saves are reliable. Deliberately not a toast: this is a condition, not
   an event, and it stays relevant until something is done about it. */
function showSizeBanner(kb) {
  if (document.getElementById("sizeBanner")) return;
  const bar = document.createElement("div");
  bar.id = "sizeBanner";
  bar.className = "size-banner";
  bar.innerHTML =
    `<span><b>This account holds ${kb} KB.</b> Every save uploads all of it, and above about 1 MB uploads start to fail.</span>` +
    `<span class="size-banner-actions">` +
      `<button class="btn btn-primary" onclick="go('trash');setTimeout(()=>reclaimSpace(),150)">Reclaim space</button>` +
      `<button class="btn btn-ghost" onclick="this.closest('.size-banner').remove()">Dismiss</button>` +
    `</span>`;
  document.body.appendChild(bar);
}

function explainSaveError(e) {
  const msg = String(e?.message || e || "");
  const code = String(e?.code || "");
  const m = msg.toLowerCase();

  if (code === "42P01" || m.includes("does not exist") || m.includes("relation")) {
    return { pill: "Save failed — table missing",
      detail: "The <code>lifeos_data</code> table isn't in this Supabase project. Open the Supabase dashboard → SQL Editor and run the contents of <code>supabase-setup.sql</code> from the project files. Having the file in the repo doesn't create the table." };
  }
  if (code === "42501" || m.includes("row-level security") || m.includes("violates") || m.includes("permission denied")) {
    return { pill: "Save failed — permission denied",
      detail: "The row-level security policies are rejecting this write. Re-run the policy section of <code>supabase-setup.sql</code>, and check that RLS is enabled on <code>lifeos_data</code> with an <b>insert</b> and an <b>update</b> policy for <code>auth.uid() = user_id</code>." };
  }
  if (m.includes("jwt") || m.includes("expired") || code === "PGRST301") {
    return { pill: "Save failed — session expired",
      detail: "Your sign-in has expired. Sign out and back in with GitHub; nothing is lost, this device still holds your data." };
  }
  if (m.includes("payload") || m.includes("too large") || m.includes("413")) {
    return { pill: "Save failed — document too large",
      detail: "The upload exceeded the size the server accepts. Open <b>Backup</b> to see what's largest — pen drawings are usually the cause — and archive or delete a board you've finished with." };
  }
  if (m.includes("failed to fetch") || m.includes("networkerror") || m.includes("load failed")) {
    /* "Failed to fetch" is ambiguous and was previously reported as a
       connection problem, which is wrong whenever the realtime websocket
       is up: that proves the network reaches Supabase and the domain is
       not blocked. fetch() throws the SAME TypeError when the server
       closes the connection mid-request — which is what a proxy does to
       an over-sized body. No status code ever reaches the browser, so it
       cannot present as a 413. When the document is already large and the
       socket is live, size is by far the likelier cause, and saying
       "check your connection" sends you to look in the wrong place. */
    const big = lastPayloadBytes > 1_000_000;
    if (big && realtimeConnected) {
      /* The fix is one button, and it lives on the Trash page under Backup —
         somewhere nobody looks when a save fails. Put it in the message
         itself rather than describing where to find it. */
      return { pill: "Save failed — document too large",
        detail: "The upload is <b>" + Math.round(lastPayloadBytes / 1024) + " KB</b>, and the live connection to Supabase is working — so this isn't the network. " +
          "Supabase closes the request when the body is too big, which the browser can only report as a generic fetch failure." +
          "<br><br><b>Reclaim space</b> removes whiteboard copies left behind by earlier updates and thins redundant pen points. " +
          "Your drawings look identical, and a restore point is written first." +
          "<br><br><button class=\"btn btn-primary\" onclick=\"closeGhModal();go('trash');setTimeout(()=>reclaimSpace(),150)\">Reclaim space now</button>" +
          " <button class=\"btn btn-ghost\" onclick=\"exportBackup()\">Download a backup first</button>" };
    }
    return { pill: "Save failed — no connection",
      detail: "The request never reached Supabase. That's usually the network, or a blocker stopping requests to the Supabase domain. Your data is safe on this device and will upload once the connection is back." };
  }
  return { pill: "Save failed — tap Sync",
    detail: "Supabase rejected the upload: <b>" + esc(msg || "unknown error") + "</b>" + (code ? " (code " + esc(code) + ")" : "") };
}

/* ---------- Cloud transport: gzip ----------
   The document is sent whole on every save, so its wire size is the thing
   that decides whether a save is fast, slow, or rejected. JSON of this
   shape — repeated keys, coordinate arrays — compresses extremely well,
   typically to a third or less. Compressing the transport attacks the
   real constraint without asking anyone to delete drawings they still
   want.

   THE MIGRATION HAZARD, AND WHY THE GUARD BELOW IS NOT OPTIONAL.

   A device running an older build reads the compressed row, doesn't
   recognise the envelope, and merge() quietly turns it into an EMPTY
   LifeOS — no error, no warning. If that device then saves, it writes
   that emptiness over the real cloud data. Silent total loss.

   Nothing can be changed in an old build. What CAN be done is refuse to
   put the account into a state where that is possible until it is safe:
   this build writes the compressed format only once the cloud row shows
   that the account has already seen a compression-capable client, and it
   records that fact in plain, readable JSON that an old build ignores
   harmlessly. Until then it keeps writing plain JSON, which every build
   understands. */
const CLOUD_TRANSPORT = "lifeos-gzip-v1";

async function gzipBytes(text) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const cs = new CompressionStream("gzip");
    const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (_) { return null; }
}
async function gunzipText(bytes) {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}
function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Reading is unconditional: this build understands both formats, so it can
   always open an account whichever way the last device wrote it. */
async function decodeCloudRow(data) {
  if (!data || typeof data !== "object") return data;
  if (data._transport !== CLOUD_TRANSPORT) return data;      // plain JSON
  if (typeof data.z !== "string" || !data.z) throw new Error("compressed cloud data is incomplete");
  if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot read compressed cloud data");
  const decoded = JSON.parse(await gunzipText(b64ToBytes(data.z)));
  if (!decoded || typeof decoded !== "object") throw new Error("compressed cloud data could not be decoded");
  return decoded;
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
  if (saveInFlight) { saveAgainAfter = true; return; }
  saveInFlight = true;
  setSyncPill("busy", "Saving…");
  try {
    const token = newSyncToken();
    state.syncToken = token; // stored in state so every device sees the same value
    const payload = Object.assign({}, state, { _client: CLIENT_ID });

    /* Every save uploads the ENTIRE document, so its size is most of what
       "Saving…" is waiting for — worth reporting, but NOT worth measuring
       on every single save.

       Measuring means JSON.stringify() over the whole state, and
       supabase-js then serialises the same object again for the request
       body. That is two full passes over 1.6 MB per save, around 120 ms
       of pure CPU on a phone, purely so a tooltip can show a number. This
       was my own addition and it made every save slower.

       Measured at most once a minute now, and always after a failure,
       where the number actually matters. */
    let payloadBytes = lastPayloadBytes;
    const now = Date.now();
    if (now - lastSizeCheck > 60_000) {
      lastSizeCheck = now;
      try { payloadBytes = JSON.stringify(payload).length; } catch (_) {}
      lastPayloadBytes = payloadBytes;
    }
    if (payloadBytes > BIG_PAYLOAD_BYTES && !bigPayloadWarned) {
      bigPayloadWarned = true;
      authDiag("payload is " + Math.round(payloadBytes / 1024) + " KB — every save uploads all of it");
      /* A toast that names a page the person then has to go and find is
         easy to dismiss and easy to forget. Show the banner instead: it
         stays until acted on, and carries the button. */
      /* Only meaningful before compression is active — afterwards the
         wire size is what matters and it is reported on each save. */
      if (!state.compressionReady) showSizeBanner(Math.round(payloadBytes / 1024));
    }
    /* Compressed only when the account has been seen by a compression-capable
       client at least once — recorded by `compressionReady`, which is written
       as ordinary readable JSON so an old build simply ignores it. The very
       first save from this build therefore stays plain (safe for every
       device) and merely announces the capability; from the next save
       onward the wire payload is gzipped.

       That one-save delay is the whole safety mechanism: it gives every
       other device a chance to be updated before the format changes, and
       it means an account is never silently switched into a format some
       device in daily use cannot read. */
    payload.compressionReady = true;
    let wireBytes = payloadBytes;
    let body = payload;
    if (state.compressionReady) {
      const gz = await gzipBytes(JSON.stringify(payload));
      if (gz) {
        body = { _transport: CLOUD_TRANSPORT, z: bytesToB64(gz) };
        wireBytes = JSON.stringify(body).length;
      }
    }
    state.compressionReady = true;

    const { error } = await sb.from("lifeos_data").upsert({
      user_id: user.id, data: body, updated_at: new Date().toISOString()
    });
    if (error) throw error;
    /* Report the WIRE size, not the raw document. Once the transport is
       compressed those are very different numbers, and warning about the
       uncompressed one would keep alarming people about a constraint that
       no longer applies. */
    lastPayloadBytes = wireBytes;
    lastSizeCheck = Date.now();
    saveErrorShown = false; // a success re-arms the explanation for any future failure
    markAgreed(token); // this device and the cloud now hold the same thing
    const pill = document.getElementById("syncPill");
    if (pill) pill.title = "Last upload " + Math.round(payloadBytes / 1024) + " KB — every save sends the whole document";
    setSyncPill("ok", "Synced · " + nowTime());
  } catch (e) {
    let size = "?";
    try { size = Math.round(JSON.stringify(state).length / 1024) + " KB"; } catch (_) {}
    authDiag("SAVE failed (payload " + size + "): " + (e.message || e) + (e.code ? " [code " + e.code + "]" : "") + (e.hint ? " — " + e.hint : ""));
    const why = explainSaveError(e);
    setSyncPill("err", why.pill);
    /* Shown once per session, not on every retry: a modal that reopens on
       each failed save would be its own problem. */
    if (!saveErrorShown) {
      saveErrorShown = true;
      const box = document.getElementById("ghErr");
      if (box) {
        openGhModal();
        box.innerHTML = "<b>Changes aren't reaching the cloud.</b><br><br>" + why.detail +
          "<br><br>Your data is safe on this device — nothing has been lost. Until this is fixed, " +
          "treat other devices as out of date, and take a <b>Backup</b> before signing out anywhere." +
          (e && (e.message || e.code) ? "<br><br><span class='hint'>Reported by Supabase: " +
            esc(String(e.message || "")) + (e.code ? " (code " + esc(String(e.code)) + ")" : "") + "</span>" : "");
        box.style.display = "block";
      }
    }
    /* Failures re-measure: this is the one moment the size matters, and
       it is what the "document too large" diagnosis reads. */
    try { lastPayloadBytes = JSON.stringify(state).length; lastSizeCheck = Date.now(); } catch (_) {}
  } finally {
    /* Released on every path — an early return or a thrown error leaving
       this set would stop the app saving for the rest of the session, a
       far worse failure than the one it is guarding against. */
    saveInFlight = false;
    if (saveAgainAfter) {
      saveAgainAfter = false;
      // Edits arrived mid-upload; send one follow-up rather than a queue.
      setTimeout(() => saveRemote(), 0);
    }
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
    if (!safeToPullNow()) { scheduleDeferredPull(); return; } // never repaint under a caret
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
      async payload => {
        const row = payload.new;
        if (!row || !row.data) return;
        /* A compressed row can't be inspected without decoding it first,
           so the cheap early-outs move after the decode. */
        let remote;
        try { remote = await decodeCloudRow(row.data); }
        catch (e) { authDiag("realtime decode failed: " + (e.message || e)); return; }
        if (!remote || typeof remote !== "object" || !Object.keys(remote).length) return;
        if (remote._client === CLIENT_ID) return;
        if (!cloudChangedSinceLastSync(remote)) return; // already have it
        if (!safeToPullNow()) {
          /* Don't overwrite something being typed right now. If it's only
             that a field has focus, the deferred pull below picks it up as
             soon as the person stops; if there are genuine unsaved local
             edits, loadRemote() reconciles them properly (conflict warning
             included) rather than one side quietly winning. */
          setSyncPill("busy", "Changes waiting — tap Sync");
          scheduleDeferredPull();
          return;
        }
        mergeIncomingWhiteboards(remote);
        mergeIncomingBrainstormBoards(remote);
        mergeIncomingSectionNotes(remote);
        mergeIncomingTasks(remote);
        mergeIncomingJournal(remote); // after the trash log has been merged, which mergeIncomingTasks does
        applyRemote(remote);
        toast("Updated from another device");
      })
    .subscribe(status => {
      // Visible on the device where it's failing — the whole point of
      // authDiag. "CHANNEL_ERROR"/"TIMED_OUT" here means realtime isn't
      // enabled for the table, and the poll above is doing the work.
      authDiag("realtime: " + status);
      realtimeConnected = (status === "SUBSCRIBED");
    });
}
function stopRealtime() {
  stopPolling();
  if (rtChannel && sb) { sb.removeChannel(rtChannel); rtChannel = null; }
}

/* ---------- init ---------- */
/* jsDelivr is not the only way to get the library, and it is the single
   point of failure that strands a perfectly good sign-in: Supabase hands
   back a valid session in the URL, and with no library there is nothing
   to catch it. Ad-blockers, corporate DNS filtering and campus networks
   all block individual CDN hosts routinely — GSI's network is exactly the
   sort of place that happens.

   So if the primary tag hasn't produced window.supabase, try the same
   package from other hosts before declaring failure. Each attempt is a
   fresh <script> tag; the first that defines window.supabase wins. */
const LIB_FALLBACKS = [
  "https://unpkg.com/@supabase/supabase-js@2.45.4/dist/umd/supabase.js",
  "https://cdn.skypack.dev/pin/@supabase/supabase-js@v2.45.4/mode=raw/dist/umd/supabase.js"
];
let fallbackIndex = 0;
let fallbackPending = false;

function tryNextLibrarySource() {
  if (window.supabase || fallbackPending) return;
  if (fallbackIndex >= LIB_FALLBACKS.length) return;
  const url = LIB_FALLBACKS[fallbackIndex++];
  fallbackPending = true;
  authDiag("primary CDN didn't provide the library — trying " + new URL(url).host);
  const tag = document.createElement("script");
  tag.src = url;
  tag.async = true;
  tag.onload = () => {
    fallbackPending = false;
    authDiag("loaded the library from " + new URL(url).host);
    trySetupClient();
  };
  tag.onerror = () => {
    fallbackPending = false;
    authDiag("blocked or unreachable: " + new URL(url).host);
    tryNextLibrarySource();
  };
  document.head.appendChild(tag);
}

function trySetupClient() {
  if (sb || !window.supabase) return; // already set up, or the library genuinely isn't available yet
  /* Options left at supabase-js defaults, matching the build that was
     working. flowType and storageKey were briefly forced here while
     debugging a sign-in failure; that failure turned out to be a missing
     DOM element (see renderIdentity below), and forcing the flow risked
     mismatching whatever this project is actually configured for. */
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
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
  const ghModalEl = document.getElementById("ghModal");
  if (ghModalEl) ghModalEl.addEventListener("click", e => {
    if (e.target.id === "ghModal") closeGhModal();
  });
  if (!configured()) { setSyncPill("", "Local only · set up sync"); return; }
  reportOauthUrlError();
  /* Deliberately NOT stripping a stranded #access_token here. The library
     may simply be arriving late — from the primary tag or from a fallback
     host — and detectSessionInUrl needs that fragment intact to complete
     the sign-in. Clearing it early would throw away a perfectly valid
     session to tidy the address bar. It is only cleared once every source
     has failed, in the give-up branch below. */
  checkReturnedWithoutSession();
  if (!storageWritable()) {
    authDiag("localStorage is BLOCKED in this browser — a session can't be saved, so sign-in will not stick. Turn off Private Browsing / allow cookies & site data for this site.");
    setSyncPill("err", "Browser storage blocked");
  }
  const finishSetup = () => {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flushPendingSave();
      // Same reasoning as the poll/realtime gates above: an open composer
      // with typed text hasn't touched `state` yet, so without this check
      // the tab simply coming back into view (switching apps for a
      // second, a keyboard or notification-shade visibility blip on
      // mobile) pulls in remote state and redraws the board mid-sentence.
      else if (user && safeToPullNow()) loadRemote();
      else if (user) scheduleDeferredPull();
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
    if (sb) {
      clearInterval(retry); setSyncPill("", "Local only"); finishSetup();
      // The first attempt may have run before the client existed.
      checkReturnedWithoutSession();
    }
    else if (attempts === 2) { tryNextLibrarySource(); }
    else if (attempts >= 12) {
      clearInterval(retry);
      setSyncPill("err", "Sign-in library blocked");
      /* Say which host to unblock rather than leaving a dead-end pill.
         The session may also be sitting unclaimed in the URL right now,
         which handleStrandedAuthFragment() explains and cleans up. */
      authDiag("gave up loading the library from every source");
      if (!handleStrandedAuthFragment()) {
        const box = document.getElementById("ghErr");
        if (box) {
          box.innerHTML = "The Supabase sign-in library couldn't be loaded from any source, so syncing is " +
            "unavailable and LifeOS is running locally on this device only." +
            "<br><br>This is almost always a blocker or a filtered network. Allow " +
            "<code>cdn.jsdelivr.net</code> or <code>unpkg.com</code> for this site, then reload." +
            "<br><br>Your data is safe — it's stored on this device and will sync once the library loads.";
          box.style.display = "block";
        }
      }
    }
  }, 500);
}

/* GitHub sign-in (via Supabase Auth), cloud storage, live sync. */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=202609262330';
import { state, replaceState, resetLocalStateForNewAccount, persist, setRemoteSaver, uid, esc, rerender, flushPendingSave } from './state.js?v=202609262330';
import { setSyncPill, nowTime, toast, isUserTyping } from './ui.js?v=202609262330';
import { pushCommunicationUpdate, mergeCommunication } from './communication-bridge.js?v=202609262330';
import { pushNgdrTrackerUpdate } from './ngdr-tracker-bridge.js?v=202609262330';
import { mergeBoardData } from './whiteboard.js?v=202609262330';
import { takeSnapshot } from './backup.js?v=202609262330';
import { moveToTrash } from './trash.js?v=202609262330';
import { mergeNoteInk, redrawAllInk } from './note-ink.js?v=202609262330';
import { hasUnsavedComposerDraft } from './composer.js?v=202609262330';
import { flushJournalEditor } from './widgets.js?v=202609262330';
import { flushNotebookEditor } from './notebook.js?v=202609262330';

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
/* Device-local; deliberately NOT part of synced state. Scoped per account,
   the same way stampKey() and compressionKey() are — otherwise Account B
   signing in on a browser Account A just used could read Account A's rev
   and syncToken and wrongly conclude it had already agreed with ITS cloud
   row, skipping the very first-sync safety checks (loadRemote()'s
   !agreedWithCloud() branch) that exist for exactly this situation. */
const SYNC_META_PREFIX = "lifeos-sync-meta:";
function syncMetaKey() { return SYNC_META_PREFIX + (user ? user.id : "anon"); }
/* Which account's data the local "lifeos-data" document currently holds.
   Separate from stampKey()/syncMetaKey() because this one is checked
   BEFORE those even apply — it's what decides whether the browser is
   about to hand a freshly-signed-in account a stranger's document, not
   which version of that account's own data this tab has seen. See
   resetLocalStateForNewAccount() in state.js for what happens on a
   mismatch. Deliberately not touched at sign-out: signing back into the
   SAME account later must not trip this and wipe a document that was
   never actually a stranger's. */
const LOCAL_OWNER_KEY = "lifeos-local-owner";
function localOwner() { try { return localStorage.getItem(LOCAL_OWNER_KEY); } catch (_) { return null; } }
function setLocalOwner(uid) { try { localStorage.setItem(LOCAL_OWNER_KEY, uid); } catch (_) {} }
function readSyncMeta() {
  try { return JSON.parse(localStorage.getItem(syncMetaKey())) || {}; }
  catch (e) { return {}; }
}
function writeSyncMeta(meta) {
  try { localStorage.setItem(syncMetaKey(), JSON.stringify(meta)); } catch (e) {}
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

/* ================================================================
   REMOTE-CHANGE DETECTION — the cheap half of sync
   ================================================================

   The document is one jsonb row of roughly 450 KB on the wire. Two things
   were downloading all of it whether or not anything had changed:

     - the 15-second poll, which ran `select data, updated_at` and then
       decided, AFTER paying for the whole document, whether it was worth
       having. At four pulls a minute that is about 108 MB an hour of an
       open tab doing nothing.
     - realtime, which by default delivers the complete row to every
       subscriber on every write — so each save also cost a full download
       on every other device.

   Both now go through a PROBE first: `select updated_at`, a single
   timestamp, a few hundred bytes including headers. The full document is
   fetched only when that timestamp differs from the one this device last
   merged. Nothing about the merge, the conflict handling or the schema
   changes — this decides only WHETHER to ask for the document, never what
   to do with it once it arrives.

   `updated_at` is sufficient and already exists: saveRemote() writes it on
   every upsert, so any write by any device moves it. No migration. */
/* ---- the stamp: what THIS TAB has downloaded, reconciled and applied ----

   Not "the last version observed". The distinction is the whole safety
   property: if the stamp ever names a version this tab did not actually
   merge, the next probe reports "unchanged" and the tab stays stale
   forever — and then overwrites the cloud with its stale copy on the next
   save. commitStamp() is therefore called in exactly one place, after a
   reconcile has completed without throwing.

   Scoped per user id: signing in as somebody else on the same browser
   must not inherit the previous account's idea of where the cloud is.

   ASSUMPTION, deliberate and documented: updated_at is client-supplied.
   saveRemote() writes it explicitly on every upsert, and supabase-setup.sql
   defines the column with `default now()` and no trigger, so the value this
   code writes is the value that comes back. If a trigger were ever added
   that rewrote updated_at server-side, every save would be followed by a
   full re-read — correct, but expensive — and this comment is where to
   start looking. */
const STAMP_PREFIX = "lifeos-remote-stamp:";
let lastRemoteStamp = null;   // version this tab has merged; null = not loaded yet
let lastStampUser = null;
let lastSelfStamp = null;     // the updated_at this tab itself last wrote
let remoteStale = false;      // another tab says the cloud moved — probe before trusting the stamp

function stampKey() { return STAMP_PREFIX + (user ? user.id : "anon"); }
function loadStamp() {
  const uid = user ? user.id : "anon";
  if (lastRemoteStamp !== null && lastStampUser === uid) return lastRemoteStamp;
  lastStampUser = uid;
  try { lastRemoteStamp = localStorage.getItem(stampKey()) || ""; }
  catch (_) { lastRemoteStamp = ""; }   // private browsing: in-session only, a reload re-reads once
  return lastRemoteStamp;
}
function commitStamp(stamp) {
  if (!stamp) return;
  lastStampUser = user ? user.id : "anon";
  lastRemoteStamp = stamp;
  remoteStale = false;
  try { localStorage.setItem(stampKey(), stamp); } catch (_) { /* private browsing */ }
  announceRemoteChanged();
}
export function forgetStamp() {   // called on sign-out; the next session re-checks from scratch
  lastRemoteStamp = null; lastStampUser = null; lastSelfStamp = null; remoteStale = false;
}

/* ---- cross-tab coordination ----

   The message is "the cloud moved, go and look", never "here is the
   version you now have". A tab that adopted another tab's stamp would be
   claiming to hold a document it never downloaded: its probe would then
   report unchanged, it would never pull, and its next save would put its
   stale copy over the newer cloud one. So the receiver only marks itself
   stale and schedules its own probe — cheap, and it still ends up doing
   the read itself.

   No loop: a tab only broadcasts after committing a stamp, and a receiver
   that probes and finds its own stamp already current stops there without
   broadcasting anything. */
let stampChannel = null;
try {
  stampChannel = new BroadcastChannel("lifeos-sync");
  stampChannel.onmessage = e => {
    if (!e.data || e.data.type !== "remote-changed") return;
    remoteStale = true;
    if (!user || !sb || document.hidden) return;   // it will probe when it comes back
    if (!safeToPullNow()) { scheduleDeferredPull(); return; }
    syncCheck("another tab");
  };
} catch (_) { stampChannel = null; }   // older browsers, some private modes
function announceRemoteChanged() {
  try { if (stampChannel) stampChannel.postMessage({ type: "remote-changed" }); } catch (_) {}
}

/* ---- the save gate ----

   saveRemote() refuses to run until this session has checked the cloud
   once, so that a device never uploads over a version it has not seen.
   The check is what matters, NOT the download: a probe proving the cloud
   still holds the exact version this tab already merged is every bit as
   good a check as re-reading the document, and far cheaper.

   Routing startup through the probe without this was the bug that silently
   swallowed every save from the second page load onward. */
function markRemoteChecked() {
  hasReconciled = true;
  /* Deliberately no longer flushing pendingSaveAfterReconcile here. This
     runs once per runSync() call, and runSyncChain() can already have
     another one queued (loadAgainAfter) for the moment this returns — an
     immediate flush here would race that queued reconciliation exactly
     the way the one removed from loadRemote()'s finally would have. The
     flush happens exactly once, in runSyncChain(), once its drain loop
     confirms nothing else is queued. */
}

/* One timestamp. This is the request that replaces a 434 KB download. */
async function probeRemoteStamp() {
  if (!sb || !user) return null;
  const { data, error } = await sb.from("lifeos_data")
    .select("updated_at").eq("user_id", user.id).maybeSingle();
  if (error) throw error;
  return data ? data.updated_at : null;
}

/* ---- probe failure backoff ----
   A probe that fails must not escalate into a full read on every poll:
   during an outage that would turn a cheap check into the most expensive
   request the app makes, once per tick. Failures back off; a success
   clears it; a manual Sync ignores it entirely. */
let probeFailures = 0;
let probeQuietUntil = 0;
/* The backoff protects Supabase from a device hammering it during an
   outage. It must not also delay RECOVERY: with the save gate now shut
   while the cloud state is unknown, a queued upload waits on the next
   successful probe, and sitting out a five-minute backoff after the
   network has demonstrably returned is the wrong trade. Any signal that
   conditions have actually changed — the browser reporting `online`, or
   the person coming back to the tab — clears it and tries once. */
function clearProbeBackoff() { probeFailures = 0; probeQuietUntil = 0; }

/* ---- one read at a time ----
   Poll, realtime, visibility, deferred pull and cross-tab messages can all
   fire at once. Without coalescing that is several concurrent probes, then
   several concurrent full reads merging into the same state. A second
   trigger during a run sets a flag and is honoured once the run finishes,
   so nothing is lost and nothing is done twice. */
let loadInFlight = false;
let loadAgainAfter = false;
let loadAgainSkipBackoff = false;   // did any coalesced caller while this run was busy ask to ignore backoff?
let currentSyncPromise = null; // the in-flight runSync() call, so a coalesced caller can await the REAL result
/* Sink for the actual race this file did NOT close: saveInFlight stops two
   uploads overlapping each other, but nothing stopped an upload from
   overlapping the READ half of a reconciliation. loadRemote() awaits a
   network fetch before it decides anything, and a local edit's debounced
   save (persist() -> ~1.5s -> saveRemote()) can fire during that exact
   window — sending this device's pre-merge state to Supabase while a
   reconcile is mid-flight and behind it, deciding a winner without
   knowing this device just wrote something new underneath it.

   The five `await saveRemote()` calls inside loadRemote() itself are not
   that race — they ARE the reconciliation's own decision to push, and
   must go through even while this flag is up, which is what the
   `fromReconcile` parameter on saveRemote() is for. Anything else calling
   saveRemote() while a reconcile is running is deferred the same way an
   unreconciled session defers it (pendingSaveAfterReconcile), and flushed
   once runSyncChain()'s drain loop confirms no further reconciliation is
   queued. (It used to be flushed from loadRemote()'s finally block; that
   moved, because a flush fired there could race the next reconciliation
   the chain was already about to start. The two comments at
   markRemoteChecked() and loadRemote()'s finally explain that change —
   this one was left describing the old arrangement.) */
let reconcileInFlight = false;

async function syncCheck(reason, skipBackoff = false) {
  if (!sb || !user) return "skipped";
  if (loadInFlight) {
    loadAgainAfter = true;
    if (skipBackoff) loadAgainSkipBackoff = true;
    /* Hand back the ACTUAL chain already in progress rather than the bare
       string "coalesced" — a caller that awaits this (manual Sync) then
       genuinely waits for everything its request caused, not just
       whichever run happened to already be running. See runSyncChain(). */
    return currentSyncPromise || "coalesced";
  }
  loadInFlight = true;
  currentSyncPromise = runSyncChain(reason, skipBackoff);
  return currentSyncPromise;
}

/* One reconciliation, plus — chained into the SAME promise, not a
   detached setTimeout() — any further one that coalesced onto it while it
   ran. This is what makes syncCheck()'s return value trustworthy for a
   caller that actually awaits it: `await syncCheck("manual", true)`
   previously could resolve the moment the run already in progress
   finished, while the queued follow-up THAT REQUEST caused was still
   about to start via a detached timer — so `saveRemote()` right after it
   in syncNow() could fire in the gap between the two, with
   reconcileInFlight already back to false. Looping here instead of
   scheduling a separate call means loadInFlight/currentSyncPromise stay
   up, and therefore reconcileInFlight-derived protection stays up, for
   every reconciliation this one call is responsible for — not just the
   first. */
async function runSyncChain(reason, skipBackoff) {
  try {
    let result = await runSync(reason, skipBackoff);
    while (loadAgainAfter) {
      loadAgainAfter = false;
      const queuedSkipBackoff = loadAgainSkipBackoff; loadAgainSkipBackoff = false;
      /* Re-check rather than re-read: whatever arrived during the run is
         almost always the change this run already merged. Carries the
         skip-backoff flag through — a coalesced manual Sync must still
         get its own immediate probe, not sit out a backoff window a
         background trigger would have accepted. */
      result = await runSync(reason + " (queued)", queuedSkipBackoff);
    }
    return result;
  } finally {
    /* Released on every path, same reasoning as saveInFlight/reconcileInFlight:
       runSync() shouldn't throw (its own paths report failure as a string,
       not an exception), but a coordinator flag that could get stuck on an
       unexpected exception is a worse bug than the one it protects against. */
    loadInFlight = false;
    currentSyncPromise = null;
    /* THE ONE place this flushes now. It used to fire from inside a single
       loadRemote() call (and from markRemoteChecked(), reached from every
       runSync() iteration) the moment THAT call finished — but by then the
       while loop above may already know it's about to run ANOTHER
       reconciliation (loadAgainAfter), and a fire-and-forget saveRemote()
       fired at that point would upload while the next reconciliation in
       this same chain reads, racing it. Waiting until here means nothing
       queues a save mid-chain — the chain is fully drained (the while loop
       has exited, so nothing else is queued) before this can fire, giving
       the invariant this coordinator is meant to guarantee: no external
       upload starts until every reconciliation this call is responsible
       for has actually finished. */
    if (pendingSaveAfterReconcile) { pendingSaveAfterReconcile = false; saveRemote(); }
  }
}

/* `skipBackoff` — the only caller is manual Sync — means "probe right now
   even if a recent probe failure would otherwise have this tab sitting
   out a backoff window." It does NOT mean "download the document even if
   the probe says nothing changed": that used to be `force`'s second
   effect, and it was pure waste — pressing Sync when nothing had actually
   changed still paid for a full read. A probe is honest regardless of who
   asked for it, so manual Sync gets exactly the same "unchanged → stop"
   short-circuit below as every automatic trigger; the only thing it gets
   that they don't is going first instead of waiting out a backoff. */
async function runSync(reason, skipBackoff) {
  if (!skipBackoff && Date.now() < probeQuietUntil) {
    authDiag("probe (" + reason + "): backing off after " + probeFailures + " failure(s)");
    return "backoff";
  }
  let stamp;
  try {
    stamp = await probeRemoteStamp();
    probeFailures = 0; probeQuietUntil = 0;
  } catch (e) {
    probeFailures++;
    /* 30s, 60s, 2m, 4m … capped at 5 minutes. Only the probe is delayed;
       local work and local saving are untouched. */
    probeQuietUntil = Date.now() + Math.min(5 * 60_000, 30_000 * Math.pow(2, probeFailures - 1));
    authDiag("probe (" + reason + ") failed: " + (e.message || e) +
             " — retrying in " + Math.round((probeQuietUntil - Date.now()) / 1000) + "s");
    /* Deliberately NOT falling through to a full read. A probe failing is
       evidence the network is unwell, which is the worst moment to ask for
       the largest thing in the app.

       AND DELIBERATELY NOT OPENING THE SAVE GATE. An earlier version
       called markRemoteChecked() on the first failure, reasoning that
       local work should never be stranded. That reasoning was wrong: a
       failed probe establishes nothing about what is in Supabase, so
       opening the gate licenses the next local edit to upsert the whole
       document over a cloud version this device has never seen. The other
       device's work would be gone with no conflict prompt and no
       snapshot — precisely the silent loss the merge functions exist to
       prevent.

       Local work IS still safe, by the route that was always correct:
       persist() has already written it to localStorage, and saveRemote()
       sets pendingSaveAfterReconcile, so the upload is queued rather than
       abandoned. It flushes the moment a probe or a reconcile actually
       succeeds. Safe on this device, queued for the cloud — not uploaded
       over an unknown remote version. */
    setSyncPill("err", "Offline — changes saved on this device");
    return "probe-failed";
  }

  if (stamp === null) {                      // no row yet — this device seeds it
    const r = await loadRemote();
    if (r !== "failed") markRemoteChecked();
    return r;
  }
  if (!remoteStale && stamp === loadStamp()) {
    /* THE CHEAP PATH, and the one that has to open the save gate: the
       cloud holds exactly the version this tab already reconciled.
       Unconditional now — manual Sync used to skip straight past this
       and pay for a full read even when the probe just confirmed nothing
       had changed. A probe is honest regardless of who asked for it;
       "check now" and "check now, ignoring backoff" are both satisfied by
       the probe alone when it comes back unchanged. */
    markRemoteChecked();
    authDiag("probe (" + reason + "): unchanged, nothing downloaded");
    return "unchanged";
  }
  if (remoteStale && stamp === loadStamp()) {
    remoteStale = false;                     // another tab's nudge, already current
    markRemoteChecked();
    authDiag("probe (" + reason + "): another tab's nudge, already current");
    return "unchanged";
  }
  authDiag("probe (" + reason + "): cloud moved " + (loadStamp() || "never") + " \u2192 " + stamp + " — reading document");
  const result = await loadRemote();
  if (result !== "failed") markRemoteChecked();
  return result;
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
    syncCheck("deferred");
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
    /* WHICH TAB IS OPEN IS THIS DEVICE'S BUSINESS, NOT THE CLOUD'S.

       `open` lives on the note object, so it rides along with everything
       else that syncs — and because selecting a tab doesn't change the
       note's content, it doesn't bump `updated` either. The winner rule
       below hands ties to the remote copy, so every sync re-imported
       whichever tab happened to be open on the other device (or on this
       one before the switch) and the tab silently changed underneath
       whoever was reading. On a 15s poll that reads as "it jumps back to
       Goals after a while".

       Nobody wants the phone deciding which note the desktop is looking
       at. The open tab is view state, like a scroll position: noted
       before the merge, reasserted after it. */
    const localOpenId = (localSec.noteList || []).find(n => n.open)?.id || null;

    const byId = new Map();
    (localSec.noteList || []).forEach(n => byId.set(n.id, n));
    (remoteSec.noteList || []).forEach(rn => {
      const ln = byId.get(rn.id);
      if (!ln) { byId.set(rn.id, rn); return; }
      const winner = (rn.updated || 0) >= (ln.updated || 0) ? rn : ln;
      /* The note's TEXT has a winner — one device's prose replaces the
         other's. Its INK does not: marks from both devices are additions
         to the same page, so they're unioned, with tombstones keeping an
         erased stroke erased. Letting the newer note win outright would
         throw away everything drawn on the other device. */
      const ink = mergeNoteInk(ln, rn);
      if (ink) winner.ink = ink;
      byId.set(rn.id, winner);
    });
    /* Remote order first — it is the more recently agreed view — with any
       note this device has that the cloud hasn't seen yet appended. */
    const order = [];
    (remoteSec.noteList || []).forEach(n => order.push(byId.get(n.id)));
    (localSec.noteList || []).forEach(n => { if (!order.includes(byId.get(n.id))) order.push(byId.get(n.id)); });
    const merged = order.filter(Boolean);

    /* Reassert the local tab. Falls back to whatever the cloud had open
       only when this device had nothing open at all — a first sync on a
       new device, where the remote's choice is better than none. */
    const keepId = merged.some(n => n.id === localOpenId)
      ? localOpenId
      : (merged.find(n => n.open)?.id || merged[0]?.id || null);
    merged.forEach(n => { n.open = (n.id === keepId); });

    remoteSec.noteList = merged;
    localSec.noteList = merged;
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
  /* ONLY a deletion the person actually made counts here.

     This used to read every "journalEntry" record in the trash log — and
     the conflict copies filed a few lines below are also written to that
     log. A copy filed to RESCUE a version was therefore indistinguishable
     from a record of a version being thrown away, and the two branches
     underneath treat a match as "the other side deleted this day" and
     drop the day from `merged` — which is written straight back to both
     `state.journal` and `remote.journal`. So a day that had ever been
     through one conflict could later be erased from both devices and the
     cloud at once, with the entry itself as the thing that triggered it.

     Conflict copies now carry their own type ("journalConflict") and are
     skipped. Records already in the log from before that carry the old
     type but a "journal-conflict-" id, so those are skipped by id — a
     backup written last week must not still be able to delete a day. */
  const deletedText = new Map(); // date -> Set of plain texts the person deleted on that date
  (remote.trash || []).forEach(e => {
    if (!e || e.type !== "journalEntry" || !e.payload || !e.payload.date) return;
    if (String(e.payload.id || "").startsWith("journal-conflict-")) return; // legacy conflict copy
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
      /* "journalConflict", not "journalEntry": this is a version being
         KEPT, not one being deleted, and the deletion scan above must be
         able to tell them apart. Restores identically (see trash.js). */
      moveToTrash("journalConflict", { id: "journal-conflict-" + c.date + "-" + uid(), date: c.date, html: c.losing }, { date: c.date });
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

/* ============================================================
   Where a task LIVES is itself a fact that has to be merged
   ============================================================
   Every merge above this line reconciles one list against the matching
   list on the other side: this project's tasks against that project's
   tasks, Overview's against Overview's. Within a list that is right. The
   thing it cannot see is a task that CHANGED LIST.

   Move "Hon'ble Union Minister…" from NGDR to BGD on the desktop. The
   desktop now has it in BGD and nowhere else. The phone, not yet synced,
   still has it in NGDR. Reconcile:

     NGDR: local has no such task, remote does  -> union keeps it
     BGD : local has it, remote does not        -> union keeps it

   Both lists are individually correct, and the task is now in two
   projects. Nothing is corrupted and nothing threw; union-by-id is
   simply the wrong shape for a value that is supposed to exist once.
   The same applies to a task archived on one device (tasks ->
   archivedTasks), and to one converted between Overview and a project by
   changeTaskProject(), which carries the id across stores intact.

   So the location is decided FIRST, once, across every list at the same
   time, and then enforced after the per-list merges have run. Deciding
   before merging is what makes it possible: only the two original
   snapshots know where each side actually had the task, and that
   provenance is exactly what union-by-id destroys.

   The rule is the same one used everywhere else here — newest
   updatedAt wins, document verdict breaks a tie — with one addition: a
   final tie falls back to comparing the location keys as strings. That
   last step never fires in practice, but it has to exist, because two
   devices resolving the same tie in opposite directions would each
   "fix" the duplicate into the other's copy and hand it straight back.
   A deterministic answer is what stops a repair loop.
   ============================================================ */
function taskHomeIndex(root) {
  const at = new Map();
  const scan = (list, key) => (list || []).forEach(t => {
    if (t && t.id && !at.has(t.id)) at.set(t.id, { key, updatedAt: t.updatedAt || 0 });
  });
  scan(root?.tasks, "tasks");
  ["gsi", "personal"].forEach(store => {
    (root?.[store]?.projects || []).forEach(p => {
      if (!p || !p.id) return;
      scan(p.tasks, store + ":" + p.id + ":tasks");
      scan(p.archivedTasks, store + ":" + p.id + ":archivedTasks");
    });
  });
  return at;
}
function decideTaskHomes(remote, remoteWins) {
  const mine = taskHomeIndex(state), theirs = taskHomeIndex(remote);
  const homes = new Map();
  new Set([...mine.keys(), ...theirs.keys()]).forEach(id => {
    const a = mine.get(id), b = theirs.get(id);
    if (!a || !b || a.key === b.key) { homes.set(id, (a || b).key); return; }
    if (b.updatedAt > a.updatedAt) homes.set(id, b.key);
    else if (a.updatedAt > b.updatedAt) homes.set(id, a.key);
    else if (a.updatedAt || b.updatedAt) homes.set(id, remoteWins ? b.key : a.key);
    else homes.set(id, a.key < b.key ? a.key : b.key);   // deterministic, both devices agree
  });
  return homes;
}
/* Drops every copy of a task that is sitting somewhere other than the
   home just decided for it. Runs after the per-list merges, so the
   surviving copy is whichever version those merges chose — this only
   settles WHERE it lives, never which fields it has. */
function enforceTaskHomes(homes) {
  let removed = 0;
  const keep = (list, key) => (list || []).filter(t => {
    if (!t || !t.id) return true;
    const home = homes.get(t.id);
    if (!home || home === key) return true;
    removed++;
    return false;
  });
  state.tasks = keep(state.tasks, "tasks");
  ["gsi", "personal"].forEach(store => {
    (state?.[store]?.projects || []).forEach(p => {
      if (!p || !p.id) return;
      p.tasks = keep(p.tasks, store + ":" + p.id + ":tasks");
      p.archivedTasks = keep(p.archivedTasks, store + ":" + p.id + ":archivedTasks");
    });
  });
  if (removed) console.info("[sync] removed " + removed + " stray duplicate task copy/copies");
  return removed;
}

/* Duplicates already written to the cloud before the fix above existed
   will not clear themselves: both copies are legitimately present on
   both devices now, so every future merge agrees about them. They have
   to be swept once.

   Kept separate from the merge, and deliberately conservative — it only
   ever acts on an id it finds in more than one list at the same moment,
   which is a state the app itself can never produce. The copy kept is
   the one with the newest updatedAt; ties fall back to the same string
   comparison the merge uses, so two devices sweeping independently
   reach the same answer and neither undoes the other. */
export function sweepDuplicateTasks(quiet) {
  const seen = new Map();          // id -> [{ key, task }]
  const visit = (list, key) => (list || []).forEach(t => {
    if (!t || !t.id) return;
    if (!seen.has(t.id)) seen.set(t.id, []);
    seen.get(t.id).push({ key, task: t });
  });
  visit(state.tasks, "tasks");
  ["gsi", "personal"].forEach(store => {
    (state?.[store]?.projects || []).forEach(p => {
      if (!p || !p.id) return;
      visit(p.tasks, store + ":" + p.id + ":tasks");
      visit(p.archivedTasks, store + ":" + p.id + ":archivedTasks");
    });
  });

  const homes = new Map();
  seen.forEach((hits, id) => {
    if (hits.length < 2) return;
    const best = hits.reduce((a, b) => {
      const ta = a.task.updatedAt || 0, tb = b.task.updatedAt || 0;
      if (tb > ta) return b;
      if (ta > tb) return a;
      return a.key < b.key ? a : b;
    });
    homes.set(id, best.key);
  });
  if (!homes.size) return 0;

  const removed = enforceTaskHomes(homes);
  /* `quiet` when called from inside a merge: applyRemote() persists and
     re-renders once for the whole reconcile, and doing it again from in
     here would re-enter the save path mid-merge. */
  if (removed && !quiet) { state.updatedAt = Date.now(); persist(); rerender(); }
  return removed;
}

function mergeIncomingTasks(remote) {
  const gone = mergeTrashLog(remote);
  const remoteWins = (remote.updatedAt || 0) >= (state.updatedAt || 0);
  // Handed to mergeIncomingRecords() so the rest of the app's lists get
  // the same deletion set and the same tie-breaker.
  lastMergeVerdict = { gone, remoteWins };

  /* Sidebar order. replaceState() takes every top-level field straight
     from `remote`, so any field the merge does not explicitly decide is
     simply the cloud's copy — which is why dragging a Space, then having
     a pull land, reverted the sidebar and made it look like the drag had
     never saved. It had; it was overwritten a moment later.

     An EMPTY order is treated as "this device has no opinion" rather than
     as a deliberate reset, so a device still running an older build — or
     one that has simply never been reordered — cannot wipe an order set
     on another. Only two non-empty, differing orders are a real conflict,
     and that falls to the same document verdict as everything else. */
  const myOrder = Array.isArray(state.navOrder) ? state.navOrder : [];
  const theirOrder = Array.isArray(remote.navOrder) ? remote.navOrder : [];
  if (!theirOrder.length) remote.navOrder = myOrder;
  else if (!myOrder.length) remote.navOrder = theirOrder;
  else remote.navOrder = remoteWins ? theirOrder : myOrder;
  state.navOrder = remote.navOrder;

  // Read BEFORE any list is merged: union-by-id is about to erase the
  // very provenance this needs.
  const homes = decideTaskHomes(remote, remoteWins);

  state.tasks = mergeTaskArray(state.tasks, remote.tasks, gone, remoteWins);

  if (state.gsi && remote.gsi) {
    state.gsi.projects = mergeProjectTrees(state.gsi.projects, remote.gsi.projects, gone, remoteWins);
  }
  if (state.personal && remote.personal) {
    state.personal.projects = mergeProjectTrees(state.personal.projects, remote.personal.projects, gone, remoteWins);
  }

  enforceTaskHomes(homes);
  /* And sweep anything that predates this fix. Cheap (one pass over the
     task lists), a no-op once the data is clean, and it has to run on a
     merge rather than only at startup — the duplicates arrive FROM the
     cloud, so a device that was already open when the bad copy landed
     would otherwise keep showing it until the next reload. */
  sweepDuplicateTasks(true);

  /* Point the remote snapshot at the reconciled lists only now. Doing it
     immediately after each merge — as this used to — published the
     pre-dedupe arrays, so the copy pushed back to the cloud still had
     the task in both projects even when this device had just resolved
     it. The duplicate would then come straight back on the next pull. */
  remote.tasks = state.tasks;
  if (state.gsi && remote.gsi) remote.gsi.projects = state.gsi.projects;
  if (state.personal && remote.personal) remote.personal.projects = state.personal.projects;
}


/* ---------- Everything else that is a list of records ----------
   Tasks, notes, the journal and the whiteboards each got a merge of
   their own as their bugs were found. Every other area of the app —
   medicines and their dose log, habits, goals, prescriptions, saved
   links, feeds, the finance lists, the entertainment catalogue — had
   none, and so fell through to the document-level verdict: whichever
   device the reconcile decided was "newer" replaced the other's copy of
   all of it wholesale.

   That is the medicine tracker bug exactly. Tick a dose on the phone
   while the desktop also has any unsent edit, and the two sides both
   changed since they last agreed; one document wins, and the loser's
   ticks are gone (into Restore, but gone from the screen). It looks like
   "this section doesn't sync" because the outcome is indistinguishable
   from never having synced.

   These lists are all the same shape — arrays of records with an id —
   so they can all use the union-by-id merge tasks already use. An item
   added on either device survives; an item deleted on either device
   stays deleted, because the trash log's `gone` set is shared; an item
   edited on both falls back to the document verdict, which is the same
   answer as before and no worse.

   NOT covered, deliberately, because each needs its own shape of merge
   rather than this one: the contents of a travel plan (packing lists,
   stops), a reference page's links, and map/ink layers. Those still
   follow the document-level verdict. */
let lastMergeVerdict = { gone: new Set(), remoteWins: true };

/* A date-keyed log — habit ticks, medicine doses — reconciled one DAY at
   a time using the per-day stamps written by habits.js / health.js. Two
   devices that ticked different days both keep their ticks, which is the
   normal case and the one that was failing. The same day touched on both
   sides still has to pick one, and picks the later stamp. */
function mergeDayLog(localLog, remoteLog, localStamps, remoteStamps, remoteWins) {
  const out = {};
  const stamps = {};
  const days = new Set([...Object.keys(localLog || {}), ...Object.keys(remoteLog || {})]);
  days.forEach(day => {
    const inLocal = localLog && day in localLog, inRemote = remoteLog && day in remoteLog;
    const ls = (localStamps || {})[day] || 0, rs = (remoteStamps || {})[day] || 0;
    let take;
    if (inLocal && !inRemote) take = "local";
    else if (!inLocal && inRemote) take = "remote";
    else if (ls || rs) take = rs > ls ? "remote" : "local";
    else take = remoteWins ? "remote" : "local";   // no stamps (older saves) — document verdict
    out[day] = take === "remote" ? remoteLog[day] : localLog[day];
    const st = Math.max(ls, rs);
    if (st) stamps[day] = st;
  });
  return { log: out, stamps };
}

function mergeIncomingRecords(remote) {
  const { gone, remoteWins } = lastMergeVerdict;
  const list = (a, b) => mergeTaskArray(a, b, gone, remoteWins);
  // Both sides get the merged result: `state` so it's on screen now,
  // `remote` so whichever copy gets pushed back carries it too.
  const both = (path, merged) => {
    const keys = path.split(".");
    const last = keys.pop();
    let ls = state, rs = remote;
    for (const k of keys) { ls = ls?.[k]; rs = rs?.[k]; }
    if (ls) ls[last] = merged;
    if (rs) rs[last] = merged;
  };
  const get = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);

  [
    "goals", "habits", "links", "feeds",
    "health.medicines", "health.prescriptions",
    "entertainment.items",
    "finance.grocery", "finance.shopping", "finance.wishlist", "finance.emiTable.rows",
    "reference.kmlLayers",
    "travel.plans", "reference.pages",
    /* "links" above is only My Day's Important links — state.links. Every
       OTHER link list in the app was missing from here and so fell through
       to the document verdict, which is why a link added on one device
       could simply be gone after the next sync: nothing merged it, so the
       losing document's copy of the whole list was discarded.

       All the same shape as the lists above — arrays of {id, title, url}
       or {id, name, url} — so they take the same union-by-id merge with
       nothing new to reason about. The per-section Links cards are keyed
       dynamically and handled just below. */
    "personal.links", "personal.docs",
    "gsi.links", "gsi.personalDocs",
    /* Same list shape, same bug, same fix — grouped separately only
       because they are not links. */
    "gsi.log", "gsi.meetings",
  ].forEach(path => {
    const l = get(state, path), r = get(remote, path);
    if (!Array.isArray(l) && !Array.isArray(r)) return;
    both(path, list(l, r));
  });

  /* The Links card on every section page — Finance, Health, Communication,
     Reference, and the Personal Workspace's own Notes-page links. Keyed by
     section rather than a fixed path, so the union of both sides' keys is
     walked: a section that exists on only one device still gets merged
     rather than being skipped. `both` no-ops on a side that lacks the
     section, so a missing key is safe. */
  new Set([
    ...Object.keys(state.sections || {}),
    ...Object.keys(remote.sections || {}),
  ]).forEach(key => {
    const path = `sections.${key}.links`;
    const l = get(state, path), r = get(remote, path);
    if (!Array.isArray(l) && !Array.isArray(r)) return;
    both(path, list(l, r));
  });

  /* Monthly expenses are a map of months, each holding its own rows —
     merged per month, then per row by id, so a row added on the phone in
     August and one added on the desktop in July both survive. */
  const lm = get(state, "finance.monthlyExpenses.months") || {};
  const rm = get(remote, "finance.monthlyExpenses.months") || {};
  const months = {};
  new Set([...Object.keys(lm), ...Object.keys(rm)]).forEach(m => {
    months[m] = Object.assign({}, lm[m], rm[m], { rows: list(lm[m]?.rows, rm[m]?.rows) });
  });
  both("finance.monthlyExpenses.months", months);

  const habit = mergeDayLog(state.habitLog, remote.habitLog, state.habitLogUpdated, remote.habitLogUpdated, remoteWins);
  both("habitLog", habit.log);
  both("habitLogUpdated", habit.stamps);

  const dose = mergeDayLog(
    state.health?.medicineLog, remote.health?.medicineLog,
    state.health?.medicineLogUpdated, remote.health?.medicineLogUpdated, remoteWins);
  both("health.medicineLog", dose.log);
  both("health.medicineLogUpdated", dose.stamps);

  /* Minutes meditated per day: a number per date, and a date only ever
     appears because someone logged on that device. Highest wins — a
     larger number is always the result of more sessions being counted,
     and taking the lower one would be forgetting a session. */
  const med = {};
  new Set([...Object.keys(state.meditation || {}), ...Object.keys(remote.meditation || {})]).forEach(d => {
    med[d] = Math.max(Number((state.meditation || {})[d]) || 0, Number((remote.meditation || {})[d]) || 0);
  });
  both("meditation", med);
}

function mergeIncomingBrainstormBoards(remote) {
  BOARD_LISTS.forEach(({ list, active }) => mergeIncomingBoardList(remote, list, active));
}

/* THE NOTEBOOK MERGE — and why it has to exist.

   Without it the notebook rode on the whole-document verdict, and that had
   a failure mode far worse than the usual "both devices edited offline"
   caveat: a device whose stored copy PREDATES the notebook has one
   fabricated for it by merge() in state.js — an empty General/Untitled
   page, and (because DEFAULT_STATE uses fixed ids) an empty page carrying
   the very same id as the one being written on elsewhere. That fabricated
   emptiness is indistinguishable from real content at document level. So
   opening the phone after writing on the desktop meant the phone's blank
   default could win the document comparison and be pushed up, wiping the
   desktop's pages out of the cloud — and off the desktop at its next pull.
   Exactly the "I wrote on the desktop, opened the phone, it's gone from
   both" report.

   Reconciling per section and per page removes the whole class of problem:
   an empty page with updatedAt 0 can never beat a written one, because the
   comparison is now between two pages rather than two documents. */
function mergeNotebookPages(ls, rs, gone, remoteWins, conflicts) {
  const byId = new Map();
  (ls.pages || []).forEach(p => { if (p && p.id && !gone.has(p.id)) byId.set(p.id, p); });
  (rs.pages || []).forEach(rp => {
    if (!rp || !rp.id || gone.has(rp.id)) return;
    const lp = byId.get(rp.id);
    if (!lp) { byId.set(rp.id, rp); return; }

    const a = journalPlainForCompare(lp.html), b = journalPlainForCompare(rp.html);
    let winner;
    if (a === b) winner = (rp.updatedAt || 0) >= (lp.updatedAt || 0) ? rp : lp;
    // One text containing the other is an append — the longer one is the
    // continuation of the shorter, so nothing is lost by keeping it and
    // the clocks don't get a say. Same rule the journal merge uses.
    else if (a && b && a.includes(b)) winner = lp;
    else if (a && b && b.includes(a)) winner = rp;
    else {
      const lt = lp.updatedAt || 0, rt = rp.updatedAt || 0;
      const takeRemote = (lt || rt) ? rt > lt : remoteWins;
      winner = takeRemote ? rp : lp;
      const loser = takeRemote ? lp : rp;
      // Only a real fork is worth filing — an empty side losing to a
      // written one is just this device catching up, not lost work.
      if (journalPlainForCompare(loser.html)) conflicts.push({ page: loser, sectionId: rs.id });
    }
    // A name edited on one device shouldn't be dragged back by the other
    // device winning on text alone; the newer name wins on its own.
    const named = (rp.updatedAt || 0) > (lp.updatedAt || 0) ? rp : lp;
    byId.set(rp.id, Object.assign({}, winner, { name: named.name || winner.name }));
  });

  // Remote order first (the copy both devices last agreed on), then any
  // page this device has that the cloud hasn't seen yet.
  const order = [], seen = new Set();
  (rs.pages || []).forEach(p => { const m = p && byId.get(p.id); if (m && !seen.has(p.id)) { seen.add(p.id); order.push(m); } });
  (ls.pages || []).forEach(p => { const m = p && byId.get(p.id); if (m && !seen.has(p.id)) { seen.add(p.id); order.push(m); } });
  return order;
}

function mergeIncomingNotebook(remote) {
  const { gone, remoteWins } = lastMergeVerdict;
  const ln = state.notebook, rn = remote.notebook;
  if (!rn || !Array.isArray(rn.sections)) { remote.notebook = ln; return; }
  if (!ln || !Array.isArray(ln.sections)) { state.notebook = rn; return; }

  /* WHICH SECTION AND PAGE ARE OPEN IS THIS DEVICE'S BUSINESS. Same
     reasoning as the note tabs above: selecting a page doesn't change any
     content, so it can't be allowed to be decided by the other device. */
  const localSection = ln.activeSection;
  const localPage = {};
  ln.sections.forEach(s => { if (s && s.id) localPage[s.id] = s.activePage; });

  const conflicts = [];
  const bySec = new Map();
  ln.sections.forEach(s => { if (s && s.id && !gone.has(s.id)) bySec.set(s.id, s); });
  rn.sections.forEach(rs => {
    if (!rs || !rs.id || gone.has(rs.id)) return;
    const ls = bySec.get(rs.id);
    if (!ls) { bySec.set(rs.id, rs); return; }
    /* A section's own name and colour need a timestamp of their own, or
       they fall back to the document verdict — the very thing this merge
       exists to get away from, and enough on its own to drag a renamed
       section back to "General". Sections are stamped on rename now;
       where neither side carries one (data written before that), the
       newest page inside the section stands in for it, which is still a
       far better signal than which whole document happened to win. */
    const newestPage = s => (s.pages || []).reduce((n, p) => Math.max(n, (p && p.updatedAt) || 0), 0);
    const lt = ls.updatedAt || 0, rt = rs.updatedAt || 0;
    let takeRemoteMeta;
    if (lt || rt) takeRemoteMeta = rt > lt;
    else {
      const lnp = newestPage(ls), rnp = newestPage(rs);
      takeRemoteMeta = (lnp || rnp) ? rnp > lnp : remoteWins;
    }
    const meta = takeRemoteMeta ? rs : ls;
    bySec.set(rs.id, Object.assign({}, ls, {
      name: meta.name || ls.name,
      color: typeof meta.color === "number" ? meta.color : (ls.color || 0),
      updatedAt: Math.max(lt, rt) || undefined,
      pages: mergeNotebookPages(ls, rs, gone, remoteWins, conflicts)
    }));
  });

  const order = [], seen = new Set();
  rn.sections.forEach(s => { const m = s && bySec.get(s.id); if (m && !seen.has(s.id)) { seen.add(s.id); order.push(m); } });
  ln.sections.forEach(s => { const m = s && bySec.get(s.id); if (m && !seen.has(s.id)) { seen.add(s.id); order.push(m); } });

  // Reassert the local view over the merged tree.
  order.forEach(s => {
    const want = localPage[s.id];
    if (want && (s.pages || []).some(p => p.id === want)) s.activePage = want;
    else if (!(s.pages || []).some(p => p.id === s.activePage)) s.activePage = (s.pages && s.pages[0] && s.pages[0].id) || "";
  });
  const merged = {
    sections: order,
    activeSection: order.some(s => s.id === localSection) ? localSection : ((order[0] && order[0].id) || "")
  };
  /* An empty result means every section is in the trash on one side or
     the other. Left as-is deliberately: merge() in state.js and
     ensureNotebook() both rebuild a starter section from empty, and doing
     it here as well would just be a third place to keep in step. */
  state.notebook = merged;
  remote.notebook = merged;

  /* Nothing is dropped silently. The losing copy is filed under a fresh
     id — never the live page's id, which would put it in `gone` and have
     the next merge delete the page it was meant to protect. */
  conflicts.forEach(({ page: p, sectionId }) => {
    try {
      moveToTrash("notebookPage", {
        id: "nb-conflict-" + p.id + "-" + uid(),
        name: (p.name || "Untitled page") + " (other device's copy)",
        html: p.html, createdAt: p.createdAt, updatedAt: p.updatedAt
      }, { sectionId }); // restores back into the section it forked from
    } catch (e) { console.warn("[sync] could not file notebook conflict copy", e); }
  });
  if (conflicts.length) {
    toast(conflicts.length === 1
      ? "Two versions of one notebook page — the other copy is in Trash"
      : conflicts.length + " notebook pages had two versions — the other copies are in Trash");
  }
}
/* Google Links (the Notebook page's tabbed link strip) merges by id — tab
   by tab, and link by link within a tab — exactly as mergeWorkDocGroups
   does for a project's Work documents, and for the same reason: a tab or
   a link added on one device must survive a pull from a device that has
   never seen it, rather than one side's whole list replacing the other's.
   Neither carries an updatedAt, so an item edited on both sides falls
   back to the document-level `remoteWins` verdict. */
function mergeIncomingGoogleLinks(remote) {
  const { gone, remoteWins } = lastMergeVerdict;
  const lg = state.googleLinks, rg = remote.googleLinks;
  if (!rg || !Array.isArray(rg.groups)) { remote.googleLinks = lg; return; }
  if (!lg || !Array.isArray(lg.groups)) { state.googleLinks = rg; return; }

  const byId = new Map();
  (lg.groups || []).forEach(g => { if (g && g.id && !gone.has(g.id)) byId.set(g.id, g); });
  (rg.groups || []).forEach(rgr => {
    if (!rgr || !rgr.id || gone.has(rgr.id)) return;
    const lgr = byId.get(rgr.id);
    if (!lgr) { byId.set(rgr.id, rgr); return; }
    const links = new Map();
    (lgr.links || []).forEach(l => { if (l && l.id) links.set(l.id, l); });
    (rgr.links || []).forEach(l => { if (l && l.id && !gone.has(l.id)) links.set(l.id, l); });
    const merged = remoteWins ? Object.assign({}, lgr, rgr) : Object.assign({}, lgr);
    merged.links = [...links.values()].filter(l => !gone.has(l.id));
    byId.set(rgr.id, merged);
  });

  const groups = [...byId.values()];
  /* WHICH TAB IS OPEN IS THIS DEVICE'S BUSINESS — same rule the notebook's
     own active section and page follow just above. */
  const out = {
    groups,
    activeGroup: groups.some(g => g.id === lg.activeGroup) ? lg.activeGroup : ((groups[0] && groups[0].id) || "")
  };
  /* An empty result is left alone deliberately: merge() in state.js and
     ensureGoogleLinks() both rebuild a starter tab from empty. */
  state.googleLinks = out;
  remote.googleLinks = out;
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
  try { flushNotebookEditor(); } catch (e) { /* editor not mounted */ }
  setSyncPill("busy", "Syncing…");
  /* Up for the whole reconciliation, not just the merge — the earliest
     and easiest-to-hit window for the race this closes is the network
     await two lines down, before a single field has been touched. */
  reconcileInFlight = true;
  try {
    const { data, error } = await sb.from("lifeos_data")
      .select("data, updated_at").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    /* The version this read observed. Deliberately NOT committed yet: see
       commitStamp() below. Everything from here to the end of the reconcile
       runs inside an inner function so that an exception anywhere in it
       skips the commit rather than recording a version this device never
       actually applied. The early `return`s in the branches return from
       THIS function, so the commit still happens on every successful path. */
    const observedStamp = data ? data.updated_at : null;
    const selfBefore = lastSelfStamp;
    let appliedRemote = false;
    /* A function, not an extra statement after each call: one of the call
       sites is the consequent of an `if` with an `else` attached, where a
       second statement would detach the else. */
    const adoptRemote = r => { applyRemote(r); appliedRemote = true; };

    await (async () => {
      if (data && data.data && Object.keys(data.data).length) {
        const remote = await decodeCloudRow(data.data);
        /* A decode that yields nothing usable must never reach the merges:
           they would read absent keys as "the other side deleted everything"
           and this device would then helpfully write that emptiness back. */
        if (!remote || typeof remote !== "object" || !Object.keys(remote).length) {
          throw new Error("cloud data could not be read");
        }
        checkClockSkew(data.updated_at);
        authDiag("full read: " + Math.round(JSON.stringify(data.data).length / 1024) + " KB downloaded");
        mergeIncomingWhiteboards(remote);
        mergeIncomingBrainstormBoards(remote);
        mergeIncomingSectionNotes(remote);
        mergeIncomingTasks(remote);
        mergeIncomingRecords(remote); // after mergeIncomingTasks: reuses the trash log's `gone` set and its verdict
        mergeIncomingJournal(remote); // after the trash log has been merged, which mergeIncomingTasks does
        mergeIncomingNotebook(remote); // after mergeIncomingTasks: needs its `gone` set and verdict
        mergeIncomingGoogleLinks(remote); // same `gone` set and verdict as the notebook merge above
        /* Course progress is append-shaped, so an incoming copy is combined
           with this device's rather than replacing it — the same reason the
           journal and the ink merge instead of one side winning. */
        remote.communication = state.communication = mergeCommunication(state.communication, remote.communication);
        // The merge just changed local state (possibly pulling in board
        // data from the remote side) independent of whatever the win/lose
        // branching below decides — make sure that's actually reflected
        // here, not just in the payload that eventually gets pushed back.
        persist(false); rerender();
        redrawAllInk(); // merged strokes are in state; the canvases still show the old set

        const mine = hasLocalEdits();
        const theirs = cloudChangedSinceLastSync(remote);

        if (preferRemote) { adoptRemote(remote); }
        else if (!agreedWithCloud()) {
          /* First run after upgrading, so there's no record of a previous
             agreement to reason from. Fall back to the old timestamp
             comparison this once; from the next successful sync onward the
             clock is out of the picture for good. */
          if ((remote.updatedAt || 0) > (state.updatedAt || 0)) adoptRemote(remote);
          else {
            // Same reasoning as the conflict branch below: don't let a
            // clock comparison be the only thing standing between the
            // cloud's copy and oblivion.
            try { takeSnapshot("cloud-version-overwritten", remote); } catch (e) {}
            hasReconciled = true; await saveRemote(true); return;
          }
        }
        else if (!mine && theirs) {
          adoptRemote(remote);                       // cloud moved, this device didn't — take it
        }
        else if (mine && !theirs) {
          hasReconciled = true; await saveRemote(true); return;  // only this device moved — send it
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
            adoptRemote(remote);
            toast("Another device had newer changes — its version is now shown. Yours is in Restore.");
          } else {
            /* This device is about to overwrite a cloud version it never
               merged — the other device's work is one upsert from being
               gone. Keep the incoming payload as a snapshot first, so it can
               be recovered from Restore rather than existing nowhere. */
            try { takeSnapshot("cloud-version-overwritten", remote); }
            catch (e) { console.warn("[sync] pre-overwrite snapshot failed", e); }
            hasReconciled = true; await saveRemote(true);
            toast("This device had newer changes — sent up. The other device's version is in Restore.");
            return;
          }
        }
        // neither side moved: nothing to do
      } else {
        hasReconciled = true; await saveRemote(true); return;      /* first device: seed the cloud copy */
      }
      hasReconciled = true;
      if (pendingSaveAfterReconcile) { pendingSaveAfterReconcile = false; await saveRemote(true); return; }
      setSyncPill("ok", "Synced · " + nowTime());
    })();

    /* Commit only now, and only if saveRemote() did not run inside the
       reconcile above — when it did, it has already recorded its own,
       newer stamp and overwriting that with the older observed one would
       make the next probe see a phantom change. Comparing lastSelfStamp
       rather than the timestamps themselves keeps this correct on a device
       whose clock is wrong. */
    if (observedStamp && lastSelfStamp === selfBefore) commitStamp(observedStamp);
    return appliedRemote ? "updated" : "ok";
  } catch (e) {
    /* hasReconciled is NOT set here. It used to be, with the comment
       "don't block saves forever over one failed check" — but a read that
       failed has told this device nothing about the cloud, and opening the
       gate on it means the next save can overwrite a newer remote version
       sight unseen. Blocking cloud saves until a check succeeds is the
       safe direction: the edits are already on this device and queued in
       pendingSaveAfterReconcile.

       The trade is real and worth naming: if reads fail persistently —
       RLS denying SELECT, say, while INSERT is allowed — this device will
       not upload at all. That is the correct outcome. The pill says so
       rather than showing a false "Synced". */
    authDiag("LOAD failed: " + (e.message || e) + (e.code ? " [code " + e.code + "]" : "") + (e.hint ? " — " + e.hint : ""));
    setSyncPill("err", "Sync failed — tap Sync");
    /* Reported, not thrown: callers decide what to do. The stamp is NOT
       advanced here, so the same cloud version is retried next time. */
    return "failed";
  } finally {
    /* Released on every path, success or failure, the same way saveInFlight
       is — an early return left this set would leave every future edit
       queued forever instead of saved.

       Deliberately NOT flushing pendingSaveAfterReconcile here anymore.
       This is ONE loadRemote() call, and runSyncChain() may already know
       it's about to run another (loadAgainAfter) the moment this one
       returns — a fire-and-forget saveRemote() fired from here would then
       race the very next reconciliation in the chain, uploading while it
       reads. The flush now happens exactly once, in runSyncChain(),
       after its drain loop confirms no further reconciliation is queued.
       See the comment there for the scenario this replaces. */
    reconcileInFlight = false;
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

/* ---------- why the handshake above needed a second half ----------

   The plan was: announce the capability in one plain save, compress from
   the next one onward. It has a deadlock in it, and this account hit it.

   `compressionReady` lives on the synced document. So:

     1. the flag is false, so the save goes up as plain JSON — 1597 KB;
     2. Supabase rejects a body that size, so the save fails;
     3. the flag was set to true in memory, but only in memory;
     4. a minute later the poll pulls, applyRemote() calls replaceState(),
        merge() reads `compressionReady` from the CLOUD row — which never
        received it, because step 2 failed — and the flag is false again;
     5. go to 1, once a minute, forever.

   The announcement can only be delivered by a save, and the save is the
   thing that cannot happen. Nothing the person does to their data breaks
   the cycle, because the cycle is not about their data.

   Two changes, both narrow:

   COMPRESS WHEN PLAIN CANNOT WORK. If the plain body is over the limit,
   compression is not an optimisation to be phased in politely — it is the
   only way the save happens at all. The handshake's purpose is to stop an
   account being switched to a format some other device cannot read; a row
   that never saved cannot be read by ANY device, so there is nothing left
   to protect and waiting costs the person their sync.

   REMEMBER IT WHERE A PULL CANNOT REACH. localStorage, not the document.
   Keyed by account, not just by browser: it is a fact about which
   browser has proven it can read compressed rows for a given account,
   and a shared browser can hold more than one account's history. Keying
   on the browser alone would let one account's capability flag leak into
   a second account signed in later, skipping that account's own
   one-save handshake. Whichever source says yes wins, and the document
   flag is still written so other devices learn it the ordinary way. */
const COMPRESSION_OK_KEY = "lifeos-compression-ok";
/* Scoped per account, the same way stampKey() below scopes the sync
   stamp — this is a fact about which account is signed in on this
   browser, not about the browser itself. Without the suffix, one
   account's "this browser can read compressed rows" flag would leak
   into a second account signed into the same browser, and that
   account's first save could go out compressed before any of ITS
   devices had a chance to prove they understand the format. */
function compressionKey() { return COMPRESSION_OK_KEY + ":" + (user ? user.id : "anon"); }
function compressionAgreed() {
  if (state.compressionReady) return true;
  try { return localStorage.getItem(compressionKey()) === "1"; } catch (_) { return false; }
}
function rememberCompressionAgreed() {
  try { localStorage.setItem(compressionKey(), "1"); } catch (_) { /* private browsing — the document flag still carries it */ }
}

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

/* The wire envelope for a compressed row.

   `updatedAt: 0` and `rev: 0` are deliberate and they are the safety net.
   A build too old to know about _transport will read this row as a
   document with almost nothing in it. What it does next is decided by
   comparing timestamps — and a zero means "the cloud is older than
   anything I hold", so that build pushes ITS copy up rather than adopting
   the emptiness it just failed to understand. The compressed row is
   overwritten with a plain one, the old device keeps everything, and this
   build simply compresses again on its next save. The degradation is a
   wasted round trip instead of a wiped account.

   `compressionReady` rides along in the clear for the same reason it
   always did: so a device reading this row learns the account has already
   moved, without having to decode anything first. */
function compressedBody(gz) {
  return { _transport: CLOUD_TRANSPORT, z: bytesToB64(gz), compressionReady: true, updatedAt: 0, rev: 0 };
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

export async function saveRemote(fromReconcile = false) {
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
  /* A reconciliation is mid-flight and this call is not part of it —
     defer rather than upload underneath it. See the note beside
     reconcileInFlight above. The internal calls loadRemote() makes to
     push its own reconciliation decision pass fromReconcile=true and are
     the one case allowed through while this is set. */
  if (!fromReconcile && reconcileInFlight) { pendingSaveAfterReconcile = true; return; }
  /* Never push this device's data up before it has checked what's already in
     the cloud — otherwise a stale local copy (e.g. a laptop that's been
     asleep for days) can silently overwrite a newer edit made on another
     device. Queue the save; it fires automatically once loadRemote() has
     run at least once this session. */
  if (!hasReconciled) { pendingSaveAfterReconcile = true; return; }
  if (saveInFlight) { saveAgainAfter = true; return; }
  saveInFlight = true;
  setSyncPill("busy", "Saving…");
  /* Read in the catch: a plain body that was rejected is worth one more
     try compressed, and a compressed body that was rejected is not. */
  let sentCompressed = false;
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
    /* Over the limit, plain JSON has no chance of landing — see the note
       beside COMPRESSION_OK_KEY. Compress on this save rather than after
       a round trip that is certain to be rejected. */
    const plainCannotWork = payloadBytes > BIG_PAYLOAD_BYTES;
    if (compressionAgreed() || plainCannotWork) {
      const gz = await gzipBytes(JSON.stringify(payload));
      if (gz) {
        body = compressedBody(gz);
        wireBytes = JSON.stringify(body).length;
        sentCompressed = true;
        rememberCompressionAgreed();
        if (plainCannotWork && !state.compressionReady) {
          authDiag("payload over " + Math.round(BIG_PAYLOAD_BYTES / 1024) + " KB — compressing this save (" +
                   Math.round(payloadBytes / 1024) + " KB → " + Math.round(wireBytes / 1024) + " KB)");
        }
      } else if (plainCannotWork) {
        /* No CompressionStream in this browser and the body is too big.
           Say so plainly rather than letting it fail as a bare fetch
           error, which reads as a network problem and is not one. */
        authDiag("payload is " + Math.round(payloadBytes / 1024) + " KB and this browser cannot compress — " +
                 "use Reclaim space, or empty Trash, to get under " + Math.round(BIG_PAYLOAD_BYTES / 1024) + " KB");
      }
    }
    state.compressionReady = true;

    const stamp = new Date().toISOString();
    /* BEFORE the await, not after. Realtime emits the change the moment
       the row commits, which can be well before the upsert promise
       resolves here — and a guard set afterwards is not yet set when the
       echo of this very write arrives, so the handler reads it as another
       device and pulls the whole document straight back. Registering the
       identity first closes that window entirely. */
    const previousSelfStamp = lastSelfStamp;
    lastSelfStamp = stamp;
    const { error } = await sb.from("lifeos_data").upsert({
      user_id: user.id, data: body, updated_at: stamp
    });
    if (error) {
      /* The write did not land, so this stamp names nothing. Leaving it in
         place would make the guard suppress a later, genuine remote update
         that happened to carry it. */
      lastSelfStamp = previousSelfStamp;
      throw error;
    }
    /* Report the WIRE size, not the raw document. Once the transport is
       compressed those are very different numbers, and warning about the
       uncompressed one would keep alarming people about a constraint that
       no longer applies. */
    lastPayloadBytes = wireBytes;
    lastSizeCheck = Date.now();
    /* The write landed, so this tab holds exactly what the cloud holds —
       commit it as the merged version. This also stops the next probe
       reading our own save as somebody else's change and pulling back the
       document we just sent. */
    commitStamp(stamp);
    saveErrorShown = false; // a success re-arms the explanation for any future failure
    markAgreed(token); // this device and the cloud now hold the same thing
    const pill = document.getElementById("syncPill");
    if (pill) pill.title = "Last upload " + Math.round(payloadBytes / 1024) + " KB — every save sends the whole document";
    setSyncPill("ok", "Synced · " + nowTime());
  } catch (e) {
    let size = "?";
    try { size = Math.round(JSON.stringify(state).length / 1024) + " KB"; } catch (_) {}
    authDiag("SAVE failed (payload " + size + "): " + (e.message || e) + (e.code ? " [code " + e.code + "]" : "") + (e.hint ? " — " + e.hint : ""));
    /* A REJECTED PLAIN BODY EARNS ONE COMPRESSED ATTEMPT.

       The size threshold above catches the obvious case, but the real
       request-body limit is the server's, not ours, and it is not a number
       this app gets to know. A body under our threshold can still be
       refused. Rather than guess at the limit, take the rejection itself as
       the evidence: send the same document again, compressed, once.

       Bounded by sentCompressed, so a compressed body that is ALSO refused
       is a genuine failure and reported as one — this cannot become a
       retry loop. */
    const canRetryCompressed = !sentCompressed && typeof CompressionStream !== "undefined";
    if (canRetryCompressed) {
      rememberCompressionAgreed();
      saveAgainAfter = true;
      authDiag("plain save refused — retrying compressed");
    }
    const why = explainSaveError(e);
    setSyncPill("err", why.pill);
    /* Shown once per session, not on every retry: a modal that reopens on
       each failed save would be its own problem. And not at all while a
       compressed retry is still to come — announcing a failure that is
       about to fix itself is how a working app looks broken. */
    if (!saveErrorShown && !canRetryCompressed) {
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
  //
  // The `true` means "probe right now even if a recent failure would
  // otherwise have this tab sitting out a backoff window" — it does NOT
  // force a full document download. Pressing Sync when nothing has
  // actually changed now costs exactly what a background poll costs: one
  // small updated_at probe, not the whole document.
  await syncCheck("manual", true); await saveRemote();
  toast("Synced");
}

/* ---------- live cross-device updates ---------- */
/* Realtime delivery depends on the lifeos_data table being added to the
   database's realtime publication — a setting in the Supabase dashboard,
   not something this code can switch on. If it was never enabled, the
   subscription below silently delivers nothing forever and cross-device
   updates only ever arrive when a tab is re-focused. Rather than depend
   on a setting that can't be verified from here, poll gently as well:
   only while the tab is actually visible, and only when this device has
   nothing unsaved to lose.

   That last claim used to be wrong, and expensively so: "an unchanged
   cloud costs one small read" described the intent, not the code. The
   poll ran `select data, updated_at` and compared revisions only AFTER
   the whole ~450 KB document had already been downloaded. Four ticks a
   minute of an idle tab is roughly 108 MB an hour. It is now true — the
   comparison happens against a timestamp fetched on its own. */
let pollTimer = null;
/* Two intervals, because the poll is doing two different jobs.

   When realtime is subscribed it is only a safety net against a missed
   push, so it can be slow. When realtime is down — the table not in the
   publication, a blocked websocket, a flaky network — it is the ONLY way
   an update from the other device ever arrives, so it has to stay brisk.

   Both tick a PROBE, not a download: one timestamp, a few hundred bytes.
   The old 15-second full read cost about 450 KB a tick, which is where
   the 6 GB went. At this size the interval stops being the thing that
   matters, so the fast one stays fast. */
const POLL_FAST_MS = 15_000;   // realtime not delivering — the probe is the only route in
const POLL_SLOW_MS = 120_000;  // realtime is live — this is just a backstop
let pollEveryMs = POLL_FAST_MS;
function startPolling() {
  stopPolling();
  pollEveryMs = realtimeConnected ? POLL_SLOW_MS : POLL_FAST_MS;
  pollTimer = setInterval(() => {
    if (document.hidden || !user || !sb) return;
    if (!safeToPullNow()) { scheduleDeferredPull(); return; } // never repaint under a caret
    syncCheck("poll");
  }, pollEveryMs);
}
/* Called when the channel's status changes: the poll's job changes with
   it, so its cadence should too. */
function retunePolling() {
  const want = realtimeConnected ? POLL_SLOW_MS : POLL_FAST_MS;
  if (want !== pollEveryMs && pollTimer) startPolling();
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function startRealtime() {
  stopRealtime();
  startPolling();
  /* COLUMN SELECTION IS THE POINT OF THIS SUBSCRIPTION.

     By default a Postgres Changes event carries the whole row, so every
     save on one device pushed the entire ~434 KB document to every other
     device. `select` narrows the payload to the primary key and the
     timestamp; the handler then decides whether the document is worth
     asking for, and the device that needs it fetches it once.

     THERE IS NO FULL-ROW FALLBACK, deliberately. An earlier version
     dropped back to a full-row subscription on CHANNEL_ERROR — which is
     also what a flaky websocket, a suspended phone and an expiring
     session look like, so one bad minute would have re-armed the exact
     egress this work exists to remove, permanently, for the rest of the
     session. If column selection is unavailable in this environment the
     right degradation is the metadata probe, which is already running and
     costs a few hundred bytes a tick. Realtime is an optimisation here,
     never the only route in. */
  rtChannel = sb.channel("lifeos-" + user.id)
    .on("postgres_changes", {
      event: "*", schema: "public", table: "lifeos_data",
      filter: "user_id=eq." + user.id,
      select: "user_id,updated_at"
    }, payload => {
      const row = payload.new;
      if (!row) return;
      const stamp = row.updated_at;
      /* This tab's own write, echoed back. Registered before the upsert
         was sent (see saveRemote), so it is always set by the time the
         echo can arrive. */
      if (stamp && stamp === lastSelfStamp) return;
      if (stamp && !remoteStale && stamp === loadStamp()) return;   // already merged
      if (!safeToPullNow()) {
        /* Don't repaint under a caret. The deferred pull retries as soon
           as typing stops; genuine unsaved edits are reconciled by
           loadRemote() with its conflict rules intact. */
        setSyncPill("busy", "Changes waiting — tap Sync");
        scheduleDeferredPull();
        return;
      }
      authDiag("realtime: another device wrote at " + (stamp || "?") + " — checking");
      /* Through the coordinator, so a realtime push arriving while a poll
         or a visibility check is mid-read coalesces instead of starting a
         second concurrent read of the same document. The probe inside is
         near-free and confirms the push rather than trusting it. */
      syncCheck("realtime").then(r => {
        // Only after a document was actually downloaded AND reconciled.
        if (r === "updated" || r === "ok") toast("Updated from another device");
      });
    })
    .subscribe(status => {
      // Visible on the device where it's failing — the whole point of
      // authDiag. CHANNEL_ERROR/TIMED_OUT here means the channel is down
      // and the metadata probe is carrying the load.
      authDiag("realtime: " + status);
      const nowConnected = (status === "SUBSCRIBED");
      if (nowConnected === realtimeConnected) return;   // nothing changed; don't touch the timer
      realtimeConnected = nowConnected;
      retunePolling();
      /* supabase-js rejoins the channel itself. Nothing here removes or
         re-creates it — doing that from inside a status callback is how a
         flapping connection turns into a channel churn loop. */
    });
}

function stopRealtime() {
  /* Signing out or dropping the channel means the probe is on its own
     again — put it back in the fast gear rather than leaving a stale
     two-minute cadence behind. */
  realtimeConnected = false;   // so a later startPolling() picks the fast gear
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
   fresh <script> tag; the first that defines window.supabase wins.

   Pinned to the same exact version the primary tag's floating "@2" tag
   currently resolves to, not an old snapshot — pinned old enough and this
   silently reintroduces exactly the egress problem the probe/Realtime
   work was for. Realtime's column selection (select: "user_id,updated_at"
   on the postgres_changes subscription below) needs supabase-js 2.109.0
   or newer; the version this used to pin to, 2.45.4, predates that
   capability entirely. A client that fell back to it would silently drop
   the column filter and receive the FULL row on every change — the exact
   full-row Realtime fallback this file's comments elsewhere say was
   deliberately never added. Bump this alongside the primary tag's
   effective version from time to time; jsDelivr's floating "@2" moves on
   its own and these two hard-coded fallbacks do not. */
const LIB_FALLBACKS = [
  "https://unpkg.com/@supabase/supabase-js@2.116.0/dist/umd/supabase.js",
  "https://cdn.skypack.dev/pin/@supabase/supabase-js@v2.116.0/mode=raw/dist/umd/supabase.js"
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
      /* A different account than whichever one last left data in this
         browser's local document — reset before anything can sync, so
         this account's first save can't silently carry the other
         account's tasks, notes and whiteboards up to its own cloud row.
         Same account signing back in (including the common case: never
         signed out anyone else) leaves the local document exactly alone. */
      const owner = localOwner();
      if (owner && owner !== user.id) {
        authDiag("different account signed in on this browser — starting from a clean local document");
        resetLocalStateForNewAccount();
      }
      setLocalOwner(user.id);
      /* Boot. A device that has never synced needs the document; one
         returning to a cloud it already matches does not — which is the
         difference between paying 450 KB on every page refresh and paying
         it only when something actually moved. */
      syncCheck("startup"); startRealtime();
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
    else { stopRealtime(); forgetStamp(); hasReconciled = false; pendingSaveAfterReconcile = false; setSyncPill("", "Local only"); }
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
      else if (user && safeToPullNow()) { clearProbeBackoff(); syncCheck("visible"); }
      else if (user) scheduleDeferredPull();
    });
    /* A second, independent safety net: on some platforms (especially
       mobile) visibilitychange doesn't fire reliably right before an
       actual tab close, but pagehide does. */
    window.addEventListener("pagehide", flushPendingSave);
    /* Reconnection. There was no handler for this at all: after an outage
       the app waited for the poll, and — now that a failed probe keeps the
       save gate shut — a queued upload waited with it, for as long as the
       backoff had grown to. `online` is the earliest evidence that the
       conditions which caused the failures have changed, so it clears the
       backoff and runs one check. If that check succeeds the gate opens
       and the queued save flushes; if it doesn't, the backoff simply
       starts again. */
    window.addEventListener("online", () => {
      clearProbeBackoff();
      authDiag("browser reports online — re-checking");
      if (user && sb && !document.hidden && safeToPullNow()) syncCheck("reconnect");
    });
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

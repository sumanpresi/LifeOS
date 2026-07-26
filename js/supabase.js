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
export const configured = () =>
  SUPABASE_URL.startsWith("https://") && SUPABASE_ANON_KEY.length > 20;

/* ---------- modal ---------- */
export function openGhModal() {
  document.getElementById("ghModal").classList.add("open");
  document.getElementById("ghErr").style.display = "none";
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
  try {
    await sb.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: location.origin + location.pathname }
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

// TEMPORARY — sticky-note sync debug logging. Remove this helper and
// its call sites once sync is confirmed reliable across devices.
function stickyCounts(whiteboards) {
  const entries = Object.entries(whiteboards || {}).map(([k, b]) => `${k}=${(b?.objects || []).filter(o => !o.deleted).length}`);
  return entries.length ? entries.join(", ") : "(none)";
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
  console.log("[sticky-sync] after merge:", stickyCounts(mergedBoards)); // TEMPORARY
}
// Same reasoning as mergeIncomingWhiteboards above, extended to the
// Brainstorming board's tabs: each tab is merged individually by id,
// reusing the exact same per-board stroke/sticky-note merge a single
// board already uses, instead of letting one device's whole tab list
// wholesale-replace the other's. A tab's own updatedAt decides whose
// name/archived/zoom "wins" when both sides touched it — the content
// (strokes/notes) is combined either way, never dropped.
function mergeIncomingBrainstormBoards(remote) {
  const localBoards = state.brainstormBoards || [];
  const remoteBoards = remote.brainstormBoards || [];
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
  state.brainstormBoards = mergedBoards;
  remote.brainstormBoards = mergedBoards;
  if (!mergedBoards.some(b => b.id === state.activeBrainstormBoard && !b.archived && !b.deleted)) {
    const fallback = mergedBoards.find(b => !b.archived && !b.deleted) || mergedBoards[0];
    if (fallback) state.activeBrainstormBoard = fallback.id;
  }
}
function applyRemote(remote) {
  replaceState(remote);
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
      console.log("[sticky-sync] after download:", stickyCounts(remote.whiteboards)); // TEMPORARY
      mergeIncomingWhiteboards(remote);
      mergeIncomingBrainstormBoards(remote);
      // The merge just changed local state (possibly pulling in board
      // data from the remote side) independent of whatever the win/lose
      // branching below decides — make sure that's actually reflected
      // here, not just in the payload that eventually gets pushed back.
      persist(false); rerender();
      if (preferRemote || (remote.updatedAt || 0) > (state.updatedAt || 0)) applyRemote(remote);
      else if ((state.updatedAt || 0) > (remote.updatedAt || 0)) { hasReconciled = true; await saveRemote(); return; }
    } else {
      hasReconciled = true; await saveRemote(); return;      /* first device: seed the cloud copy */
    }
    hasReconciled = true;
    if (pendingSaveAfterReconcile) { pendingSaveAfterReconcile = false; await saveRemote(); return; }
    setSyncPill("ok", "Synced · " + nowTime());
  } catch (e) {
    hasReconciled = true; // don't block saves forever over one failed check — the person can retry via Sync
    setSyncPill("err", "Sync failed — tap Sync");
  }
}
export async function saveRemote() {
  if (!sb || !user) return;
  /* Never push this device's data up before it has checked what's already in
     the cloud — otherwise a stale local copy (e.g. a laptop that's been
     asleep for days) can silently overwrite a newer edit made on another
     device. Queue the save; it fires automatically once loadRemote() has
     run at least once this session. */
  if (!hasReconciled) { pendingSaveAfterReconcile = true; return; }
  setSyncPill("busy", "Saving…");
  try {
    const payload = Object.assign({}, state, { _client: CLIENT_ID });
    console.log("[sticky-sync] before upload:", stickyCounts(payload.whiteboards)); // TEMPORARY
    const { error } = await sb.from("lifeos_data").upsert({
      user_id: user.id, data: payload, updated_at: new Date().toISOString()
    });
    if (error) throw error;
    setSyncPill("ok", "Synced · " + nowTime());
  } catch (e) { setSyncPill("err", "Save failed — tap Sync"); }
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
function startRealtime() {
  stopRealtime();
  rtChannel = sb.channel("lifeos-" + user.id)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "lifeos_data", filter: "user_id=eq." + user.id },
      payload => {
        const row = payload.new;
        if (row && row.data && row.data._client !== CLIENT_ID &&
            (row.data.updatedAt || 0) > (state.updatedAt || 0)) {
          mergeIncomingWhiteboards(row.data);
          mergeIncomingBrainstormBoards(row.data);
          applyRemote(row.data);
          toast("Updated from another device");
        }
      })
    .subscribe();
}
function stopRealtime() { if (rtChannel && sb) { sb.removeChannel(rtChannel); rtChannel = null; } }

/* ---------- init ---------- */
export function initSupabase() {
  renderIdentity();
  document.getElementById("ghModal").addEventListener("click", e => {
    if (e.target.id === "ghModal") closeGhModal();
  });
  if (!configured()) { setSyncPill("", "Local only · set up sync"); return; }
  if (!window.supabase) { setSyncPill("err", "Couldn't load Supabase library"); return; }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  setRemoteSaver(saveRemote);
  sb.auth.onAuthStateChange((event, session) => {
    user = session ? session.user : null;
    renderIdentity();
    if (user) { loadRemote(); startRealtime(); }
    else { stopRealtime(); hasReconciled = false; pendingSaveAfterReconcile = false; setSyncPill("", "Local only"); }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushPendingSave();
    else if (user) loadRemote();
  });
  /* A second, independent safety net: on some platforms (especially
     mobile) visibilitychange doesn't fire reliably right before an actual
     tab close, but pagehide does. */
  window.addEventListener("pagehide", flushPendingSave);
}

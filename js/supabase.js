/* GitHub sign-in (via Supabase Auth), cloud storage, live sync. */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { state, replaceState, setRemoteSaver, uid, esc, rerender } from './state.js';
import { setSyncPill, nowTime, toast } from './ui.js';
import { pushCommunicationUpdate } from './communication-bridge.js';
import { pushNgdrTrackerUpdate } from './ngdr-tracker-bridge.js';

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
      if (preferRemote || (remote.updatedAt || 0) > (state.updatedAt || 0)) applyRemote(remote);
      else if ((state.updatedAt || 0) > (remote.updatedAt || 0)) { await saveRemote(); return; }
    } else {
      await saveRemote(); return;      /* first device: seed the cloud copy */
    }
    setSyncPill("ok", "Synced · " + nowTime());
  } catch (e) { setSyncPill("err", "Sync failed — tap Sync"); }
}
export async function saveRemote() {
  if (!sb || !user) { return; }
  setSyncPill("busy", "Saving…");
  try {
    const payload = Object.assign({}, state, { _client: CLIENT_ID });
    const { error } = await sb.from("lifeos_data").upsert({
      user_id: user.id, data: payload, updated_at: new Date().toISOString()
    });
    if (error) throw error;
    setSyncPill("ok", "Synced · " + nowTime());
  } catch (e) { setSyncPill("err", "Save failed — tap Sync"); }
}
export async function syncNow() {
  if (!user) { ghButton(); return; }
  await saveRemote(); await loadRemote();
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
    else { stopRealtime(); setSyncPill("", "Local only"); }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && user) loadRemote();
  });
}

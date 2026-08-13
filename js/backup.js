/* Snapshot history + offline backup.

   Two different jobs, deliberately kept apart:

   SNAPSHOTS are the fast local safety net — automatic, silent, and good
   for "I just deleted 500 tasks, put them back". They live in
   localStorage next to the data itself, which means they survive a bad
   edit and a bad sync but NOT a lost laptop or a cleared browser. They
   are not a backup.

   BACKUPS are the real thing — a file that leaves the machine. A browser
   cannot silently write to disk, Drive or Dropbox without a click, so
   "automatic daily backup" is honestly not achievable here; what this
   does instead is track when the last backup happened and keep asking
   until one does. The file is a plain .json anyone can read, on purpose:
   a backup you can only restore with the app that broke is a weak one. */

import { state, replaceState, persist, rerender, esc } from './state.js';
import { toast } from './ui.js';

const SNAP_KEY = "lifeos-snapshots";
const LAST_BACKUP_KEY = "lifeos-last-backup";
const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000;   // at most one automatic snapshot per 6 hours
const BACKUP_NAG_DAYS = 7;
const SNAP_BUDGET_BYTES = 2_000_000;           // see pruneToBudget

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
};

function readSnapshots() {
  try {
    const raw = store.get(SNAP_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return []; // corrupt snapshot store must never take the app down with it
  }
}

/* localStorage is a single small quota (typically ~5MB) shared with the
   live data — and LifeOS data is not small, since whiteboard drawings
   live in it too. Keeping "the last 10 snapshots" unconditionally would
   quietly break saving of the real data, which is far worse than holding
   fewer snapshots. So the cap is a byte budget, oldest dropped first,
   and at least one snapshot is always kept whatever its size. */
function pruneToBudget(list) {
  const kept = [];
  let total = 0;
  for (const snap of list) { // newest first
    const size = (snap.data || "").length;
    if (kept.length && total + size > SNAP_BUDGET_BYTES) break;
    kept.push(snap);
    total += size;
  }
  return kept;
}

function writeSnapshots(list) {
  let attempt = pruneToBudget(list);
  // Even inside budget the write can fail — other keys share the quota.
  // Drop the oldest and retry rather than losing the whole history.
  while (attempt.length) {
    if (store.set(SNAP_KEY, JSON.stringify(attempt))) return true;
    attempt = attempt.slice(0, attempt.length - 1);
  }
  return false;
}

function countItems(s) {
  const n = {
    tasks: (s.tasks || []).length,
    journal: Object.keys(s.journal || {}).length,
    gsiTasks: (s.gsi?.projects || []).reduce((a, p) => a + (p.tasks || []).length, 0),
    notes: Object.values(s.sections || {}).reduce((a, sec) => a + (sec.noteList || []).length, 0),
    habits: (s.habits || []).length,
  };
  // Sticky notes live in two places: the flat per-board entries in
  // state.whiteboards, and each tab of state.brainstormBoards. Both are
  // {strokes, objects}; a note is an object without stroke points.
  let sticky = 0;
  const countNotes = b => { sticky += (b?.objects || []).length; };
  Object.values(s.whiteboards || {}).forEach(countNotes);
  (s.brainstormBoards || []).forEach(countNotes);
  n.sticky = sticky;
  return n;
}

/* `data` defaults to the live state, but can be any state-shaped object.
   The sync path needs that: when a conflict discards the CLOUD's version,
   the thing worth preserving is the payload that just came down, not what
   this device happens to be holding. */
export function takeSnapshot(reason = "manual", data = null) {
  const json = JSON.stringify(data || state);
  const snap = {
    id: "s" + Date.now() + Math.random().toString(36).slice(2, 6),
    at: Date.now(),
    reason,
    counts: countItems(data || state),
    data: json,
  };
  const list = [snap, ...readSnapshots()];
  const ok = writeSnapshots(list);
  return ok ? snap : null;
}

/* Called once at startup. Deliberately throttled: a snapshot per page
   load would fill the budget with near-identical copies of the same
   afternoon and push out the older, more useful ones. */
export function autoSnapshotIfDue() {
  const list = readSnapshots();
  const last = list.find(s => s.reason === "auto");
  if (last && Date.now() - last.at < AUTO_INTERVAL_MS) return;
  takeSnapshot("auto");
}

export function restoreSnapshot(id) {
  const snap = readSnapshots().find(s => s.id === id);
  if (!snap) return toast("That snapshot is no longer available");
  const when = new Date(snap.at).toLocaleString("en-IN");
  if (!confirm(
    `Restore everything as it was on ${when}?\n\n` +
    `This replaces all current data. A snapshot of the current state is taken first, ` +
    `so this itself can be undone.`
  )) return;

  // Taken BEFORE the overwrite, so a restore to the wrong point is
  // recoverable rather than being the mistake that loses the day's work.
  takeSnapshot("before-restore");

  let parsed;
  try { parsed = JSON.parse(snap.data); }
  catch (e) { return toast("That snapshot is corrupt and can't be restored"); }

  applyRestoredState(parsed);
  toast(`Restored to ${when}`);
}

export function deleteSnapshot(id) {
  writeSnapshots(readSnapshots().filter(s => s.id !== id));
  renderBackupPanel();
}

/* Restores go through state.js's replaceState rather than assigning the
   object directly, because that runs the restored data back through
   merge() — every schema migration, every defaulted field. A backup taken
   before a migration existed would otherwise come back in the old shape
   and break the modules that now expect the new one. */
async function applyRestoredState(next) {
  replaceState(next);
  state.updatedAt = Date.now(); // this device now holds the newest copy
  persist();
  rerender();
  renderBackupPanel();
  // The Communication and NGDR tracker pages run in iframes with their own
  // copy of the data; rerender() doesn't reach inside them, so without
  // this they'd keep showing whatever was there before the restore.
  try {
    const { pushCommunicationUpdate } = await import("./communication-bridge.js");
    const { pushNgdrTrackerUpdate } = await import("./ngdr-tracker-bridge.js");
    pushCommunicationUpdate();
    pushNgdrTrackerUpdate();
  } catch (e) { /* bridge not loaded — the main app is still correctly restored */ }
}

// ---------- backup file ----------

export function downloadBackup() {
  const payload = {
    app: "LifeOS",
    backupFormat: 1,             // shape of this envelope, not of the data
    dataVersion: state.dataVersion ?? null,
    exportedAt: new Date().toISOString(),
    counts: countItems(state),
    data: state,
  };
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `LifeOS-Backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  store.set(LAST_BACKUP_KEY, String(Date.now()));
  renderBackupPanel();
  toast("Backup downloaded — keep a copy off this device");
}

export function importBackupFile(inputOrEvent) {
  // Called both as importBackupFile(this) from the new card and as
  // importBackup(event) from the sidebar button — accept either.
  const input = inputOrEvent && inputOrEvent.target ? inputOrEvent.target : inputOrEvent;
  const file = input && input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try { parsed = JSON.parse(reader.result); }
    catch (e) { return toast("That file isn't valid JSON"); }

    // Accept both the wrapped export and a bare state object, but insist
    // on something that actually looks like LifeOS data — importing an
    // unrelated JSON file would otherwise wipe everything.
    const data = parsed && parsed.app === "LifeOS" && parsed.data ? parsed.data : parsed;
    if (!data || typeof data !== "object" || !("journal" in data) || !("tasks" in data)) {
      return toast("That doesn't look like a LifeOS backup");
    }
    const c = countItems(data);
    if (!confirm(
      `Replace everything with this backup?\n\n` +
      `It contains ${c.tasks} tasks, ${c.gsiTasks} GSI tasks, ${c.journal} journal entries, ` +
      `${c.notes} notes and ${c.sticky} sticky notes.\n\n` +
      `A snapshot of the current state is taken first.`
    )) return;

    takeSnapshot("before-import");
    applyRestoredState(data);
    toast("Backup restored");
  };
  reader.onerror = () => toast("Couldn't read that file");
  reader.readAsText(file);
  input.value = ""; // let the same file be picked again after a cancel
}

export function daysSinceBackup() {
  const raw = store.get(LAST_BACKUP_KEY);
  if (!raw) return null;
  return Math.floor((Date.now() - Number(raw)) / 86_400_000);
}

/* Shown once per session rather than on every render — a reminder that
   appears constantly gets dismissed reflexively and stops being read. */
let noticeShown = false;
export function backupReminderIfDue() {
  if (noticeShown) return;
  const days = daysSinceBackup();
  if (days !== null && days < BACKUP_NAG_DAYS) return;
  noticeShown = true;
  toast(
    days === null ? "No backup yet — worth taking one" : `Last backup was ${days} days ago`,
    "Back up now", "downloadBackup()"
  );
}

// ---------- panel ----------

function reasonLabel(r) {
  return { auto: "Automatic", manual: "Manual", "before-restore": "Before a restore", "before-import": "Before an import" }[r] || r;
}
function relative(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

/* What is actually making the document big.

   Saving uploads the whole document every time, so its size IS the save
   time — 1.6 MB on a slow uplink is several seconds of "Saving…". Until
   now that number was only visible as a tooltip, with no indication of
   what to do about it. This breaks it down so the largest contributor is
   obvious and can be acted on: an old brainstorm board with hundreds of
   pen strokes is usually the answer, and archiving or deleting it is a
   one-click fix that nothing else would have suggested. */
function sizeBreakdown() {
  const kb = v => { try { return JSON.stringify(v ?? null).length / 1024; } catch (_) { return 0; } };
  const boards = (list) => (list || []).reduce((n, b) => n + kb(b), 0);
  const rows = [
    ["Brainstorm boards", boards(state.brainstormBoards)],
    ["Scratch boards", boards(state.dayofBoards)],
    ["Whiteboard (Communication)", boards(state.commBoards) + kb(state.whiteboards)],
    ["Tasks", kb(state.tasks)],
    ["Work · GSI", kb(state.gsi)],
    ["Personal Workspace", kb(state.personal)],
    ["Notes and sections", kb(state.sections)],
    ["Finance", kb(state.finance)],
    ["Health", kb(state.health)],
    ["Travel", kb(state.travel)],
    ["Entertainment", kb(state.entertainment)],
    ["Journal", kb(state.journal)],
    ["Trash (deleted items kept 30 days)", kb(state.trash)]
  ].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  const total = kb(state);
  return { rows, total };
}

export function renderSizeBreakdown() {
  const el = document.getElementById("sizeBreakdown");
  if (!el) return;
  const { rows, total } = sizeBreakdown();
  const big = total > 1200;
  el.innerHTML = `
    <p class="hint" style="margin:0 0 8px">
      Every save uploads all ${Math.round(total)} KB, so this is what "Saving…" is waiting for.
      ${big ? "<b>Anything above about 1 MB will feel slow on mobile data.</b>" : ""}
    </p>
    ${rows.map(([label, n]) => `
      <div class="size-row">
        <span class="size-label">${esc(label)}</span>
        <span class="size-bar"><i style="width:${Math.max(2, (n / (rows[0][1] || 1)) * 100)}%"></i></span>
        <span class="size-kb">${Math.round(n)} KB</span>
      </div>`).join("")}
    <p class="hint" style="margin:10px 0 0">
      Pen drawings are usually the largest part. Archiving a board you have finished with,
      or emptying Trash, removes it from every future upload.
    </p>`;
}

/* ---------- Shrink drawings ----------
   Pen capture records far more points than a line's shape needs. The
   editor thins them a little as you draw, but that only limits how close
   two points may be — it cannot tell that forty points along a gentle
   curve are describing something four points would describe identically.

   Ramer-Douglas-Peucker drops any point that lies within a tolerance of
   the line between its neighbours. At an epsilon of roughly one pixel the
   result is visually the same stroke.

   Deliberately manual, not automatic on save: it rewrites stored data, so
   it should happen when someone asks for it and can see what it did —
   not silently in the background. A snapshot is taken first, so Restore
   undoes it completely. */
function rdp(points, eps) {
  if (!Array.isArray(points) || points.length < 3) return points;
  const a = points[0], b = points[points.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  const den = Math.hypot(dx, dy) || 1e-9;
  let idx = 0, dmax = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.abs(dy * points[i].x - dx * points[i].y + b.x * a.y - b.y * a.x) / den;
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax > eps) {
    const left = rdp(points.slice(0, idx + 1), eps);
    const right = rdp(points.slice(idx), eps);
    return [...left.slice(0, -1), ...right];
  }
  return [a, b];
}

function eachBoard(fn) {
  [state.brainstormBoards, state.dayofBoards, state.commBoards].forEach(list =>
    (list || []).forEach(b => fn(b)));
  Object.values(state.whiteboards || {}).forEach(b => fn(b));
}

export function shrinkDrawings() {
  const before = JSON.stringify(state).length;
  let strokes = 0, ptsBefore = 0, ptsAfter = 0;
  try { takeSnapshot("before-shrink-drawings"); }
  catch (e) { console.warn("[shrink] snapshot failed", e); }

  eachBoard(b => {
    if (!Array.isArray(b?.strokes)) return;
    b.strokes.forEach(st => {
      if (!Array.isArray(st.points) || st.points.length < 3) return;
      strokes++;
      ptsBefore += st.points.length;
      st.points = rdp(st.points, 0.0012);
      ptsAfter += st.points.length;
    });
  });

  const after = JSON.stringify(state).length;
  const savedKb = Math.max(0, Math.round((before - after) / 1024));
  persist(); rerender();
  toast(savedKb
    ? `Saved ${savedKb} KB — ${ptsBefore - ptsAfter} redundant points removed from ${strokes} strokes. Undo from Restore.`
    : "Drawings are already as compact as they can be.");
  renderBackupPanel();
}

export function renderBackupPanel() {
  renderSizeBreakdown();
  const status = document.getElementById("backupStatus");
  if (status) {
    const days = daysSinceBackup();
    status.textContent = days === null
      ? "No backup taken yet from this browser."
      : days === 0 ? "Last backup: today." : `Last backup: ${days} day${days === 1 ? "" : "s"} ago.`;
    status.classList.toggle("backup-overdue", days === null || days >= BACKUP_NAG_DAYS);
  }

  const box = document.getElementById("snapshotList");
  if (!box) return;
  const list = readSnapshots();
  box.innerHTML = list.map(s => {
    const c = s.counts || {};
    return `
    <div class="snap-row">
      <div class="snap-main">
        <span class="snap-when">${new Date(s.at).toLocaleString("en-IN")} <span class="hint">— ${relative(s.at)}</span></span>
        <span class="snap-meta">${reasonLabel(s.reason)} · ${c.tasks ?? 0} tasks · ${c.gsiTasks ?? 0} GSI · ${c.journal ?? 0} journal · ${c.notes ?? 0} notes · ${c.sticky ?? 0} sticky · ${Math.round((s.data || "").length / 1024)} KB</span>
      </div>
      <div class="snap-actions">
        <button class="gsi-archive-restore" onclick="restoreSnapshot('${s.id}')">↺ Restore</button>
        <button class="gsi-archive-remove" onclick="deleteSnapshot('${s.id}')" title="Remove this snapshot">✕</button>
      </div>
    </div>`;
  }).join("") || `<p class="hint" style="padding:10px 0">No snapshots yet — one is taken automatically every few hours.</p>`;
}

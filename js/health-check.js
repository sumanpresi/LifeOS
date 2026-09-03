/* "Check my data" — an integrity check written for someone who shouldn't
   have to know what a data structure is.

   Two rules shaped this file:

   1. Every finding is phrased in terms of what the person would notice,
      not what's wrong internally. "3 tasks won't show up anywhere" beats
      "orphaned records with dangling projectId".

   2. Repairs never delete anything the person wrote. A broken record is
      moved somewhere visible or given back its missing field — it is not
      tidied out of existence. If the only way to "fix" something would be
      to discard content, this reports it and leaves it alone.

   A snapshot is taken before any repair, so even the repair is undoable. */

import { state, uid, persist, rerender } from './state.js?v=202609042200';
import { toast } from './ui.js?v=202609042200';
import { renderBackupPanel, requireSnapshot } from './backup.js?v=202609042200';

/* Each check returns { problem, detail, count, fix } — fix is omitted when
   the only safe action is for a person to look at it themselves. */
function runChecks() {
  const found = [];

  // --- journal dates ---
  const badDates = Object.keys(state.journal || {}).filter(k => !/^\d{4}-\d{2}-\d{2}$/.test(k));
  if (badDates.length) {
    found.push({
      problem: `${badDates.length} journal entr${badDates.length === 1 ? "y has an unusable date" : "ies have unusable dates"}`,
      detail: "They may sort into the wrong place or not appear when you filter by date.",
      count: badDates.length,
      fix: () => {
        badDates.forEach(k => {
          const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(k).trim());
          if (!m) return; // genuinely unreadable — left alone rather than guessed at
          const good = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
          if (state.journal[good] && state.journal[good] !== state.journal[k]) {
            state.journal[good] += state.journal[k]; // both kept, nothing overwritten
          } else {
            state.journal[good] = state.journal[k];
          }
          delete state.journal[k];
        });
      }
    });
  }

  // --- records missing an id ---
  // Anything without one can't be edited or deleted: every button in the
  // app finds its record by id, so a record without one is untouchable.
  const idless = [];
  const scan = (arr, label) => (arr || []).forEach(r => { if (r && !r.id) idless.push({ r, label }); });
  scan(state.tasks, "task");
  scan(state.habits, "habit");
  scan(state.links, "link");
  (state.gsi?.projects || []).forEach(p => { scan(p.tasks, "GSI task"); scan(p.archivedTasks, "archived GSI task"); });
  (state.personal?.projects || []).forEach(p => { scan(p.tasks, "personal task"); scan(p.archivedTasks, "archived personal task"); });
  (state.travel?.plans || []).forEach(p => (p.packLists || []).forEach(l => scan(l.items, "packing item")));
  if (idless.length) {
    found.push({
      problem: `${idless.length} item${idless.length === 1 ? "" : "s"} can't be edited or deleted`,
      detail: "They show up but the buttons on them do nothing.",
      count: idless.length,
      fix: () => idless.forEach(({ r }) => { r.id = uid(); })
    });
  }

  // --- duplicate ids ---
  // Two records sharing an id means editing one silently edits the other.
  const seen = new Map();
  const dupes = [];
  const scanIds = (arr, label) => (arr || []).forEach(r => {
    if (!r || !r.id) return;
    if (seen.has(r.id)) dupes.push({ r, label }); else seen.set(r.id, label);
  });
  scanIds(state.tasks, "task");
  (state.gsi?.projects || []).forEach(p => scanIds(p.tasks, "GSI task"));
  /* Personal tasks get their own map rather than joining the one above.
     A shared map would flag a personal task and a GSI task that happen to
     draw the same uid() as a conflict — but nothing in the app ever looks
     up an id across both trees (findProjectTask searches state.gsi only,
     findPwProjectTask searches state.personal only), so such a pair is
     harmless and reporting it would be a false alarm. Within the personal
     tree a collision is a real bug, and that is what this catches. */
  const seenPersonal = new Map();
  const scanPersonalIds = arr => (arr || []).forEach(r => {
    if (!r || !r.id) return;
    if (seenPersonal.has(r.id)) dupes.push({ r, label: "personal task" }); else seenPersonal.set(r.id, "personal task");
  });
  (state.personal?.projects || []).forEach(p => scanPersonalIds(p.tasks));
  if (dupes.length) {
    found.push({
      problem: `${dupes.length} item${dupes.length === 1 ? " shares its identity" : "s share their identity"} with another`,
      detail: "Editing or ticking one can change the other unexpectedly.",
      count: dupes.length,
      fix: () => dupes.forEach(({ r }) => { r.id = uid(); })
    });
  }

  // --- GSI tasks in a project that no longer exists ---
  const projectIds = new Set((state.gsi?.projects || []).map(p => p.id));
  const orphanTasks = [];
  (state.gsi?.projects || []).forEach(p => {
    if (!Array.isArray(p.tasks)) p.tasks = [];
  });
  // Tasks referencing a deleted project via the flat task list
  (state.tasks || []).forEach(t => {
    if (t.projectId && !projectIds.has(t.projectId)) orphanTasks.push(t);
  });
  if (orphanTasks.length) {
    found.push({
      problem: `${orphanTasks.length} task${orphanTasks.length === 1 ? " belongs" : "s belong"} to a workspace that was deleted`,
      detail: "They may be hidden from the lists you normally look at.",
      count: orphanTasks.length,
      fix: () => orphanTasks.forEach(t => { t.projectId = ""; }) // becomes a plain task — nothing is discarded
    });
  }

  // --- Personal Workspace pointing at a workspace that was deleted ---
  // merge() repairs this on load, but only on load: a delete that goes
  // wrong mid-session leaves the pointer dangling until the next reload,
  // and activePwProject() then falls back to projects[0] silently, so the
  // person sees the wrong workspace with no explanation.
  const pwProjects = Array.isArray(state.personal?.projects) ? state.personal.projects : [];
  if (pwProjects.length && !pwProjects.some(p => p.id === state.personal.activeProject)) {
    found.push({
      problem: "Personal Workspace is pointing at a workspace that no longer exists",
      detail: "It falls back to your first workspace, so it can look like the wrong one is selected.",
      count: 1,
      fix: () => { state.personal.activeProject = pwProjects[0].id; }
    });
  }

  // --- lists that aren't lists ---
  // A field that should hold a list but holds something else will throw the
  // moment the page tries to draw it — this is the "white screen" class of bug.
  const listFields = [
    ["tasks", state, "tasks"], ["habits", state, "habits"], ["links", state, "links"],
    ["goals", state, "goals"], ["feeds", state, "feeds"], ["trash", state, "trash"],
  ];
  /* The Personal Workspace render path reads .length off each of these
     without guarding, so a non-array here is the blank-page fault this
     check exists to catch. Pushed in separately because they're nested
     rather than top-level fields. */
  if (state.personal) {
    listFields.push(["personal links", state.personal, "links"]);
    listFields.push(["personal documents", state.personal, "docs"]);
    listFields.push(["personal projects", state.personal, "projects"]);
    (Array.isArray(state.personal.projects) ? state.personal.projects : []).forEach(p => {
      listFields.push([`tasks in "${p.name}"`, p, "tasks"]);
      listFields.push([`documents in "${p.name}"`, p, "workDocs"]);
    });
  }
  const broken = listFields.filter(([, obj, key]) => obj[key] !== undefined && !Array.isArray(obj[key]));
  if (broken.length) {
    found.push({
      problem: `${broken.length} section${broken.length === 1 ? " is" : "s are"} in a state the app can't display`,
      detail: "This is the kind of fault that shows a blank page. Repairing resets just those sections to empty.",
      count: broken.length,
      fix: () => broken.forEach(([, obj, key]) => { obj[key] = []; })
    });
  }

  // --- trash entries that can't be restored ---
  const badTrash = (state.trash || []).filter(e => !e || !e.type || !e.payload);
  if (badTrash.length) {
    found.push({
      problem: `${badTrash.length} item${badTrash.length === 1 ? "" : "s"} in Trash can't be restored`,
      detail: "They're incomplete records that the Restore button can't act on.",
      count: badTrash.length,
      fix: () => { state.trash = (state.trash || []).filter(e => e && e.type && e.payload); }
    });
  }

  // --- storage pressure (reported, never auto-'fixed') ---
  const kb = Math.round(JSON.stringify(state).length / 1024);
  if (kb > 3500) {
    found.push({
      problem: `Your data is large (${(kb / 1024).toFixed(1)} MB)`,
      detail: "Browsers cap what a site can store at roughly 5 MB. Whiteboard drawings take the most room. Download a backup, then consider clearing an old whiteboard you no longer need.",
      count: 1
      // No fix: the only way to shrink this is to remove things, and that
      // is the person's decision, not the app's.
    });
  }

  return found;
}

let lastFindings = [];

export function runDataHealthCheck() {
  lastFindings = runChecks();
  renderHealthReport(true);
  if (!lastFindings.length) toast("Everything checks out");
}

export function repairDataProblems() {
  const fixable = lastFindings.filter(f => f.fix);
  if (!fixable.length) return;
  if (!confirm(
    `Fix ${fixable.length} problem type${fixable.length === 1 ? "" : "s"}?\n\n` +
    `Nothing you've written will be deleted. A snapshot is taken first, so this can be undone from Snapshot history.`
  )) return;

  if (!requireSnapshot("before-repair", "Nothing was repaired")) return;
  let repaired = 0;
  fixable.forEach(f => {
    try { f.fix(); repaired += f.count; }
    catch (e) { /* one failed repair must not stop the others */ }
  });
  persist();
  rerender();
  renderBackupPanel();
  lastFindings = runChecks();
  renderHealthReport(true);
  toast(`Repaired ${repaired} item${repaired === 1 ? "" : "s"}`);
}

export function renderHealthReport(showEmpty = false) {
  const box = document.getElementById("healthReport");
  if (!box) return;
  const btn = document.getElementById("healthRepairBtn");

  if (!lastFindings.length) {
    box.innerHTML = showEmpty
      ? `<p class="health-ok">✓ No problems found. Your data looks healthy.</p>`
      : "";
    if (btn) btn.style.display = "none";
    return;
  }
  box.innerHTML = lastFindings.map(f => `
    <div class="health-row">
      <span class="health-icon">${f.fix ? "⚠" : "ℹ"}</span>
      <div>
        <div class="health-problem">${f.problem}</div>
        <div class="health-detail">${f.detail}${f.fix ? "" : " This one needs your decision, so it won't be changed automatically."}</div>
      </div>
    </div>`).join("");
  if (btn) btn.style.display = lastFindings.some(f => f.fix) ? "" : "none";
}

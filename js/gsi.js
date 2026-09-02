/* GSI Workspace: multi-project task tracker, daily work log, structured
   meeting minutes, GSI links, personal & work documents. */
import { state, uid, esc, persist, rerender, todayKey, touch, commitWithoutRender } from './state.js?v=202609042000';
import { openDateSheet } from './date-sheet.js?v=202609042000';
import { isComposerOpen, composerHtml, openComposer } from './composer.js?v=202609042000';
/* tasks.js already imports gsi.js, so this is a cycle — safe here because
   neither module touches the other's bindings while modules are being
   evaluated, only inside functions called later at runtime. */
import { markDragJustEnded, boardColHeadHtml, isColCollapsed, capBoardColumnHeights, initBoardWheelScroll,
         applyHorizon, horizonWrapHtml } from './tasks.js?v=202609042000';
import { toast, autoGrow, preserveBoardScroll } from './ui.js?v=202609042000';
/* Priority now colours the checkbox ring instead of a flag button — the
   helper lives in tasks.js so all three boards agree. */
import { prioClass } from './tasks.js?v=202609042000';
import { releaseDragGhost } from './drag-cleanup.js?v=202609042000';
import { describeLink } from './attach.js?v=202609042000';
import { moveToTrash } from './trash.js?v=202609042000';
import { checkGrammar } from './text-tools.js?v=202609042000';
import { mountRichEditor, unmountRichEditor, getRichEditor } from './rich-text.js?v=202609042000';
import { syncTaskToGoogle } from './google-calendar.js?v=202609042000';

// GSI project tasks use different field names than native Overview
// tasks (date, not dueDate; status, not done) — this bridges that so
// the same sync function/endpoint in google-calendar.js is reused
// rather than duplicated for GSI's shape. syncTaskToGoogle mutates
// task.googleEventId on the object it's given directly, so that has to
// be copied back onto the real GSI task afterward — it can't just be
// handed the real task, since the real task's date field is called
// "date" and syncTaskToGoogle expects "dueDate".
function syncGsiTaskToGoogle(t, action) {
  const shim = { text: t.text, dueDate: t.date, googleEventId: t.googleEventId };
  syncTaskToGoogle(shim, action).then(() => {
    if (shim.googleEventId !== t.googleEventId) { t.googleEventId = shim.googleEventId; persist(); }
  }).catch(() => {});
}


/* Formatting: Quill's own built-in toolbar (see rich-text.js) now handles
   bold/italic/lists/etc. directly on the rendered content — no separate
   markdown-insertion toolbar needed. */

const STATUSES = [
  ["todo", "⚪ To do"], ["progress", "🔵 In progress"], ["done", "🟢 Done"], ["blocked", "🔴 Blocked"]
];
const fmtDate = k => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
};

/* ---------------- Projects (replaces the old single NGDR list) ---------------- */
function activeProject() {
  return state.gsi.projects.find(p => p.id === state.gsi.activeProject) || state.gsi.projects[0];
}

/* ---- Workspace tabs: UI-only wrapper around the existing project
   switcher. switchProject()/addProject() are unchanged — this only
   changes how they're presented and triggered (was a search+dropdown,
   now a horizontal tab row — same .wb-tab component the Brainstorming
   Board's own tabs already use, since it's the identical "switch
   between named containers" pattern). ---- */
export function chooseWorkspace(id) {
  switchProject(id); // existing function, unchanged
}
function renderWorkspaceTabs() {
  const list = document.getElementById("wsTabsList");
  if (!list) return;
  const active = activeProject();
  list.innerHTML = state.gsi.projects.map(p => `
    <button class="wb-tab ${p.id === active.id ? "active" : ""}" onclick="chooseWorkspace('${p.id}')">
      <span class="wb-tab-name">${esc(p.name)}</span>
    </button>`).join("");
}
/* Finds a project task by id across EVERY project, not just the active
   one — needed because these tasks are now also shown (and editable) from
   Overview's unified task list, where a task could belong to any project. */
export function findProjectTask(id) {
  for (const p of state.gsi.projects) {
    const t = p.tasks.find(x => x.id === id);
    if (t) return { task: t, project: p };
  }
  return { task: null, project: null };
}
/* Every GSI project task, flattened into one list with its project name
   attached — this is what Overview's "Work"/"All" task view merges in
   alongside its own native tasks. */
export function getAllGsiTasksFlat() {
  const out = [];
  state.gsi.projects.forEach(p => {
    p.tasks.forEach(t => out.push(Object.assign({}, t, { projectId: p.id, projectName: p.name })));
  });
  return out;
}

function fmtGsiDate(d) {
  if (!d) return null;
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(y, m - 1, day);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((dt - today) / 86400000);
  const label = dt.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  if (diffDays < 0) return { text: label, cls: "gsi-overdue" };
  if (diffDays === 0) return { text: "Today", cls: "gsi-today" };
  return { text: label, cls: "gsi-future" };
}

let gsiSortMode = "default";
let gsiTaskView = null; // "board" | "list" — lazily initialized from state.gsiTaskViewPref on first render, mirrors the same pattern the main Tasks module uses
export function setGsiSortMode(mode) {
  gsiSortMode = mode;
  renderProjects();
}

/* Archive is deliberately separate from Trash: Trash is for mistakes —
   items you meant to delete, kept temporarily in case you didn't.
   Archive is the opposite intent — completed tasks you want OUT of your
   active list but never intended to delete, kept indefinitely, with
   full selective restore. Stored per-project as p.archivedTasks. */
export function archiveCompletedTasks() {
  const p = activeProject();
  const completed = p.tasks.filter(t => t.status === "done");
  if (!completed.length) { toast("No completed tasks to archive"); return; }
  p.archivedTasks = p.archivedTasks || [];
  p.archivedTasks.unshift(...completed);
  p.tasks = p.tasks.filter(t => t.status !== "done");
  persist(); renderProjects();
  toast(`Archived ${completed.length} task${completed.length===1?"":"s"}`);
}
// Archives one specific task from one specific project — by id, not by
// "the active project," since this is also called from the Overview
// page's unified task list, where there's no such thing as an active
// GSI project. archiveCompletedTasks() above only ever handled bulk.
export function archiveGsiTaskEntry(projectId, taskId) {
  const p = (state.gsi.projects || []).find(x => x.id === projectId);
  if (!p) return;
  const idx = p.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  const [task] = p.tasks.splice(idx, 1);
  p.archivedTasks = p.archivedTasks || [];
  p.archivedTasks.unshift(task);
  persist(); rerender();
  toast(`Archived "${task.text}"`);
}
export function openArchiveView() {
  const modal = document.getElementById("gsiArchiveModalBg");
  if (!modal) return;
  modal.classList.add("open");
  renderArchiveList();
}
export function closeArchiveView() {
  const modal = document.getElementById("gsiArchiveModalBg");
  if (modal) modal.classList.remove("open");
}
function renderArchiveList() {
  const p = activeProject();
  const archived = p.archivedTasks || [];
  const box = document.getElementById("gsiArchiveList");
  if (!box) return;
  box.innerHTML = archived.map(t => `
    <div class="gsi-archive-row">
      <span class="gsi-archive-text">${esc(t.text)}</span>
      <div class="gsi-archive-actions">
        <button class="gsi-archive-restore" onclick="restoreArchivedTask('${t.id}')">↺ Restore</button>
        <button class="gsi-archive-remove" onclick="removeFromArchive('${t.id}')" title="Remove permanently">✕</button>
      </div>
    </div>`).join("") || `<p class="hint" style="padding:12px 0">Nothing archived yet — completed tasks you archive will appear here.</p>`;
}
export function restoreArchivedTask(id) {
  const p = activeProject();
  const archived = p.archivedTasks || [];
  const t = archived.find(x => x.id === id);
  if (!t) return;
  p.archivedTasks = archived.filter(x => x.id !== id);
  p.tasks.push(t);
  persist(); renderProjects(); renderArchiveList();
  toast("Restored to task list");
}
export function removeFromArchive(id) {
  const p = activeProject();
  const archived = p.archivedTasks || [];
  const t = archived.find(x => x.id === id);
  if (!t) return;
  if (!confirm(`Permanently remove "${t.text}" from the archive? This cannot be undone.`)) return;
  p.archivedTasks = archived.filter(x => x.id !== id);
  persist(); renderArchiveList();
}

/* Project delete already goes through Trash (see delProject below), so
   restoring one just needs a convenient, visible entry point — this
   shows a "Restore last deleted project" action right beside Delete
   whenever a recently-deleted project is sitting in Trash. */
export function restoreLastDeletedProject() {
  const entry = [...state.trash].reverse().find(x => x.type === "gsiProject");
  if (!entry) return;
  state.gsi.projects.push(entry.payload);
  state.gsi.activeProject = entry.payload.id;
  state.trash = state.trash.filter(x => x.id !== entry.id);
  persist(); renderProjects();
  toast(`Restored "${entry.payload.name}"`);
}
function hasRecentlyDeletedProject() {
  return state.trash.some(x => x.type === "gsiProject");
}

function sortGsiTasks(open) {
  const byFlag = (a, b) => (!!b.flag) - (!!a.flag);
  const byDate = (a, b) => (a.date || "9999") .localeCompare(b.date || "9999");
  const byAlpha = (a, b) => a.text.localeCompare(b.text);
  const statusOrder = { blocked: 0, progress: 1, todo: 2, done: 3 };
  const byStatus = (a, b) => statusOrder[a.status] - statusOrder[b.status];
  switch (gsiSortMode) {
    case "date": return [...open].sort(byDate);
    case "priority": return [...open].sort(byFlag);
    case "status": return [...open].sort(byStatus);
    case "alphabetical": return [...open].sort(byAlpha);
    case "newest": return [...open].reverse();
    case "oldest": return [...open];
    default: return open; // "default" — insertion order, as before
  }
}

function gsiCardHtml(item) {
  const due = fmtGsiDate(item.date);
  return `
    <div class="gsi-card ${item.status === "done" ? "done" : ""}">
      <button class="gsi-chk ${item.status === "done" ? "on" : ""}" onclick="setTaskStatus('${item.id}','${item.status === "done" ? "todo" : "done"}')" aria-label="Toggle done">
        <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <div class="gsi-card-main">
        <textarea class="gsi-title" rows="1" onchange="editProjectTask('${item.id}','text',this.value)" oninput="autoGrow(this)">${esc(item.text)}</textarea>
        <div class="gsi-link-row">
          ${item.link
            ? `<a href="${esc(item.link.startsWith("http")?item.link:"https://"+item.link)}" target="_blank" rel="noopener" class="gsi-link-display">${describeLink(item.link).icon} ${esc(describeLink(item.link).label)}</a>
               <button class="gsi-link-edit-btn" onclick="toggleGsiLinkEdit(event,'${item.id}')" title="Edit link">✎</button>`
            : `<button class="gsi-add-link" onclick="toggleGsiLinkEdit(event,'${item.id}')">+ Add link</button>`}
          <input type="text" class="gsi-link-input" id="gsi-link-edit-${item.id}" placeholder="Paste a link…" value="${esc(item.link||"")}"
            onchange="editProjectTask('${item.id}','link',this.value)" onblur="this.style.display='none'" style="display:none">
        </div>
        ${due ? `<div class="gsi-date-row ${due.cls}"><span class="date-popover-wrap">
            <button class="gsi-date-display" onclick="toggleDatePopover(event,'gsi-date-${item.id}')">📅 ${due.text}</button>
            <input type="date" class="gsi-date-hidden-input" id="gsi-date-${item.id}" value="${esc(item.date||"")}" onchange="editProjectTask('${item.id}','date',this.value)">
            <div class="date-popover" id="pop-gsi-date-${item.id}">
              <button onclick="setQuickDate('gsi-date-${item.id}','today')">Today</button>
              <button onclick="setQuickDate('gsi-date-${item.id}','tomorrow')">Tomorrow</button>
              <button onclick="setQuickDate('gsi-date-${item.id}','nextweek')">Next week</button>
              <button onclick="setQuickDate('gsi-date-${item.id}','clear')">Clear date</button>
            </div>
          </span></div>`
          : `<div class="gsi-date-row"><span class="date-popover-wrap">
              <button class="gsi-add-date" onclick="toggleDatePopover(event,'gsi-date-${item.id}')">📅 Add date</button>
              <input type="date" class="gsi-date-hidden-input" id="gsi-date-${item.id}" value="" onchange="editProjectTask('${item.id}','date',this.value)">
              <div class="date-popover" id="pop-gsi-date-${item.id}">
                <button onclick="setQuickDate('gsi-date-${item.id}','today')">Today</button>
                <button onclick="setQuickDate('gsi-date-${item.id}','tomorrow')">Tomorrow</button>
                <button onclick="setQuickDate('gsi-date-${item.id}','nextweek')">Next week</button>
              </div>
            </span></div>`}
      </div>
      <div class="gsi-card-right">
        <button class="gsi-flag ${item.flag ? "on" : ""}" onclick="toggleProjectTaskFlag('${item.id}')" title="${item.flag ? "Remove priority" : "Mark high priority"}">🚩</button>
        <select class="gsi-status-sel s-${item.status}" onchange="setTaskStatus('${item.id}',this.value)">
          ${STATUSES.map(([v, l]) => `<option value="${v}" ${item.status === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        ${projectSelectorHtml(item.id)}
      </div>
    </div>`;
}
// Shared by List and Board card templates below — lets a task move to a
// different GSI project, or back to a plain native task ("No project"),
// right from wherever it's already sitting. Routes through
// changeTaskProject (tasks.js, exposed globally via app.js) rather than
// touching state.gsi.projects here, since that function already knows
// how to remap a task's shape across native<->GSI and between projects.
function projectSelectorHtml(taskId) {
  const currentId = state.gsi.activeProject;
  return `<select class="gsi-project-sel" title="Move to project" onchange="changeTaskProject('${taskId}',this.value)">
    <option value="">No project</option>
    ${state.gsi.projects.map(p => `<option value="${p.id}" ${p.id === currentId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
  </select>`;
}

// ---------- GSI Board view — columns by status, since that's the
// dimension GSI tasks already natively track (unlike native Tasks,
// which don't have a multi-state status at all). Reuses the exact same
// .t-board-card CSS classes the main Tasks module's Board view uses,
// for visual consistency, rather than inventing a parallel style.
function gsiBoardCardHtml(item) {
  const due = fmtGsiDate(item.date);
  return `
    <div class="t-board-card ${item.status === "done" ? "done" : ""}${item.flag ? " flagged" : ""}" data-task-id="${item.id}"
      onclick="openTaskCardDetail('${item.id}')" role="button" tabindex="0"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openTaskCardDetail('${item.id}')}">
      <div class="t-board-card-top">
        <button class="t-chk ${prioClass(item)} ${item.status === "done" ? "on" : ""}" onclick="event.stopPropagation();setTaskStatus('${item.id}','${item.status === "done" ? "todo" : "done"}')" aria-label="Toggle done">
          <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
        <span class="gsi-board-card-title">${esc(item.text)}</span>
      </div>
      <div class="t-board-card-meta">
        <span class="t-board-card-date ${due && due.cls === "gsi-overdue" ? "overdue" : ""}">
          <button class="${due ? "t-due-chip" : "t-add-date-btn"}" onclick="event.stopPropagation();openGsiDatePicker('${item.id}')" title="Change due date">
            <span class="t-due-chip-ico" aria-hidden="true">🗓</span>${due ? due.text : " Add date"}</button>
          <input type="date" class="t-due-hidden-input" id="gsi-board-date-${item.id}" value="${esc(item.date||"")}"
            onclick="event.stopPropagation()" onchange="event.stopPropagation();editProjectTask('${item.id}','date',this.value)">
          </span>
        ${item.link
          ? `<a href="${esc(item.link.startsWith("http")?item.link:"https://"+item.link)}" target="_blank" rel="noopener" class="t-board-card-tag" style="text-decoration:none" onclick="event.stopPropagation()">🔗 Link</a>`
          : `<button class="t-add-link-btn" onclick="toggleGsiLinkEdit(event,'${item.id}')">+ Link</button>`}
        <input type="text" class="t-link-input" id="gsi-link-edit-${item.id}" placeholder="Paste a link…" value="${esc(item.link||"")}"
          onclick="event.stopPropagation()" onchange="editProjectTask('${item.id}','link',this.value)" onblur="this.style.display='none'" style="display:none">
        <span onclick="event.stopPropagation()">${projectSelectorHtml(item.id)}</span>
      </div>
    </div>`;
}
function gsiBoardColumnHtml(statusKey, label, tasks) {
  /* Same seven-day horizon the Overview board uses. Scoped per column so
     each one remembers its own state, and keyed on `date` because that is
     what a workspace task calls its due date. Undated and overdue tasks
     always stay visible — see splitByHorizon in tasks.js. */
  const { shown, moreBtn, emptyMsg } = applyHorizon("gsi-" + statusKey, tasks, t => t.date);
  return `
    <div class="t-board-col ${isColCollapsed("gsi", statusKey) ? "t-col-collapsed" : ""}" data-board-col="${statusKey}">
      ${boardColHeadHtml("gsi", statusKey, label, tasks.length)}
      <div class="t-board-col-body">
        ${shown.length ? shown.map(gsiBoardCardHtml).join("") : `<p class="hint" style="padding:10px 4px">${esc(emptyMsg)}</p>`}
      </div>
      ${horizonWrapHtml(moreBtn)}
      ${isComposerOpen("gsi", statusKey)
        ? composerHtml("gsi", statusKey)
        : `<button class="t-board-col-add" onclick="quickAddGsiTask('${statusKey}')" title="Add a task to ${esc(label)}">+ Add task</button>`}
    </div>`;
}
function renderGsiBoardView(tasks) {
  const byStatus = k => tasks.filter(t => t.status === k);
  return `<div class="t-board">
    ${STATUSES.map(([key, label]) => gsiBoardColumnHtml(key, label.replace(/^\S+\s/, ""), byStatus(key))).join("")}
  </div>`;
}
export function setGsiTaskView(v) {
  gsiTaskView = v;
  state.gsiTaskViewPref = v;
  persist(false);
  const switcher = document.getElementById("gsiTaskViewSwitch");
  if (switcher) switcher.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  renderProjects();
}
let gsiBoardSortables = [];
function destroyGsiBoardSortables() {
  /* Before destroy(), never after: destroy() calls Sortable's _onDrop()
     with no event, which skips the branch that removes the drag clone and
     then nulls the only reference to it. See js/drag-cleanup.js. */
  releaseDragGhost();
  gsiBoardSortables.forEach(s => { try { s.destroy(); } catch (e) { /* already gone with its container */ } });
  gsiBoardSortables = [];
}
function initGsiBoardSorting() {
  destroyGsiBoardSortables();
  if (gsiTaskView !== "board" || gsiSortMode !== "default" || typeof Sortable === "undefined") return;
  document.querySelectorAll("#ngdrList .t-board-col-body").forEach(container => {
    gsiBoardSortables.push(Sortable.create(container, {
      group: "gsi-board",
      /* Only cards are draggable. Without this Sortable treats every child
         of the column body as an item — including the "+ Add task" button
         and, now, the open composer, which could be picked up and dropped
         into another column mid-typing. */
      draggable: ".t-board-card",
      /* No handle: the whole card is draggable, which is what people
         expect of a Kanban card and what the ⠿ grip was getting in the
         way of. filter lists the controls that must keep their own
         behaviour instead of starting a drag; preventOnFilter:false lets
         their click/change events through rather than swallowing them. */
      filter: "button, input, select, textarea, a, .t-chk, .composer",
      preventOnFilter: false,
      /* The dragged clone is appended to <body> and forced onto Sortable's
         own fallback renderer.

         Without fallbackOnBody the clone stays inside the column, and the
         column sits inside a .card that carries backdrop-filter — which
         makes that card the containing block for position:fixed. The clone
         is then positioned relative to the card rather than the screen, so
         it trails the finger by the card's offset from the viewport. That
         is the visible gap between finger and card on touch.

         forceFallback keeps desktop and touch on the same code path, so
         the two behave identically instead of desktop using native HTML5
         drag with its own quirks. */
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 4,
      /* Long-press to lift, so a plain swipe still scrolls the board.
         200ms rather than 300 — Todoist feels immediate because the lift
         happens before you have consciously waited for it. */
      delay: 200, delayOnTouchOnly: true, touchStartThreshold: 6,
      /* Faster than the previous 200ms: the reflow animation is what makes
         a board feel sluggish once several cards shuffle at once. */
      animation: 140,
      easing: "cubic-bezier(0.2, 0, 0.2, 1)",
      /* Marks the whole document while a lift is in progress so the CSS
         can drop the board's blur for the duration. Cleared in onEnd —
         and also on cancel, since a drag abandoned off-screen would
         otherwise leave the board unblurred until the next reload. */
      /* onChoose, not just onStart: Sortable calls _appendGhost() — which
         MEASURES the source card to place the clone — before it dispatches
         "start". Adding the class in onStart alone lands after that
         measurement, so the containing-block reset in style.css would come
         a frame too late and the clone would keep the bad offset it was
         born with. onChoose fires first, before any ghost exists. */
      onChoose: () => document.body.classList.add("is-dragging"),
      onStart: () => document.body.classList.add("is-dragging"),
      ghostClass: "t-row-ghost", dragClass: "t-row-dragging", chosenClass: "t-row-chosen",
      scroll: true, scrollSensitivity: 90, scrollSpeed: 12,
      /* An empty column is a 5px target by default, which on a Kanban
         board is the one drop everybody misses — there is no card in it
         to aim at. 28px makes "somewhere in that column" enough. */
      emptyInsertThreshold: 28,
      onEnd: (evt) => {
        document.body.classList.remove("is-dragging");
        markDragJustEnded(); // so the click that trails a drop doesn't open the task
        const taskId = evt.item.dataset.taskId;
        const fromColEl = evt.from.closest(".t-board-col");
        const toColEl = evt.to.closest(".t-board-col");
        const toStatus = toColEl?.dataset.boardCol;

        /* THE BOARD IS NOT REBUILT ON A DROP.

           Sortable has already put the card where the finger let go, and
           every column here is defined by exactly the field the drop
           writes — drop on In Progress and the status BECOMES "progress".
           So the card is, by construction, already in the column its data
           says it belongs to, and a rebuild could only put it back where
           it already is.

           What the rebuild actually cost was the whole page. renderProjects()
           replaces #ngdrList wholesale: the page height collapses and
           re-expands while the innerHTML is swapped, the browser clamps
           scrollTop somewhere in the middle of that, and the board lands
           somewhere other than where it was left. preserveBoardScroll()
           was trying to undo that afterwards and losing, because the
           height changes across frames rather than within one. That is the
           board jumping after a move, and the fix is not a better restore
           — it is not asking for the repaint.

           Only the moved card's own chips change (its status pill, the
           strike-through), so only that card is repainted, on the next
           frame so Sortable can finish its own cleanup first. */
        if (!taskId || !toStatus) return;
        commitWithoutRender(() => setTaskStatus(taskId, toStatus));

        /* Where the card was dropped WITHIN the column is data too.

           Under Default sort the board renders project.tasks in array
           order, so a reorder that isn't written back to that array lasts
           exactly until the next render and then springs back somewhere
           else. That is the card "moving to a different place": it was
           never saved, so what you saw afterwards was the original order
           re-asserting itself.

           Written by splicing the task in ahead of whichever card now
           follows it on screen, rather than rebuilding the array from the
           DOM — the DOM only holds the cards currently rendered, and
           anything folded behind "show N later tasks" would be silently
           dropped from the project by a wholesale rebuild. */
        persistGsiCardOrder(taskId, toColEl);

        requestAnimationFrame(() => {
          patchGsiCardInPlace(taskId);
          bumpGsiColCount(fromColEl, -1);
          bumpGsiColCount(toColEl, +1);
          syncGsiColEmptyState(fromColEl);
          syncGsiColEmptyState(toColEl);
          /* Deliberately NOTHING else. The task detail sheet rebuilds from
             state every time it opens, and the other boards render on
             their own pages, so there is no stale view left behind that a
             repaint here would fix — and any repaint here would be paid
             for in exactly the jump this change removes. */
        });
      },
    }));
  });
}

/* Re-render exactly one card, in place. The replacement lands at the same
   index in the same column, so nothing around it moves — the only visible
   change is the card's own chips, which is precisely what the drop
   changed. Sortable binds to the COLUMN, not to the cards inside it, so
   swapping a child out doesn't disturb it. */
function persistGsiCardOrder(taskId, colEl) {
  if (!colEl) return;
  const { project } = findProjectTask(taskId);
  const arr = project?.tasks;
  if (!Array.isArray(arr)) return;

  const cards = [...colEl.querySelectorAll(".t-board-col-body > .t-board-card")];
  const at = cards.findIndex(c => c.dataset.taskId === taskId);
  if (at === -1) return;
  const nextId = cards[at + 1]?.dataset.taskId || null;

  const i = arr.findIndex(t => t.id === taskId);
  if (i === -1) return;
  const [moved] = arr.splice(i, 1);
  const j = nextId ? arr.findIndex(t => t.id === nextId) : -1;
  if (j === -1) arr.push(moved); else arr.splice(j, 0, moved);
  persist();
}

function patchGsiCardInPlace(id) {
  const card = document.querySelector(`#ngdrList .t-board-card[data-task-id="${gsiCssId(id)}"]`);
  if (!card) return;
  const { task } = findProjectTask(id);
  if (!task) { card.remove(); return; }
  const holder = document.createElement("div");
  holder.innerHTML = gsiBoardCardHtml(task);
  const fresh = holder.firstElementChild;
  if (fresh) card.replaceWith(fresh);
}
/* Adjusted by a delta rather than recounted from the DOM: the badge shows
   the column's TRUE total including anything folded away behind "show N
   later tasks" (see applyHorizon), so counting the cards actually on
   screen would quietly undercount it. */
function bumpGsiColCount(colEl, delta) {
  const badge = colEl?.querySelector(".t-board-col-count");
  if (!badge) return;
  badge.textContent = String(Math.max(0, (parseInt(badge.textContent, 10) || 0) + delta));
}
/* A column emptied by a drop needs its placeholder back, and one that has
   just received its first card needs it gone. */
function syncGsiColEmptyState(colEl) {
  const body = colEl?.querySelector(".t-board-col-body");
  if (!body) return;
  const hasCards = !!body.querySelector(".t-board-card");
  const hint = body.querySelector(":scope > p.hint");
  if (hasCards && hint) hint.remove();
  if (!hasCards && !hint) {
    const p = document.createElement("p");
    p.className = "hint";
    p.style.padding = "10px 4px";
    p.textContent = "Nothing here.";
    body.appendChild(p);
  }
}
function gsiCssId(id) {
  return (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id).replace(/["\\]/g, "\\$&");
}
function renderProjects() {
  if (gsiTaskView === null) {
    gsiTaskView = state.gsiTaskViewPref || "board";
    const switcher = document.getElementById("gsiTaskViewSwitch");
    if (switcher) switcher.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === gsiTaskView));
  }
  const projects = state.gsi.projects;
  const active = activeProject();
  if (active && state.gsi.activeProject !== active.id) state.gsi.activeProject = active.id;

  renderWorkspaceTabs();
  const nameEl = document.getElementById("projectName");
  if (nameEl && document.activeElement !== nameEl) nameEl.value = active.name;
  const delBtn = document.getElementById("projectDelBtn");
  if (delBtn) delBtn.style.display = projects.length > 1 ? "" : "none";
  const restoreBtn = document.getElementById("projectRestoreBtn");
  if (restoreBtn) restoreBtn.style.display = hasRecentlyDeletedProject() ? "" : "none";
  const archiveBtn = document.getElementById("gsiArchiveBtn");
  if (archiveBtn) {
    const n = (active.archivedTasks || []).length;
    archiveBtn.textContent = `📦 Archive${n ? ` (${n})` : ""}`;
  }

  /* Completed tasks always sink to the bottom, sorted separately from
     the chosen sort mode (matches Microsoft To Do / Todoist convention:
     sort controls apply to your active work, not the completed pile). */
  const open = sortGsiTasks(active.tasks.filter(t => t.status !== "done"));
  const done = active.tasks.filter(t => t.status === "done");
  const ordered = [...open, ...done];

  const listEl = document.getElementById("ngdrList");
  if (gsiTaskView === "board") {
    // Board gets the same sorted list List does. Per-column order is
    // unaffected by the open/done split (done tasks all live in one
    // column anyway), and in Default sort `ordered` still holds plain
    // insertion order — so drag-to-reorder keeps working untouched.
    listEl.innerHTML = renderGsiBoardView(ordered);
  } else {
    listEl.innerHTML = ordered.map(gsiCardHtml).join("") || `<div class="gsi-empty"><p>No tasks yet in ${esc(active.name)}.</p><p class="hint">Add your first task below.</p></div>`;
  }
  const dragHint = document.getElementById("gsiBoardDragHint");
  if (dragHint) dragHint.style.display = (gsiSortMode !== "default" && gsiTaskView === "board") ? "" : "none";
  initGsiBoardSorting();
  capBoardColumnHeights();   // five cards, then the column scrolls — same rule as Overview's board
  initBoardWheelScroll();

  const openCount = active.tasks.filter(i => i.status !== "done").length;
  document.getElementById("ngdrCount").textContent = active.tasks.length ? `${openCount} open` : "";
  // Newly-rendered textareas start at their default single-row height —
  // they don't auto-size until something measures and sets height
  // explicitly, so do that pass right after render (same pattern used
  // for Reference Library's phrase fields). If this render happened
  // while the Work·GSI page itself was hidden (e.g. during initial app
  // boot, before navigating here), this measurement will be wrong —
  // go() in ui.js re-runs this once the page actually becomes visible.
  document.querySelectorAll(".gsi-title").forEach(autoGrow);
  /* Board card titles are <span>s — they size themselves and must NOT be
     given an explicit height. Doing so while this page was hidden pinned
     them to height:0 and made every board title invisible until a
     List/Board toggle forced a re-render. autoGrow now ignores anything
     that isn't a textarea, so this is belt-and-braces, but the call is
     gone as well so the intent is unambiguous. */
}
export function openGsiDatePicker(id) {
  /* Was input.showPicker() — the OS date spinner, where "tomorrow" costs
     three interactions. openDateSheet drives this same hidden input, so
     the save path below it is untouched. See js/date-sheet.js. */
  openDateSheet(`gsi-board-date-${id}`);
}
export function toggleGsiLinkEdit(evt, id) {
  evt.stopPropagation();
  const input = document.getElementById("gsi-link-edit-" + id);
  if (!input) return;
  input.style.display = "inline-block";
  input.focus();
}

export function addProject() {
  const name = prompt("Name this project (e.g. NGDR, BISAG-N Integration, Field Survey):");
  if (!name || !name.trim()) return;
  const p = { id: uid(), name: name.trim(), tasks: [], workDocs: [],
    workDocGroups: [{ id: uid(), name: "General", archived: false, docs: [] }] };
  p.activeWorkDocGroup = p.workDocGroups[0].id;
  state.gsi.projects.push(p);
  state.gsi.activeProject = p.id;
  persist(); renderProjects();
}
export function switchProject(id) {
  state.gsi.activeProject = id;
  persist(false); renderProjects();
  renderLinksAndDocs();
}
export function renameProject(v) {
  const p = activeProject(); if (!p || !v.trim()) return;
  p.name = v.trim();
  persist(); renderProjects();
}
export function renameWorkDocsLabel(v) {
  const p = activeProject(); if (!p) return;
  p.workDocsLabel = v.trim() || "Work documents";
  persist();
}
export function delProject() {
  if (state.gsi.projects.length <= 1) return;
  const p = activeProject();
  if (!confirm(`Delete the "${p.name}" project and all its tasks? You can restore it from Trash within 30 days.`)) return;
  moveToTrash("gsiProject", p);
  state.gsi.projects = state.gsi.projects.filter(x => x.id !== p.id);
  state.gsi.activeProject = state.gsi.projects[0].id;
  persist(); renderProjects();
}
/* ---------- task composer ----------
   The single add row at the bottom of the card is the one place a task
   gets created, so date and link belong here rather than only becoming
   editable after the fact. Both are optional and live in a collapsible
   details row, keeping the common case (type text, press Enter) exactly
   as fast as it was. */
let pendingAddStatus = "todo"; // which column a new task lands in — UI-only, reset after each add

export function toggleGsiAddOptions(forceOpen) {
  const box = document.getElementById("gsiAddOptions");
  const btn = document.getElementById("gsiAddOptsBtn");
  if (!box) return;
  const open = forceOpen === true ? true : !box.classList.contains("open");
  box.classList.toggle("open", open);
  if (btn) btn.classList.toggle("on", open);
  if (open) document.getElementById("newNgdrDate")?.focus();
}
function renderGsiAddTarget() {
  const el = document.getElementById("gsiAddTarget");
  if (!el) return;
  if (pendingAddStatus === "todo") { el.innerHTML = ""; return; }
  const label = (STATUSES.find(([k]) => k === pendingAddStatus) || [null, pendingAddStatus])[1];
  el.innerHTML = `Adding to ${esc(label)} <button class="gsi-add-target-clear" onclick="clearGsiAddTarget()" title="Add to To do instead">✕</button>`;
}
export function clearGsiAddTarget() {
  pendingAddStatus = "todo";
  renderGsiAddTarget();
}
export function addNgdr() {
  const el = document.getElementById("newNgdr");
  const v = el.value.trim();
  if (!v) { el.focus(); return; }
  const dateEl = document.getElementById("newNgdrDate");
  const linkEl = document.getElementById("newNgdrLink");
  const date = dateEl ? dateEl.value : "";
  const link = linkEl ? linkEl.value.trim() : "";
  const task = { id: uid(), text: v, status: pendingAddStatus, date, link, flag: false, googleEventId: null };
  activeProject().tasks.push(task);
  el.value = "";
  if (dateEl) dateEl.value = "";
  if (linkEl) linkEl.value = "";
  pendingAddStatus = "todo";
  persist(); rerender();
  // rerender() rebuilds the task list, not the static add row, so the
  // badge has to be cleared explicitly.
  renderGsiAddTarget();
  el.focus(); // keep the cursor here for the next one
  // A task created with a due date should reach Google Calendar the
  // same way one that gets a date later does (see editProjectTask).
  if (date && task.status !== "done") syncGsiTaskToGoogle(task, "create");
}
/* Opens the inline composer inside the column itself. This used to aim
   the card's bottom add-bar at the column and scroll to it, which meant
   clicking "+ Add task" carried you away from the column you were
   looking at — on a tall board, far enough to lose your place. */
export function quickAddGsiTask(statusKey) {
  openComposer("gsi", statusKey);
}
export function editProjectTask(id, field, v) {
  const { task: t } = findProjectTask(id); if (!t) return;
  t[field] = v; touch(t); persist(); if (field === "text") { if (t.status !== "done") syncGsiTaskToGoogle(t, t.googleEventId ? "update" : "create"); return; }
  rerender();
  if (field === "date" && t.status !== "done") {
    if (!v && t.googleEventId) syncGsiTaskToGoogle(t, "delete");
    else if (v) syncGsiTaskToGoogle(t, t.googleEventId ? "update" : "create");
  }
}
export function setTaskStatus(id, v) {
  const { task: t } = findProjectTask(id);
  if (t) {
    const wasDone = t.status === "done";
    t.status = v; touch(t); persist(); rerender();
    if (v === "done" && !wasDone) syncGsiTaskToGoogle(t, "delete");
    else if (v !== "done" && wasDone) syncGsiTaskToGoogle(t, "create");
  }
}
export function delProjectTask(id) {
  const { task: t, project: p } = findProjectTask(id); if (!t) return;
  moveToTrash("gsiProjectTask", t, { projectId: p.id });
  p.tasks = p.tasks.filter(x => x.id !== id);
  persist(); rerender();
  syncGsiTaskToGoogle(t, "delete");
}
export function toggleProjectTaskFlag(id) {
  const { task: t } = findProjectTask(id);
  if (t) { t.flag = !t.flag; persist(); rerender(); }
}
// Every GSI project's id + name — used to build "which project?"
// selectors elsewhere (currently just Overview's task-project picker,
// see changeTaskProject/addTask in tasks.js). Keeps state.gsi.projects
// itself private to this file, same as everything else here.
export function getProjectList() {
  return state.gsi.projects.map(p => ({ id: p.id, name: p.name }));
}
// Adds an already-built task object straight into one project's list —
// used when Overview creates a new task with a project chosen, or when
// a native task is converted into a GSI task (see changeTaskProject in
// tasks.js). Returns false and does nothing if the project no longer
// exists, so the caller can decide not to lose the task.
export function addProjectTaskRaw(projectId, task) {
  const p = state.gsi.projects.find(x => x.id === projectId);
  if (!p) return false;
  p.tasks.push(task);
  persist(); rerender();
  return true;
}
// Moves an existing task from its current project into a different one.
export function moveProjectTask(taskId, targetProjectId) {
  const { task: t, project: from } = findProjectTask(taskId);
  if (!t || !from) return false;
  const to = state.gsi.projects.find(x => x.id === targetProjectId);
  if (!to || to.id === from.id) return false;
  from.tasks = from.tasks.filter(x => x.id !== taskId);
  to.tasks.push(t);
  persist(); rerender();
  return true;
}
// Removes a task from its project WITHOUT persisting/re-rendering —
// used only mid-conversion by changeTaskProject in tasks.js, which
// pushes the same task into state.tasks right after and persists once
// for the whole operation rather than twice.
export function pluckProjectTask(taskId) {
  const { task: t, project: p } = findProjectTask(taskId);
  if (!t || !p) return null;
  p.tasks = p.tasks.filter(x => x.id !== taskId);
  return t;
}

/* ---------------- Daily work log ---------------- */
function renderLog() {
  const byDate = [...state.gsi.log].sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById("logList").innerHTML = byDate.map(e => `
    <div class="log-entry">
      <div class="log-date"><span>${fmtDate(e.date)}</span>
        <button class="del" style="opacity:.35" onclick="delLog('${e.id}')">✕</button></div>
      <div class="log-text">${esc(e.text)}</div>
    </div>`).join("") || `<p class="hint">Log one line per day — future-you will thank you at appraisal time.</p>`;
}
export function addLog() {
  const el = document.getElementById("newLog"); const v = el.value.trim(); if (!v) return;
  state.gsi.log.push({ id: uid(), date: todayKey(), text: v }); el.value = "";
  persist(); renderLog();
}
export function delLog(id) {
  const l = state.gsi.log.find(x => x.id === id);
  if (l) moveToTrash("log", l);
  state.gsi.log = state.gsi.log.filter(x => x.id !== id); persist(); renderLog();
}

/* ---------------- Meeting minutes (structured, click to expand) ---------------- */
function meetingBodyHtml(m) {
  return `
    <table class="mm-summary">
      <tr><td>Date &amp; time</td><td>
        <input type="date" value="${esc(m.date)}" onchange="editMeeting('${m.id}','date',this.value)">
        <input type="text" placeholder="e.g. 11:00 AM" value="${esc(m.time||"")}" onchange="editMeeting('${m.id}','time',this.value)">
      </td></tr>
      <tr><td>Project name</td><td><input type="text" placeholder="Project name" value="${esc(m.title)}" onchange="editMeeting('${m.id}','title',this.value)"></td></tr>
      <tr><td>Project duration</td><td><input type="text" placeholder="e.g. 3 months" value="${esc(m.duration||"")}" onchange="editMeeting('${m.id}','duration',this.value)"></td></tr>
    </table>
    <div class="mm-section">
      <label>Agenda
        <button class="expand-btn mm-expand-btn" onclick="expandView('mm-agenda-wrap-${m.id}','Agenda — ${esc(m.title)}')" title="View large">
          <svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
      </label>
      <div id="mm-agenda-wrap-${m.id}">
        <div id="mm-agenda-${m.id}" class="mm-rich-editor"></div>
        <div class="mm-grammar-row"><button class="mm-grammar-btn" id="gbtn-mm-agenda-${m.id}" onclick="runGrammarCheck('mm-agenda-${m.id}')">✓ Grammar check</button></div>
        <div class="grammar-results" id="grammar-mm-agenda-${m.id}"></div>
      </div>
    </div>
    <div class="mm-section">
      <label>General &amp; roundtable updates
        <button class="expand-btn mm-expand-btn" onclick="expandView('mm-updates-wrap-${m.id}','Updates — ${esc(m.title)}')" title="View large">
          <svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
      </label>
      <div id="mm-updates-wrap-${m.id}">
        <div id="mm-updates-${m.id}" class="mm-rich-editor"></div>
        <div class="mm-grammar-row"><button class="mm-grammar-btn" id="gbtn-mm-updates-${m.id}" onclick="runGrammarCheck('mm-updates-${m.id}')">✓ Grammar check</button></div>
        <div class="grammar-results" id="grammar-mm-updates-${m.id}"></div>
      </div>
    </div>
    <div class="mm-section">
      <label>Action items
        <button class="expand-btn mm-expand-btn" onclick="expandView('mm-actionItems-wrap-${m.id}','Action items — ${esc(m.title)}')" title="View large">
          <svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
      </label>
      <div id="mm-actionItems-wrap-${m.id}">
        <div id="mm-actionItems-${m.id}" class="mm-rich-editor"></div>
        <div class="mm-grammar-row"><button class="mm-grammar-btn" id="gbtn-mm-actionItems-${m.id}" onclick="runGrammarCheck('mm-actionItems-${m.id}')">✓ Grammar check</button></div>
        <div class="grammar-results" id="grammar-mm-actionItems-${m.id}"></div>
      </div>
    </div>
    <div class="meeting-link-row">
      <input type="text" placeholder="Link (agenda doc, recording…)" value="${esc(m.link||"")}" onchange="editMeeting('${m.id}','link',this.value)">
      ${m.link ? `<a href="${esc(m.link.startsWith("http")?m.link:"https://"+m.link)}" target="_blank" rel="noopener" title="Open link">🔗</a>` : ""}
    </div>
    <button class="del" style="margin-top:8px" onclick="delMeeting('${m.id}')">Delete meeting</button>`;
}

function mountMeetingEditors(m) {
  ["agenda", "updates", "actionItems"].forEach(field => {
    mountRichEditor("mm-" + field + "-" + m.id, () => m[field] || "", html => {
      m[field] = html;
      persist(); // rich-text.js already debounces text-change before calling us
    });
  });
}
function unmountMeetingEditors(m) {
  ["agenda", "updates", "actionItems"].forEach(field => unmountRichEditor("mm-" + field + "-" + m.id));
}

function renderMeetings() {
  const meets = [...state.gsi.meetings].sort((a, b) => b.date.localeCompare(a.date));
  meets.forEach(m => { if (m.open) unmountMeetingEditors(m); }); // about to rebuild their containers
  document.getElementById("meetingList").innerHTML = meets.map(m => `
    <div class="mm-card">
      <button class="mm-head" onclick="toggleMeetingOpen('${m.id}')">
        <span class="log-date">${fmtDate(m.date)}${m.time ? " · " + esc(m.time) : ""}</span>
        <span class="mm-title">${esc(m.title) || "Untitled meeting"}</span>
        <span class="mm-arw">${m.open ? "▼" : "▶"}</span>
      </button>
      <div class="mm-body" id="mmBody-${m.id}">${m.open ? meetingBodyHtml(m) : ""}</div>
    </div>`).join("") || `<p class="hint">Add a meeting to capture decisions and action points.</p>`;
  meets.forEach(m => { if (m.open) mountMeetingEditors(m); });
}

let grammarCache = {}; // richEditorId -> last-checked text, so Apply buttons use fresh offsets
export async function runGrammarCheck(richId) {
  const quill = getRichEditor(richId);
  const resultsEl = document.getElementById("grammar-" + richId);
  const btn = document.getElementById("gbtn-" + richId);
  if (!quill || !resultsEl) return;
  const text = quill.getText();
  if (!text.trim()) { toast("Nothing to check yet"); return; }
  if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
  const matches = await checkGrammar(text);
  if (btn) { btn.disabled = false; btn.textContent = "✓ Grammar check"; }
  if (matches === null) { toast("Grammar check is temporarily unavailable — try again shortly"); return; }
  grammarCache[richId] = text;
  if (matches.length === 0) {
    resultsEl.innerHTML = `<p class="hint" style="margin:6px 0 0">No issues found. <a href="https://languagetool.org" target="_blank" rel="noopener">LanguageTool</a></p>`;
    return;
  }
  resultsEl.innerHTML = `<div class="grammar-list">` +
    matches.map((m, i) => `
      <div class="grammar-item">
        <span class="grammar-msg">${esc(m.message)}${m.original ? ` — "<b>${esc(m.original)}</b>"` : ""}</span>
        ${m.replacements.length ? m.replacements.map(r =>
          `<button class="grammar-fix-btn" onclick="applyGrammarFix('${richId}',${i},'${esc(r).replace(/'/g, "\\'")}')">→ ${esc(r)}</button>`).join("") : ""}
      </div>`).join("") +
    `</div><p class="hint" style="margin:8px 0 0">${matches.length} issue${matches.length===1?"":"s"} found — <a href="https://languagetool.org" target="_blank" rel="noopener">LanguageTool</a></p>`;
  resultsEl.dataset.matches = JSON.stringify(matches);
}
export function applyGrammarFix(richId, matchIndex, replacement) {
  const quill = getRichEditor(richId);
  const resultsEl = document.getElementById("grammar-" + richId);
  if (!quill || !resultsEl || !resultsEl.dataset.matches) return;
  if (quill.getText() !== grammarCache[richId]) { toast("Text changed since the last check — checking again"); runGrammarCheck(richId); return; }
  const matches = JSON.parse(resultsEl.dataset.matches);
  const m = matches[matchIndex]; if (!m) return;
  quill.deleteText(m.offset, m.length);
  quill.insertText(m.offset, replacement);
  runGrammarCheck(richId); // fresh offsets for any remaining issues
}
export function addMeeting() {
  const el = document.getElementById("newMeeting"); const v = el.value.trim(); if (!v) return;
  state.gsi.meetings.push({ id: uid(), date: todayKey(), time: "", title: v, duration: "", agenda: "", updates: "", actionItems: "", link: "", open: true });
  el.value = "";
  persist(); renderMeetings();
}
export function toggleMeetingOpen(id) {
  const m = state.gsi.meetings.find(x => x.id === id); if (!m) return;
  const wasOpen = m.open;
  m.open = !m.open;
  persist(false);

  const meets = [...state.gsi.meetings].sort((a, b) => b.date.localeCompare(a.date));
  const idx = meets.findIndex(x => x.id === id);
  const cards = document.querySelectorAll("#meetingList .mm-card");
  const card = cards[idx];
  if (!card) { renderMeetings(); return; } // structure drifted somehow — safe fallback
  const arw = card.querySelector(".mm-arw");
  const bodyEl = document.getElementById("mmBody-" + id);
  if (arw) arw.textContent = m.open ? "▼" : "▶";
  if (wasOpen) unmountMeetingEditors(m);
  if (bodyEl) bodyEl.innerHTML = m.open ? meetingBodyHtml(m) : "";
  if (m.open) mountMeetingEditors(m);
}
export function editMeeting(id, field, v) {
  const m = state.gsi.meetings.find(x => x.id === id);
  if (!m) return;
  m[field] = v;
  persist();
  if (field === "title" || field === "date" || field === "time") {
    // Update just the collapsed header, not the whole list — a full
    // re-render here would tear down this meeting's live rich editors.
    const meets = [...state.gsi.meetings].sort((a, b) => b.date.localeCompare(a.date));
    const idx = meets.findIndex(x => x.id === id);
    const card = document.querySelectorAll("#meetingList .mm-card")[idx];
    if (card) {
      const titleEl = card.querySelector(".mm-title");
      const dateEl = card.querySelector(".log-date");
      if (titleEl) titleEl.textContent = m.title || "Untitled meeting";
      if (dateEl) dateEl.textContent = fmtDate(m.date) + (m.time ? " · " + m.time : "");
    }
  }
}
export function delMeeting(id) {
  if (!confirm("Delete this meeting note?")) return;
  const m = state.gsi.meetings.find(x => x.id === id);
  if (m) { moveToTrash("meeting", m); if (m.open) unmountMeetingEditors(m); }
  state.gsi.meetings = state.gsi.meetings.filter(x => x.id !== id);
  persist(); renderMeetings();
}

/* ---------------- GSI links, personal & work documents ----------------
   All three lists share one small tab component (same one Important
   Links uses on Overview) instead of each having their own markup —
   .link-card, which they used before, no longer exists as a CSS class
   (it was retired when Important Links was redesigned), so all three
   were quietly rendering unstyled until this. */
let openDocEditId = null; // shared across all three lists — only one popover open at a time
function docTabHtml(d, nameField, urlField, editFn, delFn) {
  const name = d[nameField] || "";
  const url = d[urlField] || "";
  const fullUrl = url.startsWith("http") ? url : "https://" + url;
  return `
    <div class="link-row" data-doc-id="${d.id}">
      <a href="${esc(fullUrl)}" target="_blank" rel="noopener" class="link-row-title" onclick="linkClickPulse(this)">${esc(name)}</a>
      <button class="link-edit-btn" onclick="toggleDocEdit('${d.id}')" title="Edit">✎</button>
      <button class="del link-del-btn" onclick="${delFn}('${d.id}')" title="Delete">✕</button>
      <div class="link-edit-panel ${openDocEditId === d.id ? "open" : ""}" id="docEdit-${d.id}">
        <div class="link-edit-panel-inner">
          <input type="text" value="${esc(name)}" placeholder="Name" onchange="${editFn}('${d.id}','${nameField}',this.value)">
          <input type="text" value="${esc(url)}" placeholder="https://…" onchange="${editFn}('${d.id}','${urlField}',this.value)">
        </div>
      </div>
    </div>`;
}
export function toggleDocEdit(id) {
  openDocEditId = openDocEditId === id ? null : id;
  renderLinksAndDocs();
  document.querySelectorAll(".card.has-open-popover").forEach(c => c.classList.remove("has-open-popover"));
  if (openDocEditId) {
    const panel = document.getElementById(`docEdit-${openDocEditId}`);
    panel?.closest(".card")?.classList.add("has-open-popover"); // see widgets.js's toggleLinkEdit for why: backdrop-filter gives every .card its own stacking context, so the popover's own z-index can't otherwise escape it
    panel?.querySelector("input")?.focus();
  }
}
document.addEventListener("pointerdown", evt => {
  if (!openDocEditId) return;
  if (evt.target.closest(".link-edit-panel") || evt.target.closest(".link-edit-btn")) return;
  toggleDocEdit(openDocEditId);
});
function renderLinksAndDocs() {
  const g = state.gsi;
  const p = activeProject();
  const labelEl = document.getElementById("workDocsLabel");
  if (labelEl && document.activeElement !== labelEl) labelEl.value = p.workDocsLabel || "Work documents";
  const gl = document.getElementById("gsiLinks");
  if (gl) gl.innerHTML = g.links.map(l => docTabHtml(l, "title", "url", "editGsiLink", "delGsiLink")).join("") || `<p class="hint">No links yet.</p>`;
  const pd = document.getElementById("personalDocs");
  if (pd) pd.innerHTML = (g.personalDocs || []).map(d => docTabHtml(d, "name", "url", "editPersonalDoc", "delPersonalDoc")).join("") || `<p class="hint">No documents yet.</p>`;
  renderWorkDocs();
}

/* ---------- Work documents: named tabs, each holding its own links ----------
   Deleting still routes through Trash (30-day recovery). Archiving is the
   separate, gentler action — the tab or link stays with the project, just
   out of the way, and comes back from the Archived panel in one click.
   Same split GSI tasks already draw between Archive and Trash. */
function liveWorkDocGroups(p) { return (p.workDocGroups || []).filter(gr => !gr.archived); }
function currentWorkDocGroup(p) {
  const live = liveWorkDocGroups(p);
  return live.find(gr => gr.id === p.activeWorkDocGroup) || live[0] || null;
}
let workDocArchiveOpen = false;

function renderWorkDocs() {
  const p = activeProject();
  if (!p) return;
  const live = liveWorkDocGroups(p);
  const group = currentWorkDocGroup(p);

  const tabsEl = document.getElementById("workDocTabs");
  if (tabsEl) {
    tabsEl.innerHTML = live.map(gr => `
      <button class="tab ${group && gr.id === group.id ? "active" : ""}" onclick="switchWorkDocGroup('${gr.id}')">${esc(gr.name)}</button>`).join("")
      + `<button class="tab tab-add" onclick="addWorkDocGroup()" title="New tab">＋</button>`;
  }

  const nameRow = document.getElementById("workDocGroupRow");
  if (nameRow) nameRow.style.display = group ? "" : "none";
  const nameEl = document.getElementById("workDocGroupName");
  if (nameEl && group && document.activeElement !== nameEl) nameEl.value = group.name;

  const wd = document.getElementById("workDocs");
  if (wd) {
    if (!group) {
      wd.innerHTML = `<p class="hint">Every tab is archived — restore one below, or add a new tab.</p>`;
    } else {
      const docs = group.docs.filter(d => !d.archived);
      wd.innerHTML = docs.map(d => workDocRowHtml(d)).join("") || `<p class="hint">No documents in this tab yet.</p>`;
    }
  }

  // The count covers archived tabs plus archived links inside *live* tabs.
  // Links inside an archived tab aren't listed separately — restoring the
  // tab brings them back with it, so listing them twice would mislead.
  const archivedGroups = (p.workDocGroups || []).filter(gr => gr.archived);
  const archivedDocs = [];
  live.forEach(gr => gr.docs.filter(d => d.archived).forEach(d => archivedDocs.push({ d, gr })));
  const total = archivedGroups.length + archivedDocs.length;

  const trigger = document.getElementById("workDocArchiveBtn");
  if (trigger) {
    trigger.style.display = total ? "" : "none";
    trigger.textContent = `🗄 Archived (${total})`;
  }
  const panel = document.getElementById("workDocArchivePanel");
  if (panel) {
    if (!total) workDocArchiveOpen = false;
    panel.classList.toggle("open", workDocArchiveOpen);
    panel.innerHTML = !workDocArchiveOpen ? "" :
      archivedGroups.map(gr => `
        <div class="gsi-archive-row">
          <span class="gsi-archive-text">📁 ${esc(gr.name)} <span class="hint">— tab, ${gr.docs.length} link(s)</span></span>
          <div class="gsi-archive-actions">
            <button class="gsi-archive-restore" onclick="restoreWorkDocGroup('${gr.id}')">↺ Restore</button>
            <button class="gsi-archive-remove" onclick="delWorkDocGroup('${gr.id}')" title="Delete tab (recoverable from Trash)">✕</button>
          </div>
        </div>`).join("")
      + archivedDocs.map(({ d, gr }) => `
        <div class="gsi-archive-row">
          <span class="gsi-archive-text">🔗 ${esc(d.name)} <span class="hint">— in ${esc(gr.name)}</span></span>
          <div class="gsi-archive-actions">
            <button class="gsi-archive-restore" onclick="restoreWorkDoc('${gr.id}','${d.id}')">↺ Restore</button>
            <button class="gsi-archive-remove" onclick="delWorkDoc('${d.id}','${gr.id}')" title="Delete link (recoverable from Trash)">✕</button>
          </div>
        </div>`).join("");
  }
}
// The same row docTabHtml builds, with an archive button before delete.
function workDocRowHtml(d) {
  const url = d.url || "";
  const fullUrl = url.startsWith("http") ? url : "https://" + url;
  return `
    <div class="link-row" data-doc-id="${d.id}">
      <a href="${esc(fullUrl)}" target="_blank" rel="noopener" class="link-row-title" onclick="linkClickPulse(this)">${esc(d.name || "")}</a>
      <button class="link-edit-btn" onclick="toggleDocEdit('${d.id}')" title="Edit">✎</button>
      <button class="link-edit-btn" onclick="archiveWorkDoc('${d.id}')" title="Archive — keeps it, just hides it">🗄</button>
      <button class="del link-del-btn" onclick="delWorkDoc('${d.id}')" title="Delete">✕</button>
      <div class="link-edit-panel ${openDocEditId === d.id ? "open" : ""}" id="docEdit-${d.id}">
        <div class="link-edit-panel-inner">
          <input type="text" value="${esc(d.name || "")}" placeholder="Name" onchange="editWorkDoc('${d.id}','name',this.value)">
          <input type="text" value="${esc(url)}" placeholder="https://…" onchange="editWorkDoc('${d.id}','url',this.value)">
        </div>
      </div>
    </div>`;
}

export function toggleWorkDocArchive() { workDocArchiveOpen = !workDocArchiveOpen; renderWorkDocs(); }
export function addWorkDocGroup() {
  const name = prompt("Name this tab (e.g. NGDR, Circulars, Field reports):");
  if (!name || !name.trim()) return;
  const p = activeProject();
  const gr = { id: uid(), name: name.trim(), archived: false, docs: [] };
  p.workDocGroups.push(gr);
  p.activeWorkDocGroup = gr.id;
  persist(); rerender();
}
export function switchWorkDocGroup(id) {
  activeProject().activeWorkDocGroup = id;
  persist(false); rerender();
}
export function renameWorkDocGroup(v) {
  const gr = currentWorkDocGroup(activeProject());
  if (!gr || !v.trim()) return;
  gr.name = v.trim();
  persist(); rerender();
}
export function archiveWorkDocGroup() {
  const p = activeProject();
  const gr = currentWorkDocGroup(p);
  if (!gr) return;
  gr.archived = true;
  const next = liveWorkDocGroups(p)[0];
  p.activeWorkDocGroup = next ? next.id : "";
  persist(); rerender();
  toast(`Archived "${gr.name}" — restore it from Archived`);
}
export function restoreWorkDocGroup(id) {
  const p = activeProject();
  const gr = (p.workDocGroups || []).find(x => x.id === id);
  if (!gr) return;
  gr.archived = false;
  p.activeWorkDocGroup = gr.id;
  persist(); rerender();
  toast(`Restored "${gr.name}"`);
}
export function delWorkDocGroup(id) {
  const p = activeProject();
  const gr = (p.workDocGroups || []).find(x => x.id === id) || currentWorkDocGroup(p);
  if (!gr) return;
  if (!confirm(`Delete the "${gr.name}" tab and its ${gr.docs.length} link(s)? You can restore it from Trash within 30 days.`)) return;
  moveToTrash("workDocGroup", gr, { projectId: p.id });
  p.workDocGroups = p.workDocGroups.filter(x => x.id !== gr.id);
  if (!p.workDocGroups.length) {
    // A project always keeps at least one tab, otherwise Add has nowhere to go.
    p.workDocGroups.push({ id: uid(), name: "General", archived: false, docs: [] });
  }
  const next = liveWorkDocGroups(p)[0] || p.workDocGroups[0];
  p.activeWorkDocGroup = next.id;
  persist(); rerender();
  toast(`Deleted "${gr.name}"`, "Undo", "undoLastDeleted('workDocGroup')");
}
export function archiveWorkDoc(id) {
  const gr = currentWorkDocGroup(activeProject());
  const d = gr && gr.docs.find(x => x.id === id);
  if (!d) return;
  d.archived = true;
  persist(); rerender();
  toast(`Archived "${d.name}" — restore it from Archived`);
}
export function restoreWorkDoc(groupId, docId) {
  const p = activeProject();
  const gr = (p.workDocGroups || []).find(x => x.id === groupId);
  const d = gr && gr.docs.find(x => x.id === docId);
  if (!d) return;
  d.archived = false;
  persist(); rerender();
  toast(`Restored "${d.name}"`);
}
// Delete already goes through Trash for all three (see delGsiLink /
// delPersonalDoc / delWorkDoc below) — this just gives an accidental
// click a fast way back, same idea as restoreLastDeletedProject above,
// generalized across the three trash "type" values these deletes use.
export function undoLastDeleted(type) {
  const entry = state.trash.find(x => x.type === type); // trash is newest-first (moveToTrash unshifts new entries), so no reverse needed here
  if (!entry) return;
  if (type === "gsiLink") state.gsi.links.unshift(entry.payload);
  else if (type === "personalDoc") { state.gsi.personalDocs = state.gsi.personalDocs || []; state.gsi.personalDocs.unshift(entry.payload); }
  else if (type === "workDoc") {
    const p = state.gsi.projects.find(x => x.id === entry.meta?.projectId) || activeProject();
    // Fall back through: the tab it came from, the tab on screen, the first tab.
    const gr = (p.workDocGroups || []).find(x => x.id === entry.meta?.groupId)
      || currentWorkDocGroup(p) || (p.workDocGroups || [])[0];
    if (!gr) return;
    gr.docs.unshift(entry.payload);
  }
  else if (type === "workDocGroup") {
    const p = state.gsi.projects.find(x => x.id === entry.meta?.projectId) || activeProject();
    p.workDocGroups = p.workDocGroups || [];
    entry.payload.archived = false;
    p.workDocGroups.push(entry.payload);
    p.activeWorkDocGroup = entry.payload.id;
  }
  else return;
  state.trash = state.trash.filter(x => x.id !== entry.id);
  persist(); rerender();
  toast(`Restored "${entry.payload.title || entry.payload.name}"`);
}
function editUrlField(field, value) {
  if (field !== "url") return value.trim ? value.trim() : value;
  value = value.trim();
  return value && !/^https?:\/\//i.test(value) ? "https://" + value : value;
}
export function editGsiLink(id, field, value) {
  const l = state.gsi.links.find(x => x.id === id); if (!l) return;
  l[field] = editUrlField(field, value); persist(); rerender();
}
export function editPersonalDoc(id, field, value) {
  const d = (state.gsi.personalDocs || []).find(x => x.id === id); if (!d) return;
  d[field] = editUrlField(field, value); persist(); rerender();
}
export function editWorkDoc(id, field, value) {
  const p = activeProject();
  const gr = (p.workDocGroups || []).find(x => x.docs.some(d => d.id === id));
  const d = gr && gr.docs.find(x => x.id === id); if (!d) return;
  d[field] = editUrlField(field, value); persist(); rerender();
}
export function addGsiLink() {
  const t = document.getElementById("gsiLinkTitle"), u = document.getElementById("gsiLinkUrl");
  if (!t.value.trim() || !u.value.trim()) return toast("Title and URL are required");
  let url = u.value.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  state.gsi.links.push({ id: uid(), title: t.value.trim(), url });
  t.value = u.value = "";
  persist(); rerender();
}
export function delGsiLink(id) {
  const l = state.gsi.links.find(x => x.id === id);
  if (!l) return;
  moveToTrash("gsiLink", l);
  state.gsi.links = state.gsi.links.filter(x => x.id !== id); persist(); rerender();
  toast(`Deleted "${l.title}"`, "Undo", "undoLastDeleted('gsiLink')");
}
export function addPersonalDoc() {
  const n = document.getElementById("personalDocName"), u = document.getElementById("personalDocUrl");
  if (!n.value.trim() || !u.value.trim()) return toast("Name and link are required");
  state.gsi.personalDocs = state.gsi.personalDocs || [];
  state.gsi.personalDocs.push({ id: uid(), name: n.value.trim(), url: u.value.trim() });
  n.value = u.value = "";
  persist(); rerender();
}
export function delPersonalDoc(id) {
  const d = (state.gsi.personalDocs || []).find(x => x.id === id);
  if (!d) return;
  moveToTrash("personalDoc", d);
  state.gsi.personalDocs = (state.gsi.personalDocs || []).filter(x => x.id !== id);
  persist(); rerender();
  toast(`Deleted "${d.name}"`, "Undo", "undoLastDeleted('personalDoc')");
}
export function addWorkDoc() {
  const n = document.getElementById("workDocName"), u = document.getElementById("workDocUrl");
  if (!n.value.trim() || !u.value.trim()) return toast("Name and link are required");
  const p = activeProject();
  const gr = currentWorkDocGroup(p);
  if (!gr) return toast("Add or restore a tab first");
  gr.docs.push({ id: uid(), name: n.value.trim(), url: u.value.trim(), archived: false });
  n.value = u.value = "";
  persist(); rerender();
}
// groupId is optional — supplied when deleting from the Archived panel,
// where the link may sit in a tab that isn't the one currently selected.
export function delWorkDoc(id, groupId) {
  const p = activeProject();
  const gr = groupId
    ? (p.workDocGroups || []).find(x => x.id === groupId)
    : (p.workDocGroups || []).find(x => x.docs.some(d => d.id === id));
  const d = gr && gr.docs.find(x => x.id === id);
  if (!d) return;
  moveToTrash("workDoc", d, { projectId: p.id, groupId: gr.id });
  gr.docs = gr.docs.filter(x => x.id !== id);
  persist(); rerender();
  toast(`Deleted "${d.name}"`, "Undo", "undoLastDeleted('workDoc')");
}

export function renderGsi() {
  renderProjects();
  renderLog();
  renderMeetings();
  renderLinksAndDocs();
}

/* Tasks — flagged tasks are what make a task "important" and
   sort to the top; also has due date, link, and Work/Personal category.
   The "Work"/"All" view also merges in every Work·GSI project's tasks
   (tagged with their project name), so Overview gives one unified picture
   of everything work-related rather than two separate task lists living
   in two different places. GSI tasks keep their own storage and schema
   (a 4-state status, not a simple done/not-done) — this only merges them
   for DISPLAY, routing edits back to the correct underlying data. */
import { state, uid, esc, persist, rerender } from './state.js';
import { toast, autoGrow } from './ui.js';
import { moveToTrash } from './trash.js';
import { syncTaskToGoogle } from './google-calendar.js';
import { getAllGsiTasksFlat, findProjectTask, editProjectTask, setTaskStatus as setGsiTaskStatus,
  delProjectTask, toggleProjectTaskFlag, archiveGsiTaskEntry,
  getProjectList, addProjectTaskRaw, moveProjectTask, pluckProjectTask } from './gsi.js';

let taskFilter = "all"; // "all" | "work" | "personal"
let sortByDate = false;
let taskView = null; // "list" | "board" | "calendar" — lazily initialized from state.taskViewPref on first render (see renderTasks), then kept in sync with it on every change
let calendarMonth = (() => { const d = new Date(); d.setDate(1); return d; })(); // first-of-month, tracks which month Calendar view is showing
let collapsedSections = new Set(); // UI-only display state, not persisted — which of Today/Upcoming/Completed are collapsed
let expandedTaskId = null; // UI-only — which single row currently has its edit controls open
let archivedSort = "newest"; // "newest" | "oldest" | "completed" | "alpha" — UI-only, not persisted

function fmtCompletedAt(ts) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const isToday = d >= today;
  const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  return isToday ? time : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + " · " + time;
}

function fmtDue(d) {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(y, m - 1, day);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((dt - today) / 86400000);
  const label = dt.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  if (diffDays < 0) return { text: label, cls: "overdue" };
  if (diffDays === 0) return { text: "Today", cls: "duetoday" };
  if (diffDays === 1) return { text: "Tomorrow", cls: "" };
  return { text: label, cls: "" };
}

export function toggleSortByDate() {
  sortByDate = !sortByDate;
  renderTasks();
}
// ---------- Drag-to-reorder (List view, Default sort only) ----------
let sortableInstances = [];
function destroySortables() {
  sortableInstances.forEach(s => { try { s.destroy(); } catch (e) { /* already gone with its container — fine */ } });
  sortableInstances = [];
}
function initTaskSorting() {
  destroySortables();
  if (taskView !== "list" || sortByDate || typeof Sortable === "undefined") return;
  document.querySelectorAll("#taskList .t-section-rows-inner").forEach(container => {
    sortableInstances.push(Sortable.create(container, {
      handle: ".t-drag-handle",
      filter: ".t-drag-handle-spacer", // the GSI-row placeholder isn't a handle at all, so grabbing it (or a GSI row generally) never starts a drag
      draggable: ".t-row[data-is-gsi='0']", // only native rows are ever pick-up-able
      preventOnFilter: false, // a tap that misses the (non-existent) handle on a GSI row should still behave as a normal click, not get swallowed
      animation: 200,
      delay: 300, delayOnTouchOnly: true, touchStartThreshold: 5, // long-press to start on touch; no delay for mouse
      ghostClass: "t-row-ghost", dragClass: "t-row-dragging", chosenClass: "t-row-chosen",
      scroll: true, scrollSensitivity: 90, scrollSpeed: 12,
      onEnd: handleTaskDragEnd,
    }));
  });
}
function handleTaskDragEnd(evt) {
  const draggedId = evt.item.dataset.taskId;
  const draggedTask = state.tasks.find(t => t.id === draggedId);
  if (!draggedTask) { renderTasks(); return; } // shouldn't happen — GSI rows can't be dragged — but stay safe rather than silently do nothing
  const orderedIds = Array.from(evt.to.children).map(el => el.dataset.taskId).filter(Boolean);
  const idx = orderedIds.indexOf(draggedId);
  // Walk outward past any interspersed GSI task ids (which have no
  // position field to compare against) to find the nearest actual
  // native neighbor on each side.
  const nativeNeighbor = (dir) => {
    for (let i = idx + dir; i >= 0 && i < orderedIds.length; i += dir) {
      const t = state.tasks.find(x => x.id === orderedIds[i]);
      if (t) return t;
    }
    return null;
  };
  const before = nativeNeighbor(-1), after = nativeNeighbor(1);
  const beforePos = before ? (before.position ?? 0) : null;
  const afterPos = after ? (after.position ?? 0) : null;
  // Fractional midpoint insertion — this is the entire point of using
  // a position field instead of array index: only the ONE dragged
  // task's position ever needs to change, never a renumbering pass
  // across the whole list.
  draggedTask.position =
    beforePos == null && afterPos == null ? 1000 :
    beforePos == null ? afterPos - 1000 :
    afterPos == null ? beforePos + 1000 :
    (beforePos + afterPos) / 2;
  persist();
  renderTasks();
}

// ---------- Board view drag-and-drop (six columns, cross-column moves) ----------
let boardSortableInstances = [];
function destroyBoardSortables() {
  boardSortableInstances.forEach(s => { try { s.destroy(); } catch (e) { /* already gone with its container */ } });
  boardSortableInstances = [];
}
function initBoardSorting() {
  destroyBoardSortables();
  if (taskView !== "board" || sortByDate || typeof Sortable === "undefined") return;
  document.querySelectorAll("#taskList .t-board-col-body").forEach(container => {
    boardSortableInstances.push(Sortable.create(container, {
      group: "task-board", // shared across every column — this is what allows dragging between them, not just within one
      handle: ".t-board-card-handle",
      draggable: ".t-board-card", // GSI cards are pick-up-able here too — moveTaskToColumn routes them through setGsiTaskStatus/editProjectTask/archiveGsiTaskEntry instead of the native task functions
      preventOnFilter: false,
      animation: 200,
      delay: 300, delayOnTouchOnly: true, touchStartThreshold: 5,
      ghostClass: "t-row-ghost", dragClass: "t-row-dragging", chosenClass: "t-row-chosen",
      scroll: true, scrollSensitivity: 90, scrollSpeed: 12,
      onEnd: handleBoardDragEnd,
    }));
  });
}
function handleBoardDragEnd(evt) {
  const draggedId = evt.item.dataset.taskId;
  const fromCol = evt.from.closest(".t-board-col")?.dataset.boardCol;
  const toCol = evt.to.closest(".t-board-col")?.dataset.boardCol;
  if (!draggedId || !toCol) { renderTasks(); return; }
  if (fromCol === toCol) {
    // Reordering within one column — identical position math to List
    // view's own reorder, it doesn't care what shape the container is.
    // GSI cards have no position field to reorder by, so handleTaskDragEnd's
    // own state.tasks lookup misses, it just re-renders, and the card
    // visually snaps back — cross-column moves (below) are what GSI
    // cards actually support.
    handleTaskDragEnd(evt);
    return;
  }
  const ok = moveTaskToColumn(draggedId, toCol);
  // Always re-render regardless of outcome — this is what makes a
  // rejected move (e.g. dropping into Overdue without a qualifying
  // date) visually snap back to wherever the task actually belongs,
  // since the board is rebuilt fresh from real data rather than
  // trying to manually undo whatever SortableJS already did to the DOM.
  renderTasks();
  if (ok === false) toast("That task can't move there");
}
// Every actual mutation here goes through the exact same functions the
// rest of the app already uses (toggleTask, editTaskMeta, archiveTask,
// restoreArchivedTaskEntry, and their GSI counterparts setGsiTaskStatus/
// archiveGsiTaskEntry) — sync, Google Calendar, and persistence are
// entirely their responsibility, not reimplemented here. GSI tasks are
// looked up via findAnyTask (same helper the popup/toggle/flag/edit
// paths already share) so a card's status/date live-updates in its
// actual GSI project, not in a copy.
function moveTaskToColumn(id, targetCol) {
  const found = findAnyTask(id);
  if (!found) return false;
  const { task: t, isGsi, project } = found;
  const todayStr = new Date().toISOString().slice(0, 10);
  const curDate = isGsi ? t.date : t.dueDate;
  const done = isGsi ? t.status === "done" : t.done;

  if (targetCol === "archived") {
    if (isGsi) {
      if (done) { archiveGsiTaskEntry(project.id, id); return true; }
      setGsiTaskStatus(id, "done"); // GSI archive is for finished tasks, same intent as native's requirement below
      archiveGsiTaskEntry(project.id, id);
      return true;
    }
    if (t.archived) return true;
    if (!t.done) toggleTask(id); // archiveTask requires a completed task
    archiveTask(id);
    return true;
  }
  if (targetCol === "completed") {
    if (isGsi) {
      if (t.status !== "done") setGsiTaskStatus(id, "done");
      return true;
    }
    if (t.archived) { restoreArchivedTaskEntry(id); return true; } // "Archived -> Completed" is a restore, not a re-completion
    if (!t.done) toggleTask(id);
    return true;
  }
  // Every remaining target is date-based — a done/archived task needs
  // to come back to "open" first before its date means anything. GSI
  // has no boolean "done" to just flip back — it's reopened to "todo",
  // since which of todo/progress/blocked it was before "done" isn't tracked.
  if (isGsi) {
    if (t.status === "done") setGsiTaskStatus(id, "todo");
  } else {
    if (t.archived) restoreArchivedTaskEntry(id);
    if (t.done) toggleTask(id);
  }

  if (targetCol === "today") { editTaskMeta(id, "dueDate", todayStr); return true; }
  if (targetCol === "nodate") { editTaskMeta(id, "dueDate", ""); return true; }
  if (targetCol === "upcoming") {
    if (!curDate) {
      const v = prompt("Set a due date for this task (YYYY-MM-DD):", "");
      if (v && v.trim()) {
        const val = v.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(val) && val > todayStr) editTaskMeta(id, "dueDate", val);
        else { toast("Enter a future date (YYYY-MM-DD) after today"); return false; }
      }
      return true; // left blank on purpose — task stays undated, lands back in No Date on re-render
    }
    if (curDate <= todayStr) { // was Today/Overdue — push forward so it actually qualifies as "upcoming"
      const d = new Date(); d.setDate(d.getDate() + 1);
      editTaskMeta(id, "dueDate", d.toISOString().slice(0, 10));
    }
    return true;
  }
  if (targetCol === "overdue") {
    if (!curDate || curDate >= todayStr) { toast("Overdue needs a due date before today"); return false; }
    return true; // already qualifies, nothing to change
  }
  return true;
}

export function setTaskView(v) {
  taskView = v;
  state.taskViewPref = v;
  persist(false);
  const switcher = document.getElementById("taskViewSwitch");
  if (switcher) switcher.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  renderTasks();
}
export function calendarPrevMonth() { calendarMonth.setMonth(calendarMonth.getMonth() - 1); renderTasks(); }
export function calendarNextMonth() { calendarMonth.setMonth(calendarMonth.getMonth() + 1); renderTasks(); }
export function calendarGoToday() { calendarMonth = new Date(); calendarMonth.setDate(1); renderTasks(); }
export function calendarQuickAdd(dateStr) {
  if (calendarClickSuppressed()) return; // the click that trails a drop, not a real one
  const v = prompt(`Add a task for ${dateStr}:`);
  if (!v || !v.trim()) return;
  createNativeTask(v.trim(), dateStr);
  persist(); rerender();
}
export function toggleTaskSection(name) {
  if (collapsedSections.has(name)) collapsedSections.delete(name); else collapsedSections.add(name);
  const sectionEl = document.querySelector(`.t-section[data-section="${name}"]`);
  if (!sectionEl) { renderTasks(); return; } // fallback — shouldn't normally happen, section always exists once its group is non-empty
  const collapsed = collapsedSections.has(name);
  sectionEl.classList.toggle("collapsed", collapsed);
  sectionEl.querySelector("[aria-expanded]")?.setAttribute("aria-expanded", String(!collapsed));
}
export function toggleTaskExpanded(id) {
  expandedTaskId = expandedTaskId === id ? null : id;
  renderTasks();
}
// Opens the native date picker for a task's (hidden) date input,
// triggered by tapping the calendar icon next to its due-date text.
// editTaskMeta() already re-renders on change, and the Overdue/Today/
// Upcoming grouping is recomputed fresh on every render from each
// task's current dueDate — so picking a new date here already moves
// the task to the right section automatically, with no extra code
// needed for that part.
export function toggleTaskLinkEdit(evt, id) {
  evt.stopPropagation();
  const input = document.getElementById("task-link-edit-" + id);
  if (!input) return;
  input.style.display = "inline-block";
  input.focus();
}
export function openDueDatePicker(id) {
  const input = document.getElementById(`dueInput-${id}`);
  if (!input) return;
  if (typeof input.showPicker === "function") {
    try { input.showPicker(); return; } catch (e) { /* falls through to the older fallback below */ }
  }
  input.focus();
  input.click();
}
export function openPopupDueDatePicker(id) {
  const input = document.getElementById(`dueInput-popup-${id}`);
  if (!input) return;
  if (typeof input.showPicker === "function") {
    try { input.showPicker(); return; } catch (e) { /* falls through to the older fallback below */ }
  }
  input.focus();
  input.click();
}

// ---------- Task detail popup — opened from a calendar chip's title
// (the chip's own checkbox handles completion directly, without
// opening this). Works for native and GSI tasks alike by using the
// same lookup taskRowHtml() already uses for its breadcrumb, and
// routes every action through the exact same functions the rest of
// the app already uses (toggleTask, toggleFlag/toggleProjectTaskFlag,
// editTask/editProjectTask) — nothing task-related is reimplemented
// here, only the display around it.
export function findAnyTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) return { task: t, isGsi: false };
  const { task: gt, project } = findProjectTask(id);
  if (gt) return { task: gt, isGsi: true, project };
  return null;
}
// Shared by the "Add a task" project picker and each task's own .t-meta
// project select — "No project" is always added separately by the caller,
// this only builds the actual GSI project options.
function projectOptionsHtml(selectedId) {
  return getProjectList().map(p => `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${esc(p.name)}</option>`).join("");
}
// Moves a task between "no project" (native) and a GSI project, or
// between two GSI projects. Native<->GSI conversions remap the task's
// shape the same way createNativeTask/quickAddGsiTask build one from
// scratch (done<->status, dueDate<->date), and drop any existing
// googleEventId so it re-syncs cleanly under whichever system now owns
// it rather than carrying over an event created by the other one. The
// task keeps its id either way, so an open .t-meta panel for it stays
// open and pointed at the same row across the conversion.
export function changeTaskProject(id, projectId) {
  const found = findAnyTask(id);
  if (!found) return;
  const { task: t, isGsi } = found;

  if (!isGsi) {
    if (!projectId) return; // already native, nothing to do
    const ok = addProjectTaskRaw(projectId, {
      id: t.id, text: t.text, status: t.done ? "done" : "todo",
      date: t.dueDate || "", link: t.link || "", flag: !!t.flag, googleEventId: null
    });
    if (!ok) return; // project vanished (e.g. deleted mid-edit) — leave the native task alone
    state.tasks = state.tasks.filter(x => x.id !== id);
    persist(); rerender();
    return;
  }
  if (!projectId) {
    const plucked = pluckProjectTask(id);
    if (!plucked) return;
    state.tasks.push({
      id: plucked.id, text: plucked.text, done: plucked.status === "done",
      category: "work", flag: !!plucked.flag, link: plucked.link || "",
      dueDate: plucked.date || "", completedAt: plucked.status === "done" ? Date.now() : null,
      googleEventId: null, position: nextManualPosition()
    });
    persist(); rerender();
    return;
  }
  moveProjectTask(id, projectId); // GSI -> a different GSI project
}
/* Kept as the single entry point every card already calls, so nothing on
   the board, the calendar or the GSI pages had to change. It now opens
   the detail modal instead of the old small popup. */
export function openTaskPopup(id) {
  if (calendarClickSuppressed()) return;
  openTaskModal(id);
  return;
}
function legacyOpenTaskPopup(id) {
  // A chip is dragged by its title button, so the drop is followed by that
  // button's click — which would open the detail popup on top of the move.
  if (calendarClickSuppressed()) return;
  const bg = document.getElementById("taskPopupModalBg");
  if (!bg) return;
  bg.classList.add("open");
  renderTaskPopup(id);
}
export function closeTaskPopup() { document.getElementById("taskPopupModalBg")?.classList.remove("open"); }
function renderTaskPopup(id) {
  const box = document.getElementById("taskPopupBody");
  if (!box) return;
  const found = findAnyTask(id);
  if (!found) { box.innerHTML = `<p class="hint">This task no longer exists.</p>`; return; }
  const { task: t, isGsi, project } = found;
  const done = isGsi ? t.status === "done" : t.done;
  const due = fmtDue(isGsi ? t.date : t.dueDate);
  const tag = isGsi
    ? `${esc((project && project.name) || t.projectName || "")} / ${({ todo: "To do", progress: "In progress", done: "Done", blocked: "Blocked" })[t.status] || "To do"}`
    : `${(t.category || "work") === "work" ? "Work" : "Personal"}`;
  box.innerHTML = `
    <div class="t-popup-top">
      <button class="t-chk ${done ? "on" : ""}" onclick="popupToggleDone('${id}')" aria-label="Toggle task">
        <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <div class="t-popup-title ${done ? "done" : ""}">${esc(t.text)}</div>
      <button class="t-flag ${t.flag ? "on" : ""}" onclick="popupToggleFlag('${id}')" title="${t.flag ? "Unflag" : "Flag as priority"}">🚩</button>
    </div>
    ${due ? `<div class="t-due ${due.cls === "overdue" ? "t-overdue" : due.cls === "" ? "t-future" : ""}" style="margin:12px 0 0 38px">
      <button class="t-due-icon" onclick="openPopupDueDatePicker('${id}')" title="Change due date">📅</button>
      <input type="date" class="t-due-hidden-input" id="dueInput-popup-${id}" value="${isGsi ? (t.date || "") : (t.dueDate || "")}"
        onchange="popupEditDate('${id}',this.value)">
      <span>${due.text}</span>
    </div>` : ""}
    <div style="margin:10px 0 0 38px"><span class="t-board-card-tag">${tag}</span></div>
    ${t.link ? `<a href="${esc(t.link.startsWith("http") ? t.link : "https://" + t.link)}" target="_blank" rel="noopener" class="t-link-go" style="margin:12px 0 0 38px;display:inline-block">🔗 Open link</a>` : ""}
  `;
}
export function popupToggleDone(id) {
  toggleTask(id); // native/GSI routing already handled inside toggleTask itself
  renderTaskPopup(id);
}
export function popupToggleFlag(id) {
  toggleFlag(id); // already routes to GSI internally when needed
  renderTaskPopup(id);
}
export function popupEditDate(id, value) {
  editTaskMeta(id, "dueDate", value); // already routes to GSI internally and re-sorts sections on change
  renderTaskPopup(id);
}

function taskRowHtml(t) {
  const due = fmtDue(t.dueDate);
  const breadcrumb = t.isGsi
    ? `${esc(t.projectName)} / ${({todo:"To do",progress:"In progress",done:"Done",blocked:"Blocked"})[t.status] || "To do"}`
    : `${(t.category||"work")==="work"?"Work":"Personal"}${due ? " / " + due.text : ""}`;
  return `
    <div class="t-row ${t.done ? "done" : ""} ${expandedTaskId===t.id ? "t-expanded" : ""}" data-task-id="${t.id}" data-is-gsi="${t.isGsi ? "1" : "0"}" onclick="toggleTaskExpanded('${t.id}')">
      ${t.isGsi ? `<div class="t-drag-handle t-drag-handle-spacer" aria-hidden="true"></div>`
                : `<div class="t-drag-handle" title="Drag to reorder" onclick="event.stopPropagation()">⠿</div>`}
      <button class="t-chk ${t.done ? "on" : ""}" onclick="event.stopPropagation();toggleTask('${t.id}')" aria-label="Toggle task">
        <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <div class="t-main">
        <div class="t-title-line">
          <textarea class="t-title ${t.link ? "t-linked" : ""}" rows="1"
            onclick="event.stopPropagation()" onchange="editTask('${t.id}',this.value)" oninput="autoGrow(this)">${esc(t.text)}</textarea>
          <button class="t-flag ${t.flag ? "on" : ""}" onclick="event.stopPropagation();toggleFlag('${t.id}')"
            title="${t.flag ? "Unflag" : "Flag as priority"}">🚩</button>
        </div>
        ${due ? `<div class="t-due ${due.cls==="overdue"?"t-overdue":due.cls===""?"t-future":""}">
          <button class="t-due-icon" onclick="event.stopPropagation();openDueDatePicker('${t.id}')" title="Change due date">📅</button>
          <input type="date" class="t-due-hidden-input" id="dueInput-${t.id}" value="${t.dueDate}"
            onclick="event.stopPropagation()" onchange="event.stopPropagation();editTaskMeta('${t.id}','dueDate',this.value)">
          <span>${due.text}</span>
        </div>` : `<div class="t-due t-due-empty">
          <button class="t-add-date-btn" onclick="event.stopPropagation();openDueDatePicker('${t.id}')">📅 Add date</button>
          <input type="date" class="t-due-hidden-input" id="dueInput-${t.id}" value=""
            onclick="event.stopPropagation()" onchange="event.stopPropagation();editTaskMeta('${t.id}','dueDate',this.value)">
        </div>`}
        ${t.link ? `<a href="${esc(t.link.startsWith("http")?t.link:"https://"+t.link)}" target="_blank" rel="noopener" class="t-link-go" onclick="event.stopPropagation()">🔗 Open link</a>`
          : `<button class="t-add-link-btn" onclick="toggleTaskLinkEdit(event,'${t.id}')">+ Add link</button>`}
        <input type="text" class="t-link-input" id="task-link-edit-${t.id}" placeholder="Paste a link…" value="${esc(t.link||"")}"
          onclick="event.stopPropagation()" onchange="editTaskMeta('${t.id}','link',this.value)" onblur="this.style.display='none'" style="display:none">
      </div>
      <div class="t-right">
        <span class="t-breadcrumb">${breadcrumb}</span>
        ${t.done && t.completedAt ? `<span class="t-completed-note">✓ ${fmtCompletedAt(t.completedAt)}</span>` : ""}
        ${t.done ? (t.isGsi
          ? `<button class="t-archive-btn" onclick="event.stopPropagation();archiveGsiTaskEntry('${t.projectId}','${t.id}')" title="Archive">🗂 Archive</button>`
          : `<button class="t-archive-btn" onclick="event.stopPropagation();archiveTask('${t.id}')" title="Archive">🗂 Archive</button>`) : ""}
      </div>
    </div>
    <div class="t-meta" onclick="event.stopPropagation()">
      ${t.isGsi ? "" : `
      <select onchange="editTaskMeta('${t.id}','category',this.value)">
        <option value="work" ${(t.category||"work")==="work"?"selected":""}>Work</option>
        <option value="personal" ${t.category==="personal"?"selected":""}>Personal</option>
      </select>`}
      <select onchange="changeTaskProject('${t.id}',this.value)" title="GSI project">
        <option value="">No project</option>
        ${projectOptionsHtml(t.isGsi ? t.projectId : "")}
      </select>
      <input type="date" value="${esc(t.dueDate||"")}" onchange="editTaskMeta('${t.id}','dueDate',this.value)" title="Due date">
      <input type="text" placeholder="link" value="${esc(t.link||"")}" onchange="editTaskMeta('${t.id}','link',this.value)">
    </div>`;
}

function sectionHtml(name, label, tasks) {
  const collapsed = collapsedSections.has(name);
  return `
    <div class="t-section ${collapsed ? "collapsed" : ""}" data-section="${name}">
      <button class="t-section-head" onclick="toggleTaskSection('${name}')" aria-expanded="${!collapsed}">
        <span class="t-section-title">${label}</span>
        <span class="t-section-count">${tasks.length}</span>
        <span class="t-section-chevron">▾</span>
      </button>
      <div class="t-section-rows"><div class="t-section-rows-inner">${tasks.map(taskRowHtml).join("")}</div></div>
    </div>`;
}

// ---------- Board view — same Overdue/Today/Upcoming/Completed groups
// List view already computes, laid out as Kanban-style columns instead
// of stacked collapsible sections. Reuses taskRowHtml() directly for
// each card, so every existing interaction (checkbox, flag, archive
// button, breadcrumb, GSI vs native routing) works identically without
// any new code — only the layout differs.
// Board view needs its own compact card rather than reusing
// taskRowHtml() directly — that row's layout (a wide title field plus
// a right-aligned breadcrumb column) assumes real list-row width. Squeezed
// into a ~230px Kanban column, the title had nowhere to go but wrap
// extremely narrow, one word (sometimes near one character) per line,
// making cards enormous and barely readable. This clamps the title to
// two lines and moves metadata into a small tag row underneath instead.
function boardCardHtml(t) {
  const due = fmtDue(t.dueDate);
  const tag = t.isGsi
    ? `${esc(t.projectName)} / ${({ todo: "To do", progress: "In progress", done: "Done", blocked: "Blocked" })[t.status] || "To do"}`
    : `${(t.category || "work") === "work" ? "Work" : "Personal"}`;
  return `
    <div class="t-board-card ${t.done ? "done" : ""}" data-task-id="${t.id}" data-is-gsi="${t.isGsi ? "1" : "0"}" onclick="toggleTaskExpanded('${t.id}')">
      <div class="t-board-card-top">
        <span class="t-board-card-handle" title="Drag to move" onclick="event.stopPropagation()">⠿</span>
        <button class="t-chk ${t.done ? "on" : ""}" onclick="event.stopPropagation();toggleTask('${t.id}')" aria-label="Toggle task">
          <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
        <span class="t-board-card-title">${esc(t.text)}</span>
        ${t.flag ? `<span class="t-board-card-flag" title="Priority">🚩</span>` : ""}
      </div>
      <div class="t-board-card-meta">
        ${due ? `<span class="t-board-card-date ${due.cls}">
          <button class="t-due-icon" onclick="event.stopPropagation();openDueDatePicker('${t.id}')" title="Change due date">🗓</button>
          <input type="date" class="t-due-hidden-input" id="dueInput-${t.id}" value="${t.isGsi ? (t.date || "") : (t.dueDate || "")}"
            onclick="event.stopPropagation()" onchange="event.stopPropagation();editTaskMeta('${t.id}','dueDate',this.value)">
          ${due.text}</span>` : `<span class="t-board-card-date">
          <button class="t-add-date-btn" onclick="event.stopPropagation();openDueDatePicker('${t.id}')">🗓 Add date</button>
          <input type="date" class="t-due-hidden-input" id="dueInput-${t.id}" value=""
            onclick="event.stopPropagation()" onchange="event.stopPropagation();editTaskMeta('${t.id}','dueDate',this.value)">
          </span>`}
        ${t.link
          ? `<a href="${esc(t.link.startsWith("http")?t.link:"https://"+t.link)}" target="_blank" rel="noopener" class="t-board-card-tag" style="text-decoration:none" onclick="event.stopPropagation()">🔗 Link</a>`
          : `<button class="t-add-link-btn" onclick="event.stopPropagation();toggleTaskLinkEdit(event,'${t.id}')">+ Link</button>`}
        <input type="text" class="t-link-input" id="task-link-edit-${t.id}" placeholder="Paste a link…" value="${esc(t.link||"")}"
          onclick="event.stopPropagation()" onchange="editTaskMeta('${t.id}','link',this.value)" onblur="this.style.display='none'" style="display:none">
        <span class="t-board-card-tag">${tag}</span>
        <select class="t-board-project-sel" title="Move to project" onclick="event.stopPropagation()" onchange="event.stopPropagation();changeTaskProject('${t.id}',this.value)">
          <option value="">No project</option>
          ${projectOptionsHtml(t.isGsi ? t.projectId : "")}
        </select>
        ${t.done ? (t.isGsi
          ? `<button class="t-archive-btn" onclick="event.stopPropagation();archiveGsiTaskEntry('${t.projectId}','${t.id}')" title="Archive">🗂</button>`
          : `<button class="t-archive-btn" onclick="event.stopPropagation();archiveTask('${t.id}')" title="Archive">🗂</button>`) : ""}
      </div>
    </div>`;
}
function boardQuickAddHtml(key) {
  if (key === "today") {
    return `
      <div class="t-board-quickadd">
        <input type="text" id="boardQuickAdd-today" placeholder="Add a task…" onkeydown="if(event.key==='Enter')quickAddBoardTask('today')">
        <button class="btn btn-ghost" onclick="quickAddBoardTask('today')">+ Add</button>
      </div>`;
  }
  if (key === "upcoming") {
    return `
      <div class="t-board-quickadd">
        <input type="text" id="boardQuickAdd-upcoming" placeholder="Add a task…" onkeydown="if(event.key==='Enter')quickAddBoardTask('upcoming')">
        <input type="date" id="boardQuickAddDate-upcoming" class="t-board-quickadd-date" title="Optional due date">
        <button class="btn btn-ghost" onclick="quickAddBoardTask('upcoming')">+ Add</button>
      </div>`;
  }
  return "";
}
function boardColumnHtml(key, label, tasks, accentClass) {
  return `
    <div class="t-board-col" data-board-col="${key}">
      <div class="t-board-col-head ${accentClass}">
        <span class="t-board-col-title">${label}</span>
        <span class="t-section-count">${tasks.length}</span>
      </div>
      <div class="t-board-col-body">
        ${tasks.length ? tasks.map(boardCardHtml).join("") : `<p class="hint" style="padding:10px 4px">Nothing here.</p>`}
      </div>
      ${boardQuickAddHtml(key)}
    </div>`;
}
export function quickAddBoardTask(key) {
  const textEl = document.getElementById(`boardQuickAdd-${key}`);
  if (!textEl) return;
  const v = textEl.value.trim();
  if (!v) return;
  const dueDate = key === "today" ? new Date().toISOString().slice(0, 10)
    : (document.getElementById("boardQuickAddDate-upcoming")?.value || "");
  createNativeTask(v, dueDate);
  textEl.value = "";
  const dateEl = document.getElementById("boardQuickAddDate-upcoming");
  if (dateEl) dateEl.value = "";
  persist(); rerender();
}
function renderBoardView(overdueGroup, todayGroup, upcomingGroup, noDateGroup, done) {
  return `<div class="t-board">
    ${boardColumnHtml("overdue", "Overdue", overdueGroup, "t-board-overdue")}
    ${boardColumnHtml("today", "Today", todayGroup, "t-board-today")}
    ${boardColumnHtml("upcoming", "Upcoming", upcomingGroup, "")}
    ${boardColumnHtml("nodate", "No Date", noDateGroup, "")}
    ${boardColumnHtml("completed", "Completed", done, "")}
  </div>`;
}

// ---------- Calendar view: drag a task onto another day to reschedule it ----------
// Every day cell is a Sortable container in one shared group, which is what
// lets a chip cross from one day to another. The drop does nothing itself
// beyond working out the target date and handing it to editTaskMeta — the
// single function the date picker, the popup and the board already use — so
// persistence, re-render and Google Calendar sync stay in one place and
// GSI-sourced tasks reschedule in their real project rather than in a copy.
let calSortableInstances = [];
let calDragEndedAt = 0; // see calendarClickSuppressed()
function destroyCalSortables() {
  calSortableInstances.forEach(s => { try { s.destroy(); } catch (e) { /* already gone with its container */ } });
  calSortableInstances = [];
}
function initCalendarSorting() {
  destroyCalSortables();
  if (taskView !== "calendar" || typeof Sortable === "undefined") return;
  // Unlike List and Board, this isn't manual ordering — it edits the due
  // date — so it stays available even when "Sort by date" is on.
  document.querySelectorAll("#taskList .t-cal-tasks").forEach(container => {
    calSortableInstances.push(Sortable.create(container, {
      group: "task-calendar",
      draggable: ".t-cal-chip", // the "+N more" line isn't a task and mustn't be picked up
      animation: 180,
      delay: 300, delayOnTouchOnly: true, touchStartThreshold: 5, // a plain touch-drag should still scroll the month
      ghostClass: "t-cal-chip-ghost", chosenClass: "t-cal-chip-chosen", dragClass: "t-cal-chip-dragging",
      scroll: true, scrollSensitivity: 90, scrollSpeed: 12,
      onEnd: handleCalendarDragEnd,
    }));
  });
}
function handleCalendarDragEnd(evt) {
  calDragEndedAt = Date.now();
  const id = evt.item.dataset.taskId;
  const from = evt.from.dataset.calDate, to = evt.to.dataset.calDate;
  // Re-render either way: rebuilding from real data is what makes an
  // unchanged or rejected drop snap back, rather than trying to undo
  // whatever SortableJS already did to the DOM.
  if (!id || !to || to === from) { renderTasks(); return; }
  editTaskMeta(id, "dueDate", to); // persists, re-renders and syncs on its own
  toast(`Moved to ${new Date(to + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}`);
}
// A drag that ends over a day cell is followed by that cell's own click,
// which would otherwise pop the "add a task" prompt every time something
// is dropped. Anything within a moment of a drop is that stray click.
function calendarClickSuppressed() {
  return Date.now() - calDragEndedAt < 400;
}

// ---------- Calendar view — a plain month grid. Only tasks with a due
// date can appear here at all (nothing to place on a calendar without
// one) — that's inherent to the view, not a filter to route around.
function renderCalendarView(tasksWithDates) {
  const byDate = {};
  tasksWithDates.forEach(t => { if (t.dueDate) (byDate[t.dueDate] = byDate[t.dueDate] || []).push(t); });

  const year = calendarMonth.getFullYear(), month = calendarMonth.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthLabel = calendarMonth.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const todayStr = new Date().toISOString().slice(0, 10);

  function dayCellHtml(d) {
    if (d === null) return `<div class="t-cal-cell t-cal-empty"></div>`;
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dayTasks = byDate[dateStr] || [];
    const shown = dayTasks.slice(0, 3);
    return `
      <div class="t-cal-cell ${dateStr === todayStr ? "t-cal-today" : ""}" data-cal-date="${dateStr}" onclick="calendarQuickAdd('${dateStr}')" title="Click to add a task on ${dateStr}">
        <div class="t-cal-daynum-row"><span class="t-cal-daynum">${d}</span><span class="t-cal-add-hint">+</span></div>
        <div class="t-cal-tasks" data-cal-date="${dateStr}">
          ${shown.map(t => `
            <div class="t-cal-chip ${t.done ? "done" : ""} ${t.dueDate < todayStr && !t.done ? "overdue" : ""}" data-task-id="${t.id}" title="Drag to another day to reschedule">
              <button class="t-cal-chip-chk" onclick="event.stopPropagation();toggleTask('${t.id}')" aria-label="Toggle complete"></button>
              <button class="t-cal-chip-title" onclick="event.stopPropagation();openTaskPopup('${t.id}')" title="${esc(t.text)}">${esc(t.text)}</button>
            </div>`).join("")}
          ${dayTasks.length > 3 ? `<div class="t-cal-more">+${dayTasks.length - 3} more</div>` : ""}
        </div>
      </div>`;
  }

  // Build one flat array — firstWeekday leading nulls (blank padding
  // cells), then every real day 1..daysInMonth — then chunk it into
  // week-rows of exactly 7. Each week is rendered as its own flex row
  // with exactly 7 children, so there's no reliance on a single large
  // CSS grid correctly auto-wrapping ~34 items at a 7-column boundary.
  const slots = [];
  for (let i = 0; i < firstWeekday; i++) slots.push(null);
  for (let d = 1; d <= daysInMonth; d++) slots.push(d);
  while (slots.length % 7 !== 0) slots.push(null); // pad the final week out to a full 7

  let weeksHtml = "";
  for (let w = 0; w < slots.length; w += 7) {
    weeksHtml += `<div class="t-cal-week">${slots.slice(w, w + 7).map(dayCellHtml).join("")}</div>`;
  }

  return `
    <div class="t-cal">
      <div class="t-cal-head">
        <button class="btn btn-ghost" onclick="calendarPrevMonth()" aria-label="Previous month">‹</button>
        <div class="t-cal-month">${monthLabel}</div>
        <button class="btn btn-ghost" onclick="calendarNextMonth()" aria-label="Next month">›</button>
        <button class="btn btn-ghost" onclick="calendarGoToday()">Today</button>
      </div>
      <div class="t-cal-weekdays"><div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div></div>
      <div class="t-cal-grid">${weeksHtml}</div>
    </div>`;
}


function sortArchived(list) {
  const arr = list.slice();
  if (archivedSort === "newest") arr.sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  else if (archivedSort === "oldest") arr.sort((a, b) => (a.archivedAt || 0) - (b.archivedAt || 0));
  else if (archivedSort === "completed") arr.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  else if (archivedSort === "alpha") arr.sort((a, b) => a.text.localeCompare(b.text));
  return arr;
}
export function setArchivedSort(v) { archivedSort = v; renderArchivedTasksModal(); }

function archivedTaskRowHtml(t) {
  const cat = (t.category || "work") === "work" ? "Work" : "Personal";
  return `
    <div class="t-row t-archived-row">
      <span class="t-archived-check" aria-hidden="true">✓</span>
      <div class="t-main">
        <div class="t-title-line"><span class="t-archived-title">${esc(t.text)}</span></div>
        <div class="t-archived-meta">
          <span>Completed ${t.completedAt ? fmtCompletedAt(t.completedAt) : "—"}</span>
          <span>Archived ${t.archivedAt ? fmtCompletedAt(t.archivedAt) : "—"}</span>
          <span>${cat}</span>
          ${t.flag ? `<span class="t-archived-flag">🚩 Priority</span>` : ""}
          ${t.link ? `<a href="${esc(t.link.startsWith("http") ? t.link : "https://" + t.link)}" target="_blank" rel="noopener">🔗 Link</a>` : ""}
        </div>
      </div>
      <div class="t-archived-actions">
        <button class="btn btn-ghost" onclick="restoreArchivedTaskEntry('${t.id}')">↺ Restore</button>
        <button class="btn btn-ghost t-archived-delete" onclick="deleteArchivedTaskPermanently('${t.id}')" title="Move to Recycle Bin">🗑 Delete</button>
      </div>
    </div>`;
}
// A plain, always-tappable trigger — same pattern as GSI Workspace's own
// "Archive" / "Archive completed" buttons, deliberately not another
// inline collapsible section. Opens a modal instead, same mechanism as
// GSI's own archive view and the Brainstorming Board's archive manager.
function archivedTriggerHtml(count) {
  return `
    <div class="t-archived-trigger-row">
      <button class="t-archived-trigger" onclick="openArchivedTasksModal()">🗂 Archived <span class="t-section-count">${count}</span></button>
    </div>`;
}
function currentArchivedTasks() {
  return state.tasks.filter(t => t.archived && (taskFilter === "all" || (t.category || "work") === taskFilter));
}
export function openArchivedTasksModal() {
  const modal = document.getElementById("taskArchiveModalBg");
  if (!modal) return;
  modal.classList.add("open");
  renderArchivedTasksModal();
}
export function closeArchivedTasksModal() {
  document.getElementById("taskArchiveModalBg")?.classList.remove("open");
}
function renderArchivedTasksModal() {
  const box = document.getElementById("taskArchiveModalList");
  if (!box) return; // modal not open/mounted — nothing to refresh
  const archived = sortArchived(currentArchivedTasks());
  box.innerHTML = archived.length ? archived.map(archivedTaskRowHtml).join("") :
    `<p class="hint" style="padding:18px">No archived tasks${taskFilter !== "all" ? " in this filter" : ""}.</p>`;
  const countEl = document.getElementById("taskArchiveModalCount");
  if (countEl) countEl.textContent = archived.length;
  const sortSel = document.getElementById("taskArchiveModalSort");
  if (sortSel) sortSel.value = archivedSort;
}

export function renderTasks() {
  if (taskView === null) {
    taskView = state.taskViewPref || "board";
    const switcher = document.getElementById("taskViewSwitch");
    if (switcher) switcher.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === taskView));
  }
  const list = document.getElementById("taskList");
  let visible = state.tasks.filter(t => taskFilter === "all" || (t.category || "work") === taskFilter);

  // GSI project tasks are inherently work — merge them in for "Work"/"All"
  // views, never "Personal". Normalized to the same shape as native tasks
  // so sorting and rendering below don't need to special-case them.
  if (taskFilter === "all" || taskFilter === "work") {
    const gsiAsTasks = getAllGsiTasksFlat().map(t => ({
      id: t.id, text: t.text, done: t.status === "done", category: "work",
      flag: !!t.flag, link: t.link || "", dueDate: t.date || "", completedAt: null,
      isGsi: true, projectId: t.projectId, projectName: t.projectName, status: t.status
    }));
    visible = visible.concat(gsiAsTasks);
  }

  const byFlagThenDate = (a, b) => {
    if (!!a.flag !== !!b.flag) return a.flag ? -1 : 1;
    if (!sortByDate) return 0;
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  };
  const byDate = (a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  };
  // Manual drag order — see the position migration in state.js's
  // merge(). GSI tasks have no position field, so they fall back to 0
  // and cluster together rather than interleaving meaningfully with
  // natively-ordered tasks. List view's row drag (taskRowHtml's
  // placeholder handle) stays native-only for this reason — but Board
  // view doesn't reorder by position at all, it moves cards between
  // columns by status/date, which GSI tasks do have (see moveTaskToColumn).
  const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0);

  const todayKeyStr = new Date().toISOString().slice(0, 10);
  const open = visible.filter(t => !t.done);
  const done = visible.filter(t => t.done && !t.archived).sort(sortByDate ? byDate : byPosition);
  const todayGroup = open.filter(t => t.dueDate === todayKeyStr).sort(sortByDate ? byFlagThenDate : byPosition);
  const overdueGroup = open.filter(t => t.dueDate && t.dueDate < todayKeyStr).sort(sortByDate ? byFlagThenDate : byPosition);
  const upcomingGroup = open.filter(t => t.dueDate !== todayKeyStr && !(t.dueDate && t.dueDate < todayKeyStr)).sort(sortByDate ? byFlagThenDate : byPosition);
  // Board view only — splits what List view lumps together as one
  // "Upcoming" group into two separate columns. List view's own
  // upcomingGroup above is untouched; filtering an already-sorted
  // array preserves that order, so no re-sort needed here.
  const boardUpcomingGroup = upcomingGroup.filter(t => t.dueDate);
  const noDateGroup = upcomingGroup.filter(t => !t.dueDate);
  // Archived is native tasks only — GSI project tasks are a different
  // schema entirely (a 4-state status, not done/archived) and already
  // have their own separate archive system in GSI Workspace.
  const archivedTasks = state.tasks.filter(t => t.archived && (taskFilter === "all" || (t.category || "work") === taskFilter));

  const sortBtn = document.getElementById("taskSortBtn");
  if (sortBtn) sortBtn.classList.toggle("on", sortByDate);
  const archiveAllBtn = document.getElementById("taskArchiveAllBtn");
  if (archiveAllBtn) archiveAllBtn.disabled = !state.tasks.some(t => t.done && !t.archived);

  if (!visible.length && taskView === "list") {
    list.innerHTML = state.tasks.length ? `<p class="hint" style="padding:18px">No tasks match this filter.</p>` : `
      <div class="t-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 11l3 3L22 4M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2h-5l-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
        <div class="t-empty-title">No tasks yet</div>
        <div class="t-empty-sub">Add your first task below to get started.</div>
      </div>`;
  } else if (taskView === "board") {
    list.innerHTML = renderBoardView(overdueGroup, todayGroup, boardUpcomingGroup, noDateGroup, done);
  } else if (taskView === "calendar") {
    list.innerHTML = renderCalendarView(visible.filter(t => t.dueDate));
  } else {
    list.innerHTML =
      (overdueGroup.length ? sectionHtml("overdue", "Overdue", overdueGroup) : "") +
      sectionHtml("today", "Today", todayGroup) +
      sectionHtml("upcoming", "Upcoming", upcomingGroup) +
      (done.length ? sectionHtml("completed", "Completed", done) : "");
  }
  // Archived can be non-empty even when everything else is (e.g. filtered
  // to a category with nothing open/completed left), so its trigger is
  // shown independent of the visible.length branch above — same
  // "always there, just not always useful yet" convention as GSI
  // Workspace's own Archive button.
  if (state.tasks.length) list.innerHTML += archivedTriggerHtml(archivedTasks.length);
  if (document.getElementById("taskArchiveModalBg")?.classList.contains("open")) renderArchivedTasksModal();

  const openCount = state.tasks.filter(t => !t.done).length;
  document.getElementById("taskCount").textContent = state.tasks.length ? `${openCount} open` : "";
  const catTasksSub = document.getElementById("catTasksSub");
  if (catTasksSub) catTasksSub.textContent =
    state.tasks.length ? `${openCount} of ${state.tasks.length} still open` : "Plan your day.";
  // Same "measure after render" requirement as GSI Workspace's title
  // fields — see go() in ui.js for the re-run when this page was
  // hidden at the moment this render happened.
  list.querySelectorAll(".t-title").forEach(autoGrow);

  const filterBox = document.getElementById("taskFilterBar");
  if (filterBox) {
    filterBox.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.filter === taskFilter));
  }
  const dragHint = document.getElementById("taskDragHint");
  if (dragHint) dragHint.style.display = (sortByDate && (taskView === "list" || taskView === "board")) ? "" : "none";
  const projSel = document.getElementById("newTaskProject");
  if (projSel) {
    const current = projSel.value;
    projSel.innerHTML = `<option value="">No project</option>${projectOptionsHtml(current)}`;
  }
  initTaskSorting();
  initBoardSorting();
  initCalendarSorting();
}

export function setTaskFilter(f) { taskFilter = f; renderTasks(); }

// Shared by every entry point that creates a native task — the main
// Add Task input, Board view's per-column quick-add, and Calendar
// view's click-a-day quick-add — so all three build the same shape
// instead of three slightly-diverging copies.
function nextManualPosition() {
  return state.tasks.reduce((m, t) => Math.min(m, t.position ?? 0), 0) - 1000;
}
function createNativeTask(text, dueDate) {
  const defaultCategory = (taskFilter === "work" || taskFilter === "personal") ? taskFilter : "work";
  const task = { id: uid(), text, done: false, category: defaultCategory, flag: false, link: "", dueDate: dueDate || "", googleEventId: null, position: nextManualPosition() };
  state.tasks.push(task);
  return task;
}
export function addTask() {
  const el = document.getElementById("newTask"); const v = el.value.trim(); if (!v) return;
  const projSel = document.getElementById("newTaskProject");
  const projectId = projSel ? projSel.value : "";
  if (projectId) {
    addProjectTaskRaw(projectId, { id: uid(), text: v, status: "todo", date: "", link: "", flag: false, googleEventId: null });
  } else {
    createNativeTask(v, "");
    persist(); rerender();
  }
  el.value = "";
}
export function toggleTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) {
    t.done = !t.done;
    t.completedAt = t.done ? Date.now() : null;
    persist(); rerender();
    syncTaskToGoogle(t, t.done ? "delete" : "create").catch(() => {}); // a completed task has nothing left to remind about; reopening it (with a due date) puts it back
    return;
  }
  const { task: gt } = findProjectTask(id);
  if (gt) setGsiTaskStatus(id, gt.status === "done" ? "todo" : "done");
}
export function toggleFlag(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) { t.flag = !t.flag; persist(); rerender(); return; }
  toggleProjectTaskFlag(id);
}
export function editTask(id, v) {
  const t = state.tasks.find(x => x.id === id);
  if (t) {
    t.text = v; persist();
    if (!t.done) syncTaskToGoogle(t, t.googleEventId ? "update" : "create").catch(() => {});
    return;
  }
  const { task: gt } = findProjectTask(id);
  if (gt) editProjectTask(id, "text", v);
}
export function editTaskMeta(id, field, v) {
  const t = state.tasks.find(x => x.id === id);
  if (t) {
    t[field] = v; persist(); rerender();
    if (field === "dueDate" && !t.done) {
      if (!v && t.googleEventId) syncTaskToGoogle(t, "delete").catch(() => {});
      else if (v) syncTaskToGoogle(t, t.googleEventId ? "update" : "create").catch(() => {});
    }
    return;
  }
  // GSI tasks don't have a "category" (they're inherently Work) — that
  // control is hidden for them in the template, so this shouldn't fire,
  // but guard anyway. "dueDate" maps to their own "date" field.
  if (field === "category") return;
  const gsiField = field === "dueDate" ? "date" : field;
  editProjectTask(id, gsiField, v);
}
export function delTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) {
    moveToTrash("task", t); state.tasks = state.tasks.filter(x => x.id !== id); persist(); rerender();
    syncTaskToGoogle(t, "delete").catch(() => {});
    return;
  }
  const { task: gt } = findProjectTask(id);
  if (gt) delProjectTask(id);
}

// ---------- Archive Completed ----------
// Native tasks only (state.tasks) — GSI-merged tasks live in a
// different schema (a 4-state status, not done/archived) and already
// have their own separate archive system in GSI Workspace, so they're
// never eligible here to begin with (they're not in state.tasks at all).
export function archiveTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t || !t.done || t.archived) return;
  t.archived = true; t.archivedAt = Date.now();
  persist(); rerender();
  toast("Task archived");
}
export function archiveAllCompleted() {
  const completed = state.tasks.filter(t => t.done && !t.archived);
  if (!completed.length) return;
  if (!confirm("Archive all completed tasks?")) return;
  const now = Date.now();
  completed.forEach(t => { t.archived = true; t.archivedAt = now; });
  persist(); rerender();
  toast(`Archived ${completed.length} task${completed.length === 1 ? "" : "s"}`);
}
export function restoreArchivedTaskEntry(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  t.archived = false; t.archivedAt = null;
  persist(); rerender();
  toast("Task restored");
}
export function deleteArchivedTaskPermanently(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  if (!confirm(`Delete "${t.text}"? It moves to the Recycle Bin, where you can restore it or delete it for good.`)) return;
  moveToTrash("task", t);
  state.tasks = state.tasks.filter(x => x.id !== id);
  persist(); rerender();
  toast("Moved to Recycle Bin");
}

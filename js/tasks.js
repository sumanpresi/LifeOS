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
  delProjectTask, toggleProjectTaskFlag } from './gsi.js';

let taskFilter = "all"; // "all" | "work" | "personal"
let sortByDate = false;
let taskView = "list"; // "list" | "board" | "calendar" — UI-only, not persisted
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
export function setTaskView(v) {
  taskView = v;
  const switcher = document.getElementById("taskViewSwitch");
  if (switcher) switcher.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  renderTasks();
}
export function calendarPrevMonth() { calendarMonth.setMonth(calendarMonth.getMonth() - 1); renderTasks(); }
export function calendarNextMonth() { calendarMonth.setMonth(calendarMonth.getMonth() + 1); renderTasks(); }
export function calendarGoToday() { calendarMonth = new Date(); calendarMonth.setDate(1); renderTasks(); }
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

function taskRowHtml(t) {
  const due = fmtDue(t.dueDate);
  const breadcrumb = t.isGsi
    ? `${esc(t.projectName)} / ${({todo:"To do",progress:"In progress",done:"Done",blocked:"Blocked"})[t.status] || "To do"}`
    : `${(t.category||"work")==="work"?"Work":"Personal"}${due ? " / " + due.text : ""}`;
  return `
    <div class="t-row ${t.done ? "done" : ""} ${expandedTaskId===t.id ? "t-expanded" : ""}" onclick="toggleTaskExpanded('${t.id}')">
      <button class="t-chk ${t.done ? "on" : ""}" onclick="event.stopPropagation();toggleTask('${t.id}')" aria-label="Toggle task">
        <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <div class="t-main">
        <div class="t-title-line">
          <textarea class="t-title ${t.link ? "t-linked" : ""}" rows="1"
            onclick="event.stopPropagation()" onchange="editTask('${t.id}',this.value)" oninput="autoGrow(this)">${esc(t.text)}</textarea>
          <button class="t-flag ${t.flag ? "on" : ""}" onclick="event.stopPropagation();toggleFlag('${t.id}')"
            title="${t.flag ? "Unflag" : "Flag as priority"}">🚩</button>
        </div>
        ${due ? `<div class="t-due ${due.cls==="overdue"?"t-overdue":due.cls===""?"t-future":""}">📅 <span>${due.text}</span></div>` : ""}
        ${t.link ? `<a href="${esc(t.link.startsWith("http")?t.link:"https://"+t.link)}" target="_blank" rel="noopener" class="t-link-go" onclick="event.stopPropagation()">🔗 Open link</a>` : ""}
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
    <div class="t-board-card ${t.done ? "done" : ""}" onclick="toggleTaskExpanded('${t.id}')">
      <div class="t-board-card-top">
        <button class="t-chk ${t.done ? "on" : ""}" onclick="event.stopPropagation();toggleTask('${t.id}')" aria-label="Toggle task">
          <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
        <span class="t-board-card-title">${esc(t.text)}</span>
        ${t.flag ? `<span class="t-board-card-flag" title="Priority">🚩</span>` : ""}
      </div>
      <div class="t-board-card-meta">
        ${due ? `<span class="t-board-card-date ${due.cls}">🗓 ${due.text}</span>` : ""}
        <span class="t-board-card-tag">${tag}</span>
        ${t.done ? (t.isGsi
          ? `<button class="t-archive-btn" onclick="event.stopPropagation();archiveGsiTaskEntry('${t.projectId}','${t.id}')" title="Archive">🗂</button>`
          : `<button class="t-archive-btn" onclick="event.stopPropagation();archiveTask('${t.id}')" title="Archive">🗂</button>`) : ""}
      </div>
    </div>`;
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
    </div>`;
}
function renderBoardView(overdueGroup, todayGroup, upcomingGroup, done) {
  return `<div class="t-board">
    ${boardColumnHtml("overdue", "Overdue", overdueGroup, "t-board-overdue")}
    ${boardColumnHtml("today", "Today", todayGroup, "t-board-today")}
    ${boardColumnHtml("upcoming", "Upcoming", upcomingGroup, "")}
    ${boardColumnHtml("completed", "Completed", done, "")}
  </div>`;
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
      <div class="t-cal-cell ${dateStr === todayStr ? "t-cal-today" : ""}">
        <div class="t-cal-daynum">${d}</div>
        <div class="t-cal-tasks">
          ${shown.map(t => `<button class="t-cal-chip ${t.done ? "done" : ""} ${t.dueDate < todayStr && !t.done ? "overdue" : ""}"
              onclick="event.stopPropagation();toggleTask('${t.id}')" title="${esc(t.text)}">${esc(t.text)}</button>`).join("")}
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

  const todayKeyStr = new Date().toISOString().slice(0, 10);
  const open = visible.filter(t => !t.done);
  const done = visible.filter(t => t.done && !t.archived).sort(sortByDate ? byDate : () => 0);
  const todayGroup = open.filter(t => t.dueDate === todayKeyStr).sort(byFlagThenDate);
  const overdueGroup = open.filter(t => t.dueDate && t.dueDate < todayKeyStr).sort(byFlagThenDate);
  const upcomingGroup = open.filter(t => t.dueDate !== todayKeyStr && !(t.dueDate && t.dueDate < todayKeyStr)).sort(byFlagThenDate);
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
    list.innerHTML = renderBoardView(overdueGroup, todayGroup, upcomingGroup, done);
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
}

export function setTaskFilter(f) { taskFilter = f; renderTasks(); }

export function addTask() {
  const el = document.getElementById("newTask"); const v = el.value.trim(); if (!v) return;
  const defaultCategory = (taskFilter === "work" || taskFilter === "personal") ? taskFilter : "work";
  state.tasks.push({ id: uid(), text: v, done: false, category: defaultCategory, flag: false, link: "", dueDate: "", googleEventId: null });
  el.value = "";
  persist(); rerender();
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

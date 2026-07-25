/* Tasks — flagged tasks are what make a task "important" and
   sort to the top; also has due date, link, and Work/Personal category.
   The "Work"/"All" view also merges in every Work·GSI project's tasks
   (tagged with their project name), so Overview gives one unified picture
   of everything work-related rather than two separate task lists living
   in two different places. GSI tasks keep their own storage and schema
   (a 4-state status, not a simple done/not-done) — this only merges them
   for DISPLAY, routing edits back to the correct underlying data. */
import { state, uid, esc, persist, rerender } from './state.js';
import { toast } from './ui.js';
import { moveToTrash } from './trash.js';
import { getAllGsiTasksFlat, findProjectTask, editProjectTask, setTaskStatus as setGsiTaskStatus,
  delProjectTask, toggleProjectTaskFlag } from './gsi.js';

let taskFilter = "all"; // "all" | "work" | "personal"
let sortByDate = false;
let collapsedSections = new Set(); // UI-only display state, not persisted — which of Today/Upcoming/Completed are collapsed
let expandedTaskId = null; // UI-only — which single row currently has its edit controls open

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
export function toggleTaskSection(name) {
  if (collapsedSections.has(name)) collapsedSections.delete(name); else collapsedSections.add(name);
  renderTasks();
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
          <input type="text" class="t-title ${t.link ? "t-linked" : ""}" value="${esc(t.text)}"
            onclick="event.stopPropagation()" onchange="editTask('${t.id}',this.value)">
          <button class="t-flag ${t.flag ? "on" : ""}" onclick="event.stopPropagation();toggleFlag('${t.id}')"
            title="${t.flag ? "Unflag" : "Flag as priority"}">🚩</button>
        </div>
        ${due ? `<div class="t-due ${due.cls==="overdue"?"t-overdue":due.cls===""?"t-future":""}">📅 <span>${due.text}</span></div>` : ""}
        ${t.link ? `<a href="${esc(t.link.startsWith("http")?t.link:"https://"+t.link)}" target="_blank" rel="noopener" class="t-link-go" onclick="event.stopPropagation()">🔗 Open link</a>` : ""}
      </div>
      <div class="t-right">
        <span class="t-breadcrumb">${breadcrumb}</span>
        ${t.done && t.completedAt ? `<span class="t-completed-note">✓ ${fmtCompletedAt(t.completedAt)}</span>` : ""}
      </div>
      <button class="t-del" onclick="event.stopPropagation();delTask('${t.id}')" aria-label="Delete">✕</button>
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
    <div class="t-section ${collapsed ? "collapsed" : ""}">
      <button class="t-section-head" onclick="toggleTaskSection('${name}')" aria-expanded="${!collapsed}">
        <span class="t-section-title">${label}</span>
        <span class="t-section-count">${tasks.length}</span>
        <span class="t-section-chevron">▾</span>
      </button>
      <div class="t-section-rows">${tasks.map(taskRowHtml).join("")}</div>
    </div>`;
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
      isGsi: true, projectName: t.projectName, status: t.status
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
  const done = visible.filter(t => t.done).sort(sortByDate ? byDate : () => 0);
  const todayGroup = open.filter(t => t.dueDate === todayKeyStr).sort(byFlagThenDate);
  const upcomingGroup = open.filter(t => t.dueDate !== todayKeyStr).sort(byFlagThenDate);

  const sortBtn = document.getElementById("taskSortBtn");
  if (sortBtn) sortBtn.classList.toggle("on", sortByDate);

  if (!visible.length) {
    list.innerHTML = state.tasks.length ? `<p class="hint" style="padding:18px">No tasks match this filter.</p>` : `
      <div class="t-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 11l3 3L22 4M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2h-5l-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
        <div class="t-empty-title">No tasks yet</div>
        <div class="t-empty-sub">Add your first task below to get started.</div>
      </div>`;
  } else {
    list.innerHTML =
      sectionHtml("today", "Today", todayGroup) +
      sectionHtml("upcoming", "Upcoming", upcomingGroup) +
      (done.length ? sectionHtml("completed", "Completed", done) : "");
  }

  const openCount = state.tasks.filter(t => !t.done).length;
  document.getElementById("taskCount").textContent = state.tasks.length ? `${openCount} open` : "";
  document.getElementById("catTasksSub").textContent =
    state.tasks.length ? `${openCount} of ${state.tasks.length} still open` : "Plan your day.";

  const filterBox = document.getElementById("taskFilterBar");
  if (filterBox) {
    filterBox.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.filter === taskFilter));
  }
}

export function setTaskFilter(f) { taskFilter = f; renderTasks(); }

export function addTask() {
  const el = document.getElementById("newTask"); const v = el.value.trim(); if (!v) return;
  const defaultCategory = (taskFilter === "work" || taskFilter === "personal") ? taskFilter : "work";
  state.tasks.push({ id: uid(), text: v, done: false, category: defaultCategory, flag: false, link: "", dueDate: "" });
  el.value = "";
  persist(); rerender();
}
export function toggleTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) {
    t.done = !t.done;
    t.completedAt = t.done ? Date.now() : null;
    persist(); rerender();
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
  if (t) { t.text = v; persist(); return; }
  const { task: gt } = findProjectTask(id);
  if (gt) editProjectTask(id, "text", v);
}
export function editTaskMeta(id, field, v) {
  const t = state.tasks.find(x => x.id === id);
  if (t) { t[field] = v; persist(); rerender(); return; }
  // GSI tasks don't have a "category" (they're inherently Work) — that
  // control is hidden for them in the template, so this shouldn't fire,
  // but guard anyway. "dueDate" maps to their own "date" field.
  if (field === "category") return;
  const gsiField = field === "dueDate" ? "date" : field;
  editProjectTask(id, gsiField, v);
}
export function delTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) { moveToTrash("task", t); state.tasks = state.tasks.filter(x => x.id !== id); persist(); rerender(); return; }
  const { task: gt } = findProjectTask(id);
  if (gt) delProjectTask(id);
}

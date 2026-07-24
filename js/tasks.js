/* Top 5 tasks — now with priority flag, due date, link, and Work/Personal category. */
import { state, uid, esc, persist, rerender } from './state.js';
import { toast } from './ui.js';
import { moveToTrash } from './trash.js';

let taskFilter = "all"; // "all" | "work" | "personal"
let sortByDate = false;

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

export function renderTasks() {
  const list = document.getElementById("taskList");
  let visible = state.tasks.filter(t => taskFilter === "all" || (t.category || "work") === taskFilter);

  /* Completed tasks always sink to the bottom, regardless of sort mode.
     Within each group (open / done), sort by due date if that's on —
     tasks with no due date fall after ones that have a date. */
  const open = visible.filter(t => !t.done);
  const done = visible.filter(t => t.done);
  if (sortByDate) {
    const byDate = (a, b) => {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    };
    open.sort(byDate);
    done.sort(byDate);
  }
  visible = [...open, ...done];

  const sortBtn = document.getElementById("taskSortBtn");
  if (sortBtn) sortBtn.classList.toggle("on", sortByDate);

  list.innerHTML = visible.map((t) => {
    const i = state.tasks.indexOf(t);
    const due = fmtDue(t.dueDate);
    return `
    <div class="task-row ${t.done ? "done" : ""}">
      <button class="flag-btn ${t.flag ? "on" : ""}" onclick="toggleFlag('${t.id}')" title="${t.flag ? "Unflag" : "Flag as priority"}">🚩</button>
      <button class="chk ${t.done ? "on" : ""}" onclick="toggleTask('${t.id}')" aria-label="Toggle task">
        <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <span class="task-num">${i + 1}</span>
      <input type="text" value="${esc(t.text)}" onchange="editTask('${t.id}',this.value)">
      <button class="del" onclick="delTask('${t.id}')" aria-label="Delete">✕</button>
    </div>
    <div class="task-meta-row">
      <select class="task-cat-sel" onchange="editTaskMeta('${t.id}','category',this.value)">
        <option value="work" ${(t.category||"work")==="work"?"selected":""}>Work</option>
        <option value="personal" ${t.category==="personal"?"selected":""}>Personal</option>
      </select>
      <input type="date" class="task-due-input" value="${esc(t.dueDate||"")}" onchange="editTaskMeta('${t.id}','dueDate',this.value)" title="Due date">
      ${due ? `<span class="due-pill ${due.cls}">${due.text}</span>` : ""}
      <input type="text" class="task-link-input" placeholder="link" value="${esc(t.link||"")}" onchange="editTaskMeta('${t.id}','link',this.value)">
      ${t.link ? `<a href="${esc(t.link.startsWith("http")?t.link:"https://"+t.link)}" target="_blank" rel="noopener" class="task-link-go" title="Open link">🔗</a>` : ""}
    </div>`;
  }).join("") || `<p class="hint">${state.tasks.length ? "No tasks match this filter." : "No tasks yet — add your top priorities for today."}</p>`;

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
  if (state.tasks.length >= 5) { toast("Keep it to 5 — finish one first!"); return; }
  state.tasks.push({ id: uid(), text: v, done: false, category: "work", flag: false, link: "", dueDate: "" });
  el.value = "";
  persist(); rerender();
}
export function toggleTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) { t.done = !t.done; persist(); rerender(); }
}
export function toggleFlag(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) { t.flag = !t.flag; persist(); renderTasks(); }
}
export function editTask(id, v) {
  const t = state.tasks.find(x => x.id === id);
  if (t) { t.text = v; persist(); }
}
export function editTaskMeta(id, field, v) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  t[field] = v;
  persist();
  renderTasks();
}
export function delTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) moveToTrash("task", t);
  state.tasks = state.tasks.filter(x => x.id !== id);
  persist(); rerender();
}

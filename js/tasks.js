/* Top 5 tasks. */
import { state, uid, esc, persist, rerender } from './state.js';
import { toast } from './ui.js';

export function renderTasks() {
  const list = document.getElementById("taskList");
  list.innerHTML = state.tasks.map((t, i) => `
    <div class="task-row ${t.done ? "done" : ""}">
      <button class="chk ${t.done ? "on" : ""}" onclick="toggleTask('${t.id}')" aria-label="Toggle task">
        <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <span class="task-num">${i + 1}</span>
      <input type="text" value="${esc(t.text)}" onchange="editTask('${t.id}',this.value)">
      <button class="del" onclick="delTask('${t.id}')" aria-label="Delete">✕</button>
    </div>`).join("") || `<p class="hint">No tasks yet — add your top priorities for today.</p>`;
  const open = state.tasks.filter(t => !t.done).length;
  document.getElementById("taskCount").textContent = state.tasks.length ? `${open} open` : "";
  document.getElementById("catTasksSub").textContent =
    state.tasks.length ? `${open} of ${state.tasks.length} still open` : "Plan your day.";
}

export function addTask() {
  const el = document.getElementById("newTask"); const v = el.value.trim(); if (!v) return;
  if (state.tasks.length >= 5) { toast("Keep it to 5 — finish one first!"); return; }
  state.tasks.push({ id: uid(), text: v, done: false }); el.value = "";
  persist(); rerender();
}
export function toggleTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) { t.done = !t.done; persist(); rerender(); }
}
export function editTask(id, v) {
  const t = state.tasks.find(x => x.id === id);
  if (t) { t.text = v; persist(); }
}
export function delTask(id) {
  state.tasks = state.tasks.filter(x => x.id !== id);
  persist(); rerender();
}

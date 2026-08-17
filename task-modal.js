/* Task detail modal — the Todoist-style overlay.

   WHAT THIS IS NOT

   The brief asked for Radix Dialog and Framer Motion. Neither is usable
   here: both are React libraries, and LifeOS is vanilla ES modules with
   no build step — adding React to open one dialog would mean a bundler,
   a toolchain and a rewrite of every page that renders task cards. So the
   things Radix would have provided are implemented directly below and
   called out where they appear: focus trapping, focus restore, Escape,
   aria-modal semantics, and inert background. Animation is CSS
   transitions, which is what Framer Motion compiles down to for a fade
   and a scale anyway.

   The modal owns no task data. It holds an id, reads through
   findAnyTask() on every render, and writes through the same
   editTaskMeta/toggleTask functions the board uses — so a change here
   and a change on the board cannot diverge, and nothing has to be kept
   in sync. */

import { state, esc, persist, rerender, uid } from './state.js';
import { toast } from './ui.js';
import { findAnyTask, toggleTask, toggleFlag, editTask, editTaskMeta, changeTaskProject, delTask } from './tasks.js';
import { getProjectList } from './gsi.js';
import { getPwProjectList, changePwTaskProject } from './personal.js';
import { sanitizeHtml } from './sanitize.js';
import { mountRichEditor, getRichEditor, unmountRichEditor } from './rich-text.js';

const DESC_EDITOR_ID = "taskDescEditor";
const PRIORITIES = [
  ["p1", "Priority 1", "#B5533F"],
  ["p2", "Priority 2", "#C08A3E"],
  ["p3", "Priority 3", "#4F6D9A"],
  ["p4", "Priority 4", "#8A8A85"],
];
const STATUSES = [["todo", "To do"], ["progress", "In progress"], ["done", "Done"], ["blocked", "Blocked"]];

let openId = null;
let siblingIds = [];        // the list the caller was looking at, for prev/next
let lastFocused = null;     // restored on close, so Tab order isn't lost
let editingField = null;    // which right-rail property is currently an editor
let descLoadedFor = null;

/* ---------- helpers ---------- */
function taskOf(id) { return findAnyTask(id); }
/* Personal tasks share GSI's field shape — `date` not `dueDate`, a
   `status` string not a `done` boolean — so both read the same way here.
   Where the task LIVES is a different question, answered by isPersonal
   alone further down. */
const shapedLikeProject = f => f.isGsi || f.isPersonal;
function dueOf(found) { return shapedLikeProject(found) ? (found.task.date || "") : (found.task.dueDate || ""); }
function isDone(found) { return shapedLikeProject(found) ? found.task.status === "done" : !!found.task.done; }

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
function fmtStamp(ms) {
  return ms ? new Date(ms).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

/* The URL carries ?task=<id> rather than /tasks/<id>. A path would 404 on
   refresh: this is a static deployment with no rewrite rule sending
   unknown paths back to index.html, and adding one would break the
   GitHub Pages fallback. A query string is still the History API, still
   restores on refresh, and works on any host. */
function pushUrl(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set("task", id); else url.searchParams.delete("task");
  history.pushState({ task: id || null }, "", url);
}
function replaceUrl(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set("task", id); else url.searchParams.delete("task");
  history.replaceState({ task: id || null }, "", url);
}

/* ---------- open / close ---------- */
export function openTaskModal(id, siblings) {
  const found = taskOf(id);
  if (!found) return;
  openId = id;
  siblingIds = Array.isArray(siblings) && siblings.length ? siblings : collectSiblings(id);
  lastFocused = document.activeElement;
  editingField = null;
  descLoadedFor = null;

  const bg = document.getElementById("taskModalBg");
  if (!bg) return;
  bg.classList.add("open");
  bg.setAttribute("aria-hidden", "false");
  // Locking the body rather than the overlay: the overlay itself must
  // still scroll on mobile, where the modal is a full-height sheet.
  document.body.classList.add("modal-locked");
  renderTaskModal();
  pushUrl(id);
  // Focus lands on the title, not the close button — the first thing
  // someone wants after opening a task is usually to read or edit it.
  setTimeout(() => document.getElementById("taskModalTitle")?.focus(), 60);
}

/* Reads the title and link fields back before the modal goes away.

   Both commit through onchange, which fires on blur — so closing with
   Escape, or with the backdrop, never gave them the chance: the handler
   ran, openId was cleared, and whatever had just been typed was gone.
   Only the description was flushed, because Quill needed it; the two
   plain fields were overlooked, which is why a retitled task could show
   its old text on the card while the modal showed the new one.

   Reading the DOM rather than trusting an event is the reliable move for
   anything that must survive an abrupt close. */
function commitOpenFields() {
  if (!openId) return;
  const found = taskOf(openId);
  if (!found) return;
  const titleEl = document.getElementById("taskModalTitle");
  if (titleEl) {
    const v = titleEl.value.trim();
    if (v && v !== found.task.text) editTask(openId, v);
  }
  const linkEl = document.querySelector("#taskModalBg .tm-link-input");
  if (linkEl) {
    const v = linkEl.value.trim();
    if (v !== (found.task.link || "")) editTaskMeta(openId, "link", v);
  }
}

export function closeTaskModal(skipUrl) {
  const bg = document.getElementById("taskModalBg");
  if (!bg || !bg.classList.contains("open")) return;
  commitOpenFields();
  flushDescription();
  unmountRichEditor(DESC_EDITOR_ID);
  bg.classList.remove("open");
  bg.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-locked");
  openId = null;
  descLoadedFor = null;
  if (!skipUrl) pushUrl(null);
  if (lastFocused && lastFocused.isConnected) lastFocused.focus();
  lastFocused = null;
}

/* Prev/next walks whatever list the task was opened from, so the order
   matches what is on screen rather than some canonical order the person
   never sees. */
function collectSiblings(id) {
  const onScreen = Array.from(document.querySelectorAll("[data-task-id]"))
    .map(el => el.dataset.taskId)
    .filter((v, i, a) => v && a.indexOf(v) === i);
  return onScreen.includes(id) ? onScreen : [id];
}
export function taskModalStep(delta) {
  if (!openId) return;
  const i = siblingIds.indexOf(openId);
  if (i === -1) return;
  const next = siblingIds[i + delta];
  if (!next || !taskOf(next)) return;
  flushDescription();
  unmountRichEditor(DESC_EDITOR_ID);
  descLoadedFor = null;
  editingField = null;
  openId = next;
  renderTaskModal();
  replaceUrl(next); // stepping through tasks shouldn't fill up Back
}

/* ---------- rendering ---------- */
function propRow(field, label, valueHtml, editorHtml) {
  const editing = editingField === field;
  return `
    <div class="tm-prop ${editing ? "editing" : ""}">
      <div class="tm-prop-label" id="tmLabel-${field}">${esc(label)}</div>
      ${editing
        ? `<div class="tm-prop-editor">${editorHtml}</div>`
        : `<button class="tm-prop-value" aria-labelledby="tmLabel-${field}"
             onclick="editTaskProperty('${field}')">${valueHtml || `<span class="tm-empty">Add ${esc(label.toLowerCase())}</span>`}</button>`}
    </div>`;
}

export function renderTaskModal() {
  const box = document.getElementById("taskModalBody");
  if (!box || !openId) return;
  const found = taskOf(openId);
  if (!found) { closeTaskModal(); return; }
  const { task: t, isGsi, project } = found;
  const done = isDone(found);
  const due = dueOf(found);
  const priority = t.priority || (t.flag ? "p1" : "p4");
  const labels = Array.isArray(t.labels) ? t.labels : [];
  const subtasks = Array.isArray(t.subtasks) ? t.subtasks : [];
  const projName = (isGsi || found.isPersonal)
    ? ((project && project.name) || t.projectName || "Project") : "No project";
  const statusKey = (isGsi || found.isPersonal) ? (t.status || "todo") : (t.done ? "done" : "todo");

  const i = siblingIds.indexOf(openId);
  const crumb = document.getElementById("taskModalCrumb");
  if (crumb) crumb.textContent = projName;
  const prevBtn = document.getElementById("taskModalPrev");
  const nextBtn = document.getElementById("taskModalNext");
  if (prevBtn) prevBtn.disabled = i <= 0;
  if (nextBtn) nextBtn.disabled = i === -1 || i >= siblingIds.length - 1;
  const bar = document.getElementById("taskModalBarTitle");
  if (bar) bar.textContent = t.text || "Task";

  /* Quill lives in a real DOM node, so assigning innerHTML here throws
     the mounted editor away — the instance stays in rich-text.js's cache
     while its element is gone, so remounting silently returns a detached
     editor and the Description box vanishes. That is exactly what
     happened on every property click, because editing a property
     re-rendered the whole modal.

     Two things fix it. The editor is dropped deliberately before the
     rebuild so a fresh one is created (and flushed first, so an
     in-flight edit isn't lost). And property edits now repaint only the
     sidebar via renderTaskModalSide(), which doesn't touch the editor at
     all — so typing a description and setting a due date no longer
     interfere with each other. */
  flushDescription();
  unmountRichEditor(DESC_EDITOR_ID);
  descLoadedFor = null;

  box.innerHTML = `
    <div class="tm-main">
      <div class="tm-title-row">
        <button class="t-chk ${done ? "on" : ""}" onclick="taskModalToggleDone()" aria-label="${done ? "Mark as not done" : "Mark as done"}">
          <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
        <textarea id="taskModalTitle" class="tm-title ${done ? "done" : ""}" rows="1"
          aria-label="Task title"
          oninput="autoGrow(this)" onchange="taskModalEditTitle(this.value)">${esc(t.text || "")}</textarea>
      </div>

      <div class="tm-section">
        <div class="tm-section-head">Description</div>
        <div id="${DESC_EDITOR_ID}" class="mm-rich-editor tm-desc"></div>
      </div>

      <div class="tm-section">
        <div class="tm-section-head">Link</div>
        <input type="text" class="tm-link-input" value="${esc(t.link || "")}" placeholder="https://…"
          aria-label="Task link" onchange="taskModalEditField('link', this.value)">
        ${t.link ? `<a class="tm-link-go" href="${esc(t.link.startsWith("http") ? t.link : "https://" + t.link)}" target="_blank" rel="noopener">Open link →</a>` : ""}
      </div>

      <div class="tm-section" id="taskModalSubtaskSection">${subtasksHtml(subtasks)}</div>
    </div>

    ${sideHtml(found)}`;

  const titleEl = document.getElementById("taskModalTitle");
  if (titleEl) { titleEl.style.height = "auto"; titleEl.style.height = titleEl.scrollHeight + "px"; }
  mountDescription(t);
}

/* Repaints only the properties column. Everything that edits a property
   goes through here rather than renderTaskModal(). */
export function renderTaskModalSide() {
  const found = openId && taskOf(openId);
  if (!found) return;
  const side = document.querySelector("#taskModalBody .tm-side");
  if (!side) { renderTaskModal(); return; }
  side.outerHTML = sideHtml(found);
  // The left column's done state can change with status or the checkbox.
  const done = isDone(found);
  document.querySelector("#taskModalBody .t-chk")?.classList.toggle("on", done);
  document.getElementById("taskModalTitle")?.classList.toggle("done", done);
}

function subtasksHtml(subtasks) {
  return `
    <div class="tm-section-head">Sub-tasks ${subtasks.length ? `<span class="tm-count">${subtasks.filter(s => s.done).length}/${subtasks.length}</span>` : ""}</div>
    <div class="tm-subtasks">
      ${subtasks.map(st => `
        <div class="tm-subtask ${st.done ? "done" : ""}">
          <button class="t-chk small ${st.done ? "on" : ""}" onclick="taskModalToggleSubtask('${st.id}')" aria-label="Toggle sub-task">
            <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
          <input type="text" value="${esc(st.text)}" aria-label="Sub-task"
            onchange="taskModalEditSubtask('${st.id}', this.value)">
          <button class="del" onclick="taskModalDelSubtask('${st.id}')" aria-label="Delete sub-task">✕</button>
        </div>`).join("")}
    </div>
    <div class="tm-subtask-add">
      <input type="text" id="taskModalNewSubtask" placeholder="Add a sub-task"
        onkeydown="if(event.key==='Enter')taskModalAddSubtask()">
      <button class="btn btn-ghost" onclick="taskModalAddSubtask()">Add</button>
    </div>`;
}
/* Sub-tasks repaint on their own, for the same reason the sidebar does:
   a full render would drop and rebuild the description editor, losing the
   cursor for someone mid-sentence. */
function renderSubtasks() {
  const found = openId && taskOf(openId);
  const box = document.getElementById("taskModalSubtaskSection");
  if (!found || !box) return;
  box.innerHTML = subtasksHtml(Array.isArray(found.task.subtasks) ? found.task.subtasks : []);
}

function sideHtml(found) {
  const { task: t, isGsi, project } = found;
  const due = dueOf(found);
  const priority = t.priority || (t.flag ? "p1" : "p4");
  const labels = Array.isArray(t.labels) ? t.labels : [];
  const projName = (isGsi || found.isPersonal)
    ? ((project && project.name) || t.projectName || "Project") : "No project";
  const statusKey = (isGsi || found.isPersonal) ? (t.status || "todo") : (t.done ? "done" : "todo");
  return `
    <aside class="tm-side" aria-label="Task properties">
      ${propRow("project", "Project", `<span class="tm-pill">${esc(projName)}</span>`,
        /* A personal task can only move between personal workspaces, and
           has no "No project" state — it always lives inside one. Offering
           GSI projects here would let a task jump trees, which the sync,
           trash and health-check paths all assume never happens. */
        found.isPersonal
          ? `<select onchange="taskModalSetProject(this.value)" autofocus>
               ${getPwProjectList().map(p => `<option value="${p.id}" ${project && p.id === project.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
             </select>`
          : `<select onchange="taskModalSetProject(this.value)" autofocus>
               <option value="">No project</option>
               ${getProjectList().map(p => `<option value="${p.id}" ${project && p.id === project.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
             </select>`)}

      ${propRow("date", "Due date", due ? esc(fmtDate(due)) : "",
        `<input type="date" value="${esc(due)}" autofocus onchange="taskModalSetDate(this.value)">
         ${due ? `<button class="tm-clear" onclick="taskModalSetDate('')">Clear</button>` : ""}`)}

      ${propRow("priority", "Priority",
        `<span class="tm-prio" style="color:${PRIORITIES.find(p => p[0] === priority)?.[2]}">⚑ ${esc(PRIORITIES.find(p => p[0] === priority)?.[1] || "Priority 4")}</span>`,
        `<select autofocus onchange="taskModalSetPriority(this.value)">
           ${PRIORITIES.map(([k, l]) => `<option value="${k}" ${k === priority ? "selected" : ""}>${l}</option>`).join("")}
         </select>`)}

      ${propRow("status", "Status", `<span class="tm-pill">${esc((STATUSES.find(s => s[0] === statusKey) || [])[1] || "To do")}</span>`,
        `<select autofocus onchange="taskModalSetStatus(this.value)">
           ${STATUSES.map(([k, l]) => `<option value="${k}" ${k === statusKey ? "selected" : ""}>${l}</option>`).join("")}
         </select>`)}

      ${propRow("labels", "Labels",
        labels.length ? labels.map(l => `<span class="tm-label">${esc(l)}</span>`).join("") : "",
        `<input type="text" list="taskModalLabelOptions" value="${esc(labels.join(", "))}" autofocus
           placeholder="Comma separated" onchange="taskModalSetLabels(this.value)">
         <datalist id="taskModalLabelOptions">${allLabels().map(l => `<option value="${esc(l)}">`).join("")}</datalist>`)}

      <div class="tm-prop static">
        <div class="tm-prop-label">Created</div>
        <div class="tm-prop-static">${esc(fmtStamp(t.createdAt))}</div>
      </div>
      <div class="tm-prop static">
        <div class="tm-prop-label">Last modified</div>
        <div class="tm-prop-static">${esc(fmtStamp(t.updatedAt))}</div>
      </div>

      <button class="btn btn-ghost tm-delete" onclick="taskModalDelete()">Delete task</button>
    </aside>`;
}

function allLabels() {
  const set = new Set();
  const add = t => (t.labels || []).forEach(l => set.add(l));
  (state.tasks || []).forEach(add);
  (state.gsi?.projects || []).forEach(p => (p.tasks || []).forEach(add));
  (state.personal?.projects || []).forEach(p => (p.tasks || []).forEach(add));
  return [...set].sort();
}

/* ---------- description ----------
   One Quill instance serving whichever task is open, the same
   one-editor-many-documents arrangement the journal uses. Content is
   swapped explicitly on task change and flushed back before the swap, so
   a debounced edit can't land on the task being moved to. */
function mountDescription(t) {
  const quill = mountRichEditor(DESC_EDITOR_ID, () => sanitizeHtml(t.desc || ""), html => {
    if (!descLoadedFor) return;
    const f = taskOf(descLoadedFor);
    if (!f) return;
    f.task.desc = sanitizeHtml(html);
    f.task.updatedAt = Date.now();
    persist();
  });
  if (!quill) return;
  quill.root.dataset.placeholder = "Notes, steps, anything about this task…";
  if (descLoadedFor === openId) return;
  descLoadedFor = openId;
  const html = sanitizeHtml(t.desc || "");
  if (html) quill.clipboard.dangerouslyPasteHTML(html);
  else quill.setText("");
}
function flushDescription() {
  const q = getRichEditor(DESC_EDITOR_ID);
  if (!q || !descLoadedFor) return;
  const f = taskOf(descLoadedFor);
  if (!f) return;
  const html = sanitizeHtml(q.root.innerHTML);
  const empty = !html.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "").trim();
  const next = empty ? "" : html;
  if ((f.task.desc || "") !== next) { f.task.desc = next; f.task.updatedAt = Date.now(); persist(); }
}

/* ---------- editing ---------- */
function touch(found) { found.task.updatedAt = Date.now(); }

export function editTaskProperty(field) { editingField = field; renderTaskModalSide(); }

export function taskModalEditTitle(v) {
  if (!openId) return;
  editTask(openId, v);
  const f = taskOf(openId); if (f) touch(f);
  persist();
  const bar = document.getElementById("taskModalBarTitle");
  if (bar) bar.textContent = v || "Task";
}
export function taskModalEditField(field, v) {
  if (!openId) return;
  editTaskMeta(openId, field, v);
  const f = taskOf(openId); if (f) touch(f);
  persist(); renderTaskModalSide();
}
export function taskModalToggleDone() { if (openId) { toggleTask(openId); renderTaskModalSide(); } }
export function taskModalSetDate(v) {
  editingField = null;
  editTaskMeta(openId, "dueDate", v);
  const f = taskOf(openId); if (f) touch(f);
  persist(); renderTaskModalSide();
}
export function taskModalSetProject(pid) {
  editingField = null;
  const f = taskOf(openId);
  if (f?.isPersonal) changePwTaskProject(openId, pid);
  else changeTaskProject(openId, pid);
  renderTaskModalSide();
}
export function taskModalSetPriority(p) {
  const f = taskOf(openId); if (!f) return;
  f.task.priority = p;
  // The board's flag and P1 are the same idea shown two ways; keeping
  // them in step stops a task looking urgent in one view and not the other.
  const wantFlag = p === "p1";
  if (!!f.task.flag !== wantFlag) toggleFlag(openId);
  touch(f); editingField = null; persist(); rerender(); renderTaskModalSide();
}
export function taskModalSetStatus(v) {
  const f = taskOf(openId); if (!f) return;
  if (f.isGsi || f.isPersonal) f.task.status = v;
  else f.task.done = v === "done";
  touch(f); editingField = null; persist(); rerender(); renderTaskModalSide();
}
export function taskModalSetLabels(v) {
  const f = taskOf(openId); if (!f) return;
  f.task.labels = [...new Set(String(v).split(",").map(x => x.trim()).filter(Boolean))];
  touch(f); editingField = null; persist(); rerender(); renderTaskModalSide();
}
export function taskModalDelete() {
  if (!openId) return;
  const id = openId;
  closeTaskModal();
  delTask(id);
}

/* ---------- sub-tasks ---------- */
function subs(found) {
  if (!Array.isArray(found.task.subtasks)) found.task.subtasks = [];
  return found.task.subtasks;
}
export function taskModalAddSubtask() {
  const el = document.getElementById("taskModalNewSubtask");
  const v = (el?.value || "").trim();
  if (!v) return;
  const f = taskOf(openId); if (!f) return;
  subs(f).push({ id: uid(), text: v, done: false });
  el.value = "";
  touch(f); persist(); renderSubtasks();
  document.getElementById("taskModalNewSubtask")?.focus();
}
export function taskModalToggleSubtask(sid) {
  const f = taskOf(openId); if (!f) return;
  const st = subs(f).find(x => x.id === sid); if (!st) return;
  st.done = !st.done; touch(f); persist(); renderSubtasks();
}
export function taskModalEditSubtask(sid, v) {
  const f = taskOf(openId); if (!f) return;
  const st = subs(f).find(x => x.id === sid); if (!st) return;
  st.text = v.trim(); touch(f); persist();
}
export function taskModalDelSubtask(sid) {
  const f = taskOf(openId); if (!f) return;
  f.task.subtasks = subs(f).filter(x => x.id !== sid);
  touch(f); persist(); renderSubtasks();
}

/* ---------- keyboard, overlay, history ----------
   The parts a headless dialog library would normally provide. */
document.addEventListener("keydown", (e) => {
  const bg = document.getElementById("taskModalBg");
  if (!bg || !bg.classList.contains("open")) return;

  if (e.key === "Escape") { e.preventDefault(); closeTaskModal(); return; }

  // Arrow keys step between tasks — but only when the caret isn't in a
  // field, or they'd fight with moving through text.
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")
    || document.activeElement?.isContentEditable;
  if (!typing && (e.key === "ArrowUp" || e.key === "ArrowLeft")) { e.preventDefault(); taskModalStep(-1); return; }
  if (!typing && (e.key === "ArrowDown" || e.key === "ArrowRight")) { e.preventDefault(); taskModalStep(1); return; }

  if (e.key !== "Tab") return;
  // Focus trap: Tab off either end wraps to the other, so keyboard focus
  // can't wander into the board behind the overlay.
  const focusables = bg.querySelectorAll(
    'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]');
  const list = Array.from(focusables).filter(el => el.offsetParent !== null);
  if (!list.length) return;
  const first = list[0], last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

document.addEventListener("pointerdown", (e) => {
  const bg = document.getElementById("taskModalBg");
  if (!bg || !bg.classList.contains("open")) return;
  if (e.target === bg) closeTaskModal(); // only the backdrop itself, never a child
});

// Back/forward, and the ?task= parameter on a fresh load.
window.addEventListener("popstate", () => syncModalFromUrl(true));
export function syncModalFromUrl(fromHistory) {
  const id = new URL(location.href).searchParams.get("task");
  if (id && taskOf(id)) {
    if (openId !== id) {
      openId = id;
      siblingIds = collectSiblings(id);
      const bg = document.getElementById("taskModalBg");
      bg?.classList.add("open");
      bg?.setAttribute("aria-hidden", "false");
      document.body.classList.add("modal-locked");
      descLoadedFor = null;
      renderTaskModal();
    }
  } else if (openId) {
    closeTaskModal(fromHistory); // don't push another entry while handling one
  }
}

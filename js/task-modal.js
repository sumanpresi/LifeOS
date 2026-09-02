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

import { state, esc, persist, rerender, uid } from './state.js?v=202609031800';
import { toast } from './ui.js?v=202609031800';
import { findAnyTask, toggleTask, toggleFlag, editTask, editTaskMeta, changeTaskProject, delTask } from './tasks.js?v=202609031800';
import { openDateSheet } from './date-sheet.js?v=202609031800';
import { getProjectList } from './gsi.js?v=202609031800';
import { getPwProjectList, changePwTaskProject } from './personal.js?v=202609031800';
import { sanitizeHtml } from './sanitize.js?v=202609031800';
import { mountRichEditor, getRichEditor, unmountRichEditor } from './rich-text.js?v=202609031800';

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
/* Whether the Description section is expanded. Todoist keeps a task's
   notes behind a tap: a task that HAS a description shows it, and a task
   that doesn't shows one quiet "Add description" line instead of a
   permanently-mounted editor with a toolbar.

   Two reasons this matters beyond looks. The rich editor is the single
   tallest thing in the sheet — its toolbar alone is a row of eighteen
   controls — so on the Fold it pushed the properties, the link and the
   sub-tasks below the fold on every open, for a field most tasks never
   use. And mounting Quill costs real time on open; leaving it unmounted
   until asked for is why the sheet now appears immediately.

   Per-open, not persisted: it is a state of the panel, not of the task. */
let descOpen = false;
/* The sub-task composer's pending chips. A sub-task is not created until
   the text is submitted, so a date or a priority chosen beforehand has
   nowhere to live yet — same problem the board composer solves with its
   own `draft`, and solved the same way. Reset on open and after each add. */
let subDraft = { date: "", priority: "", labels: [], projectId: "", projectName: "" };
/* Which sub-task picker is open, if any: "project" | "labels" | null.
   One at a time — two popovers on screen at once inside a half-height
   sheet is a stack of layers nobody can read.

   subPickerFor records WHICH composer opened it — "edit" or "add" — so
   that only that composer renders the popover. Both composers can be on
   screen together (adding a new sub-task while another one is mid-edit),
   and without this a picker opened from one would get duplicated into
   the other's markup too, with duplicate ids fighting over every click. */
let subPicker = null;
let subPickerFor = null;
let subPickerQuery = "";
/* Which sub-task is open for editing, and its working copy. A sub-task
   being edited needs exactly the same four chips the composer offers, so
   rather than build a second set of pickers that would drift, both share
   one set of picker UI — but each chip handler is told explicitly which
   draft it belongs to (via forEdit) rather than guessing from ambient
   state. Guessing from `editingSubId` alone broke the moment both
   composers were open together: every chip in the "add a sub-task" row
   would silently edit whichever OTHER sub-task was open for editing,
   because that check can't tell which of the two on-screen composers the
   click actually came from. */
let editingSubId = null;
let editDraft = null;
function draftFor(forEdit) { return forEdit ? (editDraft || blankDraft()) : subDraft; }
function blankDraft() { return { date: "", priority: "", labels: [], projectId: "", projectName: "" }; }

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
  // A description that exists is content, not a control, so it opens with
  // the task. An empty one stays out of the way until asked for.
  descOpen = !!(found.task.desc || "").replace(/<[^>]*>/g, "").trim();
  subDraft = { date: "", priority: "", labels: [], projectId: "", projectName: "" };
  subPicker = null; subPickerFor = null; subPickerQuery = "";
  editingSubId = null; editDraft = null;
  taskLabelQuery = "";

  const bg = document.getElementById("taskModalBg");
  if (!bg) return;
  bg.classList.add("open");
  bg.setAttribute("aria-hidden", "false");
  // Locking the body rather than the overlay: the overlay itself must
  // still scroll on mobile, where the modal is a full-height sheet.
  document.body.classList.add("modal-locked");
  renderTaskModal();
  pushUrl(id);
  /* Focus goes to the close button, never the title, regardless of
     pointer type. The title is a <textarea>, so focusing it drops the
     caret straight in — on touch that also summons the on-screen
     keyboard, which on the Fold covers half the sheet. Either way,
     opening a task is a request to LOOK at it; putting it straight into
     "editing the title" before anyone asked to edit anything is the bug,
     not a feature worth keeping just for keyboard users. The close
     button still gives the focus trap somewhere inside the dialog to
     start from, which is what the focus was actually for. */
  setTimeout(() => {
    const el = document.querySelector("#taskModalBg .tm-close");
    try { el?.focus({ preventScroll: true }); } catch (e) { el?.focus(); }
  }, 60);
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
/* Due date does not use propRow's swap-to-an-editor pattern.

   Every other property here becomes a <select> or a text box when you
   click it, which suits them. A date is different: the editor it swapped
   in was a native <input type="date">, i.e. the OS spinner — the same
   control the board cards were moved off, and for the same reason.
   Setting "tomorrow" through it is a three-step operation.

   So this row opens the shared date sheet instead. The hidden input is
   what the sheet drives, and its onchange is the ordinary save path this
   row always used, so nothing downstream changes. The separate "Clear"
   button is gone because the sheet's own "No date" row does that job.

   .t-due-hidden-input is the same off-screen-input class the board cards
   use — no new CSS, and the two behave identically by construction. */
function dateRow(due) {
  return `
    <div class="tm-prop">
      <div class="tm-prop-label" id="tmLabel-date">Due date</div>
      <button class="tm-prop-value" aria-labelledby="tmLabel-date" aria-haspopup="dialog"
        onclick="openTaskModalDatePicker()">${due ? esc(fmtDate(due)) : `<span class="tm-empty">Add due date</span>`}</button>
      <input type="date" class="t-due-hidden-input" id="tmDueInput" value="${esc(due)}"
        onchange="taskModalSetDate(this.value)">
    </div>`;
}

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

      <div class="tm-section tm-desc-section ${descOpen ? "is-open" : ""}">
        <button type="button" class="tm-desc-toggle" onclick="taskModalToggleDesc()"
          aria-expanded="${descOpen}" aria-controls="${DESC_EDITOR_ID}">
          <span class="tm-desc-chevron" aria-hidden="true">▾</span>
          <span class="tm-section-head">Description</span>
          ${descOpen ? "" : `<span class="tm-desc-preview">${esc(descPreview(t)) || "Add description"}</span>`}
        </button>
        <div id="${DESC_EDITOR_ID}" class="mm-rich-editor tm-desc" ${descOpen ? "" : "hidden"}></div>
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
  if (descOpen) mountDescription(t);
}

/* The first line of the notes, as plain text, so a collapsed section still
   says what is inside it rather than just that something is. Truncated
   here rather than in CSS because the string also has to fit the button's
   accessible name. */
function descPreview(t) {
  const text = String(t.desc || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 60 ? text.slice(0, 59) + "…" : text;
}

/* Opening mounts the editor; closing flushes it and takes it back down,
   so a collapsed section holds no live Quill instance at all. Only this
   one section is repainted — a full renderTaskModal() would rebuild the
   title and the sub-tasks too, and the title is very often mid-edit when
   someone reaches for the description. */
export function taskModalToggleDesc() {
  const found = openId && taskOf(openId);
  if (!found) return;
  if (descOpen) { flushDescription(); unmountRichEditor(DESC_EDITOR_ID); descLoadedFor = null; }
  descOpen = !descOpen;

  const section = document.querySelector("#taskModalBody .tm-desc-section");
  const editor = document.getElementById(DESC_EDITOR_ID);
  const toggle = section?.querySelector(".tm-desc-toggle");
  if (!section || !editor || !toggle) { renderTaskModal(); return; }

  section.classList.toggle("is-open", descOpen);
  toggle.setAttribute("aria-expanded", String(descOpen));
  editor.hidden = !descOpen;

  let preview = toggle.querySelector(".tm-desc-preview");
  if (descOpen) {
    preview?.remove();
    mountDescription(found.task);
    // Land the cursor in the editor: the tap that opened it was a request
    // to write, not merely to look.
    setTimeout(() => getRichEditor(DESC_EDITOR_ID)?.focus(), 40);
  } else {
    if (!preview) {
      preview = document.createElement("span");
      preview.className = "tm-desc-preview";
      toggle.appendChild(preview);
    }
    preview.textContent = descPreview(found.task) || "Add description";
  }
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

/* Which of Todoist's quick-add chips a LifeOS sub-task can actually
   honour. The reference row shows eight — Project, Labels, Date,
   Deadline, Reminders, Location, Priority, Attachment — and four of them
   have no counterpart anywhere in this data model: there is no deadline
   distinct from a due date, no reminder scheduler, no geofencing, and no
   file store. Rendering them would put four controls on screen that do
   nothing when tapped, which is worse than not offering them.

   Project is deliberately out too, for a different reason: a sub-task
   belongs to its parent by definition, so a project picker on it would
   be offering to contradict that.

   That leaves the three the app already understands and already renders
   everywhere else — Date, Priority and Labels. */
const SUB_PRIOS = [["p1", "#B5533F"], ["p2", "#C08A3E"], ["p3", "#4F6D9A"], ["p4", "#8A8A85"]];
function subPrioColor(p) { return (SUB_PRIOS.find(x => x[0] === p) || SUB_PRIOS[3])[1]; }
function subMetaHtml(st) {
  const bits = [];
  if (st.date) bits.push(`<span class="tm-sub-chip tm-sub-date">🗓 ${esc(fmtShort(st.date))}</span>`);
  if (st.priority && st.priority !== "p4") {
    bits.push(`<span class="tm-sub-chip tm-sub-prio" style="color:${subPrioColor(st.priority)}">⚑ ${esc(st.priority.toUpperCase())}</span>`);
  }
  if (st.projectName) bits.push(`<span class="tm-sub-chip tm-sub-proj"># ${esc(st.projectName)}</span>`);
  (Array.isArray(st.labels) ? st.labels : []).forEach(l =>
    bits.push(`<span class="tm-sub-chip tm-sub-label">🏷 ${esc(l)}</span>`));
  return bits.length ? `<div class="tm-sub-meta">${bits.join("")}</div>` : "";
}
function fmtShort(iso) {
  if (!iso) return "";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/* A reference resolves through findAnyTask on every render, so it reads as
   whatever the target is called NOW. A dangling one says so rather than
   pretending — the sub-task is still yours to keep or delete. */
function subRefHtml(st) {
  const target = taskOf(st.refId);
  if (!target) {
    return `<span class="tm-sub-ref is-gone" title="This task no longer exists">
      <span class="tm-sub-ref-ico">🔗</span> ${esc(st.text || "Linked task")} <em>(deleted)</em></span>`;
  }
  return `<button type="button" class="tm-sub-ref" onclick="openTaskModal('${st.refId}')"
      title="Open ${esc(target.task.text || "task")}">
      <span class="tm-sub-ref-ico">🔗</span> Task: ${esc(target.task.text || "Untitled")}</button>`;
}

/* Todoist lets you type the project straight into the text as #Name
   rather than reaching for the chip — faster when you already know where
   it goes, and it is how their composer is designed to be used. Matched
   against real project names longest-first, so "#NGDR 2.0" wins over
   "#NGDR" when both exist. The token is removed from the text: it was an
   instruction, not part of the title. */
function extractProjectToken(text) {
  const t = String(text || "");
  if (!t.includes("#")) return null;
  const all = [...getProjectList(), ...getPwProjectList()]
    .slice().sort((a, b) => b.name.length - a.name.length);
  for (const p of all) {
    const i = t.toLowerCase().indexOf("#" + p.name.toLowerCase());
    if (i !== -1) {
      const rest = (t.slice(0, i) + t.slice(i + 1 + p.name.length)).replace(/\s{2,}/g, " ").trim();
      return { project: p, text: rest };
    }
  }
  return null;
}

function subtasksHtml(subtasks) {
  return `
    <div class="tm-section-head">Sub-tasks ${subtasks.length ? `<span class="tm-count">${subtasks.filter(s => s.done).length}/${subtasks.length}</span>` : ""}</div>
    <div class="tm-subtasks">
      ${subtasks.map(st => editingSubId === st.id ? subComposerHtml(st) : `
        <div class="tm-subtask ${st.done ? "done" : ""}">
          <button class="t-chk small ${st.done ? "on" : ""}" onclick="taskModalToggleSubtask('${st.id}')" aria-label="Toggle sub-task">
            <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
          <div class="tm-sub-main">
            ${st.refId ? subRefHtml(st) : `<input type="text" value="${esc(st.text)}" aria-label="Sub-task"
              onchange="taskModalEditSubtask('${st.id}', this.value)">`}
            ${subMetaHtml(st)}
          </div>
          <div class="tm-sub-actions">
            <button class="tm-sub-act" onclick="taskModalSubEditStart('${st.id}')" title="Edit sub-task" aria-label="Edit sub-task">✏️</button>
            <button class="tm-sub-act" onclick="taskModalSubEditStart('${st.id}', 'date')" title="Set date" aria-label="Set date">🗓</button>
            <button class="tm-sub-act tm-sub-act-del" onclick="taskModalDelSubtask('${st.id}')" title="Delete sub-task" aria-label="Delete sub-task">✕</button>
          </div>
        </div>`).join("")}
    </div>
    ${subComposerHtml()}`;
}

/* Same shape as the board's quick add: the field, then one horizontal row
   of chips with the send button pinned to its right end.

   `editing` is truthy only for the composer standing in for a sub-task
   that is being edited; every chip handler below is passed the matching
   `forEdit` boolean explicitly (`!!editing`) so it writes into THIS
   composer's draft and repaints THIS composer specifically — never a
   sibling composer that happens to also be on screen (adding a new
   sub-task while another one is open for editing puts both composers
   in the DOM at once). Ids are likewise suffixed so the two composers
   never collide on the same element id. */
function subComposerHtml(editing) {
  const forEdit = !!editing;
  const d = draftFor(forEdit);
  const labels = Array.isArray(d.labels) ? d.labels : [];
  const dateId = forEdit ? "taskModalSubEditDate" : "taskModalSubDate";
  const isOwnPicker = subPicker && subPickerFor === (forEdit ? "edit" : "add");
  return `
    <div class="${editing ? "tm-sub-edit" : "tm-subtask-add"} composer-quick">
      <input type="text" id="${editing ? "taskModalSubEditInput" : "taskModalNewSubtask"}" class="composer-text"
        placeholder="Sub-task name" value="${editing ? esc(editing.text || "") : ""}"
        onkeydown="if(event.key==='Enter'){${editing ? "taskModalSubEditSave()" : "taskModalAddSubtask()"}}">
      <div class="composer-chips">
        <button type="button" class="composer-chip${d.projectId ? " on" : ""}"
          onclick="taskModalSubPicker('project', ${forEdit})" aria-haspopup="listbox"
          aria-expanded="${isOwnPicker && subPicker === "project"}" title="Project">
          # ${d.projectName ? esc(d.projectName) : "Project"}</button>
        <button type="button" class="composer-chip composer-chip-date${d.date ? " on" : ""}"
          onclick="taskModalSubOpenDatePicker(${forEdit})" title="Due date">
          🗓 ${d.date ? `<b>${esc(fmtShort(d.date))}</b>` : "Date"}</button>
        <input type="date" class="t-due-hidden-input" id="${dateId}" value="${esc(d.date)}"
          onchange="taskModalSubDraft('date', this.value, ${forEdit})">
        <button type="button" class="composer-chip${d.priority && d.priority !== "p4" ? " on" : ""}"
          onclick="taskModalSubCyclePriority(${forEdit})" title="Priority"
          style="${d.priority && d.priority !== "p4" ? `color:${subPrioColor(d.priority)}` : ""}">
          ⚑ ${d.priority && d.priority !== "p4" ? esc(d.priority.toUpperCase()) : "Priority"}</button>
        <button type="button" class="composer-chip${labels.length ? " on" : ""}"
          onclick="taskModalSubPicker('labels', ${forEdit})" aria-haspopup="listbox"
          aria-expanded="${isOwnPicker && subPicker === "labels"}" title="Labels">
          🏷 ${labels.length ? esc(labels.length === 1 ? labels[0] : labels.length + " labels") : "Labels"}</button>
        <span class="composer-spacer"></span>
        <button type="button" class="composer-icon-btn composer-cancel"
          onclick="${editing ? "taskModalSubEditCancel()" : "taskModalSubClear()"}"
          title="${editing ? "Cancel" : "Clear"}" aria-label="${editing ? "Cancel editing" : "Clear sub-task fields"}">✕</button>
        <button type="button" class="composer-icon-btn composer-send"
          onclick="${editing ? "taskModalSubEditSave()" : "taskModalAddSubtask()"}"
          title="${editing ? "Save changes" : "Add sub-task"}" aria-label="${editing ? "Save changes" : "Add sub-task"}">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M4 12h13M12 5l7 7-7 7" fill="none" stroke="currentColor"
              stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      ${isOwnPicker ? subPickerHtml(forEdit) : ""}
    </div>`;
}

/* ---------- the two pickers ----------
   Both are the same popover: a search field over a scrolling list. The
   only difference is what a row does when tapped — a project replaces the
   choice and closes, a label toggles a checkbox and stays open, because
   labels are a set and projects are not.

   A <datalist> was what the labels chip used before, and it was the wrong
   control in two ways: it only suggests while you type, so there is no way
   to SEE which labels exist, and it cannot show what is already selected.
   The reference's checkbox list answers both.

   Only ever called by the composer that owns the open picker (see
   isOwnPicker above), so there is exactly one on screen at a time — no
   duplicate ids, no ambiguity about which draft a row's tap should hit. */
function subPickerHtml(forEdit) {
  if (!subPicker) return "";
  const q = subPickerQuery.trim().toLowerCase();
  const rows = subPicker === "project" ? subProjectRows(q, forEdit) : subLabelRows(q, forEdit);
  const isNew = subPicker === "labels" && subPickerQuery.trim() &&
    !allLabels().some(l => l.toLowerCase() === q);
  return `
    <div class="tm-picker" role="dialog" aria-label="${subPicker === "project" ? "Choose project" : "Choose labels"}">
      <input type="text" class="tm-picker-search" id="taskModalSubPickerSearch"
        placeholder="${subPicker === "project" ? "Type a project name" : "Type a label"}"
        value="${esc(subPickerQuery)}" oninput="taskModalSubPickerFilter(this.value)"
        onkeydown="if(event.key==='Escape'){event.stopPropagation();taskModalSubPicker(null, ${forEdit})}">
      <div class="tm-picker-list">
        ${rows || `<div class="tm-picker-empty">${
          subPicker === "labels" && !subPickerQuery.trim()
            ? "No labels yet — type one to create it"
            : "No matches"}</div>`}
        ${isNew ? `<button type="button" class="tm-picker-row tm-picker-new"
          onclick="taskModalSubToggleLabel('${esc(subPickerQuery.trim()).replace(/'/g, "\\'")}', ${forEdit})">
          <span class="tm-picker-ico">+</span> Create “${esc(subPickerQuery.trim())}”</button>` : ""}
      </div>
    </div>`;
}
/* Both trees, each under its own heading — the same separation the task's
   own project picker keeps, because a GSI project and a personal one are
   different stores and moving between them is not allowed anywhere else
   in the app either. */
function subProjectRows(q, forEdit) {
  const d = draftFor(forEdit);
  const groups = [["Work · GSI", getProjectList()], ["Personal", getPwProjectList()]];
  let html = `<button type="button" class="tm-picker-row${d.projectId ? "" : " is-on"}"
    onclick="taskModalSubSetProject('','', ${forEdit})"><span class="tm-picker-ico">🗂</span> No project
    ${d.projectId ? "" : `<span class="tm-picker-tick">✓</span>`}</button>`;
  groups.forEach(([label, list]) => {
    const hits = list.filter(p => !q || p.name.toLowerCase().includes(q));
    if (!hits.length) return;
    html += `<div class="tm-picker-head">${esc(label)}</div>`;
    html += hits.map(p => `
      <button type="button" class="tm-picker-row${d.projectId === p.id ? " is-on" : ""}"
        onclick="taskModalSubSetProject('${p.id}', '${esc(p.name).replace(/'/g, "\\'")}', ${forEdit})">
        <span class="tm-picker-ico tm-picker-hash">#</span> ${esc(p.name)}
        ${d.projectId === p.id ? `<span class="tm-picker-tick">✓</span>` : ""}</button>`).join("");
  });
  return html;
}
function subLabelRows(q, forEdit) {
  const chosen = new Set(draftFor(forEdit).labels);
  return allLabels()
    .filter(l => !q || l.toLowerCase().includes(q))
    .map(l => `
      <button type="button" class="tm-picker-row${chosen.has(l) ? " is-on" : ""}"
        onclick="taskModalSubToggleLabel('${esc(l).replace(/'/g, "\\'")}', ${forEdit})" role="checkbox"
        aria-checked="${chosen.has(l)}">
        <span class="tm-picker-ico">🏷</span> ${esc(l)}
        <span class="tm-picker-box${chosen.has(l) ? " on" : ""}" aria-hidden="true"></span></button>`).join("");
}

/* The task's own label picker. Deliberately reuses the sub-task picker's
   row markup and CSS rather than growing a second visual language for the
   same job; only the click target differs, because this one writes
   straight to the task instead of to a pending draft. */
let taskLabelQuery = "";
function taskLabelPickerHtml() {
  const found = openId && taskOf(openId);
  const chosen = new Set(Array.isArray(found?.task.labels) ? found.task.labels : []);
  const q = taskLabelQuery.trim().toLowerCase();
  const rows = allLabels()
    .filter(l => !q || l.toLowerCase().includes(q))
    .map(l => `
      <button type="button" class="tm-picker-row${chosen.has(l) ? " is-on" : ""}"
        onclick="taskModalToggleLabel('${esc(l).replace(/'/g, "\\'")}')" role="checkbox"
        aria-checked="${chosen.has(l)}">
        <span class="tm-picker-ico">🏷</span> ${esc(l)}
        <span class="tm-picker-box${chosen.has(l) ? " on" : ""}" aria-hidden="true"></span></button>`).join("");
  const typed = taskLabelQuery.trim();
  const isNew = typed && !allLabels().some(l => l.toLowerCase() === q);
  return `
    <div class="tm-picker tm-picker-inline" role="dialog" aria-label="Choose labels">
      <input type="text" class="tm-picker-search" id="taskModalLabelSearch" autofocus
        placeholder="Type a label" value="${esc(taskLabelQuery)}"
        oninput="taskModalLabelFilter(this.value)"
        onkeydown="if(event.key==='Enter'&&this.value.trim()){event.preventDefault();taskModalToggleLabel(this.value.trim())}">
      <div class="tm-picker-list">
        ${rows || `<div class="tm-picker-empty">${typed ? "No matches" : "No labels yet — type one to create it"}</div>`}
        ${isNew ? `<button type="button" class="tm-picker-row tm-picker-new"
          onclick="taskModalToggleLabel('${esc(typed).replace(/'/g, "\\'")}')">
          <span class="tm-picker-ico">+</span> Create “${esc(typed)}”</button>` : ""}
      </div>
    </div>`;
}
export function taskModalLabelFilter(v) {
  taskLabelQuery = v;
  // Rebuild the list only, so the search field keeps its caret.
  const list = document.querySelector("#taskModalBody .tm-picker-inline .tm-picker-list");
  if (!list) { renderTaskModalSide(); return; }
  const holder = document.createElement("div");
  holder.innerHTML = taskLabelPickerHtml();
  const fresh = holder.querySelector(".tm-picker-list");
  if (fresh) list.innerHTML = fresh.innerHTML;
}
/* Stays open, like the sub-task one: labels are a set, and closing after
   each pick would mean reopening for every label on the task. */
export function taskModalToggleLabel(label) {
  const f = openId && taskOf(openId);
  if (!f || !label) return;
  const cur = Array.isArray(f.task.labels) ? [...f.task.labels] : [];
  const i = cur.indexOf(label);
  if (i === -1) cur.push(label); else cur.splice(i, 1);
  taskModalSetLabels(cur.join(", "));
  taskLabelQuery = "";
  // taskModalSetLabels re-renders the side pane, which closes the editor;
  // reopen it on the same field so a run of picks isn't interrupted.
  editingField = "labels";
  renderTaskModalSide();
  setTimeout(() => document.getElementById("taskModalLabelSearch")?.focus(), 20);
}

export function taskModalSubPicker(which, forEdit) {
  const same = subPicker && which === subPicker && subPickerFor === (forEdit ? "edit" : "add");
  const prevFor = subPickerFor;
  subPicker = (which && !same) ? which : null;
  subPickerFor = subPicker ? (forEdit ? "edit" : "add") : null;
  subPickerQuery = "";
  /* If a picker was already open on the OTHER composer, jumping straight
     to a chip on this one leaves that other popup stale in the DOM —
     still showing, still wired to its own composer, just no longer the
     one "subPicker" describes. Repaint it closed too, or the exact
     two-popups-at-once bug this file exists to fix would come right
     back through this one gap. */
  if (prevFor && prevFor !== (forEdit ? "edit" : "add")) {
    repaintSubComposer(prevFor === "edit");
  }
  repaintSubComposer(forEdit);
  if (subPicker) setTimeout(() => document.getElementById("taskModalSubPickerSearch")?.focus(), 30);
}
export function taskModalSubPickerFilter(v) {
  subPickerQuery = v;
  const forEdit = subPickerFor === "edit";
  // Only the list is rebuilt, so the search field keeps its caret.
  const list = document.querySelector("#taskModalSubtaskSection .tm-picker-list");
  if (!list) { repaintSubComposer(forEdit); return; }
  const holder = document.createElement("div");
  holder.innerHTML = subPickerHtml(forEdit);
  const fresh = holder.querySelector(".tm-picker-list");
  if (fresh) list.innerHTML = fresh.innerHTML;
}
export function taskModalSubSetProject(id, name, forEdit) {
  const d = draftFor(forEdit);
  d.projectId = id || "";
  d.projectName = id ? name : "";
  subPicker = null; subPickerFor = null; subPickerQuery = "";
  repaintSubComposer(forEdit);
}
/* Stays open: choosing labels is a set operation, and closing after each
   one would mean reopening the picker for every label on the task. */
export function taskModalSubToggleLabel(label, forEdit) {
  const d = draftFor(forEdit);
  const i = d.labels.indexOf(label);
  if (i === -1) d.labels.push(label); else d.labels.splice(i, 1);
  subPickerQuery = "";
  repaintSubComposer(forEdit);
  setTimeout(() => document.getElementById("taskModalSubPickerSearch")?.focus(), 20);
}
/* A tap anywhere outside closes it — the same dismissal every other
   popover in the app uses, bound once at module load. */
document.addEventListener("click", (e) => {
  if (!subPicker) return;
  if (e.target.closest?.(".tm-picker")) return;
  if (e.target.closest?.('.composer-chip[aria-haspopup="listbox"]')) return;
  const forEdit = subPickerFor === "edit";
  subPicker = null; subPickerFor = null; subPickerQuery = "";
  repaintSubComposer(forEdit);
}, true);

/* The chips write into subDraft rather than into a sub-task, because the
   sub-task does not exist until the text is submitted. forEdit says
   explicitly which composer this came from — the "add a sub-task" row and
   an in-progress edit of another sub-task can both be on screen together,
   so there's no safe way to infer the target from ambient state alone. */
export function taskModalSubDraft(field, v, forEdit) {
  const d = draftFor(forEdit);
  if (field === "labels") {
    d.labels = [...new Set(String(v).split(",").map(x => x.trim()).filter(Boolean))];
  } else {
    d[field] = v || "";
  }
  repaintSubComposer(forEdit);
}
/* Same shared date sheet the task's own due-date row and every board
   card use (see dateRow() above) — the sub-task composer used to hand
   this off to a bare native <input type="date"> instead, which is the
   OS spinner the rest of the app was moved off of. The hidden input
   below still carries the value and still fires the same "change" that
   taskModalSubDraft listens for; only how it gets opened changes. */
export function taskModalSubOpenDatePicker(forEdit) {
  openDateSheet(forEdit ? "taskModalSubEditDate" : "taskModalSubDate");
}
/* One control, four states — a four-way picker would be a menu, and a
   menu inside a half-height sheet inside a modal is a lot of layers for
   choosing between four values. P4 is "none" and is where it lands after
   P3, so the cycle also clears. */
export function taskModalSubCyclePriority(forEdit) {
  const order = ["p4", "p1", "p2", "p3"];
  const d = draftFor(forEdit);
  const i = order.indexOf(d.priority || "p4");
  d.priority = order[(i + 1) % order.length];
  repaintSubComposer(forEdit);
}
export function taskModalSubClear() {
  subDraft = { date: "", priority: "", labels: [], projectId: "", projectName: "" };
  if (subPickerFor === "add") { subPicker = null; subPickerFor = null; }
  subPickerQuery = "";
  const el = document.getElementById("taskModalNewSubtask");
  if (el) el.value = "";
  repaintSubComposer(false);
  document.getElementById("taskModalNewSubtask")?.focus();
}
/* Repaints the chip row only, carrying the typed text across by hand.
   Rebuilding the whole sub-task section would replace the input the
   person is typing into, which is the same caret-loss problem
   renderTaskModalSide() exists to avoid one level up.

   `forEdit` picks which of the (possibly two) on-screen composers to
   repaint — the caller always knows this, since it's the same composer
   whose chip was just clicked. It no longer has to be guessed from
   `editingSubId`, which can't tell the two composers apart. */
function repaintSubComposer(forEdit) {
  const editing = forEdit && editingSubId ? currentSub(editingSubId) : null;
  const sel = editing ? ".tm-sub-edit" : ".tm-subtask-add";
  const box = document.querySelector("#taskModalSubtaskSection " + sel);
  if (!box) { renderSubtasks(); return; }
  const inputId = editing ? "taskModalSubEditInput" : "taskModalNewSubtask";
  const typed = document.getElementById(inputId)?.value ?? null;
  const holder = document.createElement("div");
  holder.innerHTML = subComposerHtml(editing ? { ...editing, text: typed ?? editing.text } : null);
  const fresh = holder.firstElementChild;
  if (!fresh) return;
  box.replaceWith(fresh);
  const el = document.getElementById(inputId);
  if (el) { if (typed !== null) el.value = typed; el.focus(); }
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

      ${dateRow(due)}

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
        /* A checkbox list, not a comma-separated text box.

           The old editor was an <input list="…"> over a <datalist>, which
           looks like a picker and is not one: a datalist only suggests
           once you have typed a character, so clicking the field showed
           nothing at all, and it can't indicate which labels are ALREADY
           on the task. Both of the things you want from a label control,
           missing from the control.

           This is the same popover the sub-task chip opens — same rows,
           same checkboxes, same "create it" affordance for a name that
           doesn't exist yet — so labels behave identically wherever they
           are set. */
        taskLabelPickerHtml())}

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

/* Every label in use anywhere, which is what the picker offers back.

   This used to walk TASKS only, and missed the one place the picker
   itself writes: sub-tasks. So creating "to do" on a sub-task worked,
   stored correctly, rendered on the row — and then was gone from the list
   the next time the picker opened, because nothing looked there. The
   picker could create labels but never accumulate them, which made it
   feel broken exactly when it had just been used.

   Sub-tasks are walked in all three stores, not just native ones: a GSI or
   Personal task's sub-tasks are edited through this same panel and can
   carry labels for the same reason. */
function allLabels() {
  const set = new Set();
  const add = t => {
    if (!t) return;
    (Array.isArray(t.labels) ? t.labels : []).forEach(l => set.add(l));
    (Array.isArray(t.subtasks) ? t.subtasks : []).forEach(st =>
      (Array.isArray(st.labels) ? st.labels : []).forEach(l => set.add(l)));
  };
  (state.tasks || []).forEach(add);
  (state.gsi?.projects || []).forEach(p => (p.tasks || []).forEach(add));
  (state.personal?.projects || []).forEach(p => (p.tasks || []).forEach(add));
  /* Labels chosen for a sub-task that has not been submitted yet. Without
     this, picking two labels in a row would drop the first one off the
     list between taps — it exists in the draft but nowhere in state. */
  (subDraft?.labels || []).forEach(l => set.add(l));
  (editDraft?.labels || []).forEach(l => set.add(l));
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
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
export function openTaskModalDatePicker() {
  openDateSheet("tmDueInput");
}
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
  let v2 = v;
  /* A pasted task link becomes a REFERENCE, not a title. Checked before
     anything else, because a URL happens to contain "#" fragments and
     would otherwise be mangled by the project-token pass below. */
  const refId = parseTaskLink(v2);
  const tok = refId ? null : extractProjectToken(v2);
  if (tok) {
    v2 = tok.text;
    subDraft.projectId = tok.project.id;
    subDraft.projectName = tok.project.name;
    if (!v2) { // "#Project" alone sets the chip and waits for a title
      el.value = ""; repaintSubComposer(false); return;
    }
  }
  const st = { id: uid(), text: v2, done: false };
  if (refId) { st.refId = refId; st.text = taskOf(refId)?.task.text || v2; }
  if (subDraft.date) st.date = subDraft.date;
  if (subDraft.priority && subDraft.priority !== "p4") st.priority = subDraft.priority;
  if (subDraft.labels.length) st.labels = [...subDraft.labels];
  if (subDraft.projectId) { st.projectId = subDraft.projectId; st.projectName = subDraft.projectName; }
  subs(f).push(st);
  el.value = "";
  /* The date, priority and labels are KEPT for the next one. Sub-tasks are
     entered in runs and a run usually shares them — the same reasoning as
     the board composer's keepOpen, and the same reason the text is the one
     thing cleared. */
  touch(f); persist(); renderSubtasks();
  document.getElementById("taskModalNewSubtask")?.focus();
}
function currentSub(sid) {
  const f = taskOf(openId); if (!f) return null;
  return subs(f).find(x => x.id === sid) || null;
}
/* Editing opens the same composer the add row uses, in the row's place —
   so a sub-task is edited with the controls it was created with, rather
   than a bare text box that can reach none of its own chips. This is also
   the ONLY way to edit a referenced sub-task: that row renders as a link
   so it can open its target, which leaves it with nothing to type into.
   The pencil is what gives it back. */
export function taskModalSubEditStart(sid, focus) {
  const st = currentSub(sid); if (!st) return;
  editingSubId = sid;
  editDraft = {
    date: st.date || "", priority: st.priority || "",
    labels: Array.isArray(st.labels) ? [...st.labels] : [],
    projectId: st.projectId || "", projectName: st.projectName || ""
  };
  subPicker = null; subPickerFor = null; subPickerQuery = "";
  renderSubtasks();
  setTimeout(() => {
    /* The same shared date sheet the chip inside this composer opens, and
       the same one the task's own due-date row and every board card use.
       This path used to call showPicker() on the input directly, which was
       wrong twice over: it opened the OS spinner the rest of the app was
       deliberately moved off, so one field had two different pickers
       depending on which control you tapped — and the input is now
       visually hidden (opacity:0, pointer-events:none), which some
       Chromium builds refuse to open a picker for at all. It threw inside
       a setTimeout, so the tap did nothing and said nothing.
       openDateSheet bails safely when the input is missing, so no guard. */
    if (focus === "date") openDateSheet("taskModalSubEditDate");
    else document.getElementById("taskModalSubEditInput")?.focus();
  }, 40);
}
export function taskModalSubEditCancel() {
  editingSubId = null; editDraft = null;
  subPicker = null; subPickerFor = null; subPickerQuery = "";
  renderSubtasks();
}
export function taskModalSubEditSave() {
  const f = taskOf(openId);
  const st = editingSubId && currentSub(editingSubId);
  if (!f || !st) { taskModalSubEditCancel(); return; }
  const v = (document.getElementById("taskModalSubEditInput")?.value || "").trim();
  const d = editDraft || blankDraft();
  /* A reference keeps its link; renaming it renames only the label you
     see, never where it points. Clearing the text restores the target's
     own name on the next render rather than leaving a blank row. */
  if (v || !st.refId) st.text = v;
  if (d.date) st.date = d.date; else delete st.date;
  if (d.priority && d.priority !== "p4") st.priority = d.priority; else delete st.priority;
  if (d.labels.length) st.labels = [...d.labels]; else delete st.labels;
  if (d.projectId) { st.projectId = d.projectId; st.projectName = d.projectName; }
  else { delete st.projectId; delete st.projectName; }
  editingSubId = null; editDraft = null;
  subPicker = null; subPickerFor = null; subPickerQuery = "";
  touch(f); persist(); renderSubtasks();
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

/* ============================================================
   TASK LINKS — a task is a place you can point at
   ============================================================
   The modal already puts ?task=<id> in the address bar every time one
   opens, so a durable link to any task has existed all along; there was
   simply no way to get hold of one without reading the URL bar, which on
   a phone is not a thing anyone does.

   Two halves, and they only pay off together:

     Copy link to task  — hands you that URL.
     Paste it back      — anywhere a sub-task is typed, the URL resolves
                          to the task it points at and becomes a live
                          reference to it rather than 90 characters of
                          unreadable query string.

   The reference stores the target's ID, not its title. A title copied at
   paste time would be a snapshot that quietly goes stale the moment the
   other task is renamed; resolving through findAnyTask() on every render
   means the reference always reads as whatever that task is called now,
   and can say so plainly when the target has been deleted.
   ============================================================ */
export function taskLinkFor(id) {
  const url = new URL(location.href);
  url.search = ""; url.hash = "";
  url.searchParams.set("task", id);
  return url.toString();
}
/* Accepts a full link, or a bare id pasted on its own. Deliberately does
   NOT accept any URL with a ?task= — it must be this deployment, or a
   link to somebody else's LifeOS would resolve against your data. */
export function parseTaskLink(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw, location.href);
    if (u.origin !== location.origin) return null;
    const id = u.searchParams.get("task");
    if (id && taskOf(id)) return id;
  } catch (e) { /* not a URL — fall through to the bare-id case */ }
  if (/^[A-Za-z0-9_-]{4,}$/.test(raw) && taskOf(raw)) return raw;
  return null;
}

export function taskModalToggleMenu(evt) {
  evt?.stopPropagation();
  const menu = document.getElementById("taskModalMenu");
  const btn = document.getElementById("taskModalMore");
  if (!menu) return;
  const open = menu.hidden;
  menu.hidden = !open;
  btn?.setAttribute("aria-expanded", String(open));
}
function closeTaskMenu() {
  const menu = document.getElementById("taskModalMenu");
  if (menu && !menu.hidden) { menu.hidden = true; document.getElementById("taskModalMore")?.setAttribute("aria-expanded", "false"); }
}
document.addEventListener("click", (e) => {
  if (e.target.closest?.("#taskModalMenu") || e.target.closest?.("#taskModalMore")) return;
  closeTaskMenu();
}, true);

export async function taskModalCopyLink() {
  closeTaskMenu();
  if (!openId) return;
  const link = taskLinkFor(openId);
  /* navigator.clipboard needs a secure context and is absent in a few
     Android WebViews, so the textarea fallback stays — a copy action that
     silently does nothing is worse than an old API. */
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(link);
    else {
      const ta = document.createElement("textarea");
      ta.value = link; ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove();
    }
    toast("Link copied — paste it into any sub-task");
  } catch (e) { toast("Couldn't copy the link"); }
}

export function taskModalDuplicate() {
  closeTaskMenu();
  const f = openId && taskOf(openId);
  if (!f) return;
  if (f.isGsi || f.isPersonal) { toast("Duplicate works on Overview tasks for now"); return; }
  const copy = JSON.parse(JSON.stringify(f.task));
  copy.id = uid();
  copy.text = (copy.text || "Task") + " (copy)";
  copy.done = false; copy.completedAt = null; copy.archived = false;
  copy.googleEventId = null;
  copy.position = (f.task.position ?? 0) + 1;   // lands directly after its original
  (copy.subtasks || []).forEach(st => { st.id = uid(); st.done = false; });
  state.tasks.push(copy);
  persist(); rerender();
  toast("Task duplicated", "Open it", `openTaskModal('${copy.id}')`);
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

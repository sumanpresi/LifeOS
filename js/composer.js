/* ============================================================
   Inline board composer
   ============================================================
   One "+ Add task" experience for every board.

   Before this there were two, and neither was good. The Personal board
   opened a native prompt() — a browser dialog that can hold exactly one
   line of text, can't offer a due date, a link or a priority, and looks
   like a security warning. The GSI board avoided the prompt by aiming the
   composer at the bottom of the card, which meant clicking "+ Add task"
   in a column scrolled you away from the column you were looking at.

   This opens the composer where you clicked: inside the column, in place
   of the button. The column is already the answer to "which status", so
   the composer only has to ask for the things it can't infer.

   It is deliberately NOT a modal. A modal would cover the board you are
   adding to, and adding several tasks in a row — the common case when
   planning — would mean opening and dismissing it each time. This stays
   open after each add so you can keep typing.
   ============================================================ */

import { state, uid, esc, persist, rerender, todayKey } from './state.js';

/* Which column, on which board, currently has the composer open.
   Null means closed. Kept here rather than in state: it is transient UI,
   must never sync, and must never mark the document dirty. */
let openAt = null;      // { board: "gsi" | "personal", status: "todo" | ... }
let draft = { text: "", date: "", link: "", flag: false };

export function isComposerOpen(board, status) {
  return !!openAt && openAt.board === board && openAt.status === status;
}

export function openComposer(board, status) {
  openAt = { board, status };
  draft = { text: "", date: "", link: "", flag: false };
  rerender();
  // After the re-render paints, put the cursor in the new field.
  requestAnimationFrame(() => {
    const el = document.getElementById("composerText");
    if (el) { el.focus(); el.scrollIntoView({ block: "nearest" }); }
  });
}

export function closeComposer() {
  openAt = null;
  rerender();
}

/* Read the live field values before acting. The inputs are uncontrolled
   between renders — re-rendering on every keystroke would lose the
   caret — so the draft is only synced at the moments that matter. */
function syncDraft() {
  const t = document.getElementById("composerText");
  const d = document.getElementById("composerDate");
  const l = document.getElementById("composerLink");
  if (t) draft.text = t.value;
  if (d) draft.date = d.value;
  if (l) draft.link = l.value;
}

export function composerToggleFlag() {
  syncDraft();
  draft.flag = !draft.flag;
  rerender();
  requestAnimationFrame(() => document.getElementById("composerText")?.focus());
}

export function composerSetQuickDate(which) {
  syncDraft();
  const d = new Date();
  if (which === "tomorrow") d.setDate(d.getDate() + 1);
  if (which === "nextweek") d.setDate(d.getDate() + 7);
  const next = todayKey(d);
  // Tapping the chip that's already set clears it, so the same control
  // both sets and unsets rather than needing a separate "no date".
  draft.date = (draft.date === next) ? "" : next;
  rerender();
  requestAnimationFrame(() => document.getElementById("composerText")?.focus());
}

/* The native date picker writes straight into the field; this just keeps
   the draft and the chip label in step. */
export function composerDateChanged() {
  syncDraft();
  rerender();
  requestAnimationFrame(() => document.getElementById("composerText")?.focus());
}

/* `keepOpen` distinguishes Enter (add another) from the Add button
   (add and close). Both are useful; conflating them is what makes bulk
   entry tedious. */
export function composerSubmit(keepOpen) {
  syncDraft();
  const text = (draft.text || "").trim();
  if (!text) return;
  const { board, status } = openAt || {};
  if (!board) return;

  const task = {
    id: uid(), text, status,
    date: draft.date || "",
    link: (draft.link || "").trim(),
    flag: !!draft.flag,
    googleEventId: null
  };

  if (board === "personal") {
    const p = (state.personal?.projects || []).find(x => x.id === state.personal.activeProject);
    if (!p) return;
    (p.tasks = p.tasks || []).push(task);
  } else {
    const p = (state.gsi?.projects || []).find(x => x.id === state.gsi.activeProject);
    if (!p) return;
    (p.tasks = p.tasks || []).push(task);
  }

  if (keepOpen) {
    // Keep the date and priority — consecutive tasks usually share them —
    // but clear the text and link, which never repeat.
    draft.text = ""; draft.link = "";
  } else {
    openAt = null;
  }
  persist(); rerender();
  if (keepOpen) requestAnimationFrame(() => document.getElementById("composerText")?.focus());
}

export function composerKey(evt) {
  if (evt.key === "Escape") { evt.preventDefault(); closeComposer(); return; }
  // Enter submits, Shift+Enter makes a new line — the convention people
  // already expect from every other task tool.
  if (evt.key === "Enter" && !evt.shiftKey) { evt.preventDefault(); composerSubmit(true); }
}

/* ---------- markup ---------- */

const DATE_CHIPS = [
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "nextweek", label: "Next week" }
];

function prettyDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${+d} ${MON[+m - 1]}`;
}

export function composerHtml(board, status) {
  const projName = board === "personal"
    ? ((state.personal?.projects || []).find(p => p.id === state.personal.activeProject)?.name || "Personal")
    : ((state.gsi?.projects || []).find(p => p.id === state.gsi.activeProject)?.name || "Project");

  return `
    <div class="composer" onclick="event.stopPropagation()">
      <textarea id="composerText" class="composer-text" rows="2"
        placeholder="Task name"
        onkeydown="composerKey(event)">${esc(draft.text)}</textarea>

      <div class="composer-chips">
        <span class="composer-project" title="Adding to ${esc(projName)}">#&nbsp;${esc(projName)}</span>
        ${DATE_CHIPS.map(c => `
          <button class="composer-chip" onclick="composerSetQuickDate('${c.key}')">${c.label}</button>`).join("")}
        <label class="composer-chip composer-chip-date" title="Pick a due date">
          🗓 <input type="date" id="composerDate" value="${esc(draft.date)}"
            onchange="composerDateChanged()">
          ${draft.date ? `<b>${prettyDate(draft.date)}</b>` : ""}
        </label>
        <button class="composer-chip ${draft.flag ? "on" : ""}" onclick="composerToggleFlag()"
          aria-pressed="${draft.flag}" title="Mark high priority">🚩 Priority</button>
      </div>

      <input type="url" id="composerLink" class="composer-link" placeholder="Link (optional)"
        value="${esc(draft.link)}" onkeydown="composerKey(event)">

      <div class="composer-actions">
        <span class="composer-hint">Enter to add another · Esc to close</span>
        <button class="btn btn-ghost" onclick="closeComposer()">Cancel</button>
        <button class="btn btn-primary" onclick="composerSubmit(false)">Add task</button>
      </div>
    </div>`;
}

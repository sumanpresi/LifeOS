/* Eisenhower matrix — My Day.

   A VIEW, not a store. Every task shown here is the same object that lives
   in state.gsi.projects, state.personal.projects or state.tasks; the only
   thing this feature adds to the data model is one string field on a task:

       t.eis = "do" | "schedule" | "delegate" | "eliminate"

   Nothing is copied, no task exists twice, and moving a card writes that
   one field, stamps the task's own updatedAt via the existing touch(),
   and calls the existing persist() — exactly the pattern every other
   field edit in the app follows, which is what lets the sync layer's
   item-level merge (compares each task's own updatedAt) see an
   Eisenhower move as a genuine edit rather than a silent one that could
   lose to a stale copy of the same task. The sync layer itself is
   untouched: no query, no subscription, no timer, no fetch. A quadrant
   change rides to the cloud on exactly the same debounced save as
   renaming a task.

   Cards are the app's OWN card renderers, imported rather than reimplemented
   — gsiCardHtml for Work·GSI, pwCardHtml for Personal Workspace,
   boardCardHtml for loose tasks — so every control, date picker, flag,
   status select and link on a card keeps working inside the matrix. */
import { state, esc, persist, rerender, uid, touch } from './state.js?v=202609271345';
import { gsiCardHtml, addProjectTaskRaw } from './gsi.js?v=202609271345';
import { pwCardHtml, addPwProjectTaskRaw } from './personal.js?v=202609271345';
import { boardCardHtml, findAnyTask, createNativeTask, openTaskCardDetail, markDragJustEnded } from './tasks.js?v=202609271345';
import { toast, autoGrow } from './ui.js?v=202609271345';

/* Display labels only — the stored value on each task (t.eis) keeps its
   original key ("do" / "schedule" / "delegate" / "eliminate") so nothing
   already saved needs to change; only the title shown on screen moves to
   the "Decide" / "Delete" wording, with the classic Eisenhower verb as a
   subtitle under it. */
const QUADRANTS = [
  { key: "do",        n: "Q1", title: "Do first", action: "Do it now",     urgency: "Urgent",     importance: "Important"     },
  { key: "schedule",  n: "Q2", title: "Decide",   action: "Schedule it",   urgency: "Not urgent", importance: "Important"     },
  { key: "delegate",  n: "Q3", title: "Delegate", action: "Delegate it",   urgency: "Urgent",     importance: "Not important" },
  { key: "eliminate", n: "Q4", title: "Delete",   action: "Eliminate it",  urgency: "Not urgent", importance: "Not important" }
];
const QUAD_KEYS = QUADRANTS.map(q => q.key);

/* Seeded from the last tab this device had open, so closing and reopening
   the app (or just reloading the page) comes back to the same project —
   state.eisActiveProject is read from localStorage before this module
   body runs (state.js's own top-level `state = load()` resolves first,
   since this module imports it). A malformed or now-nonexistent value is
   harmless: the "project deleted" guard in renderEisenhower() already
   falls back to "all" the first time it renders.

   Deliberately NOT kept in sync with a later cloud pull (no
   onStateReplaced hook, unlike navOrder below) — which tab is open right
   now is this device's own business while the matrix is actually on
   screen, same rule googleLinks.activeGroup and the notebook's active
   section already follow in this app; only the tab order is the kind of
   change that should visibly jump to match another device. */
let activeProject = (state && typeof state.eisActiveProject === "string")
  ? state.eisActiveProject : "all";      // "all" | "none" | "gsi:<id>" | "pw:<id>"
let dupWarningSignature = "";   // last duplicate-name set the notice was shown for
let sortables = [];
let tabSortable = null;         // Sortable instance on the draggable project-tab strip
let lastRenderedProject = null; // which tab the current DOM was painted for (scroll restore)

/* ---- inline "add task" composer ----

   One composer at a time, addressed by quadrant. The draft text lives here
   rather than only in the DOM because a sync pull can repaint the matrix
   mid-sentence — the input would be rebuilt and half a typed task would be
   gone. Keeping it in module state means a repaint restores exactly what
   was typed. */
let composerQuadrant = null;   // quadrant key whose composer is open, or null
let composerDraft = "";
let composerProject = "";      // only consulted while "All projects" is active
let focusComposerNext = false; // focus on open, NOT on every repaint
let flashTaskId = null;        // the card to play the arrival animation on, once

const reducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- which tasks, and from where ----------

   Projects are identified by SECTION + ID, never by name. Personal
   "Travel" and Work·GSI "Travel" are different projects that happen to
   share a label, and collapsing them would silently merge two people's
   worth of work. The id is the identity; the name is display text. */
function projectList() {
  const out = [];
  (state.gsi && state.gsi.projects || []).forEach(p =>
    out.push({ key: "gsi:" + p.id, id: p.id, name: p.name, section: "Work · GSI", kind: "gsi" }));
  (state.personal && state.personal.projects || []).forEach(p =>
    out.push({ key: "pw:" + p.id, id: p.id, name: p.name, section: "Personal", kind: "pw" }));
  return out;
}

/* A name that appears in more than one section. Returned as a Set of
   lowercased names so the tab labels can disambiguate only the ones that
   actually clash — labelling every tab with its section would be noise. */
function duplicateNames(list) {
  const bySection = new Map();
  list.forEach(p => {
    const k = (p.name || "").trim().toLowerCase();
    if (!k) return;
    if (!bySection.has(k)) bySection.set(k, new Set());
    bySection.get(k).add(p.kind);
  });
  const dup = new Set();
  bySection.forEach((kinds, name) => { if (kinds.size > 1) dup.add(name); });
  return dup;
}

/* Every task the matrix can show, normalised only enough to know which
   renderer draws it and which project it belongs to. The task object
   itself is carried through untouched. */
function allTasks() {
  const out = [];
  (state.gsi && state.gsi.projects || []).forEach(p =>
    (p.tasks || []).forEach(t => out.push({ t, kind: "gsi", projectKey: "gsi:" + p.id, projectName: p.name })));
  (state.personal && state.personal.projects || []).forEach(p =>
    (p.tasks || []).forEach(t => out.push({ t, kind: "pw", projectKey: "pw:" + p.id, projectName: p.name })));
  /* Tasks with no project are not hidden — they get their own tab, so
     nothing silently disappears from view just because it was never
     filed. */
  (state.tasks || []).forEach(t => out.push({ t, kind: "loose", projectKey: "none", projectName: "" }));
  return out;
}

/* ---------- the quadrant of a task ----------

   Stored in t.eis once the person has placed it. Until then it is DERIVED
   from signals the app already has, rather than dumped in an "unsorted"
   pile the person has to empty by hand before the matrix is any use:

     important = the flag they already set (the app's own word for it)
     urgent    = due today or overdue

   So a matrix is useful the first time it is opened, and any card the
   person drags stops being derived and stays where they put it. */
function quadrantOf(entry) {
  const t = entry.t;
  if (t.eis && QUAD_KEYS.includes(t.eis)) return t.eis;
  const due = t.date || t.dueDate || "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const urgent = !!due && new Date(due + "T00:00:00") <= today;
  const important = !!t.flag;
  if (urgent && important) return "do";
  if (!urgent && important) return "schedule";
  if (urgent && !important) return "delegate";
  return "eliminate";
}

function isDone(t) { return t.status === "done" || t.done === true; }

/* ---------- moving a task ----------
   Two writes now, not one: t.eis (which quadrant) and t.eisOrder (where
   inside it) — the same app-wide persist() every other edit in LifeOS
   makes, which is what carries either through the existing save queue,
   reconciliation and offline handling without any of them knowing this
   feature exists.

   eisOrder exists because a quadrant is not one project's task list — it's
   an interleaving of tasks from Work·GSI, Personal and loose tasks, each
   living in its OWN array with its OWN existing position field, and those
   three positions have nothing to do with each other. There is no single
   underlying array whose element order the matrix could reuse to mean
   "where in this quadrant", so a quadrant-scoped order needs a
   quadrant-scoped field — one plain number per task, read only by
   quadrantOf()'s sibling sort in renderEisenhower(), meaningless anywhere
   else in the app.

   touch() matters here as much as the field writes themselves: the sync
   layer resolves item-level conflicts by comparing each task's own
   updatedAt, the same way every other field edit in gsi.js/personal.js/
   tasks.js does (t[field] = v; touch(t); persist()). Setting eis/eisOrder
   without touching the task would make a real edit invisible to that
   reconciliation — it could lose to a stale copy of the same task instead
   of being recognised as the newer change. */

/* The one ordering rule, used everywhere something needs "the quadrant's
   current order": a task with a real eisOrder sorts by it; a task that has
   never been dragged (no eisOrder yet) sorts after every task that has one,
   and keeps its original relative position against other never-dragged
   tasks (stable sort, comparator returns 0 for that pair) — the same
   fallback the matrix has always used for a task nobody has touched. */
function compareEisOrder(ta, tb) {
  const ao = ta.eisOrder, bo = tb.eisOrder;
  const aHas = typeof ao === "number", bHas = typeof bo === "number";
  if (aHas && bHas) return ao - bo;
  if (aHas) return -1;
  if (bHas) return 1;
  return 0;
}

/* One past the last position in a quadrant — "the end of the list" — for
   a task arriving by any route that isn't a drag (the Move menu, a
   keyboard move, a freshly composed task), so it lands after everything
   already there instead of colliding with, or sorting ahead of, whatever's
   already at position 0. excludeId keeps a task already IN that quadrant
   from counting itself while it's being recomputed. This deliberately
   looks at EVERY task in the quadrant, not just the ones the active
   project filter is currently showing — same reason reindex above does
   the same.

   Why "last position" isn't simply "the highest existing eisOrder, plus
   one": compareEisOrder ranks ANY numbered task ahead of an unnumbered
   (legacy) one, regardless of the number — that's the rule that keeps a
   never-dragged task from jumping around as other tasks get dragged past
   it, and it's deliberately being kept. But it means the old max+1 here
   quietly broke on a quadrant that still had legacy tasks with no
   eisOrder at all: with no numbered task yet, max was -1, so the first
   arrival got 0 — a NUMBER, which compareEisOrder then placed ahead of
   every legacy task instead of after them, however large the number.  No
   number handed to the new task could ever land it past an unnumbered
   one; the legacy tasks themselves had to be given numbers first.

   So this backfills: it sorts the quadrant's current members with the
   very same compareEisOrder used everywhere else (which, with no filter
   involved here, reproduces today's on-screen order exactly — numbered
   tasks by value, then legacy tasks in their existing relative order) and
   assigns each one its position, 0..N-1 — a task whose number doesn't
   change from this isn't touch()'d, so on a quadrant that's fully numbered
   already this is a no-op walk, not a rewrite. Only after every existing
   task has a real position does "one past the end" (N) mean what it's
   supposed to. */
function nextEisOrder(quadrant, excludeId) {
  const members = allTasks()
    .filter(e => !isDone(e.t) && e.t.id !== excludeId && quadrantOf(e) === quadrant)
    .map(e => e.t)
    .sort(compareEisOrder);
  members.forEach((t, i) => {
    if (t.eisOrder !== i) { t.eisOrder = i; touch(t); }
  });
  return members.length;
}

/* Renumbers a quadrant to match the order its cards currently sit in the
   DOM — called right after Sortable has already moved the dragged element
   into its dropped position, so the DOM *is* the intended order for
   whatever is actually on screen. The catch: with a project filter active,
   what's on screen is only SOME of the quadrant. Renumbering just those
   visible cards 0..n-1 would collide with the eisOrder values still held
   by every task the filter is hiding — two tasks (one shown, one hidden)
   ending up claiming the same position, which is the bug this replaces.

   incomingId matters here, and has to be told apart from an ordinary
   same-quadrant reorder rather than treated the same way. For a
   same-quadrant reorder, the dragged task's existing eisOrder already
   means something IN THIS quadrant — it's exactly as meaningful as every
   other resident's, so sorting it in with everyone else by that number
   (the block below this comment) is correct and is deliberately left
   exactly as it originally was, filtered-reorder behaviour included.

   A CROSS-quadrant arrival is different: whatever eisOrder it's carrying
   is a leftover number from the quadrant it just LEFT — meaningful there,
   not here. Sorting it into this quadrant's existing order by that number
   let it land anywhere among the other visible and hidden tasks depending
   on what that leftover number happened to be, which could silently shift
   a hidden resident to one side of it or the other for no reason visible
   on screen — the same visible drop producing a different result for a
   task nobody touched, purely because of a number from a different
   quadrant. commitEisDrop only passes incomingId when it detected exactly
   this case (the task's quadrant actually changed), so that branch below
   pulls it out of the ordering question entirely until the very last step:
     1. `residents` — every OTHER task already in this quadrant, filter or
        no filter, sorted by the quadrant's existing order. Because the
        incoming task is excluded here, its old number cannot influence
        where any resident (visible or hidden) sits relative to any other
        resident — that pattern is fixed by the residents alone, exactly
        as if this drag had never happened.
     2. The other visible residents' new relative order (domIds with the
        incoming task removed) is spliced into residents' visible slots,
        one for one, same as always — hidden residents keep the slot they
        already had.
     3. Only then is the incoming task placed, purely from where the
        settled DOM put it: right after whichever visible task the drop
        landed it behind (or at the very front, if the drop put it first)
        — never by number, by position. */
function reindexEisQuadrantFromDom(bodyEl, quadrant, incomingId) {
  if (!bodyEl || !quadrant) return;
  const domIds = [...bodyEl.querySelectorAll(":scope > .eis-item[data-task-id]")]
    .map(el => el.dataset.taskId);
  const domSet = new Set(domIds);

  const members = allTasks()
    .filter(e => !isDone(e.t) && quadrantOf(e) === quadrant)
    .map(e => e.t);
  const byId = new Map(members.map(t => [t.id, t]));

  let result;
  if (!incomingId) {
    // Same-quadrant reorder: sort the whole membership by its existing
    // order (the dragged task included — its number is valid here) and
    // splice in the new visible order exactly as always.
    const existingOrder = members.slice().sort(compareEisOrder);
    let domIdx = 0;
    result = existingOrder.map(t => {
      if (!domSet.has(t.id)) return t;
      const substitute = byId.get(domIds[domIdx]);
      domIdx++;
      return substitute || t;
    });
  } else {
    // Cross-quadrant arrival: keep the incoming task's leftover number out
    // of the resident ordering entirely, then place it purely by its DOM
    // position, as described above.
    const residents = members.filter(t => t.id !== incomingId).sort(compareEisOrder);
    const otherVisibleIds = domIds.filter(id => id !== incomingId);
    let domIdx = 0;
    const withoutIncoming = residents.map(t => {
      if (!domSet.has(t.id)) return t;
      const substitute = byId.get(otherVisibleIds[domIdx]);
      domIdx++;
      return substitute || t;
    });
    const incoming = byId.get(incomingId);
    result = withoutIncoming;
    if (incoming) {
      const dropIdx = domIds.indexOf(incomingId);
      const beforeId = dropIdx > 0 ? domIds[dropIdx - 1] : null;
      const insertAt = beforeId ? withoutIncoming.findIndex(t => t.id === beforeId) + 1 : 0;
      result = withoutIncoming.slice();
      result.splice(insertAt, 0, incoming);
    }
  }

  result.forEach((t, i) => {
    if (t.eisOrder !== i) { t.eisOrder = i; touch(t); }
  });
}

export function setTaskQuadrant(id, quadrant) {
  if (!QUAD_KEYS.includes(quadrant)) return;
  const found = findAnyTask(id);
  if (!found || !found.task) return;
  if (found.task.eis === quadrant) return;
  found.task.eis = quadrant;
  found.task.eisOrder = nextEisOrder(quadrant, id);
  touch(found.task);
  persist();
  /* Only this card repaints. A full rerender() here would rebuild every
     board, list and chart in the app for a one-field change. */
  renderEisenhower();
}

/* ---- the drag route ----
   The Move-menu/keyboard route above always means "send this task to the
   END of quadrant X" — there's no dropped position to honour. A drag has
   one: Sortable has already moved evt.item into its dropped slot in
   evt.to's DOM by the time onEnd fires, so the DOM order at THIS moment is
   the order the person just chose, for a same-quadrant reorder exactly as
   much as for a move to a different quadrant. Reading that back and
   writing it down is the whole fix — nothing here needs to distinguish
   "reordered in place" from "moved to another quadrant"; both are just
   "here is this quadrant's list now". */
function commitEisDrop(id, toBody) {
  const quadrant = toBody && toBody.dataset.quadrant;
  const found = findAnyTask(id);
  if (!id || !quadrant || !found || !found.task) { setTimeout(renderEisenhower, 0); return; }
  const crossQuadrant = found.task.eis !== quadrant;
  if (crossQuadrant) { found.task.eis = quadrant; touch(found.task); }
  /* Only pass the dragged task's id as "incoming" when it genuinely just
     arrived from a different quadrant — that's the one case whose old
     eisOrder is foreign to this quadrant and must be kept out of the
     ordering question (see reindexEisQuadrantFromDom). For a same-quadrant
     reorder, passing null keeps the original, already-correct behaviour:
     the dragged task's existing number is sorted in with everyone else's,
     exactly as it always was. */
  reindexEisQuadrantFromDom(toBody, quadrant, crossQuadrant ? id : null);
  persist();
  /* Full repaint, not a single card: a cross-quadrant move can renumber
     several siblings in the destination (everything after the drop point),
     and a same-quadrant reorder renumbers the whole list — all of which
     need their new order reflected, not just the dragged card.

     But NOT synchronously. This runs inside Sortable's own onEnd, and
     renderEisenhower() → wireDragAndDrop() destroys every Sortable
     instance — including the one whose _onDrop is still on the stack and
     has yet to run its save() and _nulling(). Destroying an instance from
     inside its own drop handler is the re-entrancy js/drag-cleanup.js
     documents. The data is already written above and the DOM already
     shows the drop (Sortable put the card there), so nothing is lost by
     painting one tick later, after Sortable has fully let go. */
  setTimeout(renderEisenhower, 0);
}

/* ---- the composer ----

   A task added here is created through the app's OWN add helpers —
   addProjectTaskRaw, addPwProjectTaskRaw, createNativeTask — so it is
   shaped, positioned, persisted and synced exactly like a task added from
   the board. The matrix contributes one extra field, `eis`, which is the
   quadrant it was dropped into. No new storage, no new network call. */
export function openEisComposer(quadrant) {
  if (!QUAD_KEYS.includes(quadrant)) return;
  composerQuadrant = quadrant;
  composerDraft = "";
  focusComposerNext = true;
  renderEisenhower();
}
export function closeEisComposer() {
  composerQuadrant = null;
  composerDraft = "";
  renderEisenhower();
}
export function onEisComposerInput(v) { composerDraft = v; }   // no repaint per keystroke
export function onEisComposerProject(v) { composerProject = v; }

export function onEisComposerKey(evt, quadrant) {
  if (evt.key === "Enter" && !evt.shiftKey) { evt.preventDefault(); submitEisComposer(quadrant); }
  else if (evt.key === "Escape") { evt.preventDefault(); closeEisComposer(); }
}

/* Which project a new task belongs to. With a project tab selected the
   answer is that tab; on "All projects" the composer shows a picker,
   because guessing would file work somewhere the person never chose. */
function composerTargetKey() {
  if (activeProject !== "all") return activeProject;
  if (composerProject) return composerProject;
  const first = projectList()[0];
  return first ? first.key : "none";
}

export function submitEisComposer(quadrant) {
  const text = (composerDraft || "").trim();
  if (!text) return;
  const el = document.querySelector(".eis-composer");
  /* Let the exit animation play, THEN commit. The commit re-renders the
     whole matrix, which would otherwise delete the element mid-animation
     and make the composer vanish rather than close. */
  if (el && !reducedMotion()) {
    el.classList.add("is-committing");
    setTimeout(() => commitEisTask(quadrant, text), 190);
  } else {
    commitEisTask(quadrant, text);
  }
}

function commitEisTask(quadrant, text) {
  const key = composerTargetKey();
  composerQuadrant = null;
  composerDraft = "";

  if (key === "none") {
    /* createNativeTask builds the loose-task shape (category, position,
       googleEventId) and pushes it; it deliberately does not persist, so
       the quadrant can be set on the same object first. */
    const t = createNativeTask(text, "");
    t.eis = quadrant;
    t.eisOrder = nextEisOrder(quadrant, t.id);   // lands at the bottom of the quadrant, not wherever it falls naturally
    flashTaskId = t.id;
    persist();
    /* The two project helpers re-render themselves; this path does not, so
       it calls the app's own rerender — the same one every other edit uses
       — rather than repainting the matrix alone and leaving the rest of
       the app showing a task count that is one out of date. */
    rerender();
    return;
  }

  const task = {
    id: uid(), text, status: "todo", date: "", link: "",
    flag: false, googleEventId: null, eis: quadrant,
    eisOrder: nextEisOrder(quadrant)   // not yet pushed anywhere, so nothing to exclude by id
  };
  flashTaskId = task.id;
  /* Both helpers persist and re-render themselves — same call the board's
     own add makes. If the project has since been deleted the helper
     returns false and nothing is written. */
  const ok = key.startsWith("pw:")
    ? addPwProjectTaskRaw(key.slice(3), task)
    : addProjectTaskRaw(key.slice(4), task);
  if (!ok) {
    flashTaskId = null;
    toast("That project no longer exists — task not added");
    renderEisenhower();
  }
}

/* ---- opening a task ----

   Every other surface opens the detail modal by clicking the card. The
   matrix could not, because it renders the LIST card templates
   (gsiCardHtml / pwCardHtml) and only the BOARD templates carry that
   handler. Rather than add it to shared renderers used by pages this
   feature has nothing to do with, the matrix puts it on its own wrapper
   and routes to the same openTaskCardDetail every other surface calls. */
export function onEisCardClick(evt, id) {
  /* The card is full of its own controls. A click that landed on one of
     them has already done its job — opening the modal on top of it would
     mean ticking a checkbox or changing a status also opened a dialogue.
     .gsi-title (the textarea) isn't listed: it's now read-only and
     pointer-events:none in the matrix (see renderEisenhower and
     eisenhower.css), so a tap on it never actually reaches it as
     evt.target — it falls straight through to the card, same as a tap
     anywhere else non-interactive, and opens the task like this function
     already does for everything else. */
  if (evt.target.closest("button, input, select, a, label, .eis-move, .gsi-chk, .t-chk")) return;
  /* A task with no project renders through boardCardHtml, which already
     carries its own onclick. Without this the click would bubble up here
     and open the modal a second time. */
  if (evt.target.closest(".t-board-card")) return;
  if (evt.key) evt.preventDefault();          // Space would scroll the page
  openTaskCardDetail(id);
}

export function setEisProject(key) {
  activeProject = key;
  /* persist(false): a tab click is UI state, not an edit — see the
     eisActiveProject comment in state.js. persist(true)'s default would
     bump state.updatedAt, and the very next sync tie-break anywhere in
     the app could then let this device's copy win purely because someone
     switched tabs a moment ago, at the cost of a genuine edit made
     meanwhile on another device. setTaskView() follows the identical
     pattern for the board/list toggle. */
  state.eisActiveProject = key;
  persist(false);
  renderEisenhower();
}

/* Accessible, non-drag route between quadrants — keyboard, screen reader,
   and anyone on a phone who would rather tap than long-press. */
export function moveEisTask(id, quadrant) {
  setTaskQuadrant(id, quadrant);
  const q = QUADRANTS.find(x => x.key === quadrant);
  if (q) toast("Moved to " + q.title);
}

/* ---------- render ---------- */
function cardFor(entry) {
  if (entry.kind === "gsi") return gsiCardHtml(entry.t);
  if (entry.kind === "pw")  return pwCardHtml(entry.t);
  return boardCardHtml(Object.assign({}, entry.t, { isGsi: false }));
}

/* User-chosen order of the reorderable project tabs — "All projects" and
   "No project" are fixed anchors (same idea as Overview/Today/Trash
   staying put in the sidebar; see nav-order.js) and never move, so they
   are not part of this list. Unknown keys — a project the saved order
   predates — keep their natural projectList() order, appended after the
   known ones, same rule applyNavOrder() uses: a new project appears at
   the end instead of jumping to some random position. */
function applyEisTabOrder(list) {
  const saved = Array.isArray(state.eisTabOrder) ? state.eisTabOrder : null;
  if (!saved || !saved.length) return list;
  const byKey = new Map(list.map(p => [p.key, p]));
  const seen = new Set();
  const out = [];
  saved.forEach(key => {
    const p = byKey.get(key);
    if (p && !seen.has(key)) { out.push(p); seen.add(key); }
  });
  list.forEach(p => { if (!seen.has(p.key)) out.push(p); });
  return out;
}

function tabsHtml(list, dup) {
  const tab = (key, label, sub) => `
    <button class="eis-tab ${activeProject === key ? "on" : ""}" role="tab"
            aria-selected="${activeProject === key}"
            onclick="setEisProject('${key}')">${esc(label)}${sub ? `<span class="eis-tab-sub">${esc(sub)}</span>` : ""}</button>`;
  /* Same as `tab` above plus data-key, which is what readTabOrder() below
     reads back off the DOM after a drag — and what marks a button as one
     Sortable is allowed to pick up (see wireTabDragAndDrop's `draggable`
     selector), so "All projects" and "No project" — built with the plain
     `tab` helper, no data-key — are structurally excluded rather than
     merely styled to look fixed. */
  const projectTab = p => `
    <button class="eis-tab ${activeProject === p.key ? "on" : ""}" role="tab"
            aria-selected="${activeProject === p.key}" data-key="${esc(p.key)}"
            onclick="setEisProject('${p.key}')">${esc(p.name)}${
      dup.has((p.name || "").trim().toLowerCase()) ? `<span class="eis-tab-sub">${esc(p.section)}</span>` : ""
    }</button>`;
  const looseCount = (state.tasks || []).length;
  const ordered = applyEisTabOrder(list);
  return `
    <div class="eis-tabs" role="tablist" aria-label="Filter the matrix by project">
      ${tab("all", "All projects")}
      <div class="eis-tabs-drag" id="eisTabsDrag" role="presentation">${ordered.map(projectTab).join("")}</div>
      ${looseCount ? tab("none", "No project") : ""}
    </div>`;
}

/* The composer sits at the TOP of the quadrant body rather than in a
   footer under it. A footer would cost every quadrant ~34px of permanent
   height — 68px of matrix — for a control that is idle almost all of the
   time, and that height is exactly what the fourth task card needs. Here
   it costs nothing until it is opened. */
function composerHtml(q) {
  const needsPicker = activeProject === "all";
  const target = composerTargetKey();
  const projects = projectList();
  return `
    <div class="eis-composer" data-quadrant="${q.key}">
      <div class="eis-composer-glow" aria-hidden="true"></div>
      <input type="text" class="eis-composer-input" id="eisComposerInput"
             placeholder="Add a task to ${esc(q.title)}…"
             aria-label="New task in ${esc(q.title)}"
             value="${esc(composerDraft)}"
             oninput="onEisComposerInput(this.value)"
             onkeydown="onEisComposerKey(event,'${q.key}')">
      <div class="eis-composer-row">
        ${needsPicker ? `
          <select class="eis-composer-proj" aria-label="Project for the new task"
                  onchange="onEisComposerProject(this.value)">
            ${projects.map(p => `<option value="${esc(p.key)}" ${p.key === target ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
            <option value="none" ${target === "none" ? "selected" : ""}>No project</option>
          </select>` : ""}
        <span class="eis-composer-spacer"></span>
        <button type="button" class="eis-composer-cancel" onclick="closeEisComposer()">Cancel</button>
        <button type="button" class="eis-composer-add" onclick="submitEisComposer('${q.key}')">Add</button>
      </div>
    </div>`;
}

function quadrantHtml(q, entries) {
  /* Trigger only. The menu itself is built on demand and attached to
     <body> — see toggleEisMove. It used to live here, absolutely
     positioned inside the card, and .eis-q-body is overflow-y:auto: the
     scroller clipped it, so a menu of three destinations showed as one. */
  const menu = id => `
    <div class="eis-move">
      <button class="eis-move-btn" type="button" aria-haspopup="menu" aria-expanded="false"
              aria-label="Move this task to another quadrant"
              onclick="toggleEisMove(this,'${id}','${q.key}')">Move ▾</button>
    </div>`;
  return `
    <section class="eis-q eis-${q.key}" data-quadrant="${q.key}" aria-label="${esc(q.n + " " + q.title)}">
      <header class="eis-q-head">
        <span class="eis-q-n">${q.n}</span>
        <span class="eis-q-title">${esc(q.title)}</span>
        <span class="eis-q-meta">${esc(q.urgency)} + ${esc(q.importance)} · ${esc(q.action)}</span>
        <button class="eis-add-btn" type="button" aria-label="Add a task to ${esc(q.title)}"
                title="Add a task to ${esc(q.title)}" onclick="openEisComposer('${q.key}')">+</button>
        <span class="eis-q-count">${entries.length}</span>
      </header>
      <div class="eis-q-body" data-quadrant="${q.key}">
        ${composerQuadrant === q.key ? composerHtml(q) : ""}
        ${entries.map(e => `
          <div class="eis-item${e.t.id === flashTaskId ? " eis-just-added" : ""}" data-task-id="${e.t.id}">
            <div class="eis-item-card" role="button" tabindex="0"
                 onclick="onEisCardClick(event,'${e.t.id}')"
                 onkeydown="if(event.key==='Enter'||event.key===' '){onEisCardClick(event,'${e.t.id}')}">
              ${cardFor(e)}
              ${menu(e.t.id)}
            </div>
            <span class="eis-drag-handle" aria-hidden="true">⠿⠿</span>
          </div>`).join("")}
        <p class="eis-empty">Drop tasks here</p>
      </div>
    </section>`;
}

export function renderEisenhower() {
  const host = document.getElementById("eisenhower");
  if (!host) return;

  const list = projectList();
  const dup = duplicateNames(list);
  if (activeProject !== "all" && activeProject !== "none" &&
      !list.some(p => p.key === activeProject)) activeProject = "all";   // project deleted

  /* Filtering is a pure state read. Switching tabs touches no network:
     every task is already in memory, which is the whole point of doing it
     here rather than querying per tab. */
  let entries = allTasks().filter(e => !isDone(e.t));
  if (activeProject !== "all") entries = entries.filter(e => e.projectKey === activeProject);

  const byQuad = new Map(QUAD_KEYS.map(k => [k, []]));
  entries.forEach(e => byQuad.get(quadrantOf(e)).push(e));
  /* A quadrant is stocked from three different arrays (Work·GSI, Personal,
     loose), so "the order they were pushed in" is an accident of which
     project happened to be iterated first — not a position anyone chose.
     eisOrder is the position someone actually chose, by dragging; a task
     that has never been dragged has none, and falls back to that original
     insertion order (stable sort keeps ties in place), same as before this
     field existed. */
  byQuad.forEach(list => list.sort((a, b) => compareEisOrder(a.t, b.t)));

  /* Scroll survives the repaint. innerHTML below throws away the swipe
     track and all four quadrant scrollers, and new ones start at 0 — so
     every drop snapped the phone board back to "Do first" (drop a card in
     Delete, and you're suddenly looking at Q1/Q2) and every quadrant list
     jumped back to its top card. Captured by quadrant key, not by index,
     and the per-quadrant offsets are only restored when the project tab
     is the same one that was showing — a different project is a
     different list, and landing halfway down it would be the stranger
     outcome. The track's sideways position is kept either way. */
  const prevTrack = host.querySelector(".eis-board-scroll");
  const prevLeft = prevTrack ? prevTrack.scrollLeft : 0;
  const prevTops = {};
  if (lastRenderedProject === activeProject) {
    host.querySelectorAll(".eis-q-body[data-quadrant]").forEach(b => {
      prevTops[b.dataset.quadrant] = b.scrollTop;
    });
  }
  lastRenderedProject = activeProject;

  /* .eis-board-scroll is the horizontal-swipe track on PHONES only
     (eisenhower.css turns .eis-grid itself into a single flex row there,
     Do first → Decide → Delegate → Delete, left to right); on desktop the
     wrapper is a plain, non-scrolling box and .eis-grid keeps today's
     fixed-height 2×2. One wrapper, one rule that changes with width —
     nothing here needs to know which mode it's in. */
  host.innerHTML =
    tabsHtml(list, dup) +
    (entries.length
      ? `<div class="eis-board-scroll"><div class="eis-grid">${QUADRANTS.map(q => quadrantHtml(q, byQuad.get(q.key))).join("")}</div></div>`
      : `<div class="eis-board-scroll"><div class="eis-grid">${QUADRANTS.map(q => quadrantHtml(q, [])).join("")}</div></div>
         <p class="eis-empty-all">No open tasks in this project.</p>`);

  /* The notice is informative, not nagging — it only reappears when the
     actual set of clashing names changes (a new duplicate appears, or an
     existing one goes away and comes back), not on every tab click or
     render while the same clash is still active. */
  const signature = [...dup].sort().join("|");
  if (dup.size && signature !== dupWarningSignature) {
    dupWarningSignature = signature;
    const names = [...dup].map(n => `"${n}"`).join(", ");
    toast(`Duplicate project name: ${names} exists in both Personal and Work · GSI. They stay separate — the tabs show which is which.`);
  } else if (!dup.size) {
    dupWarningSignature = "";
  }

  /* The card title is a rows="1" textarea with overflow:hidden — it only
     shows more than one line once something measures it. Every other place
     that renders these cards does this after painting; the matrix did not,
     so a two-line task title was silently clipped to its first line. Must
     run after innerHTML, since scrollHeight is meaningless before layout. */
  document.querySelectorAll("#eisenhower textarea").forEach(autoGrow);

  /* Put the scroll positions captured above back — after autoGrow, since
     growing the titles is what gives each list its real height to scroll
     within. The browser clamps anything past the new end on its own. */
  const track = host.querySelector(".eis-board-scroll");
  if (track && prevLeft) track.scrollLeft = prevLeft;
  host.querySelectorAll(".eis-q-body[data-quadrant]").forEach(b => {
    const top = prevTops[b.dataset.quadrant];
    if (top) b.scrollTop = top;
  });

  /* Titles are read-only here, in the matrix specifically. gsiCardHtml and
     pwCardHtml render the title as an editable <textarea> because that's
     right on the Work·GSI and Personal boards — but on a phone-width
     matrix quadrant the title textarea is most of the card, so it was
     eating almost every tap and drag attempt: a tap put a caret into it
     instead of opening the task, and (before eisenhower.css turned off
     its text-selection) a press-and-hold there selected text instead of
     lifting the card. Editing still works exactly as before everywhere
     else this component renders; only this matrix instance is affected,
     and only via `readOnly`/tabIndex set here after paint — the shared
     gsi.js/personal.js templates that build the markup are untouched.

     `pointer-events:none` on .gsi-title in eisenhower.css is what makes a
     tap fall through to the card underneath (opening the task, via
     onEisCardClick) instead of focusing the textarea; `readOnly` here is
     the belt-and-suspenders case a pointer-events rule can't cover — a
     keyboard user tabbing to the field and typing. tabIndex=-1 keeps it
     out of the tab order entirely, so Tab lands on the card (which opens
     the task on Enter/Space, per onEisCardClick's onkeydown) rather than
     a field that can't be edited anyway. Native/loose task titles render
     as a plain, already-non-editable <span> (.t-board-card-title) and
     need none of this. */
  document.querySelectorAll("#eisenhower .gsi-title").forEach(t => {
    t.readOnly = true;
    t.tabIndex = -1;
  });

  /* Move starts out as quadrantHtml()'s plain sibling of the card — see
     the comment there — and gets docked into the card's own wrapping meta
     line here, once there's an actual card in the DOM to dock it into.
     .gsi-card is now that line for GSI/Personal cards (eisenhower.css
     turns it into one flex-wrap row); native/loose cards already had a
     single wrapping meta row of their own (.t-board-card-meta) and just
     gain Move as one more thing that can share or spill off it. */
  document.querySelectorAll("#eisenhower .eis-item-card").forEach(card => {
    const move = card.querySelector(".eis-move");
    if (!move) return;
    const dock = card.querySelector(".gsi-card") ||
                 card.querySelector(".t-board-card-meta") ||
                 card.querySelector(".t-board-card");
    if (dock && move.parentElement !== dock) dock.appendChild(move);
  });

  /* Focus only when the composer was just OPENED. Doing it on every
     repaint would yank the caret out of whatever the person was typing in
     every time a sync pull repainted the matrix. */
  if (focusComposerNext) {
    focusComposerNext = false;
    const input = document.getElementById("eisComposerInput");
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  /* The arrival animation plays once. Clearing the id here — not in a
     timeout — means a later repaint for an unrelated reason cannot replay
     it on a card that is no longer new. */
  if (flashTaskId) {
    flashTaskId = null;
    const fresh = document.querySelector("#eisenhower .eis-just-added");
    if (fresh) {
      fresh.addEventListener("animationend", () => fresh.classList.remove("eis-just-added"), { once: true });
      /* Belt and braces: if the animation never fires (reduced motion, a
         backgrounded tab), the class still comes off rather than leaving a
         card permanently highlighted. */
      setTimeout(() => fresh.classList.remove("eis-just-added"), 1200);
    }
  }

  /* The trigger this menu was anchored to has just been replaced by the
     repaint above, so the menu would be left pointing at nothing. */
  closeEisMove();

  wireDragAndDrop();
  wireTabDragAndDrop();
}

/* ---------- reordering the project tabs ----------
   Same Sortable + forceFallback recipe as the sidebar's Spaces group
   (nav-order.js) and the quadrant cards below — one drag mechanism,
   reused a third time rather than reinvented. Unlike the sidebar, the
   whole tab strip is thrown away and rebuilt by tabsHtml() on every
   render (it's part of host.innerHTML above), so — exactly like
   wireDragAndDrop() for the quadrants — the old instance is destroyed
   and a fresh one made every time, rather than trying to keep one alive
   across a repaint that has already replaced its DOM out from under it. */
function readTabOrder(group) {
  return [...group.querySelectorAll(":scope > .eis-tab[data-key]")].map(el => el.dataset.key);
}

function wireTabDragAndDrop() {
  if (tabSortable) { try { tabSortable.destroy(); } catch (_) {} tabSortable = null; }
  if (typeof Sortable === "undefined") return;   // lazy-loaded; tabs still work, just not reorderable yet
  const group = document.getElementById("eisTabsDrag");
  if (!group) return;
  tabSortable = Sortable.create(group, {
    animation: 150,
    draggable: ".eis-tab[data-key]",   // "All projects" / "No project" live outside this group entirely — see tabsHtml
    delay: 250,
    delayOnTouchOnly: true,   // a plain tap still switches tabs instantly; only a held touch starts a drag
    touchStartThreshold: 6,
    forceFallback: true,      // same reason as nav-order.js: native DnD is unreliable on Samsung Internet
    fallbackTolerance: 6,     // clears ordinary click jitter on mouse/trackpad — see nav-order.js for why
    ghostClass: "eis-tab-ghost",
    chosenClass: "eis-tab-chosen",
    onStart: () => document.body.classList.add("is-dragging"),
    onEnd: () => {
      document.body.classList.remove("is-dragging");
      state.eisTabOrder = readTabOrder(group);
      /* eisTabOrder is a plain field on the document (like navOrder), so
         the document's own stamp is what has to move for this to reach
         another device — see mergeIncomingTasks() in supabase.js for the
         merge that then keeps an empty order on some other device from
         wiping this one. */
      state.updatedAt = Date.now();
      persist();
      /* No re-render: Sortable already dropped the tab where it belongs,
         and tabsHtml() would only reproduce what's already on screen —
         same reasoning nav-order.js's onEnd gives for the sidebar. */
    }
  });
}

/* ---------- drag, and the touch equivalent ----------
   Same Sortable configuration the task boards use, for the
   same reasons documented there: forceFallback keeps desktop and touch
   on one code path, fallbackOnBody escapes the backdrop-filter
   containing block so the dragged card tracks the finger, and
   delayOnTouchOnly means a plain swipe still scrolls the page while a
   long press on the handle lifts a card. */
function wireDragAndDrop() {
  sortables.forEach(s => { try { s.destroy(); } catch (_) {} });
  sortables = [];
  if (typeof Sortable === "undefined") return;   // lazy-loaded; the Move menu still works

  /* Touch gets a dedicated handle; mouse still doesn't. Whole-card dragging
     (the comment below explains why it works for mouse) turned out to
     genuinely conflict with scrolling on an actual touchscreen: dragging
     needs the browser to hand a touch's moves entirely to Sortable's own
     tracking, but scrolling — the quadrant list vertically, the board
     horizontally — needs the OPPOSITE, the browser handling those same
     moves itself. touch-action is how a browser is told which one to do,
     and it's decided ONCE, at the moment a finger first touches down, for
     that finger's whole gesture — not re-decided as the finger moves over
     different elements. So the two behaviours can't coexist on one shared
     touch surface no matter how the delay or the CSS override is tuned;
     they only stop fighting once each has its OWN surface to start from.
     Hence .eis-drag-handle (eisenhower.css): a small grip, touch-action:
     none, that exists ONLY on a touchscreen (hidden entirely under
     hover:hover, i.e. a real pointer) — a finger that lands there commits
     that touch to Sortable from the first instant, with nothing else on
     the card affected; a finger anywhere else still just taps or scrolls,
     exactly as before. Mouse keeps the whole card as the drag surface,
     unchanged — a mouse click doesn't have this conflict to begin with,
     since preventDefault on a mouse event isn't racing the browser's own
     touch-scroll decision the way it is on a touchscreen. */
  const isTouch = !!(window.matchMedia && window.matchMedia("(hover: none)").matches);

  document.querySelectorAll("#eisenhower .eis-q-body").forEach(body => {
    sortables.push(Sortable.create(body, {
      group: "eisenhower",
      draggable: ".eis-item",
      handle: isTouch ? ".eis-drag-handle" : undefined,
      /* `filter` still matters on both inputs: on mouse it's the only
         thing keeping every other interactive part of the card behaving
         normally (tapping the checkbox toggles it, opening the status/
         project select opens it, a link opens) rather than getting
         swallowed as a drag attempt; preventOnFilter:false is what makes
         the filtered elements still work at all — without it Sortable
         eats the click/change event it just vetoed, and the checkbox, the
         status select etc. go dead. On touch it's a defensive second
         layer behind `handle` above, not the thing actually doing the
         work — a real drag there can only ever start from the handle.

         .gsi-title is deliberately NOT in this list, even though it is a
         <textarea>. On mouse a press on it should always place a caret,
         and `delay` (below) is what makes that safe: nothing here calls
         preventDefault before the delay elapses, so a quick click still
         reaches the textarea to focus and type into it, and only a press
         held past 200ms turns into a drag. On touch the handle already
         means a press on the title can never start a drag in the first
         place, so this is belt-and-braces there, not load-bearing — but
         text selection is still turned off on the title in eisenhower.css
         so a long press on it reads as inert rather than selecting text.

         Otherwise identical to gsi.js and personal.js apart from
         .composer, which the matrix has no equivalent of. .t-chk is kept
         because a loose task with no project renders through
         boardCardHtml, whose checkbox carries that class rather than
         .gsi-chk. */
      filter: "button, input, select, a, .t-chk",
      preventOnFilter: false,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 4,
      /* delayOnTouchOnly used to be true, back when only touch needed a
         grace period (the title was filtered out for mouse, so a mouse
         click there could never even attempt a drag). Now that the title
         is a valid drag start for both, the same 200ms grace applies to
         both: a plain click still reaches the textarea instantly for
         editing, and only a press held past 200ms — mouse or touch —
         turns into a drag, so a slightly-imprecise click into the title
         can't be mistaken for one. */
      delay: 200, delayOnTouchOnly: false, touchStartThreshold: 6,
      animation: 140,
      easing: "cubic-bezier(0.2, 0, 0.2, 1)",
      /* A quadrant can legitimately be empty, and an empty one is the
         hardest target on the board — there is no card to aim at. 28px of
         tolerance makes "somewhere in that panel" enough, which matters
         far more with a thumb than with a mouse. */
      emptyInsertThreshold: 28,
      /* Autoscroll has two different edges to find now, not one. Below
         980px .eis-q-body sits inside .eis-board-scroll, a second
         scrollable ancestor (horizontal) above the first (vertical) —
         exactly the shape SortableJS's own autoscroll plugin is built for:
         bubbleScroll (on by default, named here so it stays on even if a
         future Sortable version changes that default) walks OUTWARD from
         the innermost scrollable ancestor to the next one whenever the
         inner one has nowhere further to scroll, so dragging a card to the
         left/right edge of a narrow quadrant scrolls the BOARD to the next
         quadrant over, while dragging it to the top/bottom edge still
         scrolls that quadrant's own list, with no mode switch to wire up —
         it is the same autoscroll, just walking a taller ancestor chain on
         narrow screens than it does on wide ones.
         forceAutoScrollFallback is what makes any of this fire at all:
         forceFallback:true (above) means every drag — mouse included —
         runs through Sortable's own pointer-tracking fallback rather than
         native HTML5 drag events, and autoscroll only listens for native
         dragover by default, so without this flag it would silently never
         scroll anything once fallback mode was already forced on. */
      scroll: true, bubbleScroll: true, forceAutoScrollFallback: true,
      /* Touch gets a 40px edge zone, mouse keeps 90. On touch the grip is
         the card's RIGHT edge, which sat inside a 90px zone from the very
         first instant of a lift: the swipe-track started sliding the next
         quadrant under a finger that hadn't moved, and the card dropped
         there (Q1 9 -> 8 in the recording). 90px was also ~60% of a
         short quadrant list's height, so lists scrolled under a card being
         reordered. Desktop is unchanged. */
      scrollSensitivity: isTouch ? 40 : 90, scrollSpeed: isTouch ? 10 : 14,
      /* Explicit highlight rather than relying only on :has() support —
         fires continuously while a card is dragged over any quadrant, so
         the destination panel visibly reacts (border glow, brighter
         background) even on older browsers. */
      onMove: evt => {
        document.querySelectorAll("#eisenhower .eis-q-body.eis-over")
          .forEach(el => { if (el !== evt.to) el.classList.remove("eis-over"); });
        if (evt.to) evt.to.classList.add("eis-over");
        return true;
      },
      ghostClass: "eis-ghost", dragClass: "eis-dragging", chosenClass: "eis-chosen",
      /* The drag finger's pointerId is recorded by the multi-touch layer
         below (on the grip's own pointerdown); these callbacks only open
         and close the window during which that layer is allowed to act.
         onStart, not onChoose: a second finger landing during the 200ms
         lift delay should still cancel the lift, exactly as before. */
      onChoose: () => document.body.classList.add("is-dragging"),
      onStart: () => {
        document.body.classList.add("is-dragging");
        eisDragLive = true;
      },
      onEnd: evt => {
        document.body.classList.remove("is-dragging");
        eisDragLive = false;
        endScrollFinger();
        /* Tell the shared guard a drag just finished. A drop lands a
           pointerup on the card, and now that the card opens the task,
           every move would otherwise end with the modal in your face.
           openTaskCardDetail ignores clicks for 350ms after this. */
        markDragJustEnded();
        document.querySelectorAll("#eisenhower .eis-q-body.eis-over")
          .forEach(el => el.classList.remove("eis-over"));
        commitEisDrop(evt.item.dataset.taskId, evt.to);
      }
    }));
  });

  wireMultiTouch();
}

/* ---------- two fingers: one holds the card, the other scrolls ----------

   THE BUG IN THE OLD VERSION, from SortableJS 1.15's own source.
   On Chrome/Android (and iOS) Sortable runs on POINTER events —
   supportPointer is on wherever PointerEvent exists — and it binds them on
   the whole document:

       on(document, 'pointermove', this._onTouchMove);
       on(ownerDocument, 'pointerup',     _this._onDrop);
       on(ownerDocument, 'pointercancel', _this._onDrop);

   None of those check pointerId. Every finger on the glass is "the drag"
   as far as Sortable is concerned, so with a second finger down, moving
   it moved the CARD to that finger and hit-tested under it (reproduced in
   Chromium with real two-finger input). Its pointerup/pointercancel also
   reach _onDrop, which is a premature drop waiting to happen. The previous
   second-finger code listened to TOUCH events, a separate stream, so it
   could scroll the board but could never stop Sortable seeing the finger —
   and it could only scroll sideways, never a quadrant list or the page.

   THE FIX. One small filter in front of Sortable, on window in the
   CAPTURE phase — the first listener any pointer event reaches, before it
   gets down to Sortable's document-level handlers:
     • the drag finger's events pass through untouched, so Sortable
       behaves exactly as it does for a one-finger drag;
     • any OTHER touch pointer's down/move/up/cancel is stopped right
       there, so Sortable never learns a second finger exists;
     • and that second finger's movement is turned into scrolling:
         sideways → the phone swipe-track (which quadrant is showing),
         up/down  → the quadrant list it started on, and once that list
                    hits its end, the page (on the Fold 2x2, that's how
                    the bottom row comes into reach).
   Native scrolling can't do this job: while a card is lifted Sortable
   calls preventDefault on every touchmove (to stop the page panning under
   the drag), which blocks the browser from panning for ANY finger.

   PRECISE DROP. Sortable re-runs its hit test every 50ms during a
   fallback drag (_loopId → _emulateDragOver), using the drag finger's
   last position, whether or not that finger moved. So when the second
   finger scrolls content under a stationary first finger, the gap
   (placeholder) re-positions to the exact slot now under the card within
   one tick — you can scroll, stop, and drop precisely between two cards.

   The mouse is untouched: nothing here acts on a non-touch pointer. */
let eisDragLive = false;       // a lift has actually started (Sortable onStart → onEnd)
let dragPointerId = null;      // the finger holding the card
let scrollPointerId = null;    // the finger doing the scrolling, while one is down
let scrollLastX = 0, scrollLastY = 0;
let scrollListEl = null;       // the quadrant list the scroll finger started on, if any
let multiTouchWired = false;

function endScrollFinger() {
  scrollPointerId = null;
  scrollListEl = null;
}

/* Scroll the list the finger started on first; whatever it can't absorb
   (it's at its top or bottom, or the finger started outside every list)
   goes to the page. Same hand-off a native nested scroll does. */
function scrollVertically(dy) {
  if (!dy) return;
  let rest = dy;
  if (scrollListEl && scrollListEl.isConnected) {
    const before = scrollListEl.scrollTop;
    scrollListEl.scrollTop = before + rest;
    rest -= scrollListEl.scrollTop - before;
  }
  if (Math.abs(rest) >= 1) window.scrollBy(0, rest);
}

function scrollHorizontally(dx) {
  if (!dx) return;
  const track = document.querySelector("#eisenhower .eis-board-scroll");
  /* Only the phone swipe-row actually scrolls sideways; on the 2x2 the
     track has no overflow and this is a no-op. */
  if (track && track.scrollWidth > track.clientWidth) track.scrollLeft += dx;
}

function isOtherTouch(e) {
  return e.pointerType === "touch" && e.pointerId !== dragPointerId;
}

function wireMultiTouch() {
  if (multiTouchWired) return;   // bind once, ever — not once per render
  multiTouchWired = true;
  const cap = { capture: true };

  window.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch") return;
    if (!eisDragLive) {
      /* Not dragging yet: note which finger pressed a grip. If this press
         becomes a lift, it is the drag finger. A press anywhere else is
         ignored, so an ordinary tap can never be mistaken for it. */
      if (e.target.closest && e.target.closest("#eisenhower .eis-drag-handle")) dragPointerId = e.pointerId;
      return;
    }
    if (e.pointerId === dragPointerId) return;
    e.stopImmediatePropagation();          // Sortable must never see it
    if (scrollPointerId !== null) return;  // a third finger: ignored entirely
    scrollPointerId = e.pointerId;
    scrollLastX = e.clientX;
    scrollLastY = e.clientY;
    scrollListEl = e.target.closest ? e.target.closest("#eisenhower .eis-q-body") : null;
  }, cap);

  window.addEventListener("pointermove", e => {
    if (!eisDragLive || !isOtherTouch(e)) return;
    e.stopImmediatePropagation();
    if (e.pointerId !== scrollPointerId) return;
    /* Finger moves up → content moves up → scroll position increases,
       the same direction a normal one-finger scroll goes. 1:1 with the
       finger, no acceleration, so a small nudge means a small nudge. */
    const dx = scrollLastX - e.clientX;
    const dy = scrollLastY - e.clientY;
    scrollLastX = e.clientX;
    scrollLastY = e.clientY;
    scrollHorizontally(dx);
    scrollVertically(dy);
  }, cap);

  const release = e => {
    if (!eisDragLive || !isOtherTouch(e)) return;
    /* Stopped here, the second finger lifting no longer reaches Sortable's
       pointerup → _onDrop — the card stays in hand — nor app.js's release
       safety net, which would clear body.is-dragging and let a background
       repaint through under the held card. */
    e.stopImmediatePropagation();
    if (e.pointerId === scrollPointerId) endScrollFinger();
  };
  window.addEventListener("pointerup", release, cap);
  window.addEventListener("pointercancel", release, cap);

  /* The same finger also produces a touchend, which app.js's safety net
     listens for as well. While the card is still held, any touch that
     ends with at least one finger left on the glass is the second finger
     (the drag finger's pointerup has already ended the drag, and turned
     eisDragLive off, before its touchend is dispatched). */
  const touchRelease = e => {
    if (eisDragLive && e.touches && e.touches.length > 0) e.stopImmediatePropagation();
  };
  window.addEventListener("touchend", touchRelease, cap);
  window.addEventListener("touchcancel", touchRelease, cap);
}

/* ---------- the Move menu ----------

   Attached to <body>, not to the card. Two separate things would clip it
   otherwise, and only one of them is obvious:

     - .eis-q-body is overflow-y:auto, so an absolutely positioned child
       is clipped by the scroller. That is the bug that was visible: three
       destinations rendered, one showed.
     - position:fixed would not have helped either. .eis-q carries
       backdrop-filter, which makes it the containing block for fixed
       descendants — the same trap documented on the drag clone, where
       fallbackOnBody exists for exactly this reason. Fixed coordinates
       inside that card resolve against the card, not the viewport.

   So the menu is a real portal: built on open, positioned from the
   trigger's viewport rect, removed on close. */
let openMove = null;   // { el, taskId, btn }

function closeEisMove() {
  if (!openMove) return;
  openMove.btn?.setAttribute("aria-expanded", "false");
  openMove.el.remove();
  openMove = null;
}

function placeEisMove(menu, btn) {
  const r = btn.getBoundingClientRect();
  const m = 8;
  const { offsetWidth: w, offsetHeight: h } = menu;
  /* Below the button by default; above it when there isn't room, which is
     what a card near the bottom of a quadrant needs. */
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - m) top = Math.max(m, r.top - 6 - h);
  /* Right-aligned to the trigger, then pulled back inside the viewport —
     the quadrants on the right edge would otherwise push it off-screen. */
  let left = Math.min(Math.max(m, r.right - w), window.innerWidth - w - m);
  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(left)}px`;
}

export function toggleEisMove(btn, taskId, fromQuadrant) {
  if (openMove && openMove.taskId === taskId) { closeEisMove(); return; }
  closeEisMove();

  const menu = document.createElement("div");
  menu.className = "eis-move-menu";
  menu.setAttribute("role", "menu");
  QUADRANTS.filter(x => x.key !== fromQuadrant).forEach(x => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.textContent = x.title;
    /* Listener, not an inline onclick: this element is created here rather
       than parsed from a string, so there is no HTML-escaping question and
       a task title or key can never break out of an attribute. */
    b.addEventListener("click", () => { closeEisMove(); moveEisTask(taskId, x.key); });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  placeEisMove(menu, btn);          // after append: needs a measured size
  btn.setAttribute("aria-expanded", "true");
  openMove = { el: menu, taskId, btn, settling: true };

  /* preventScroll, and it is not cosmetic: focusing an element makes the
     browser scroll it into view, and the scroll listener below closes the
     menu. Without this the menu opened and closed inside the same frame —
     the click appeared to do nothing at all. (jsdom does not scroll on
     focus, which is exactly why this survived a DOM test.) */
  menu.querySelector("button")?.focus({ preventScroll: true });

  /* Belt and braces for the same class of problem: anything else that
     scrolls as a side effect of opening — a browser bringing the trigger
     into view, a layout settling — is ignored until the next frame. After
     that, a real scroll closes the menu as intended. */
  requestAnimationFrame(() => { if (openMove) openMove.settling = false; });
}

/* A menu anchored to a rect has to go when the rect moves. Capture phase,
   because the quadrant's own scroller is the one that usually moves. */
document.addEventListener("pointerdown", e => {
  if (e.target.closest(".eis-move-menu") || e.target.closest(".eis-move-btn")) return;
  closeEisMove();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeEisMove(); });
window.addEventListener("scroll", () => {
  if (openMove && openMove.settling) return;   // the scroll that opening caused
  closeEisMove();
}, true);
window.addEventListener("resize", closeEisMove);

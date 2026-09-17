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
import { state, esc, persist, touch } from './state.js?v=202609042200';
import { gsiCardHtml } from './gsi.js?v=202609042200';
import { pwCardHtml } from './personal.js?v=202609042200';
import { boardCardHtml, findAnyTask } from './tasks.js?v=202609042200';
import { toast, autoGrow } from './ui.js?v=202609042200';

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

let activeProject = "all";      // "all" | "none" | "gsi:<id>" | "pw:<id>"
let dupWarningSignature = "";   // last duplicate-name set the notice was shown for
let sortables = [];

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
   The ONLY write this feature performs. One field, then the app's own
   persist() — the same call every other edit in LifeOS makes, which is
   what carries it through the existing save queue, reconciliation and
   offline handling without any of them knowing this feature exists.

   touch() matters here as much as the field write itself: the sync layer
   resolves item-level conflicts by comparing each task's own updatedAt,
   the same way every other field edit in gsi.js/personal.js/tasks.js
   does (t[field] = v; touch(t); persist()). Setting t.eis without
   touching the task would make a real edit invisible to that
   reconciliation — it could lose to a stale copy of the same task instead
   of being recognised as the newer change. */
export function setTaskQuadrant(id, quadrant) {
  if (!QUAD_KEYS.includes(quadrant)) return;
  const found = findAnyTask(id);
  if (!found || !found.task) return;
  if (found.task.eis === quadrant) return;
  found.task.eis = quadrant;
  touch(found.task);
  persist();
  /* Only this card repaints. A full rerender() here would rebuild every
     board, list and chart in the app for a one-field change. */
  renderEisenhower();
}

export function setEisProject(key) {
  activeProject = key;
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

function tabsHtml(list, dup) {
  const tab = (key, label, sub) => `
    <button class="eis-tab ${activeProject === key ? "on" : ""}" role="tab"
            aria-selected="${activeProject === key}"
            onclick="setEisProject('${key}')">${esc(label)}${sub ? `<span class="eis-tab-sub">${esc(sub)}</span>` : ""}</button>`;
  const looseCount = (state.tasks || []).length;
  return `
    <div class="eis-tabs" role="tablist" aria-label="Filter the matrix by project">
      ${tab("all", "All projects")}
      ${list.map(p => tab(p.key, p.name,
          dup.has((p.name || "").trim().toLowerCase()) ? p.section : "")).join("")}
      ${looseCount ? tab("none", "No project") : ""}
    </div>`;
}

function quadrantHtml(q, entries) {
  const menu = id => `
    <div class="eis-move">
      <button class="eis-move-btn" aria-label="Move this task to another quadrant"
              onclick="this.parentNode.classList.toggle('open')">Move ▾</button>
      <div class="eis-move-menu">
        ${QUADRANTS.filter(x => x.key !== q.key).map(x =>
          `<button onclick="moveEisTask('${id}','${x.key}');this.closest('.eis-move').classList.remove('open')">${esc(x.title)}</button>`).join("")}
      </div>
    </div>`;
  return `
    <section class="eis-q eis-${q.key}" data-quadrant="${q.key}" aria-label="${esc(q.n + " " + q.title)}">
      <header class="eis-q-head">
        <span class="eis-q-n">${q.n}</span>
        <span class="eis-q-title">${esc(q.title)}</span>
        <span class="eis-q-meta">${esc(q.urgency)} + ${esc(q.importance)} · ${esc(q.action)}</span>
        <span class="eis-q-count">${entries.length}</span>
      </header>
      <div class="eis-q-body" data-quadrant="${q.key}">
        ${entries.map(e => `
          <div class="eis-item" data-task-id="${e.t.id}">
            <div class="eis-item-card">
              ${cardFor(e)}
              ${menu(e.t.id)}
            </div>
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

  host.innerHTML =
    tabsHtml(list, dup) +
    (entries.length
      ? `<div class="eis-grid">${QUADRANTS.map(q => quadrantHtml(q, byQuad.get(q.key))).join("")}</div>`
      : `<div class="eis-grid">${QUADRANTS.map(q => quadrantHtml(q, [])).join("")}</div>
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

  wireDragAndDrop();
}

/* ---------- drag, and the touch equivalent ----------
   The GSI and Personal cards use a <textarea> for the task title, and
   Sortable's own drag-start filter (button, input, select, textarea, a)
   deliberately refuses to lift a card from any of those elements — so a
   press on the title never started a drag, and on a phone it just
   selected text instead. Rather than touch the shared card renderers,
   every item gets one small dedicated handle (⠿) and Sortable is told
   to start drags from that handle only. The card itself, its title, and
   every other control on it stay exactly as clickable/editable as
   before; only the handle picks a card up.

   Same Sortable configuration the task boards use otherwise, for the
   same reasons documented there: forceFallback keeps desktop and touch
   on one code path, fallbackOnBody escapes the backdrop-filter
   containing block so the dragged card tracks the finger, and
   delayOnTouchOnly means a plain swipe still scrolls the page while a
   long press on the handle lifts a card. */
function wireDragAndDrop() {
  sortables.forEach(s => { try { s.destroy(); } catch (_) {} });
  sortables = [];
  if (typeof Sortable === "undefined") return;   // lazy-loaded; the Move menu still works

  document.querySelectorAll("#eisenhower .eis-q-body").forEach(body => {
    sortables.push(Sortable.create(body, {
      group: "eisenhower",
      draggable: ".eis-item",
      /* NO handle — the whole card is the drag surface, exactly as on the
         Work·GSI and Personal boards. The grip that used to sit beside
         each card existed because .gsi-title is a <textarea>, which a
         press would otherwise put a caret into rather than lifting the
         card. `filter` solves that properly instead: every interactive
         part of the card keeps its own behaviour, and a press anywhere
         else on the card starts a drag.

         preventOnFilter:false is what makes the filtered elements still
         work — without it Sortable swallows the click/change events it
         just vetoed, so the checkbox, the status select and the title
         would all go dead.

         Identical to gsi.js and personal.js apart from .composer, which
         the matrix has no equivalent of. .t-chk is kept because a loose
         task with no project renders through boardCardHtml, whose
         checkbox carries that class rather than .gsi-chk. */
      filter: "button, input, select, textarea, a, .t-chk",
      preventOnFilter: false,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 4,
      delay: 200, delayOnTouchOnly: true, touchStartThreshold: 6,
      animation: 140,
      easing: "cubic-bezier(0.2, 0, 0.2, 1)",
      /* A quadrant can legitimately be empty, and an empty one is the
         hardest target on the board — there is no card to aim at. 28px of
         tolerance makes "somewhere in that panel" enough, which matters
         far more with a thumb than with a mouse. */
      emptyInsertThreshold: 28,
      scroll: true, scrollSensitivity: 90, scrollSpeed: 12,
      onChoose: () => document.body.classList.add("is-dragging"),
      onStart: () => document.body.classList.add("is-dragging"),
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
      onEnd: evt => {
        document.body.classList.remove("is-dragging");
        document.querySelectorAll("#eisenhower .eis-q-body.eis-over")
          .forEach(el => el.classList.remove("eis-over"));
        const id = evt.item.dataset.taskId;
        const to = evt.to.dataset.quadrant;
        if (!id || !to) return renderEisenhower();
        setTaskQuadrant(id, to);
      }
    }));
  });
}

/* Any tap outside an open Move menu closes it. */
document.addEventListener("pointerdown", e => {
  if (e.target.closest(".eis-move")) return;
  document.querySelectorAll(".eis-move.open").forEach(m => m.classList.remove("open"));
});

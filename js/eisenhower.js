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
import { state, esc, persist, rerender, uid, touch } from './state.js?v=202609262357';
import { gsiCardHtml, addProjectTaskRaw } from './gsi.js?v=202609262357';
import { pwCardHtml, addPwProjectTaskRaw } from './personal.js?v=202609262357';
import { boardCardHtml, findAnyTask, createNativeTask, openTaskCardDetail, markDragJustEnded } from './tasks.js?v=202609262357';
import { toast, autoGrow } from './ui.js?v=202609262357';

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
    flag: false, googleEventId: null, eis: quadrant
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
     mean ticking a checkbox or changing a status also opened a dialogue. */
  if (evt.target.closest("button, input, select, textarea, a, label, .eis-move, .gsi-chk, .t-chk")) return;
  /* A task with no project renders through boardCardHtml, which already
     carries its own onclick. Without this the click would bubble up here
     and open the modal a second time. */
  if (evt.target.closest(".t-board-card")) return;
  if (evt.key) evt.preventDefault();          // Space would scroll the page
  openTaskCardDetail(id);
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

  document.querySelectorAll("#eisenhower .eis-q-body").forEach(body => {
    sortables.push(Sortable.create(body, {
      group: "eisenhower",
      draggable: ".eis-item",
      /* NO handle — the whole card is the drag surface, exactly as on the
         Work·GSI and Personal boards. `filter` is what keeps every other
         interactive part of the card behaving normally (tapping the
         checkbox toggles it, opening the status/project select opens it,
         a link opens) rather than getting swallowed as a drag attempt;
         preventOnFilter:false is what makes the filtered elements still
         work at all — without it Sortable eats the click/change event it
         just vetoed, and the checkbox, the status select etc. go dead.

         .gsi-title is deliberately NOT in this list, even though it is a
         <textarea>. It used to be, on the theory that a press on it
         should always place a caret — but on a touch screen the title is
         most of the visible card, so almost every real drag attempt
         started there, and being filtered meant Sortable ignored it
         completely: the browser's own press-and-hold-to-select gesture
         ran instead, which is the "text gets selected when I try to drag"
         bug this is fixing. Leaving it draggable lets `delay` (below) do
         its job — a quick tap still reaches the textarea to focus and
         type into it, since nothing here calls preventDefault before the
         delay elapses; only a press held past it becomes a drag, exactly
         the long-press-to-reorder feel Todoist's own cards use. Text
         selection itself is turned off on the title in eisenhower.css so
         that held press reads as "picking the card up", not "selecting".

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
        /* Tell the shared guard a drag just finished. A drop lands a
           pointerup on the card, and now that the card opens the task,
           every move would otherwise end with the modal in your face.
           openTaskCardDetail ignores clicks for 350ms after this. */
        markDragJustEnded();
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

/* Tasks — flagged tasks are what make a task "important" and
   sort to the top; also has due date, link, and Work/Personal category.
   The "Work"/"All" view also merges in every Work·GSI project's tasks
   (tagged with their project name), so Overview gives one unified picture
   of everything work-related rather than two separate task lists living
   in two different places. GSI tasks keep their own storage and schema
   (a 4-state status, not a simple done/not-done) — this only merges them
   for DISPLAY, routing edits back to the correct underlying data. */
import { state, uid, esc, persist, rerender, touch, commitWithoutRender } from './state.js?v=202609031800';
import { openDateSheet } from './date-sheet.js?v=202609031800';
import { isComposerOpen, composerHtml, openComposer, nativeColumnAccepts } from './composer.js?v=202609031800';
import { toast, autoGrow } from './ui.js?v=202609031800';
import { releaseDragGhost } from './drag-cleanup.js?v=202609031800';
import { moveToTrash } from './trash.js?v=202609031800';
import { syncTaskToGoogle } from './google-calendar.js?v=202609031800';
import { getAllGsiTasksFlat, findProjectTask, editProjectTask, setTaskStatus as setGsiTaskStatus,
  delProjectTask, toggleProjectTaskFlag, archiveGsiTaskEntry,
  getProjectList, addProjectTaskRaw, moveProjectTask, pluckProjectTask, renderGsi } from './gsi.js?v=202609031800';
import { changePwTaskProject, findPwProjectTask, editPwProjectTask, setPwTaskStatus, togglePwProjectTaskFlag, delPwProjectTask,
  getAllPwTasksFlat, archivePwTaskEntry, getPwProjectList,
  addPwProjectTaskRaw, pluckPwProjectTask, renderPersonalWorkspace } from './personal.js?v=202609031800';

let taskFilter = "all"; // "all" | "work" | "personal"
let sortByDate = false;
let taskView = null; // "list" | "board" | "calendar" — lazily initialized from state.taskViewPref on first render (see renderTasks), then kept in sync with it on every change
/* Which calendar days are showing all their tasks rather than the first
   three. View-only and per-session: not persisted, not synced — the same
   treatment as which task sections are collapsed. Cleared when the month
   changes, since the dates no longer apply. */
let expandedCalDays = new Set();
let calendarMonth = (() => { const d = new Date(); d.setDate(1); return d; })(); // first-of-month, tracks which month Calendar view is showing
/* Which range the Calendar view is showing: a week, a month, a year, or a
   block of years. The anchor above is the date inside that range — for
   Month and above only its month/year matter, so it stays pinned to the
   1st; Week moves it to a real date. Persisted like taskViewPref, so the
   phone and the desktop open on the range you last used. */
let calendarScale = null; // "week" | "month" | "year" | "years" — lazily read from state on first render
const CAL_SCALES = [["week", "Week"], ["month", "Month"], ["year", "Year"], ["years", "Years"]];
const YEARS_BLOCK = 12; // how many years the Years view shows at once
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
// ---------- Drag-to-reorder (List view, Default sort only) ----------
let sortableInstances = [];
function destroySortables() {
  /* Before destroy(), never after: destroy() calls Sortable's _onDrop()
     with no event, which skips the branch that removes the drag clone and
     then nulls the only reference to it. See js/drag-cleanup.js. */
  releaseDragGhost();
  sortableInstances.forEach(s => { try { s.destroy(); } catch (e) { /* already gone with its container — fine */ } });
  sortableInstances = [];
}
function initTaskSorting() {
  destroySortables();
  if (taskView !== "list" || sortByDate || typeof Sortable === "undefined") return;
  document.querySelectorAll("#taskList .t-section-rows-inner").forEach(container => {
    sortableInstances.push(Sortable.create(container, {
      filter: "button, input, select, textarea, a, .t-chk",
      preventOnFilter: false,
      filter: ".t-drag-handle-spacer", // the GSI-row placeholder isn't a handle at all, so grabbing it (or a GSI row generally) never starts a drag
      draggable: ".t-row[data-is-gsi='0']", // only native rows are ever pick-up-able
      preventOnFilter: false, // a tap that misses the (non-existent) handle on a GSI row should still behave as a normal click, not get swallowed // long-press to start on touch; no delay for mouse
      /* The dragged clone is appended to <body> and forced onto Sortable's
         own fallback renderer.

         Without fallbackOnBody the clone stays inside the column, and the
         column sits inside a .card that carries backdrop-filter — which
         makes that card the containing block for position:fixed. The clone
         is then positioned relative to the card rather than the screen, so
         it trails the finger by the card's offset from the viewport. That
         is the visible gap between finger and card on touch.

         forceFallback keeps desktop and touch on the same code path, so
         the two behave identically instead of desktop using native HTML5
         drag with its own quirks. */
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 4,
      /* Long-press to lift, so a plain swipe still scrolls the board.
         200ms rather than 300 — Todoist feels immediate because the lift
         happens before you have consciously waited for it. */
      delay: 200, delayOnTouchOnly: true, touchStartThreshold: 6,
      /* Faster than the previous 200ms: the reflow animation is what makes
         a board feel sluggish once several cards shuffle at once. */
      animation: 140,
      easing: "cubic-bezier(0.2, 0, 0.2, 1)",
      /* Marks the whole document while a lift is in progress so the CSS
         can drop the board's blur for the duration. Cleared in onEnd —
         and also on cancel, since a drag abandoned off-screen would
         otherwise leave the board unblurred until the next reload. */
      /* onChoose, not just onStart: Sortable calls _appendGhost() — which
         MEASURES the source card to place the clone — before it dispatches
         "start". Adding the class in onStart alone lands after that
         measurement, so the containing-block reset in style.css would come
         a frame too late and the clone would keep the bad offset it was
         born with. onChoose fires first, before any ghost exists. */
      onChoose: () => document.body.classList.add("is-dragging"),
      onStart: () => document.body.classList.add("is-dragging"),
      ghostClass: "t-row-ghost", dragClass: "t-row-dragging", chosenClass: "t-row-chosen",
      scroll: true, scrollSensitivity: 90, scrollSpeed: 12,
      onEnd: handleTaskDragEnd,
    }));
  });
}
function handleTaskDragEnd(evt) {
  markDragJustEnded(); // a drop lands a click on the card — don't let it open the task
  const draggedId = evt.item.dataset.taskId;
  const draggedTask = state.tasks.find(t => t.id === draggedId);
  /* No native task behind this id means a GSI or Personal card, reordered
     within one board column. Those have no `position` field, so there is
     nothing to write down — manual order is a native-task idea and Board
     view moves those cards BETWEEN columns (by status and date) rather
     than within one.
     
     This used to re-render, which snapped the card back to its data order
     and repainted the whole board to do it. Leaving it alone is the
     smaller surprise of the two: the card stays where it was put, and the
     next full render — a sync, an edit, a view switch — restores the real
     order without anything having to flash to say so. */
  if (!draggedTask) { reuniteRowMeta(evt.item, draggedId); return; }
  const orderedIds = Array.from(evt.to.children).map(el => el.dataset.taskId).filter(Boolean);
  const idx = orderedIds.indexOf(draggedId);
  // Walk outward past any interspersed GSI task ids (which have no
  // position field to compare against) to find the nearest actual
  // native neighbor on each side.
  const nativeNeighbor = (dir) => {
    for (let i = idx + dir; i >= 0 && i < orderedIds.length; i += dir) {
      const t = state.tasks.find(x => x.id === orderedIds[i]);
      if (t) return t;
    }
    return null;
  };
  const before = nativeNeighbor(-1), after = nativeNeighbor(1);
  const beforePos = before ? (before.position ?? 0) : null;
  const afterPos = after ? (after.position ?? 0) : null;
  // Fractional midpoint insertion — this is the entire point of using
  // a position field instead of array index: only the ONE dragged
  // task's position ever needs to change, never a renumbering pass
  // across the whole list.
  draggedTask.position =
    beforePos == null && afterPos == null ? 1000 :
    beforePos == null ? afterPos - 1000 :
    afterPos == null ? beforePos + 1000 :
    (beforePos + afterPos) / 2;
  persist();
  /* NO RENDER. The list on screen is already the answer.

     Sortable moved the row to exactly where it was dropped, and the only
     thing that changed in the data is one task's `position` — a field
     nothing on the card displays. Rebuilding the list could therefore
     only ever reproduce what is already there, at the cost of replacing
     every row in it: the page height collapses and re-expands while the
     innerHTML is swapped, the scroll position is clamped somewhere in the
     middle of that, and the list lands somewhere other than where the
     person left it. That is the jump after a move.

     The one loose end is the row's own .t-meta panel, which is a SIBLING
     of the row rather than a child of it, so Sortable — which is told to
     drag `.t-row` — leaves it behind. Reuniting the two is a two-line DOM
     move, and much cheaper than a rebuild. */
  reuniteRowMeta(evt.item, draggedId);
}
/* Each task in List view renders as two sibling elements: the visible
   .t-row and the .t-meta editor panel that expands beneath it. Only the
   row is draggable, so after a reorder the panel is stranded next to
   whichever row has taken its old place. The panel carries data-meta-for
   so it can be found again by task id and put back under its own row. */
function reuniteRowMeta(rowEl, id) {
  if (!rowEl || !id) return;
  const container = rowEl.parentElement;
  if (!container) return;
  const meta = container.querySelector(`.t-meta[data-meta-for="${cssId(id)}"]`);
  if (meta && rowEl.nextElementSibling !== meta) rowEl.after(meta);
}
/* Task ids come from uid(), but they still get interpolated into selectors
   here, so escape them rather than trusting the generator's alphabet to
   stay the way it is today. */
function cssId(id) {
  return (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id).replace(/["\\]/g, "\\$&");
}

// ---------- Board view drag-and-drop (six columns, cross-column moves) ----------
let boardSortableInstances = [];
function destroyBoardSortables() {
  releaseDragGhost();   // see destroySortables above
  boardSortableInstances.forEach(s => { try { s.destroy(); } catch (e) { /* already gone with its container */ } });
  boardSortableInstances = [];
}
/* ---------- Board: the mouse wheel pans it sideways ----------
   A board wider than the window is only useful if the columns past the
   edge are reachable, and on a desktop with no trackpad the wheel is the
   only gesture there is.

   The hard constraint is that this must never trap the pointer. So the
   wheel is a chain, not a takeover, and the board is last in it:

   - Shift+wheel always pans. That's the convention, and it works anywhere
     on the board at any scroll position.
   - A trackpad's own horizontal gesture is left to the browser.
   - A column under the pointer with more than five cards scrolls its own
     list first, until that list reaches its end.
   - Then the page, if the page has anywhere left to go.
   - Only then does the wheel pan the board — and at either end of the
     board the event is handed back, so nothing sticks.

   Re-bound each render because renderTasks() rewrites #taskList wholesale,
   so this is always a fresh element with no listener left to leak. */
function pageScroller(el) {
  // The page scrolls on <html> in this layout, but .main or a modal body
  // could be the real scroller depending on where the board is mounted, so
  // find it rather than assume it.
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight - n.clientHeight > 1) return n;
  }
  return document.scrollingElement || document.documentElement;
}
export function initBoardWheelScroll() {
  document.querySelectorAll(boardSel(".t-board")).forEach(bindBoardWheel);
}
function bindBoardWheel(board) {
  board.addEventListener("wheel", (e) => {
    const max = board.scrollWidth - board.clientWidth;
    if (max <= 1) return;                                   // nothing to pan
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;    // native horizontal gesture
    const delta = e.deltaY;
    if (!delta) return;

    if (!e.shiftKey) {
      /* A column that can still scroll its own list keeps the wheel:
         reading down a full Overdue column must not slide the board
         sideways under the pointer. Once that list is at its end the wheel
         passes on. */
      const colBody = e.target.closest?.(".t-board-col-body");
      if (colBody && colBody.scrollHeight - colBody.clientHeight > 1) {
        const atTop = colBody.scrollTop <= 1;
        const atEnd = colBody.scrollTop + colBody.clientHeight >= colBody.scrollHeight - 1;
        if (!(delta < 0 && atTop) && !(delta > 0 && atEnd)) return;
      }
      const page = pageScroller(board);
      const pageHasRoom = delta > 0
        ? page.scrollTop + page.clientHeight < page.scrollHeight - 1
        : page.scrollTop > 1;
      if (pageHasRoom) return; // then the page
    }
    if ((delta < 0 && board.scrollLeft <= 0) || (delta > 0 && board.scrollLeft >= max - 1)) return;
    e.preventDefault();
    board.scrollLeft = Math.max(0, Math.min(max, board.scrollLeft + delta));
  }, { passive: false });
}

/* ---------- Board columns: five cards, then scroll ----------
   A column stops at the height of its fifth card and scrolls from there.
   Five is the number the board reads well at: every column's head stays on
   one screen, so Overdue can't push Today and Upcoming below the fold just
   by being long.

   Measured rather than declared. Cards here are not a fixed height — a
   two-line title, a wrapped meta row, a Hindi title that sets taller all
   change it — so a max-height in CSS would cut the fifth card in half on
   one column and leave a gap on another. This reads the fifth card's own
   bottom edge in each column and caps to exactly that.

   It runs after every render (card heights are only knowable once they're
   laid out) and again on resize, since a narrower column rewraps titles
   and every height changes with it.

   Applied to all three Kanban boards, not just Overview's: Work · GSI
   (#ngdrList) and the Personal workspace (#pwTaskList) render the same
   .t-board-col markup, so a rule about how tall a column gets should
   hold in all of them rather than being a quirk of one screen.
   Exported so those two modules can call it after their own renders —
   renderTasks() doesn't run when they re-render. */
const BOARD_CARDS_BEFORE_SCROLL = 5;
// Overview, Work · GSI, and the Personal workspace — the three screens that render .t-board.
const BOARD_ROOTS = ["#taskList", "#ngdrList", "#pwTaskList"];
const boardSel = (suffix) => BOARD_ROOTS.map(r => `${r} ${suffix}`).join(", ");
export function capBoardColumnHeights() {
  document.querySelectorAll(boardSel(".t-board-col-body")).forEach(capOneColumnBody);
}
/* One column's worth of the above, pulled out so a drop can remeasure only
   the two columns it actually touched.

   Remeasuring ALL of them costs nothing when the board is being rebuilt
   anyway — but on a drop, where nothing is being rebuilt, it is the one
   remaining thing that could still move the page: clearing maxHeight lets
   every column spring to its full natural height for the duration of the
   measurement, and a Completed column holding forty cards is a very large
   spring. Touching only the source and destination keeps that to the two
   columns whose contents genuinely changed. */
function capOneColumnBody(body) {
  {
    // Clear first: the measurement has to happen against the column's
    // natural height, not against last render's cap.
    body.style.maxHeight = "";
    body.classList.remove("t-board-col-capped");

    /* NOTHING HIDDEN CAN BE MEASURED.

       `.page{display:none}` until it is the visible one, and every offset
       and rect inside a display:none subtree reads 0. The measurement below
       then came out as just the bottom padding — about 10px — and `h > 0`
       happily accepted it, so the column was pinned to a 10px cap: a header
       and a sliver of the first card, exactly as reported on switching tabs.
       A later click triggered a render with the page now visible, the cap
       was recomputed correctly, and the column "expanded".

       Renders happen while a page is hidden all the time — on first load
       every page is rendered, and a sync landing while you are on another
       page re-renders this one — so this was reachable constantly.

       go() in ui.js already re-measures textareas and maps for precisely
       this reason; the board cap simply was not on that list. It is now,
       and this guard makes a hidden pass a no-op rather than a wrong one.
       Left uncapped instead of wrongly capped: an uncapped column is
       merely taller than intended, which is a far better failure than a
       column that hides its own contents. */
    if (!body.offsetParent) return;

    const cards = body.querySelectorAll(".t-board-card");
    if (cards.length <= BOARD_CARDS_BEFORE_SCROLL) return;
    const fifth = cards[BOARD_CARDS_BEFORE_SCROLL - 1];
    const padBottom = parseFloat(getComputedStyle(body).paddingBottom) || 0;

    /* MEASURED FROM LAYOUT, NOT FROM THE PAINTED BOX.

       getBoundingClientRect() reports the TRANSFORMED rectangle, and these
       cards are transformed for the first third of a second of every page
       visit: `.page.visible .card{animation:cardEnter}` runs
       translateY(10px) scale(.98), staggered up to 120ms. A cap measured
       inside that window is measured against a card that is scaled and
       offset, so it comes out wrong — and because the number depends on
       how far the animation had got, EVERY remeasure produced a different
       cap. Renders restart the animation, so the columns kept resizing:
       the shaking, and the columns that showed too few cards until a
       click forced a fresh render after the animation had finished.

       offsetTop and offsetHeight are layout values. Transforms cannot
       reach them, so this now returns the same answer whether it runs
       mid-animation, after fonts load, or on resize. Both elements are
       measured against the same offsetParent so the difference between
       them is meaningful; where that isn't true the old measurement is
       still the better of the two available. */
    let h;
    if (fifth.offsetParent && fifth.offsetParent === body.offsetParent) {
      h = (fifth.offsetTop - body.offsetTop) + fifth.offsetHeight + padBottom;
    } else {
      h = fifth.getBoundingClientRect().bottom - body.getBoundingClientRect().top + padBottom;
    }
    if (h > 0) {
      body.style.maxHeight = `${Math.round(h)}px`;
      body.classList.add("t-board-col-capped");
    }
  }
}
/* Web fonts land after the first render, and Inter sets taller than the
   fallback: a cap measured before they arrive is a few pixels short and
   clips the fifth card. Remeasure once, when the fonts are in. */
if (document.fonts?.ready) document.fonts.ready.then(() => capBoardColumnHeights());

/* A resize changes every card's height, so the caps have to be remeasured.
   Debounced because resize fires continuously while a window is dragged,
   and each pass reads layout for every column on the board. */
let boardCapResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(boardCapResizeTimer);
  boardCapResizeTimer = setTimeout(capBoardColumnHeights, 120);
});

function initBoardSorting() {
  destroyBoardSortables();
  if (taskView !== "board" || sortByDate || typeof Sortable === "undefined") return;
  /* No `handle`: the whole card is draggable, which is what the GSI and
     Personal boards settled on and what people expect of a Kanban card.
     The ⠿ grip is still rendered as an affordance and is the most
     reliable place to start a drag on touch — it is the one spot with
     `touch-action:none`, so WebKit never mistakes a press there for a
     pan — but it is no longer REQUIRED. Dragging by the card body works
     again. */
  document.querySelectorAll("#taskList .t-board-col-body").forEach(container => {
    boardSortableInstances.push(Sortable.create(container, {
      group: "task-board", // shared across every column — this is what allows dragging between them, not just within one
      filter: "button, input, select, textarea, a, .t-chk",
      preventOnFilter: false,
      draggable: ".t-board-card", // GSI cards are pick-up-able here too — moveTaskToColumn routes them through setGsiTaskStatus/editProjectTask/archiveGsiTaskEntry instead of the native task functions
      animation: 140,
      easing: "cubic-bezier(0.2, 0, 0.2, 1)",
      delay: 200, delayOnTouchOnly: true, touchStartThreshold: 6,
      /* Same fallback treatment as the other boards: the clone goes on
         <body> so a .card's backdrop-filter can't become its containing
         block and offset it from the finger. */
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 4,
      ghostClass: "t-row-ghost", dragClass: "t-row-dragging", chosenClass: "t-row-chosen",
      scroll: true, scrollSensitivity: 90, scrollSpeed: 12,
      /* An empty column is a 5px target by default, which on a Kanban
         board is the one drop everybody misses — there is no card in it
         to aim at. 28px makes "somewhere in that column" enough. */
      emptyInsertThreshold: 28,
      /* onChoose, not just onStart: Sortable calls _appendGhost() — which
         MEASURES the source card to place the clone — before it dispatches
         "start". Adding the class in onStart alone lands after that
         measurement, so the containing-block reset in style.css would come
         a frame too late and the clone would keep the bad offset it was
         born with. onChoose fires first, before any ghost exists. */
      onChoose: () => document.body.classList.add("is-dragging"),
      onStart: () => document.body.classList.add("is-dragging"),
      onEnd: handleBoardDragEnd,
    }));
  });
}
function handleBoardDragEnd(evt) {
  document.body.classList.remove("is-dragging");
  markDragJustEnded(); // a drop lands a click on the card — don't let it open the task
  const draggedId = evt.item.dataset.taskId;
  const fromCol = evt.from.closest(".t-board-col")?.dataset.boardCol;
  const toCol = evt.to.closest(".t-board-col")?.dataset.boardCol;
  if (!draggedId || !toCol) { rerender(); return; }
  if (fromCol === toCol) {
    // Reordering within one column — identical position math to List
    // view's own reorder, it doesn't care what shape the container is.
    // GSI and Personal cards have no position field to reorder by, so
    // that function's state.tasks lookup misses and it leaves the card
    // alone; cross-column moves (below) are what those cards support.
    handleTaskDragEnd(evt);
    return;
  }
  /* The board is NOT rebuilt from the data any more, and the reason it no
     longer needs to be is worth stating plainly: every column on this
     board is defined by the very field the drop writes. Dropping on Today
     sets the date to today; on Upcoming, to a future date; on No Date,
     clears it; on Completed, marks it done. So the card SortableJS has
     already placed is, by construction, in the column its data says it
     belongs to. A rebuild could only put it back where it already is.

     What the rebuild was actually paying for was the card's own chips —
     the date it now carries, the strike-through, the archive button that
     appears once it's done. Those are patched directly below, on the one
     card that changed. Everything else on screen stays untouched, which
     is what makes the board hold still.

     No column rejects a drop any more — Overdue was the last one, and it
     now dates the task yesterday instead of refusing. The `ok === false`
     branch is kept as a backstop in case a future column needs to decline
     one, since silently swallowing a refused move would look like a bug. */
  const fromColEl = evt.from.closest(".t-board-col");
  const toColEl = evt.to.closest(".t-board-col");
  holdBoardSnap();
  const ok = commitWithoutRender(() => moveTaskToColumn(draggedId, toCol));

  if (ok === false) {
    // A refused move is the one case where the DOM really is wrong: the
    // card is sitting in a column the data rejected. Put it back.
    toast("That task can't move there");
    if (evt.from !== evt.to) {
      const sibling = evt.from.children[evt.oldIndex] || null;
      evt.from.insertBefore(evt.item, sibling);
    }
    syncColumnEmptyState(fromColEl); syncColumnEmptyState(toColEl);
    return;
  }

  /* Deferred one frame on purpose. onEnd runs INSIDE Sortable's _onDrop,
     which is still holding a reference to evt.item and still walking its
     own cleanup — swapping that node out from under it synchronously is
     the same re-entrancy the old code deferred its render for. A single
     frame of stale chips is invisible; the card does not move. */
  requestAnimationFrame(() => {
    patchBoardCardInPlace(draggedId);
    bumpColumnCount(fromColEl, -1);
    bumpColumnCount(toColEl, +1);
    syncColumnEmptyState(fromColEl);
    syncColumnEmptyState(toColEl);
    refreshTaskCounters();
    // Only the two columns that changed — see capOneColumnBody.
    [fromColEl, toColEl].forEach(col => {
      const body = col?.querySelector(".t-board-col-body");
      if (body) capOneColumnBody(body);
    });
    /* The other two Kanban boards render the same task from their own
       data and are now one move out of date. They live inside pages that
       are display:none right now, so redrawing them cannot shift a single
       pixel of what is on screen — this is the one repaint a drop can
       afford, because it is guaranteed to be invisible. */
    refreshHiddenWorkspaceBoards(draggedId);
  });
}

/* On the fold and on phones the board scrolls horizontally with
   scroll-snap-type:x mandatory. Releasing a card hands snapping straight
   back, and the browser's first act is to "correct" the board to the
   nearest column edge — which slides the board sideways the instant the
   finger lifts. body.is-dragging covers the drag itself; this covers the
   moment just after it, and hands snapping back two frames later once
   everything has settled. */
function holdBoardSnap() {
  const boards = [...document.querySelectorAll(".t-board")];
  boards.forEach(el => { el.style.scrollSnapType = "none"; });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    boards.forEach(el => { el.style.scrollSnapType = ""; });
  }));
}

/* GSI and Personal tasks reach this board as normalised COPIES (see
   renderTasks). Re-derive that same shape for a single task, from the real
   object, so one card can be re-rendered without re-running the whole
   merge. Native tasks are already the right shape and are returned as-is. */
function boardCardModel(id) {
  const found = findAnyTask(id);
  if (!found) return null;
  const { task: t, isGsi, isPersonal, project } = found;
  if (!isGsi && !isPersonal) return t;
  return {
    id: t.id, text: t.text, done: t.status === "done",
    category: isGsi ? "work" : "personal",
    flag: !!t.flag, priority: t.priority, link: t.link || "",
    dueDate: t.date || "", completedAt: null,
    isGsi: !!isGsi, isPersonal: !!isPersonal,
    projectId: project?.id || t.projectId || "",
    projectName: project?.name || t.projectName || "",
    status: t.status
  };
}
/* Re-render exactly one card, in place. The replacement lands at the same
   index in the same column, so nothing around it moves — the only visible
   change is the card's own chips, which is precisely what the drop
   changed. Sortable binds to the COLUMN, not to the cards inside it, so
   swapping a child out doesn't disturb it. */
function patchBoardCardInPlace(id) {
  const card = document.querySelector(`#taskList .t-board-card[data-task-id="${cssId(id)}"]`);
  if (!card) return false;
  const model = boardCardModel(id);
  // Archiving is the one move that takes a task off this board entirely.
  if (!model || model.archived) { card.remove(); return true; }
  const holder = document.createElement("div");
  holder.innerHTML = boardCardHtml(model);
  const fresh = holder.firstElementChild;
  if (!fresh) return false;
  card.replaceWith(fresh);
  return true;
}
/* Adjusted by a delta rather than recounted from the DOM. Upcoming's badge
   deliberately shows its TRUE total including anything folded away behind
   "show N later tasks" (see boardColumnHtml), so counting the cards
   actually on screen would quietly undercount it. */
function bumpColumnCount(colEl, delta) {
  const badge = colEl?.querySelector(".t-board-col-count");
  if (!badge) return;
  const next = Math.max(0, (parseInt(badge.textContent, 10) || 0) + delta);
  badge.textContent = String(next);
}
/* A column that has just been emptied needs its "Nothing here." back, and
   one that has just received its first card needs it gone. Rendered by
   boardColumnHtml on a full pass; maintained here on a drop. */
function syncColumnEmptyState(colEl) {
  const body = colEl?.querySelector(".t-board-col-body");
  if (!body) return;
  const hasCards = !!body.querySelector(".t-board-card");
  const hint = body.querySelector(":scope > p.hint");
  if (hasCards && hint) hint.remove();
  if (!hasCards && !hint) {
    const p = document.createElement("p");
    p.className = "hint";
    p.style.padding = "10px 4px";
    p.textContent = "Nothing here.";
    body.appendChild(p);
  }
}
/* The two open/total readouts renderTasks maintains, kept in step without
   re-running it. */
function refreshTaskCounters() {
  const openCount = state.tasks.filter(t => !t.done).length;
  const countEl = document.getElementById("taskCount");
  if (countEl) countEl.textContent = state.tasks.length ? `(${openCount} open)` : "";
  const catTasksSub = document.getElementById("catTasksSub");
  if (catTasksSub) catTasksSub.textContent =
    state.tasks.length ? `${openCount} of ${state.tasks.length} still open` : "Plan your day.";
  const archiveAllBtn = document.getElementById("taskArchiveAllBtn");
  if (archiveAllBtn) archiveAllBtn.disabled = !state.tasks.some(t => t.done && !t.archived);
}
/* Used by the board composer to show a just-added task without rebuilding
   anything. Returns false if the card can't be placed — a different view is
   on screen, the column is folded away — and the composer falls back to a
   normal render in that case.

   Inserted at the TOP of the column because that is where the data puts
   it: createNativeTask gives every new task the lowest position on the
   board, and the column sorts by position. The DOM and a later full render
   therefore agree, which is the whole requirement for skipping the render. */
export function insertNativeBoardCard(task, columnKey) {
  if (taskView !== "board") return false;
  const col = document.querySelector(`#taskList .t-board-col[data-board-col="${cssId(columnKey)}"]`);
  const body = col?.querySelector(".t-board-col-body");
  if (!body) return false;
  const holder = document.createElement("div");
  holder.innerHTML = boardCardHtml(task);
  const el = holder.firstElementChild;
  if (!el) return false;
  body.insertBefore(el, body.querySelector(".t-board-card"));
  bumpColumnCount(col, +1);
  syncColumnEmptyState(col);
  refreshTaskCounters();
  capOneColumnBody(body);
  return true;
}
function refreshHiddenWorkspaceBoards(id) {
  const found = findAnyTask(id);
  if (!found) return;
  try {
    if (found.isGsi) renderGsi();
    else if (found.isPersonal) renderPersonalWorkspace();
  } catch (e) { /* a stale sibling board is never worth breaking a drop over */ }
}
// Every actual mutation here goes through the exact same functions the
// rest of the app already uses (toggleTask, editTaskMeta, archiveTask,
// restoreArchivedTaskEntry, and their GSI counterparts setGsiTaskStatus/
// archiveGsiTaskEntry) — sync, Google Calendar, and persistence are
// entirely their responsibility, not reimplemented here. GSI tasks are
// looked up via findAnyTask (same helper the popup/toggle/flag/edit
// paths already share) so a card's status/date live-updates in its
// actual GSI project, not in a copy.
function moveTaskToColumn(id, targetCol) {
  const found = findAnyTask(id);
  if (!found) return false;
  const { task: t, isGsi, isPersonal, project } = found;
  const todayStr = new Date().toISOString().slice(0, 10);
  // Personal tasks share GSI's field shape (date/status), so they read the
  // same way — but every WRITE below dispatches to its own tree.
  const projShaped = isGsi || isPersonal;
  const curDate = projShaped ? t.date : t.dueDate;
  const done = projShaped ? t.status === "done" : t.done;

  if (targetCol === "archived") {
    if (isPersonal) {
      if (t.status !== "done") setPwTaskStatus(id, "done");
      archivePwTaskEntry(project.id, id);
      return true;
    }
    if (isGsi) {
      if (done) { archiveGsiTaskEntry(project.id, id); return true; }
      setGsiTaskStatus(id, "done"); // GSI archive is for finished tasks, same intent as native's requirement below
      archiveGsiTaskEntry(project.id, id);
      return true;
    }
    if (t.archived) return true;
    if (!t.done) toggleTask(id); // archiveTask requires a completed task
    archiveTask(id);
    return true;
  }
  if (targetCol === "completed") {
    if (isPersonal) {
      if (t.status !== "done") setPwTaskStatus(id, "done");
      return true;
    }
    if (isGsi) {
      if (t.status !== "done") setGsiTaskStatus(id, "done");
      return true;
    }
    if (t.archived) { restoreArchivedTaskEntry(id); return true; } // "Archived -> Completed" is a restore, not a re-completion
    if (!t.done) toggleTask(id);
    return true;
  }
  // Every remaining target is date-based — a done/archived task needs
  // to come back to "open" first before its date means anything. GSI
  // has no boolean "done" to just flip back — it's reopened to "todo",
  // since which of todo/progress/blocked it was before "done" isn't tracked.
  if (isPersonal) {
    if (t.status === "done") setPwTaskStatus(id, "todo");
  } else if (isGsi) {
    if (t.status === "done") setGsiTaskStatus(id, "todo");
  } else {
    if (t.archived) restoreArchivedTaskEntry(id);
    if (t.done) toggleTask(id);
  }

  if (targetCol === "today") { editTaskMeta(id, "dueDate", todayStr); return true; }
  if (targetCol === "nodate") { editTaskMeta(id, "dueDate", ""); return true; }
  if (targetCol === "upcoming") {
    /* An undated task dragged here used to open a prompt() demanding a
       hand-typed YYYY-MM-DD — in the middle of a drag, which is the worst
       possible moment to stop and type, and with no calendar to consult.
       Mistype it and the drop was rejected outright and the card sprang
       back.

       Dropping onto "Upcoming" already states the intent: this is due,
       and later than today. Tomorrow is the smallest date satisfying
       that, so it is applied directly — exactly what the branch below
       already did for a task dragged from Today or Overdue. The two paths
       differed for no reason other than one having a date already.

       Nothing is lost: the date is shown on the card and editable in
       place, and dragging back to No Date clears it. */
    if (!curDate || curDate <= todayStr) {
      const d = new Date(); d.setDate(d.getDate() + 1);
      const iso = d.toISOString().slice(0, 10);
      editTaskMeta(id, "dueDate", iso);
      if (!curDate) toast("Due tomorrow — tap the date on the card to change it");
    }
    return true;
  }
  if (targetCol === "overdue") {
    /* Overdue used to be the only column that REFUSED a drop, on the
       reasoning that the app shouldn't invent a date in the past. But
       every other column here sets the date the drop implies — Today sets
       today, Upcoming sets tomorrow — so Overdue was inconsistent, and a
       column you can drag out of but never into reads as broken rather
       than as principled.

       Dropping here states an intent plainly: this was due and it is late.
       Yesterday is the smallest date that satisfies it, which keeps the
       invention to a minimum, and the date is editable on the card. A task
       already dated in the past is left exactly as it is, so dragging a
       genuinely old item between columns never rewrites its history. */
    if (curDate && curDate < todayStr) return true;   // already overdue — change nothing
    const d = new Date(); d.setDate(d.getDate() - 1);
    const iso = d.toISOString().slice(0, 10);
    editTaskMeta(id, "dueDate", iso);
    toast("Marked overdue — due yesterday. Tap the date on the card to set the real one.");
    return true;
  }
  return true;
}

export function setTaskView(v) {
  taskView = v;
  state.taskViewPref = v;
  persist(false);
  const switcher = document.getElementById("taskViewSwitch");
  if (switcher) switcher.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  renderTasks();
}
/* Prev/Next step by whatever range is on screen — a week at a time in
   Week, a month in Month, a year in Year, a whole block in Years — so the
   same two arrows keep meaning "back one" and "forward one" throughout. */
export function calendarPrevMonth() { shiftCalendar(-1); }
export function calendarNextMonth() { shiftCalendar(1); }
function shiftCalendar(dir) {
  expandedCalDays.clear();
  const scale = currentCalScale();
  if (scale === "week") calendarMonth.setDate(calendarMonth.getDate() + 7 * dir);
  // setMonth on the 31st of a month rolls into the next one ("Jan 31" +1
  // month = "Mar 3"), so month steps are rebuilt from the parts instead.
  else if (scale === "month") calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + dir, 1);
  else if (scale === "year") calendarMonth = new Date(calendarMonth.getFullYear() + dir, calendarMonth.getMonth(), 1);
  else calendarMonth = new Date(calendarMonth.getFullYear() + YEARS_BLOCK * dir, 0, 1);
  renderTasks();
}
export function calendarGoToday() {
  expandedCalDays.clear();
  calendarMonth = new Date();
  if (currentCalScale() !== "week") calendarMonth.setDate(1);
  renderTasks();
}

/* The range switcher beside Today. Changing range keeps the date you were
   looking at: Month → Week opens the week containing the 1st of that
   month, Year → Month opens the month you were already in. */
export function setCalendarScale(v) {
  if (!CAL_SCALES.some(([k]) => k === v)) return;
  expandedCalDays.clear();
  calendarScale = v;
  state.calendarScalePref = v;
  persist(false);
  if (v !== "week") calendarMonth.setDate(1);
  renderTasks();
}
/* Drilling down: tapping a month in Year view, or a year in Years view. */
export function calendarZoomTo(dateStr, scale) {
  expandedCalDays.clear();
  const [y, m, d] = dateStr.split("-").map(Number);
  calendarMonth = new Date(y, m - 1, d || 1);
  if (scale) { calendarScale = scale; state.calendarScalePref = scale; persist(false); }
  renderTasks();
}
function currentCalScale() {
  if (calendarScale === null) calendarScale = state.calendarScalePref || "month";
  return calendarScale;
}

/* "+N more" used to be an inert <div>: it looked like a control, did
   nothing, and the click fell through to the cell — whose handler adds a
   NEW task. So the one affordance for seeing hidden tasks instead created
   an extra one. It is a real button now, and stops propagation. */
export function toggleCalendarDay(dateStr) {
  if (expandedCalDays.has(dateStr)) expandedCalDays.delete(dateStr);
  else expandedCalDays.add(dateStr);
  renderTasks();
}
export function calendarQuickAdd(dateStr) {
  if (calendarClickSuppressed()) return; // the click that trails a drop, not a real one
  const v = prompt(`Add a task for ${dateStr}:`);
  if (!v || !v.trim()) return;
  createNativeTask(v.trim(), dateStr);
  persist(); rerender();
}

/* ---------- Day view — tapping a day cell opens this, a full agenda
   for that one date, instead of the month grid's 3-chip preview. Mirrors
   the "tap a day → see everything, add from right there" pattern of a
   native calendar app's day sheet. dayViewDate is which date it's
   currently showing; null means the modal is closed. */
let dayViewDate = null;

function tasksForDayView(dateStr) {
  // Same Work/Personal/GSI/Personal-Workspace merge renderTasks() itself
  // uses for the main list — a day view under a filtered Work/Personal
  // tab should only show what that tab would show on the grid behind it.
  let list = state.tasks.filter(t => taskFilter === "all" || (t.category || "work") === taskFilter);
  if (taskFilter === "all" || taskFilter === "work") {
    list = list.concat(getAllGsiTasksFlat().map(t => ({
      id: t.id, text: t.text, done: t.status === "done", category: "work",
      flag: !!t.flag, link: t.link || "", dueDate: t.date || "", isGsi: true,
      projectId: t.projectId, projectName: t.projectName, status: t.status
    })));
  }
  if (taskFilter === "all" || taskFilter === "personal") {
    list = list.concat(getAllPwTasksFlat().map(t => ({
      id: t.id, text: t.text, done: t.status === "done", category: "personal",
      flag: !!t.flag, link: t.link || "", dueDate: t.date || "", isPersonal: true,
      projectId: t.projectId, projectName: t.projectName, status: t.status
    })));
  }
  return list.filter(t => t.dueDate === dateStr);
}

export function openDayView(dateStr) {
  if (calendarClickSuppressed()) return; // the click trailing a chip drag/drop, not a real tap
  dayViewDate = dateStr;
  const bg = document.getElementById("dayViewModalBg");
  if (!bg) return;
  bg.classList.add("open");
  renderDayView();
  // Land focus in the add field so typing a task is a single tap + type,
  // same as the target native day sheet.
  setTimeout(() => document.getElementById("dayViewAddInput")?.focus(), 50);
}
export function closeDayView() {
  document.getElementById("dayViewModalBg")?.classList.remove("open");
  dayViewDate = null;
}
function renderDayView() {
  const body = document.getElementById("dayViewBody");
  if (!body || !dayViewDate) return;
  const titleEl = document.getElementById("dayViewTitle");
  const subEl = document.getElementById("dayViewSub");
  const d = new Date(dayViewDate + "T00:00:00");
  if (titleEl) titleEl.textContent = d.toLocaleDateString("en-IN", { day: "numeric", weekday: "long" });
  if (subEl) subEl.textContent = d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  const dayTasks = tasksForDayView(dayViewDate);
  body.innerHTML = dayTasks.length
    ? dayTasks.map(t => `
      <div class="day-view-task ${t.done ? "done" : ""}" data-task-id="${t.id}">
        <button class="day-view-task-chk" onclick="event.stopPropagation();dayViewToggleTask('${t.id}')" aria-label="Toggle complete"></button>
        <button class="day-view-task-title" onclick="event.stopPropagation();dayViewOpenTask('${t.id}')" title="${esc(t.text)}">${esc(t.text)}</button>
        ${t.flag ? `<span class="day-view-task-flag" title="Priority">🚩</span>` : ""}
      </div>`).join("")
    : `<p class="hint" style="padding:4px 2px 0">No tasks on this day yet.</p>`;
  const addInput = document.getElementById("dayViewAddInput");
  if (addInput) addInput.placeholder = `Add on ${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;
}
export function dayViewToggleTask(id) {
  toggleTask(id); // persists + triggers the full rerender itself
  renderDayView();
}
export function dayViewOpenTask(id) {
  openTaskPopup(id); // opens the full task detail on top; the day view stays open behind it
}
export function dayViewAddTask() {
  const input = document.getElementById("dayViewAddInput");
  if (!input || !dayViewDate) return;
  const v = (input.value || "").trim();
  if (!v) return;
  createNativeTask(v, dayViewDate);
  input.value = "";
  persist(); rerender();
  renderDayView();
}
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
// Opens the native date picker for a task's (hidden) date input,
// triggered by tapping the calendar icon next to its due-date text.
// editTaskMeta() already re-renders on change, and the Overdue/Today/
// Upcoming grouping is recomputed fresh on every render from each
// task's current dueDate — so picking a new date here already moves
// the task to the right section automatically, with no extra code
// needed for that part.
export function toggleTaskLinkEdit(evt, id) {
  evt.stopPropagation();
  const input = document.getElementById("task-link-edit-" + id);
  if (!input) return;
  input.style.display = "inline-block";
  input.focus();
}
export function openDueDatePicker(id) {
  /* Was input.showPicker() — the OS date spinner, where "tomorrow" costs
     three interactions. openDateSheet drives this same hidden input, so
     the save path below it is untouched. See js/date-sheet.js. */
  openDateSheet(`dueInput-${id}`);
}
export function openPopupDueDatePicker(id) {
  /* Was input.showPicker() — the OS date spinner, where "tomorrow" costs
     three interactions. openDateSheet drives this same hidden input, so
     the save path below it is untouched. See js/date-sheet.js. */
  openDateSheet(`dueInput-popup-${id}`);
}

// ---------- Task detail popup — opened from a calendar chip's title
// (the chip's own checkbox handles completion directly, without
// opening this). Works for native and GSI tasks alike by using the
// same lookup taskRowHtml() already uses for its breadcrumb, and
// routes every action through the exact same functions the rest of
// the app already uses (toggleTask, toggleFlag/toggleProjectTaskFlag,
// editTask/editProjectTask) — nothing task-related is reimplemented
// here, only the display around it.
export function findAnyTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) return { task: t, isGsi: false };
  const { task: gt, project } = findProjectTask(id);
  if (gt) return { task: gt, isGsi: true, project };
  /* Personal tasks are shaped like GSI ones (status/date/link/flag) but are
     deliberately NOT reported as isGsi. Several callers read that flag as
     "lives in state.gsi" and act on it — archiveGsiTaskEntry(project.id)
     being the dangerous one — so a personal task claiming to be GSI would
     write into the wrong tree. Callers that care about the task's SHAPE
     test isGsi || isPersonal; callers that care about where it LIVES test
     one flag or the other. */
  const { task: pt, project: pp } = findPwProjectTask(id);
  if (pt) return { task: pt, isGsi: false, isPersonal: true, project: pp };
  return null;
}
// Shared by the "Add a task" project picker and each task's own .t-meta
// project select — "No project" is always added separately by the caller,
// this only builds the actual GSI project options.
/* `scope` limits which destinations are offered:
     "work"     — a task already inside a GSI project
     "personal" — a task already inside a personal workspace
     undefined  — a native task, which may go either way
   A task never sees the opposite tree, because GSI <-> Personal moves are
   not allowed: the two trees are separate by design, and every sync,
   trash and health-check path assumes a task stays in the one it was
   created in. Offering an option that would be refused is worse than not
   offering it. */
function projectOptionsHtml(selectedId, scope) {
  const opt = p => `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${esc(p.name)}</option>`;
  const work = getProjectList().map(opt).join("");
  const personal = getPwProjectList().map(opt).join("");
  if (scope === "work") return work;
  if (scope === "personal") return personal;
  return (work ? `<optgroup label="Work · GSI">${work}</optgroup>` : "") +
         (personal ? `<optgroup label="Personal Workspace">${personal}</optgroup>` : "");
}
const projectScopeOf = t => t.isGsi ? "work" : (t.isPersonal ? "personal" : undefined);
// Moves a task between "no project" (native) and a GSI project, or
// between two GSI projects. Native<->GSI conversions remap the task's
// shape the same way createNativeTask/quickAddGsiTask build one from
// scratch (done<->status, dueDate<->date), and drop any existing
// googleEventId so it re-syncs cleanly under whichever system now owns
// it rather than carrying over an event created by the other one. The
// task keeps its id either way, so an open .t-meta panel for it stays
// open and pointed at the same row across the conversion.
/* The fields the detail modal owns. Moving a task between projects
   rebuilds it from a fixed list of properties, so anything the modal
   added has to be named here or it vanishes on the move. */
function detailFields(t) {
  const out = {};
  if (t.desc) out.desc = t.desc;
  if (Array.isArray(t.subtasks) && t.subtasks.length) out.subtasks = t.subtasks;
  if (Array.isArray(t.labels) && t.labels.length) out.labels = t.labels;
  if (t.priority) out.priority = t.priority;
  if (t.createdAt) out.createdAt = t.createdAt;
  if (t.updatedAt) out.updatedAt = t.updatedAt;
  return out;
}
export function changeTaskProject(id, projectId) {
  const found = findAnyTask(id);
  if (!found) return;
  const { task: t, isGsi, isPersonal } = found;
  const toPersonal = !!projectId && getPwProjectList().some(p => p.id === projectId);

  // Cross-tree moves stay refused. The picker doesn't offer them, but a
  // stale select rendered before a re-render still could.
  if ((isGsi && toPersonal) || (isPersonal && projectId && !toPersonal)) {
    toast("A task can't move between Work and Personal workspaces");
    return;
  }

  if (isPersonal) {
    if (!projectId) {
      // Personal workspace -> the Overview list, as a personal task.
      const plucked = pluckPwProjectTask(id);
      if (!plucked) return;
      state.tasks.push({
        id: plucked.id, text: plucked.text, done: plucked.status === "done",
        category: "personal", flag: !!plucked.flag, link: plucked.link || "",
        dueDate: plucked.date || "", completedAt: plucked.status === "done" ? Date.now() : null,
        googleEventId: null, position: nextManualPosition(),
        ...detailFields(plucked)
      });
      persist(); rerender();
      return;
    }
    changePwTaskProject(id, projectId); // between two personal workspaces
    return;
  }

  if (!isGsi) {
    if (!projectId) return; // already native, nothing to do
    if (toPersonal) {
      // Overview list -> a personal workspace.
      const ok = addPwProjectTaskRaw(projectId, {
        id: t.id, text: t.text, status: t.done ? "done" : "todo",
        date: t.dueDate || "", link: t.link || "", flag: !!t.flag,
        ...detailFields(t)
      });
      if (!ok) return;
      state.tasks = state.tasks.filter(x => x.id !== id);
      persist(); rerender();
      return;
    }
    const ok = addProjectTaskRaw(projectId, {
      id: t.id, text: t.text, status: t.done ? "done" : "todo",
      date: t.dueDate || "", link: t.link || "", flag: !!t.flag, googleEventId: null,
      // Carried across explicitly. This remap rebuilds the task rather
      // than moving the object, so any field not named here is dropped —
      // which silently threw away the description, sub-tasks and labels
      // the detail view had just been used to write.
      ...detailFields(t)
    });
    if (!ok) return; // project vanished (e.g. deleted mid-edit) — leave the native task alone
    state.tasks = state.tasks.filter(x => x.id !== id);
    persist(); rerender();
    return;
  }
  if (!projectId) {
    const plucked = pluckProjectTask(id);
    if (!plucked) return;
    state.tasks.push({
      id: plucked.id, text: plucked.text, done: plucked.status === "done",
      category: "work", flag: !!plucked.flag, link: plucked.link || "",
      dueDate: plucked.date || "", completedAt: plucked.status === "done" ? Date.now() : null,
      googleEventId: null, position: nextManualPosition(),
      ...detailFields(plucked) // same reason as above
    });
    persist(); rerender();
    return;
  }
  moveProjectTask(id, projectId); // GSI -> a different GSI project
}
/* Kept as the single entry point every card already calls, so nothing on
   the board, the calendar or the GSI pages had to change. It now opens
   the detail modal instead of the old small popup. */
/* One entry point for "the user clicked a task card", used by every
   surface. It swallows the click that trails a drag — a drop lands a
   pointerup on the card, which would otherwise open the task every time
   something was moved. */
let dragEndedAt = 0;
export function markDragJustEnded() { dragEndedAt = Date.now(); }
export function openTaskCardDetail(id) {
  if (Date.now() - dragEndedAt < 350) return;
  if (calendarClickSuppressed()) return;
  openTaskModal(id);
}

export function openTaskPopup(id) {
  if (calendarClickSuppressed()) return;
  openTaskModal(id);
  return;
}
function legacyOpenTaskPopup(id) {
  // A chip is dragged by its title button, so the drop is followed by that
  // button's click — which would open the detail popup on top of the move.
  if (calendarClickSuppressed()) return;
  const bg = document.getElementById("taskPopupModalBg");
  if (!bg) return;
  bg.classList.add("open");
  renderTaskPopup(id);
}
export function closeTaskPopup() { document.getElementById("taskPopupModalBg")?.classList.remove("open"); }
function renderTaskPopup(id) {
  const box = document.getElementById("taskPopupBody");
  if (!box) return;
  const found = findAnyTask(id);
  if (!found) { box.innerHTML = `<p class="hint">This task no longer exists.</p>`; return; }
  const { task: t, isGsi, project } = found;
  const done = isGsi ? t.status === "done" : t.done;
  const due = fmtDue(isGsi ? t.date : t.dueDate);
  const tag = isGsi
    ? `${esc((project && project.name) || t.projectName || "")} / ${({ todo: "To do", progress: "In progress", done: "Done", blocked: "Blocked" })[t.status] || "To do"}`
    : `${(t.category || "work") === "work" ? "Work" : "Personal"}`;
  box.innerHTML = `
    <div class="t-popup-top">
      <button class="t-chk ${done ? "on" : ""}" onclick="popupToggleDone('${id}')" aria-label="Toggle task">
        <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <div class="t-popup-title ${done ? "done" : ""}">${esc(t.text)}</div>
      <button class="t-flag ${t.flag ? "on" : ""}" onclick="popupToggleFlag('${id}')" title="${t.flag ? "Unflag" : "Flag as priority"}">🚩</button>
    </div>
    ${due ? `<div class="t-due ${due.cls === "overdue" ? "t-overdue" : due.cls === "" ? "t-future" : ""}" style="margin:12px 0 0 38px">
      <button class="t-due-chip" onclick="openPopupDueDatePicker('${id}')" title="Change due date">
        <span class="t-due-chip-ico" aria-hidden="true">📅</span>${due.text}</button>
      <input type="date" class="t-due-hidden-input" id="dueInput-popup-${id}" value="${isGsi ? (t.date || "") : (t.dueDate || "")}"
        onchange="popupEditDate('${id}',this.value)">
    </div>` : ""}
    <div style="margin:10px 0 0 38px"><span class="t-board-card-tag">${tag}</span></div>
    ${t.link ? `<a href="${esc(t.link.startsWith("http") ? t.link : "https://" + t.link)}" target="_blank" rel="noopener" class="t-link-go" style="margin:12px 0 0 38px;display:inline-block">🔗 Open link</a>` : ""}
  `;
}
export function popupToggleDone(id) {
  toggleTask(id); // native/GSI routing already handled inside toggleTask itself
  renderTaskPopup(id);
}
export function popupToggleFlag(id) {
  toggleFlag(id); // already routes to GSI internally when needed
  renderTaskPopup(id);
}
export function popupEditDate(id, value) {
  editTaskMeta(id, "dueDate", value); // already routes to GSI internally and re-sorts sections on change
  renderTaskPopup(id);
}

function taskRowHtml(t) {
  const due = fmtDue(t.dueDate);
  const breadcrumb = t.isGsi
    ? `${esc(t.projectName)} / ${({todo:"To do",progress:"In progress",done:"Done",blocked:"Blocked"})[t.status] || "To do"}`
    : `${(t.category||"work")==="work"?"Work":"Personal"}${due ? " / " + due.text : ""}`;
  return `
    <div class="t-row ${t.done ? "done" : ""} ${expandedTaskId===t.id ? "t-expanded" : ""}" data-task-id="${t.id}" data-is-gsi="${t.isGsi ? "1" : "0"}" onclick="openTaskCardDetail('${t.id}')" role="button" tabindex="0"
      onkeydown="if(event.key==='Enter'){event.preventDefault();openTaskCardDetail('${t.id}')}">
      ${t.isGsi ? `<div class="t-drag-handle t-drag-handle-spacer" aria-hidden="true"></div>`
                : `<div class="t-drag-handle" title="Drag to reorder" onclick="event.stopPropagation()">⠿</div>`}
      <button class="t-chk ${prioClass(t)} ${t.done ? "on" : ""}" onclick="event.stopPropagation();toggleTask('${t.id}')" aria-label="Toggle task" title="${prioLabel(t)}">
        <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <div class="t-main">
        <div class="t-title-line">
          <textarea class="t-title ${t.link ? "t-linked" : ""}" rows="1"
            onclick="event.stopPropagation()" onchange="editTask('${t.id}',this.value)" oninput="autoGrow(this)">${esc(t.text)}</textarea>
          <button class="t-flag ${t.flag ? "on" : ""}" onclick="event.stopPropagation();toggleFlag('${t.id}')"
            title="${t.flag ? "Unflag" : "Flag as priority"}">🚩</button>
        </div>
        ${due ? `<div class="t-due ${due.cls==="overdue"?"t-overdue":due.cls===""?"t-future":""}">
          <button class="t-due-chip" onclick="event.stopPropagation();openDueDatePicker('${t.id}')" title="Change due date">
            <span class="t-due-chip-ico" aria-hidden="true">📅</span>${due.text}</button>
          <input type="date" class="t-due-hidden-input" id="dueInput-${t.id}" value="${t.dueDate}"
            onclick="event.stopPropagation()" onchange="event.stopPropagation();editTaskMeta('${t.id}','dueDate',this.value)">
        </div>` : `<div class="t-due t-due-empty">
          <button class="t-add-date-btn" onclick="event.stopPropagation();openDueDatePicker('${t.id}')">📅 Add date</button>
          <input type="date" class="t-due-hidden-input" id="dueInput-${t.id}" value=""
            onclick="event.stopPropagation()" onchange="event.stopPropagation();editTaskMeta('${t.id}','dueDate',this.value)">
        </div>`}
        ${t.link ? `<a href="${esc(t.link.startsWith("http")?t.link:"https://"+t.link)}" target="_blank" rel="noopener" class="t-link-go" onclick="event.stopPropagation()">🔗 Open link</a>`
          : `<button class="t-add-link-btn" onclick="toggleTaskLinkEdit(event,'${t.id}')">+ Add link</button>`}
        <input type="text" class="t-link-input" id="task-link-edit-${t.id}" placeholder="Paste a link…" value="${esc(t.link||"")}"
          onclick="event.stopPropagation()" onchange="editTaskMeta('${t.id}','link',this.value)" onblur="this.style.display='none'" style="display:none">
      </div>
      <div class="t-right">
        <span class="t-breadcrumb">${breadcrumb}</span>
        ${t.done && t.completedAt ? `<span class="t-completed-note">✓ ${fmtCompletedAt(t.completedAt)}</span>` : ""}
        ${t.done ? (t.isGsi
          ? `<button class="t-archive-btn" onclick="event.stopPropagation();archiveGsiTaskEntry('${t.projectId}','${t.id}')" title="Archive">🗂 Archive</button>`
          : `<button class="t-archive-btn" onclick="event.stopPropagation();archiveTask('${t.id}')" title="Archive">🗂 Archive</button>`) : ""}
      </div>
    </div>
    <div class="t-meta" data-meta-for="${t.id}" onclick="event.stopPropagation()">
      ${t.isGsi ? "" : `
      <select onchange="editTaskMeta('${t.id}','category',this.value)">
        <option value="work" ${(t.category||"work")==="work"?"selected":""}>Work</option>
        <option value="personal" ${t.category==="personal"?"selected":""}>Personal</option>
      </select>`}
      <select onchange="changeTaskProject('${t.id}',this.value)" title="GSI project">
        <option value="">No project</option>
        ${projectOptionsHtml(t.projectId || "", projectScopeOf(t))}
      </select>
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
// making cards enormous and barely readable. So this card keeps the title
// on its own line and moves metadata into a small tag row underneath.
// The title itself is no longer truncated — the narrow-wrapping it used to
// suffer from was a missing overflow-wrap rule, not a length problem, and
// that is now fixed in .t-board-card-title. Long NGDR filenames wrap and
// stay fully readable, matching the GSI and Personal boards.
/* Priority is shown by COLOURING THE CHECKBOX RING rather than by a flag
   button sitting opposite the title, which is how Todoist does it. The
   button was fixed furniture on every card, occupying width the title
   needed and repeating information the ring can carry for free.

   Priority stays fully editable — the task detail already has the real
   four-level control, and it is a better home for it than a binary
   toggle: the card was only ever able to express P1 or nothing.

   The same expression the detail panel uses, so a task flagged before
   priorities existed still reads as P1. Exported because the GSI and
   Personal boards render the same .t-board-card and need it too. */
export function prioClass(t) {
  const p = t.priority || (t.flag ? "p1" : "p4");
  return p === "p4" ? "" : "prio-" + p;
}
export function prioLabel(t) {
  const p = t.priority || (t.flag ? "p1" : "p4");
  return p === "p4" ? "Toggle task" : "Toggle task · Priority " + p.slice(1);
}

function boardCardHtml(t) {
  const due = fmtDue(t.dueDate);
  const tag = t.isGsi
    ? `${esc(t.projectName)} / ${({ todo: "To do", progress: "In progress", done: "Done", blocked: "Blocked" })[t.status] || "To do"}`
    : `${(t.category || "work") === "work" ? "Work" : "Personal"}`;
  return `
    <div class="t-board-card ${t.done ? "done" : ""}${t.flag ? " flagged" : ""}" data-task-id="${t.id}" data-is-gsi="${t.isGsi ? "1" : "0"}" onclick="openTaskCardDetail('${t.id}')" role="button" tabindex="0"
      onkeydown="if(event.key==='Enter'){event.preventDefault();openTaskCardDetail('${t.id}')}">
      <div class="t-board-card-top">
        <span class="t-board-card-handle" aria-hidden="true">⠿</span>
        <button class="t-chk ${prioClass(t)} ${t.done ? "on" : ""}" onclick="event.stopPropagation();toggleTask('${t.id}')"
          aria-label="Toggle task" title="${prioLabel(t)}">
          <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
        <span class="t-board-card-title">${esc(t.text)}</span>
      </div>
      <div class="t-board-card-meta">
        ${due ? `<span class="t-board-card-date ${due.cls}">
          <button class="t-due-chip" onclick="event.stopPropagation();openDueDatePicker('${t.id}')" title="Change due date">
            <span class="t-due-chip-ico" aria-hidden="true">🗓</span>${due.text}</button>
          <input type="date" class="t-due-hidden-input" id="dueInput-${t.id}" value="${t.isGsi ? (t.date || "") : (t.dueDate || "")}"
            onclick="event.stopPropagation()" onchange="event.stopPropagation();editTaskMeta('${t.id}','dueDate',this.value)">
          </span>` : `<span class="t-board-card-date">
          <button class="t-add-date-btn" onclick="event.stopPropagation();openDueDatePicker('${t.id}')">🗓 Add date</button>
          <input type="date" class="t-due-hidden-input" id="dueInput-${t.id}" value=""
            onclick="event.stopPropagation()" onchange="event.stopPropagation();editTaskMeta('${t.id}','dueDate',this.value)">
          </span>`}
        ${t.link
          ? `<a href="${esc(t.link.startsWith("http")?t.link:"https://"+t.link)}" target="_blank" rel="noopener" class="t-board-card-tag" style="text-decoration:none" onclick="event.stopPropagation()">🔗 Link</a>`
          : `<button class="t-add-link-btn" onclick="event.stopPropagation();toggleTaskLinkEdit(event,'${t.id}')">+ Link</button>`}
        <input type="text" class="t-link-input" id="task-link-edit-${t.id}" placeholder="Paste a link…" value="${esc(t.link||"")}"
          onclick="event.stopPropagation()" onchange="editTaskMeta('${t.id}','link',this.value)" onblur="this.style.display='none'" style="display:none">
        <span class="t-board-card-tag">${tag}</span>
        <select class="t-board-project-sel" title="Move to project" onclick="event.stopPropagation()" onchange="event.stopPropagation();changeTaskProject('${t.id}',this.value)">
          <option value="">No project</option>
          ${projectOptionsHtml(t.projectId || "", projectScopeOf(t))}
        </select>
        ${t.done ? (t.isGsi
          ? `<button class="t-archive-btn" onclick="event.stopPropagation();archiveGsiTaskEntry('${t.projectId}','${t.id}')" title="Archive">🗂</button>`
          : `<button class="t-archive-btn" onclick="event.stopPropagation();archiveTask('${t.id}')" title="Archive">🗂</button>`) : ""}
      </div>
    </div>`;
}
/* The two bespoke quick-add rows here — a bare text box for Today, and a
   text box plus a raw dd-mm-yyyy date field for Upcoming — are replaced by
   the same composer the GSI and Personal boards use. They could not set a
   priority or a link, and the date input squeezed into a column was the
   widest, least readable control on the board.

   "No Date" gains an add button it never had, which was an odd gap: it is
   a perfectly reasonable place to capture something undated. */
function boardQuickAddHtml(key) {
  if (!nativeColumnAccepts(key)) return "";
  if (isComposerOpen("native", key)) return composerHtml("native", key);
  return `
    <div class="t-board-quickadd">
      <button class="t-board-col-add" onclick="openComposer('native','${key}')">+ Add task</button>
    </div>`;
}
/* ---------- Collapsible board columns ----------
   Completed columns grow without bound and push the useful columns off
   screen, so they need to be foldable. Implemented once and exported,
   because Work·GSI and Personal have Done columns with the same problem —
   three separate implementations is how the boards drifted apart before.

   Per device, not synced: folding the Done column on a phone shouldn't
   fold it on the desktop, and a view preference must never be able to
   bump updatedAt and take part in a sync conflict. Same treatment as the
   task view preference and the trash collapse. */
const COLLAPSE_KEY = "lifeos-collapsed-cols";
function collapsedCols() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]")); }
  catch (_) { return new Set(); }
}
export function isColCollapsed(board, key) {
  const set = collapsedCols();
  /* Completed starts collapsed: it is a record of what is already done, and
     left open it is the longest column on the board. Once toggled the
     choice is remembered like any other, so this only decides the first
     view on a device. */
  if (key === "completed" && !set.has(board + ":completed:seen")) return true;
  return set.has(board + ":" + key);
}
export function toggleBoardCol(board, key) {
  const set = collapsedCols();
  const id = board + ":" + key;
  if (key === "completed" && !set.has(board + ":completed:seen")) {
    // First touch of Completed: record that it has been seen, and open it.
    set.add(board + ":completed:seen");
    set.delete(id);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch (_) {}
    rerender();
    return;
  }
  if (set.has(id)) set.delete(id); else set.add(id);
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch (_) {}
  rerender();
}

/* The head is a button so it is keyboard reachable; the count sits outside
   it so it reads as a label rather than part of the control.

   The click is handled by ONE delegated listener on document (below)
   rather than an inline onclick attribute. Inline handlers resolve against
   the global scope at click time, so they depend on app.js having attached
   the function to window — a single unrelated error during boot silently
   turns every such control into a dead element, with no clue at the point
   of failure. Delegation binds once, from inside the module that owns the
   behaviour, and cannot be broken that way. */
export function boardColHeadHtml(board, key, label, count) {
  const collapsed = isColCollapsed(board, key);
  return `
    <div class="t-board-col-head">
      <button type="button" class="t-board-col-toggle"
        data-col-board="${board}" data-col-key="${key}"
        aria-expanded="${!collapsed}" title="${collapsed ? "Show" : "Hide"} ${esc(label)}">
        <span class="t-board-col-burger" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>
          </svg>
        </span>
        <span class="t-board-col-title">${esc(label)}</span>
      </button>
      <span class="t-section-count t-board-col-count">${count}</span>
    </div>`;
}

/* Bound once, at module load. Capture phase so it runs before any drag
   library that might otherwise swallow the event on its way up. */
document.addEventListener("click", (evt) => {
  const btn = evt.target.closest?.(".t-board-col-toggle");
  if (!btn) return;
  evt.preventDefault();
  evt.stopPropagation();
  toggleBoardCol(btn.dataset.colBoard, btn.dataset.colKey);
}, true);

/* ---- Upcoming: a near horizon, with the rest one tap away ----

   Upcoming is unbounded by definition — everything with a date that isn't
   today and isn't past lands in it — so a Puja in late October sits in the
   same column as something due tomorrow, and the column stops answering
   "what is coming up". Default to the next seven days and keep the rest
   behind a button rather than dropping it: nothing is lost, it just isn't
   competing for attention.

   The preference is per-device in localStorage, like the column collapse
   state right above. It is a view choice, not data — putting it in `state`
   would sync it and bump the document rev for a toggle. */
const UPCOMING_DAYS = 7;
/* Scoped per column, so expanding the GSI To Do column doesn't also
   expand Overview's Upcoming or the Personal board. Same shape of key as
   the column-collapse state above. */
const laterKey = scope => "lifeos-later-" + scope;
export function isLaterExpanded(scope) {
  try { return localStorage.getItem(laterKey(scope)) === "1"; } catch (_) { return false; }
}
export function toggleLaterHorizon(scope) {
  try { localStorage.setItem(laterKey(scope), isLaterExpanded(scope) ? "0" : "1"); } catch (_) {}
  rerender();
}
// Kept for the native Upcoming column, which was the first user of this.
export const isUpcomingExpanded = () => isLaterExpanded("native-upcoming");
export const toggleUpcomingHorizon = () => toggleLaterHorizon("native-upcoming");
/* Inclusive of today + UPCOMING_DAYS, compared as YYYY-MM-DD strings, which
   is what dueDate already is — no Date parsing, so no timezone to get
   wrong. Built by adding days to a local date so month and year ends roll
   over correctly. */
function upcomingHorizonKey() {
  const d = new Date();
  d.setHours(12, 0, 0, 0); // midday, so a DST shift can't move the day
  d.setDate(d.getDate() + UPCOMING_DAYS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/* `dateOf` differs by board: the native list calls the field dueDate, the
   GSI and Personal workspaces call it date — so the caller supplies the
   accessor rather than this having to know about all three.

   A task with NO date stays near. On the native Upcoming column that case
   can't arise (undated tasks have their own column), but on a workspace
   To Do column it is common — "Report upload tracker" has no date — and
   hiding those behind a "later" button would be plainly wrong: an undated
   task isn't later, it's just undated. Past dates stay near too, so
   nothing overdue can ever be tucked away. */
export function splitByHorizon(tasks, dateOf = t => t.dueDate) {
  const horizon = upcomingHorizonKey();
  const near = [], later = [];
  tasks.forEach(t => {
    const d = dateOf(t);
    ((!d || d <= horizon) ? near : later).push(t);
  });
  return { near, later };
}

/* The whole "show N later" treatment for one column: which cards to draw,
   the button, and the message when the near list is empty. Shared so the
   three boards stay identical in behaviour and wording. */
export function applyHorizon(scope, tasks, dateOf) {
  const { near, later } = splitByHorizon(tasks, dateOf);
  if (!later.length) return { shown: tasks, moreBtn: "", emptyMsg: "Nothing here." };
  const expanded = isLaterExpanded(scope);
  const n = later.length;
  const moreBtn = `<button type="button" class="t-upcoming-more${expanded ? " is-open" : ""}" data-upcoming-more="${esc(scope)}">${
    expanded ? `Show only the next ${UPCOMING_DAYS} days`
             : `Show ${n} later ${n === 1 ? "task" : "tasks"}`}</button>`;
  return {
    shown: expanded ? tasks : near,
    moreBtn,
    emptyMsg: `Nothing due in the next ${UPCOMING_DAYS} days.`
  };
}
export function horizonWrapHtml(moreBtn) {
  return moreBtn ? `<div class="t-upcoming-more-wrap">${moreBtn}</div>` : "";
}

/* accentClass is gone: the per-column heading colours it carried were
   dropped when the boards moved to the reference's white headings, so it
   had become an argument that was passed and never used. */
function boardColumnHtml(key, label, tasks) {
  let shown = tasks, moreBtn = "", emptyMsg = "Nothing here.";
  if (key === "upcoming") {
    ({ shown, moreBtn, emptyMsg } = applyHorizon("native-upcoming", tasks, t => t.dueDate));
  }
  // The count stays the column's TRUE total. A badge that shrank with the
  // filter would hide the very thing the button is there to reveal.
  return `
    <div class="t-board-col ${isColCollapsed("native", key) ? "t-col-collapsed" : ""}" data-board-col="${key}">
      ${boardColHeadHtml("native", key, label, tasks.length)}
      <div class="t-board-col-body">
        ${shown.length ? shown.map(boardCardHtml).join("") : `<p class="hint" style="padding:10px 4px">${esc(emptyMsg)}</p>`}
      </div>
      ${horizonWrapHtml(moreBtn)}
      ${boardQuickAddHtml(key)}
    </div>`;
}

/* Delegated, same as the column collapse toggle above and for the same
   reason: bound once from the module that owns the behaviour, so it can't
   be broken by an unrelated boot error. */
document.addEventListener("click", (evt) => {
  const btn = evt.target.closest?.("[data-upcoming-more]");
  if (!btn) return;
  evt.preventDefault();
  evt.stopPropagation();
  toggleLaterHorizon(btn.dataset.upcomingMore);
}, true);
/* Kept as a thin redirect: the old inline inputs are gone, but a stale
   cached page or a bookmarklet could still call this. */
export function quickAddBoardTask(key) {
  if (nativeColumnAccepts(key)) openComposer("native", key);
}
function renderBoardView(overdueGroup, todayGroup, upcomingGroup, noDateGroup, done) {
  return `<div class="t-board">
    ${boardColumnHtml("overdue", "Overdue", overdueGroup)}
    ${boardColumnHtml("today", "Today", todayGroup)}
    ${boardColumnHtml("upcoming", "Upcoming", upcomingGroup)}
    ${boardColumnHtml("nodate", "No Date", noDateGroup)}
    ${boardColumnHtml("completed", "Completed", done)}
  </div>`;
}

// ---------- Calendar view: drag a task onto another day to reschedule it ----------
// Every day cell is a Sortable container in one shared group, which is what
// lets a chip cross from one day to another. The drop does nothing itself
// beyond working out the target date and handing it to editTaskMeta — the
// single function the date picker, the popup and the board already use — so
// persistence, re-render and Google Calendar sync stay in one place and
// GSI-sourced tasks reschedule in their real project rather than in a copy.
let calSortableInstances = [];
let calDragEndedAt = 0; // see calendarClickSuppressed()
function destroyCalSortables() {
  calSortableInstances.forEach(s => { try { s.destroy(); } catch (e) { /* already gone with its container */ } });
  calSortableInstances = [];
}
function initCalendarSorting() {
  destroyCalSortables();
  if (taskView !== "calendar" || typeof Sortable === "undefined") return;
  // Unlike List and Board, this isn't manual ordering — it edits the due
  // date — so it stays available even when "Sort by date" is on.
  document.querySelectorAll("#taskList .t-cal-tasks").forEach(container => {
    calSortableInstances.push(Sortable.create(container, {
      group: "task-calendar",
      draggable: ".t-cal-chip", // the "+N more" line isn't a task and mustn't be picked up
      animation: 180,
      delay: 300, delayOnTouchOnly: true, touchStartThreshold: 5, // a plain touch-drag should still scroll the month
      ghostClass: "t-cal-chip-ghost", chosenClass: "t-cal-chip-chosen", dragClass: "t-cal-chip-dragging",
      scroll: true, scrollSensitivity: 90, scrollSpeed: 12,
      onEnd: handleCalendarDragEnd,
    }));
  });
}
function handleCalendarDragEnd(evt) {
  calDragEndedAt = Date.now();
  const id = evt.item.dataset.taskId;
  const from = evt.from.dataset.calDate, to = evt.to.dataset.calDate;
  // Re-render either way: rebuilding from real data is what makes an
  // unchanged or rejected drop snap back, rather than trying to undo
  // whatever SortableJS already did to the DOM.
  if (!id || !to || to === from) { renderTasks(); return; }
  editTaskMeta(id, "dueDate", to); // persists, re-renders and syncs on its own
  toast(`Moved to ${new Date(to + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}`);
}
// A drag that ends over a day cell is followed by that cell's own click,
// which would otherwise pop the "add a task" prompt every time something
// is dropped. Anything within a moment of a drop is that stray click.
function calendarClickSuppressed() {
  return Date.now() - calDragEndedAt < 400;
}

// ---------- Calendar view — a plain month grid. Only tasks with a due
// date can appear here at all (nothing to place on a calendar without
// one) — that's inherent to the view, not a filter to route around.
// ---------- Calendar view. Four ranges share one header and one chip:
// Week (an agenda-width column per day), Month (the grid), Year (twelve
// mini-months) and Years (a block of twelve years). Only tasks with a due
// date can appear here at all — that's inherent to a calendar, not a
// filter to route around.
function renderCalendarView(tasksWithDates) {
  const byDate = {};
  tasksWithDates.forEach(t => { if (t.dueDate) (byDate[t.dueDate] = byDate[t.dueDate] || []).push(t); });
  const scale = currentCalScale();
  const todayStr = isoDate(new Date());

  const body =
    scale === "week" ? renderCalWeek(byDate, todayStr) :
    scale === "year" ? renderCalYear(byDate, todayStr) :
    scale === "years" ? renderCalYears(byDate, todayStr) :
    renderCalMonth(byDate, todayStr);

  // t-cal-r-* ("r" for range) rather than t-cal-week / t-cal-month: those
  // two names are already taken inside this view by a week ROW in the
  // month grid and by the month LABEL in the header, and reusing them on
  // the container silently applied a flex row and a 30px serif to it.
  return `<div class="t-cal t-cal-r-${scale}">${calHeadHtml(scale)}${body}</div>`;
}

// Local-time ISO. new Date().toISOString() is UTC, which in IST turns
// anything before 05:30 into yesterday — the wrong day highlighted, and
// "Today" landing on the wrong cell, for the first five and a half hours.
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function startOfWeek(d) { const s = new Date(d); s.setDate(s.getDate() - s.getDay()); s.setHours(0, 0, 0, 0); return s; }
/* The block runs from three years back, not from a fixed 12-year boundary:
   aligning to multiples of 12 put 2026 in a 2016–2027 block, eight of whose
   cells can never hold anything. Three back covers what's already filed,
   the rest looks forward. Paging still moves a whole block at a time. */
function yearsBlockStart(y) { return y - 3; }

// The header is one component across all four ranges: what you're looking
// at on the left, how to move and how to change range on the right.
function calHeadHtml(scale) {
  const y = calendarMonth.getFullYear();
  let name, sub;
  if (scale === "week") {
    const s = startOfWeek(calendarMonth), e = new Date(s); e.setDate(s.getDate() + 6);
    const fmt = (d, withMonth) => `${d.getDate()}${withMonth ? " " + d.toLocaleDateString("en-IN", { month: "short" }) : ""}`;
    name = `${fmt(s, s.getMonth() !== e.getMonth())} – ${fmt(e, true)}`;
    sub = s.getFullYear() === e.getFullYear() ? String(e.getFullYear()) : `${s.getFullYear()}–${e.getFullYear()}`;
  } else if (scale === "month") {
    name = calendarMonth.toLocaleDateString("en-IN", { month: "long" }); sub = String(y);
  } else if (scale === "year") {
    name = String(y); sub = "";
  } else {
    const s = yearsBlockStart(y); name = `${s}`; sub = `– ${s + YEARS_BLOCK - 1}`;
  }
  const step = { week: "week", month: "month", year: "year", years: "years" }[scale];
  return `
      <div class="t-cal-head">
        <div class="t-cal-month">
          <span class="t-cal-month-name">${name}</span>${sub ? `<span class="t-cal-month-year">${sub}</span>` : ""}
        </div>
        <div class="t-cal-nav">
          <button class="btn btn-ghost t-cal-arrow" onclick="calendarPrevMonth()" aria-label="Previous ${step}">‹</button>
          <button class="btn btn-ghost t-cal-arrow" onclick="calendarNextMonth()" aria-label="Next ${step}">›</button>
          <button class="btn btn-ghost t-cal-today-btn" onclick="calendarGoToday()">Today</button>
          <label class="t-cal-scale">
            <select onchange="setCalendarScale(this.value)" aria-label="Calendar range">
              ${CAL_SCALES.map(([k, label]) => `<option value="${k}" ${k === scale ? "selected" : ""}>${label}</option>`).join("")}
            </select>
            <span class="t-cal-scale-caret" aria-hidden="true">⌄</span>
          </label>
        </div>
      </div>`;
}

// One chip, used by both Week and Month, so a task looks and behaves the
// same wherever it's dragged from.
function calChipHtml(t, todayStr) {
  return `
            <div class="t-cal-chip cat-${(t.category || "work") === "personal" ? "personal" : "work"} ${t.done ? "done" : ""} ${t.dueDate < todayStr && !t.done ? "overdue" : ""}" data-task-id="${t.id}" title="Drag to another day to reschedule">
              <button class="t-cal-chip-chk" onclick="event.stopPropagation();toggleTask('${t.id}')" aria-label="Toggle complete"></button>
              <button class="t-cal-chip-title" onclick="event.stopPropagation();openTaskPopup('${t.id}')" title="${esc(t.text)}"><span class="t-cal-chip-text">${esc(t.text)}</span></button>
            </div>`;
}

function renderCalMonth(byDate, todayStr) {
  const year = calendarMonth.getFullYear(), month = calendarMonth.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  function dayCellHtml(slot) {
    const { y, m, d, adjacent } = slot;
    const dateStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dayTasks = byDate[dateStr] || [];
    const expanded = expandedCalDays.has(dateStr);
    const shown = expanded ? dayTasks : dayTasks.slice(0, 3);
    return `
      <div class="t-cal-cell ${adjacent ? "t-cal-adjacent" : ""} ${dateStr === todayStr ? "t-cal-today" : ""} ${expanded ? "t-cal-expanded" : ""}" data-cal-date="${dateStr}" onclick="openDayView('${dateStr}')" title="View all tasks on ${dateStr}">
        <div class="t-cal-daynum-row"><span class="t-cal-daynum">${d}</span><span class="t-cal-add-hint">+</span></div>
        <div class="t-cal-tasks" data-cal-date="${dateStr}">
          ${shown.map(t => calChipHtml(t, todayStr)).join("")}
          ${dayTasks.length > 3 ? `<button class="t-cal-more" onclick="event.stopPropagation();toggleCalendarDay('${dateStr}')"
            title="${expanded ? "Show fewer" : `Show all ${dayTasks.length} tasks`}"
            aria-label="${expanded ? "Show fewer tasks" : `Show all ${dayTasks.length} tasks`}"
            aria-expanded="${expanded}">${expanded
              ? `<span class="t-cal-more-n">−</span><span class="t-cal-more-lbl">Show less</span>`
              : `<span class="t-cal-more-n">+${dayTasks.length - 3}</span><span class="t-cal-more-lbl"> more</span>`}</button>` : ""}
        </div>
      </div>`;
  }

  /* Build one flat array of day slots, then chunk it into week-rows of
     exactly 7. Each week is rendered as its own flex row with exactly 7
     children, so there's no reliance on a single large CSS grid correctly
     auto-wrapping ~34 items at a 7-column boundary.

     The padding either side is real dates from the neighbouring months
     rather than blank cells — 27–31 July ahead of a August that starts on
     a Saturday. Blank corners made the first and last weeks read as
     missing rather than as a month boundary, and a task due on the 31st
     of last month simply vanished from view on the way past it. They
     carry their tasks and their drop target like any other day; the
     .t-cal-adjacent class is what dims them so the current month still
     reads as the subject of the grid. */
  const prevLast = new Date(year, month, 0);      // day 0 of this month = last day of the previous one
  const slots = [];
  for (let i = firstWeekday; i > 0; i--) {
    slots.push({ y: prevLast.getFullYear(), m: prevLast.getMonth(), d: prevLast.getDate() - i + 1, adjacent: true });
  }
  for (let d = 1; d <= daysInMonth; d++) slots.push({ y: year, m: month, d, adjacent: false });
  const next = new Date(year, month + 1, 1);
  for (let d = 1; slots.length % 7 !== 0; d++) {
    slots.push({ y: next.getFullYear(), m: next.getMonth(), d, adjacent: true });
  }

  let weeksHtml = "";
  for (let w = 0; w < slots.length; w += 7) {
    weeksHtml += `<div class="t-cal-week">${slots.slice(w, w + 7).map(dayCellHtml).join("")}</div>`;
  }

  return `
      <div class="t-cal-scroll">
        <div class="t-cal-weekdays">${
          ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(w =>
            `<div><span class="t-cal-wd-full">${w}</span><span class="t-cal-wd-mini" aria-hidden="true">${w[0]}</span></div>`).join("")
        }</div>
        <div class="t-cal-grid">${weeksHtml}</div>
      </div>`;
}

/* Week: seven days, every task shown in full — no "+N more", because a
   week has the room the month grid doesn't. Same .t-cal-tasks containers,
   so dragging a task from Monday to Thursday reschedules it exactly as it
   does in Month. On a phone the seven columns stack into an agenda. */
function renderCalWeek(byDate, todayStr) {
  const s = startOfWeek(calendarMonth);
  let cells = "";
  for (let i = 0; i < 7; i++) {
    const d = new Date(s); d.setDate(s.getDate() + i);
    const dateStr = isoDate(d);
    const dayTasks = byDate[dateStr] || [];
    cells += `
      <div class="t-cal-cell t-cal-wcell ${dateStr === todayStr ? "t-cal-today" : ""}" data-cal-date="${dateStr}" onclick="openDayView('${dateStr}')" title="View all tasks on ${dateStr}">
        <div class="t-cal-daynum-row">
          <span class="t-cal-wcell-wd">${d.toLocaleDateString("en-IN", { weekday: "short" })}</span>
          <span class="t-cal-daynum">${d.getDate()}</span>
          <span class="t-cal-wcell-count">${dayTasks.length || ""}</span>
        </div>
        <div class="t-cal-tasks" data-cal-date="${dateStr}">
          ${dayTasks.map(t => calChipHtml(t, todayStr)).join("")}
        </div>
      </div>`;
  }
  return `<div class="t-cal-scroll"><div class="t-cal-weekgrid">${cells}</div></div>`;
}

/* Year: twelve mini-months. A day carries a dot if anything is due on it,
   which is all a month-at-this-size can honestly show. Tapping a day opens
   its day sheet — the same tap as the month grid — and tapping a month
   name drops into that month. */
function renderCalYear(byDate, todayStr) {
  const year = calendarMonth.getFullYear();
  let months = "";
  for (let m = 0; m < 12; m++) {
    const first = new Date(year, m, 1);
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    const pad = first.getDay();
    let days = "";
    for (let i = 0; i < pad; i++) days += `<span class="t-cal-mini-day t-cal-mini-blank"></span>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const n = (byDate[dateStr] || []).length;
      days += `<button class="t-cal-mini-day ${n ? "has" : ""} ${dateStr === todayStr ? "is-today" : ""}"
        onclick="openDayView('${dateStr}')" title="${n ? `${n} task${n > 1 ? "s" : ""} on ${dateStr}` : dateStr}">${d}</button>`;
    }
    months += `
      <div class="t-cal-mini ${new Date().getFullYear() === year && new Date().getMonth() === m ? "is-current" : ""}">
        <button class="t-cal-mini-head" onclick="calendarZoomTo('${year}-${String(m + 1).padStart(2, "0")}-01','month')"
          title="Open ${first.toLocaleDateString("en-IN", { month: "long" })} ${year}">${first.toLocaleDateString("en-IN", { month: "long" })}</button>
        <div class="t-cal-mini-wd">${["S", "M", "T", "W", "T", "F", "S"].map(w => `<span>${w}</span>`).join("")}</div>
        <div class="t-cal-mini-grid">${days}</div>
      </div>`;
  }
  return `<div class="t-cal-yeargrid">${months}</div>`;
}

/* Years: a block of twelve, each with how much is on it. Deliberately a
   count and not a grid — at this zoom the only useful question is "which
   year has anything in it", and the answer is a number. */
function renderCalYears(byDate, todayStr) {
  const startY = yearsBlockStart(calendarMonth.getFullYear());
  const thisYear = new Date().getFullYear();
  const counts = {};
  Object.keys(byDate).forEach(dateStr => {
    const y = Number(dateStr.slice(0, 4));
    counts[y] = (counts[y] || 0) + byDate[dateStr].length;
  });
  let cells = "";
  for (let y = startY; y < startY + YEARS_BLOCK; y++) {
    const n = counts[y] || 0;
    cells += `
      <button class="t-cal-yearcell ${y === thisYear ? "is-current" : ""} ${n ? "has" : ""}"
        onclick="calendarZoomTo('${y}-01-01','year')" title="Open ${y}">
        <span class="t-cal-yearcell-y">${y}</span>
        <span class="t-cal-yearcell-n">${n ? `${n} task${n > 1 ? "s" : ""}` : "—"}</span>
      </button>`;
  }
  return `<div class="t-cal-yearsgrid">${cells}</div>`;
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
  if (taskView === null) {
    taskView = state.taskViewPref || "board";
    const switcher = document.getElementById("taskViewSwitch");
    if (switcher) switcher.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === taskView));
  }
  const list = document.getElementById("taskList");
  /* Board and Calendar carry their own ways to add a task (a per-column
     "+ Add task" composer, and tapping a day cell). The permanent
     "Add a task" bar is redundant there and is hidden by CSS keyed off
     this attribute. List view has no other affordance, so it keeps the
     bar — removing it outright would leave that view unable to add
     anything at all. */
  document.getElementById("tasksCard")?.setAttribute("data-view", taskView);
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

  /* Personal Workspace tasks are the mirror image: inherently personal, so
     they join "Personal"/"All" and never "Work". Same normalisation, and
     the same important caveat — these are COPIES. Nothing may be written
     back through them; every action routes by id through findAnyTask,
     which resolves to the real object inside state.personal. */
  if (taskFilter === "all" || taskFilter === "personal") {
    const pwAsTasks = getAllPwTasksFlat().map(t => ({
      id: t.id, text: t.text, done: t.status === "done", category: "personal",
      flag: !!t.flag, link: t.link || "", dueDate: t.date || "", completedAt: null,
      isPersonal: true, projectId: t.projectId, projectName: t.projectName, status: t.status
    }));
    visible = visible.concat(pwAsTasks);
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
  // Manual drag order — see the position migration in state.js's
  // merge(). GSI tasks have no position field, so they fall back to 0
  // and cluster together rather than interleaving meaningfully with
  // natively-ordered tasks. List view's row drag (taskRowHtml's
  // placeholder handle) stays native-only for this reason — but Board
  // view doesn't reorder by position at all, it moves cards between
  // columns by status/date, which GSI tasks do have (see moveTaskToColumn).
  const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0);

  const todayKeyStr = new Date().toISOString().slice(0, 10);
  const open = visible.filter(t => !t.done);
  const done = visible.filter(t => t.done && !t.archived).sort(sortByDate ? byDate : byPosition);
  const todayGroup = open.filter(t => t.dueDate === todayKeyStr).sort(sortByDate ? byFlagThenDate : byPosition);
  const overdueGroup = open.filter(t => t.dueDate && t.dueDate < todayKeyStr).sort(sortByDate ? byFlagThenDate : byPosition);
  const upcomingGroup = open.filter(t => t.dueDate !== todayKeyStr && !(t.dueDate && t.dueDate < todayKeyStr)).sort(sortByDate ? byFlagThenDate : byPosition);
  // Board view only — splits what List view lumps together as one
  // "Upcoming" group into two separate columns. List view's own
  // upcomingGroup above is untouched; filtering an already-sorted
  // array preserves that order, so no re-sort needed here.
  const boardUpcomingGroup = upcomingGroup.filter(t => t.dueDate);
  const noDateGroup = upcomingGroup.filter(t => !t.dueDate);
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
    list.innerHTML = renderBoardView(overdueGroup, todayGroup, boardUpcomingGroup, noDateGroup, done);
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
  document.getElementById("taskCount").textContent = state.tasks.length ? `(${openCount} open)` : "";
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
  const dragHint = document.getElementById("taskDragHint");
  if (dragHint) dragHint.style.display = (sortByDate && (taskView === "list" || taskView === "board")) ? "" : "none";
  const projSel = document.getElementById("newTaskProject");
  /* Rebuilding the list while it is the focused control closes an open
     dropdown mid-choice — and the options can't have changed if the
     person is standing in it. Leave it alone until they step away. */
  if (projSel && projSel !== document.activeElement) {
    const current = projSel.value;
    projSel.innerHTML = `<option value="">No project</option>${projectOptionsHtml(current)}`;
  }
  restoreNewTaskDraft();
  initTaskSorting();
  initBoardSorting();
  initBoardWheelScroll();
  capBoardColumnHeights();
  initCalendarSorting();
}

export function setTaskFilter(f) { taskFilter = f; renderTasks(); }

// Shared by every entry point that creates a native task — the main
// Add Task input, Board view's per-column quick-add, and Calendar
// view's click-a-day quick-add — so all three build the same shape
// instead of three slightly-diverging copies.
function nextManualPosition() {
  return state.tasks.reduce((m, t) => Math.min(m, t.position ?? 0), 0) - 1000;
}
/* Exported so the shared board composer can create a native task without
   duplicating the category/position rules that live here. */
export function createNativeTask(text, dueDate) {
  const defaultCategory = (taskFilter === "work" || taskFilter === "personal") ? taskFilter : "work";
  const task = { id: uid(), text, done: false, category: defaultCategory, flag: false, link: "", dueDate: dueDate || "", googleEventId: null, position: nextManualPosition() };
  state.tasks.push(task);
  return task;
}
/* ---------- the "Add a task" box keeps what you typed ----------

   The box lives outside every rendered region, so a repaint doesn't clear
   it — but a reload does, and on mobile a PWA that has been backgrounded
   for a while gets reloaded by the OS without warning. Half a task typed
   and then lost that way is invisible to Undo and Trash, because it never
   reached `state` at all.

   Kept in localStorage, deliberately NOT in state: an unsubmitted draft
   is this device's business, must never sync, and must never bump
   updatedAt (which would make a stale device look "newer" — see the note
   on persist() in state.js). */
const NEWTASK_DRAFT_KEY = "lifeos-newtask-draft";
export function saveNewTaskDraft(v) {
  try {
    if ((v || "").trim()) localStorage.setItem(NEWTASK_DRAFT_KEY, v);
    else localStorage.removeItem(NEWTASK_DRAFT_KEY);
  } catch (e) { /* private browsing — the draft just isn't kept */ }
}
function clearNewTaskDraft() {
  try { localStorage.removeItem(NEWTASK_DRAFT_KEY); } catch (e) {}
}
function restoreNewTaskDraft() {
  const el = document.getElementById("newTask");
  if (!el || el.value || el === document.activeElement) return; // never overwrite what's on screen
  try {
    const draft = localStorage.getItem(NEWTASK_DRAFT_KEY);
    if (draft) el.value = draft;
  } catch (e) {}
}

export function addTask() {
  const el = document.getElementById("newTask"); const v = el.value.trim(); if (!v) return;
  const projSel = document.getElementById("newTaskProject");
  const projectId = projSel ? projSel.value : "";
  if (projectId) {
    /* The picker now lists both trees, so the id has to be routed to the
       right one. Personal is checked first because a GSI project id would
       never appear in the personal list and vice versa — one lookup
       decides it, with no prefix convention to keep in sync. */
    const task = { id: uid(), text: v, status: "todo", date: "", link: "", flag: false, googleEventId: null };
    if (getPwProjectList().some(p => p.id === projectId)) addPwProjectTaskRaw(projectId, task);
    else addProjectTaskRaw(projectId, task);
  } else {
    createNativeTask(v, "");
    persist(); rerender();
  }
  el.value = "";
  clearNewTaskDraft();
}
/* Completed starts collapsed (see isColCollapsed). That default is fine
   on a board you are only reading, but it makes the first completion
   look broken: the card leaves its column and lands inside a collapsed
   one, so the visible result of ticking a task is that it vanishes with
   no feedback. Completing something is exactly the moment that column
   becomes worth showing, so the first completion opens it and records
   it as seen — after that the person's own collapse choice is honoured
   like any other column's. */
function revealCompletedColumnOnce() {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    const set = new Set(raw ? JSON.parse(raw) : []);
    if (set.has("native:completed:seen")) return; // already seen — respect whatever the user chose since
    set.add("native:completed:seen");
    set.delete("native:completed");
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  } catch (_) { /* storage unavailable — the column just stays collapsed, same as before */ }
}

export function toggleTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) {
    t.done = !t.done;
    if (t.done) revealCompletedColumnOnce();
    t.completedAt = t.done ? Date.now() : null;
    touch(t); persist(); rerender();
    syncTaskToGoogle(t, t.done ? "delete" : "create").catch(() => {}); // a completed task has nothing left to remind about; reopening it (with a due date) puts it back
    return;
  }
  /* GSI and Personal project tasks land in the same Completed column as
     native ones, so they get the same one-time reveal. */
  const { task: gt } = findProjectTask(id);
  if (gt) {
    if (gt.status !== "done") revealCompletedColumnOnce();
    setGsiTaskStatus(id, gt.status === "done" ? "todo" : "done");
    return;
  }
  const { task: pt } = findPwProjectTask(id);
  if (pt) {
    if (pt.status !== "done") revealCompletedColumnOnce();
    setPwTaskStatus(id, pt.status === "done" ? "todo" : "done");
  }
}
export function toggleFlag(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) { t.flag = !t.flag; touch(t); persist(); rerender(); return; }
  const { task: gt } = findProjectTask(id);
  if (gt) { toggleProjectTaskFlag(id); return; }
  togglePwProjectTaskFlag(id);
}
export function editTask(id, v) {
  const t = state.tasks.find(x => x.id === id);
  if (t) {
    t.text = v; touch(t); persist();
    if (!t.done) syncTaskToGoogle(t, t.googleEventId ? "update" : "create").catch(() => {});
    return;
  }
  const { task: gt } = findProjectTask(id);
  if (gt) { editProjectTask(id, "text", v); return; }
  const { task: pt } = findPwProjectTask(id);
  if (pt) editPwProjectTask(id, "text", v);
}
export function editTaskMeta(id, field, v) {
  const t = state.tasks.find(x => x.id === id);
  if (t) {
    t[field] = v; touch(t); persist(); rerender();
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
  const projField = field === "dueDate" ? "date" : field;
  const { task: gt } = findProjectTask(id);
  if (gt) { editProjectTask(id, projField, v); return; }
  const { task: pt } = findPwProjectTask(id);
  if (pt) editPwProjectTask(id, projField, v);
}
export function delTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) {
    moveToTrash("task", t); state.tasks = state.tasks.filter(x => x.id !== id); persist(); rerender();
    syncTaskToGoogle(t, "delete").catch(() => {});
    return;
  }
  const { task: gt } = findProjectTask(id);
  if (gt) { delProjectTask(id); return; }
  const { task: pt } = findPwProjectTask(id);
  if (pt) delPwProjectTask(id);
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

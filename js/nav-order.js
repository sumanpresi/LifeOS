/* ============================================================
   Sidebar — the order of the Spaces is the user's, not the file's
   ============================================================
   The Spaces were in whatever order index.html happened to list them,
   which is the order they were built in rather than the order anyone
   uses them. Dragging one now moves it, and the arrangement is stored
   on state so it survives a reload and follows you between devices.

   Only the Spaces group moves. Overview, Today and Trash stay put: they
   are not places you keep things, they are how you get around, and a
   sidebar whose navigation moves is a sidebar you have to read every
   time instead of reaching for by muscle memory. That is also why the
   group is wrapped in its own container rather than making the whole
   sidebar sortable — the boundary is enforced by the DOM, so it cannot
   drift later.
   ============================================================ */
import { state, persist, onStateReplaced } from './state.js';

const GROUP_ID = "navSpaces";

/* The order is stored as a list of data-page keys rather than indices.
   Indices would silently point at the wrong Space the moment one is
   added, removed or renamed; a key that no longer exists is simply
   skipped, and a Space the stored order has never seen keeps its
   position from the markup instead of jumping to the front. */
export function applyNavOrder() {
  const group = document.getElementById(GROUP_ID);
  if (!group) return;
  const saved = Array.isArray(state.navOrder) ? state.navOrder : null;
  if (!saved || !saved.length) return;

  const items = new Map();
  group.querySelectorAll(":scope > .nav-item[data-page]").forEach(el => items.set(el.dataset.page, el));

  const seen = new Set();
  saved.forEach(key => {
    const el = items.get(key);
    if (!el || seen.has(key)) return;
    seen.add(key);
    group.appendChild(el);          // appendChild MOVES an existing node
  });
  // Anything the saved order predates keeps its markup order, after the
  // known ones — a new Space appears at the bottom rather than at random.
  items.forEach((el, key) => { if (!seen.has(key)) group.appendChild(el); });
}

function readOrder(group) {
  return [...group.querySelectorAll(":scope > .nav-item[data-page]")].map(el => el.dataset.page);
}

export function initNavSorting() {
  const group = document.getElementById(GROUP_ID);
  if (!group || typeof Sortable === "undefined") return;
  if (group.dataset.sortable === "1") return;   // idempotent: safe to call on every render
  group.dataset.sortable = "1";

  Sortable.create(group, {
    animation: 150,
    draggable: ".nav-item",
    /* delayOnTouchOnly is what keeps a tap a tap. On touch, a press has
       to be held 250ms before it becomes a drag, so navigating still
       works normally; with a mouse a drag starts on movement, and a
       click without movement is never treated as one. Without this the
       sidebar would become unusable for its actual job. */
    delay: 250,
    delayOnTouchOnly: true,
    touchStartThreshold: 6,
    forceFallback: true,            // same as the task boards — Samsung Internet's native DnD is unreliable here
    ghostClass: "nav-item-ghost",
    chosenClass: "nav-item-chosen",
    onStart: () => document.body.classList.add("is-dragging"),
    onEnd: () => {
      document.body.classList.remove("is-dragging");
      state.navOrder = readOrder(group);
      /* touch() in this codebase stamps a RECORD (touch(rec) sets
         rec.updatedAt); navOrder is a plain field on the document, so the
         document's own stamp is what has to move for sync to see the
         change. */
      state.updatedAt = Date.now();
      persist();
      /* No re-render. Sortable has already put the button where it was
         dropped, so the sidebar on screen is the answer — rebuilding it
         would only reproduce what is there, and would throw away the
         .active class and the scroll position doing it. Same reasoning
         as the task board's drop handler. */
    }
  });
}

/* A cloud pull swaps the whole state object out, so an order set on
   another device arrives with no repaint behind it — the sidebar is not
   part of any renderer. Re-applying here is what makes the order actually
   cross devices rather than merely survive a reload on the one it was set
   on. Moving nodes that are already in the right place is a no-op, so
   this is safe to run on every replace. */
onStateReplaced(() => applyNavOrder());

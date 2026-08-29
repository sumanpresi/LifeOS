/* ============================================================
   Reclaiming a stranded drag clone
   ============================================================
   THE BUG, from SortableJS's own source.

   Every board here runs with `forceFallback:true, fallbackOnBody:true`,
   so the card you see under the pointer is not the card in the column —
   it is a CLONE that Sortable appends directly to <body> and moves with
   an inline transform. Sortable holds the only reference to it, in a
   module-level `ghostEl`, mirrored as `Sortable.ghost`.

   In `_onDrop`, every cleanup step — including

       ghostEl && ghostEl.parentNode && ghostEl.parentNode.removeChild(ghostEl)

   — sits inside `if (evt) { … }`. `_nulling()`, which runs unconditionally
   at the end, then sets `ghostEl = null`.

   `Sortable.prototype.destroy()` calls `this._onDrop()` with NO event.
   So destroying an instance mid-drag skips the whole `if (evt)` block,
   never removes the clone, and immediately discards the only reference
   to it. The clone is left parented to <body>, at whatever coordinates
   the pointer last had, with pointer-events:none — a card floating over
   the board that nothing in the app can name any more. Only a reload
   clears it.

   HOW THE APP REACHES THAT PATH.

   `initBoardSorting()` (and the GSI and Personal equivalents) begin with
   `destroy*Sortables()`, and they run on every render. A render arriving
   while a card is in the air therefore strands the clone. Renders arrive
   unbidden — a realtime sync landing, a Google Calendar pass finishing,
   a poll — which is exactly why this was intermittent rather than
   reproducible: it needed a background render to coincide with a lift.

   THE FIX, in two layers.

   state.js now holds re-renders back until the lift is over, so the
   collision mostly stops happening. This module is the second layer: it
   takes the clone away from Sortable before `destroy()` can lose it, and
   sweeps by class for any clone a previous session already stranded.
   Cheap enough to call defensively, which is what the pointer-release
   safety net in app.js does.
   ============================================================ */

/* Sortable's own default for `fallbackClass`. The clone carries it for
   the whole of its life, which makes it findable by selector after the
   reference to it is gone. */
const FALLBACK_CLASS = "sortable-fallback";

export function releaseDragGhost() {
  /* While Sortable still knows about the clone this is the reliable
     handle — it does not depend on the class surviving. */
  const live = typeof Sortable !== "undefined" ? Sortable.ghost : null;
  if (live && live.parentNode) live.parentNode.removeChild(live);

  /* Anything already orphaned has no reference left, so it can only be
     found by class. Restricted to direct children of <body> because that
     is the only place fallbackOnBody puts one; a `.sortable-fallback`
     anywhere else is not ours to remove. */
  document.querySelectorAll(`body > .${FALLBACK_CLASS}`).forEach(el => {
    if (el !== live && el.parentNode) el.parentNode.removeChild(el);
  });
}

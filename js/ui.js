
/* ---------- sidebar visibility ---------- */
/* Collapses the whole nav rail away so the writing area gets its width.
   Deliberately a per-device preference in localStorage and NOT part of
   `state`: putting it in state would sync it, so hiding the sidebar on a
   tablet would hide it on the desktop too, and — worse — every toggle
   would bump the document's rev and fire a full save to the cloud for a
   piece of view state. */
const SIDEBAR_KEY = "lifeos-sidebar";
export function isSidebarHidden() {
  return document.documentElement.classList.contains("sidebar-hidden");
}
export function syncSidebarToggle() {
  const btn = document.getElementById("sidebarToggle");
  if (!btn) return;
  const hidden = isSidebarHidden();
  const label = hidden ? "Show sidebar" : "Hide sidebar";
  btn.setAttribute("aria-label", label);
  btn.setAttribute("aria-pressed", hidden ? "true" : "false");
  btn.setAttribute("data-tooltip", label);
  btn.classList.toggle("is-hidden-state", hidden);
}
export function toggleSidebar(force) {
  const hidden = typeof force === "boolean" ? force : !isSidebarHidden();
  document.documentElement.classList.toggle("sidebar-hidden", hidden);
  try { localStorage.setItem(SIDEBAR_KEY, hidden ? "hidden" : "shown"); } catch (e) {}
  syncSidebarToggle();
  /* Quill sizes its editor against the width it had at mount, so a layout
     this large changing under it needs a nudge to re-measure. */
  try { window.dispatchEvent(new Event("resize")); } catch (e) {}
}

/* Navigation, toasts, header, sync pill. */
import { state, esc } from './state.js?v=202609041600';
import { resizeWhiteboardIfVisible } from './whiteboard.js?v=202609041600';

let toastTimer = null;
/* ---------- sticky header ----------
   Three behaviours, each earning its place:

   1. STICKY everywhere. The header carries Search, Sync, the sync pill and
      Backup — status and actions wanted at any scroll position, not only
      at the top of the document.
   2. Deliberately DOES NOT resize as you scroll. It used to condense —
      smaller padding, smaller greeting, date hidden — which was a layout
      change driven by scroll position. That is a shape of change that can
      keep a page from settling, and the ~45px it recovered was not worth
      the risk, so it is gone. The bar is one size at all times.
   3. TUCKS AWAY on small and folded screens only, when scrolling DOWN, and
      comes straight back on the first upward flick. Vertical space is
      scarce there in a way it isn't on a desktop, and an upward flick is
      already the reflex for "give me the top of this" — cheaper than a
      button to find. Whether the class does anything is decided in CSS by
      breakpoint; this only reports the direction of travel.

   Reads scroll position inside requestAnimationFrame and listens
   passively, so scrolling is never blocked by this. */
export function initStickyHeader() {
  const top = document.querySelector(".top");
  if (!top) return;
  const TUCK_AFTER = 110;  // far enough down that the header isn't the subject
  let lastY = 0, ticking = false;

  const apply = () => {
    ticking = false;
    const y = Math.max(0, window.scrollY || document.documentElement.scrollTop || 0);

    /* Never tuck out from under someone who is using it — a keyboard user
       tabbed onto Sync, or an open menu inside the bar. */
    if (document.activeElement && document.activeElement !== document.body
        && top.contains(document.activeElement)) {
      top.classList.remove("is-tucked");
      lastY = y;
      return;
    }
    const DEAD = 5; // ignore sub-pixel jitter and rubber-banding
    if (y <= TUCK_AFTER) top.classList.remove("is-tucked");
    else if (y > lastY + DEAD) top.classList.add("is-tucked");
    else if (y < lastY - DEAD) top.classList.remove("is-tucked");
    lastY = y;
  };

  window.addEventListener("scroll", () => {
    if (!ticking) { ticking = true; requestAnimationFrame(apply); }
  }, { passive: true });
  // Coming back to a page already scrolled should not start from a wrong state.
  window.addEventListener("pageshow", apply);
  apply();
}

export function toast(msg, actionLabel, actionOnclick) {
  const t = document.getElementById("toast");
  if (actionLabel && actionOnclick) {
    t.innerHTML = `<span>${esc(msg)}</span><button class="toast-action" onclick="${actionOnclick}">${esc(actionLabel)}</button>`;
  } else {
    t.textContent = msg;
  }
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), actionLabel ? 4500 : 2200); // an undo action needs enough time to actually be clicked
}

/* Makes a textarea grow to fit its content instead of clipping/scrolling —
   used anywhere a box should always show everything typed into it.

   The tag guard is load-bearing, not defensive noise. Writing an explicit
   pixel height onto an ordinary element that sizes itself (a <span>, a
   <div>) can only ever make things worse, and when the element is inside a
   hidden page it is actively destructive: a hidden .page is display:none,
   every descendant reports scrollHeight 0, so the element gets height:0px
   burned into its style attribute and — paired with overflow:hidden —
   disappears until something re-renders it while visible. That is exactly
   the bug that made GSI board card titles invisible until you toggled
   List/Board. Only textareas need this, so only textareas get it. */
export function autoGrow(el) {
  if (!el || el.tagName !== "TEXTAREA") return;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

/* ---------- "is someone mid-sentence right now?" ----------

   A background sync tick has no idea a person is halfway through typing.
   state.rev only moves once something is actually SAVED, so an in-progress
   entry — the "Add a task" box at the top of Tasks, a task title being
   edited in place (those commit on change/blur, not per keystroke), a
   journal entry inside Quill — looks exactly like "nothing going on
   here". A pull then lands, renderAll() rebuilds the DOM under the caret,
   the keyboard drops, the page jumps, and whatever was typed is gone with
   nothing for Undo or Trash to have ever seen.

   The first version of this asked only "does a text field have focus?".
   That is too blunt in both directions, and the false positive is the
   damaging one: Quill's editor is a contenteditable that keeps focus
   after you stop writing, so leaving the cursor parked in the journal —
   which is the normal state of that page — made this return true
   indefinitely and silently switched OFF every background pull on the
   device. Cross-device sync then appeared to be broken when in fact it
   was being suppressed here, on purpose, forever.

   Focus is not the question. The question is whether there is unsaved
   text that a repaint would destroy, which is exactly two things:

     1. keystrokes in the last few seconds — someone is mid-thought and
        even a perfectly restored caret is disruptive;
     2. a focused field whose content has diverged from what it held when
        it was focused — a real pending edit, however long ago it was
        typed. Editors that commit on blur (task titles) live here.

   A field that is focused, unmodified and quiet is not typing, and a pull
   during it is completely safe. */
const TEXTUAL_INPUT_TYPES = new Set(
  ["text", "search", "url", "email", "tel", "password", "number", "date", "time", "datetime-local", ""]);
const PENDING_ENTRY_BOXES = ["newTask", "composerText", "composerLink"];
const TYPING_QUIET_MS = 2500;

function isTextField(el) {
  if (!el || el === document.body || el.disabled || el.readOnly) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" &&
    TEXTUAL_INPUT_TYPES.has((el.getAttribute("type") || "text").toLowerCase());
}
function fieldContent(el) {
  return el.isContentEditable ? el.innerHTML : (el.value || "");
}

let lastKeystrokeAt = 0;
/* What each field held when it was focused, so "has this been edited?"
   can be answered without every editor having to report in. WeakMap so a
   field destroyed by a re-render takes its entry with it. */
const fieldBaseline = new WeakMap();

document.addEventListener("keydown", () => { lastKeystrokeAt = Date.now(); }, true);
document.addEventListener("input", () => { lastKeystrokeAt = Date.now(); }, true);
document.addEventListener("focusin", e => {
  if (isTextField(e.target)) fieldBaseline.set(e.target, fieldContent(e.target));
}, true);

/* Call after a field's contents have been written into `state` — the
   pending edit is no longer pending, so the field stops counting as
   dirty even though it still holds the text and still has focus. */
export function markFieldClean(el) {
  if (el && isTextField(el)) fieldBaseline.set(el, fieldContent(el));
}

/* Editors that manage their own commit cycle (the journal's Quill) can
   report their unsaved state directly rather than being inferred from
   the DOM. Registered rather than imported: ui.js is imported by nearly
   everything, so it must not import back. */
const busyChecks = new Set();
export function registerBusyCheck(fn) { if (typeof fn === "function") busyChecks.add(fn); }

export function isUserTyping() {
  if (Date.now() - lastKeystrokeAt < TYPING_QUIET_MS) return true;

  /* Only editors that commit on blur are judged this way. A search or
     filter box is also a focused, modified text field, but its contents
     are throwaway UI state that no repaint can destroy — blocking sync
     on a half-typed search term would recreate the exact bug this
     replaced, just in a smaller room. */
  const el = document.activeElement;
  const commitsOnBlur = el && (el.tagName === "TEXTAREA" || el.isContentEditable);
  if (commitsOnBlur && isTextField(el) && fieldBaseline.has(el) && fieldBaseline.get(el) !== fieldContent(el)) return true;

  for (const check of busyChecks) {
    try { if (check()) return true; } catch (e) { /* a broken check must not wedge sync */ }
  }

  // Text left sitting in a quick-add box that has lost focus (a tapped
  // date chip, a closed keyboard) is still unsubmitted work.
  return PENDING_ENTRY_BOXES.some(id => {
    const box = document.getElementById(id);
    return !!box && (box.value || "").trim().length > 0;
  });
}

/* ---------- the card entry animation belongs to NAVIGATION ----------
   `.page.visible .card{animation:cardEnter}` fades every card up from
   opacity 0 with a staggered 10px rise. Cards are rebuilt from scratch on
   every render, so a brand-new element matched that rule and replayed the
   animation — meaning the whole board flashed and re-rose after a task
   was moved, after a sync landed, after any edit at all. It read as the
   page reloading, which is exactly what was reported.

   The animation is worth keeping for an actual page entry, which is what
   it was written for. So the rule is now gated on a marker that only
   navigation sets, and that expires: 300ms of animation plus the 120ms
   maximum stagger, plus a frame of slack. A render inside that window
   still animates, which is correct — the page really is arriving. */
const PAGE_ENTER_MS = 460;
let pageEnterTimer = null;
function markPageEntering(el) {
  clearTimeout(pageEnterTimer);
  document.querySelectorAll(".page-entering").forEach(p => p.classList.remove("page-entering"));
  el.classList.add("page-entering");
  pageEnterTimer = setTimeout(() => el.classList.remove("page-entering"), PAGE_ENTER_MS);
}

export function go(page) {
  /* Today was merged into Overview, so "dayof" no longer names a page.
     It is redirected rather than deleted because the name survives in
     three places that would otherwise dead-end: search results link to
     it for journal hits, "lifeos-last-page" in localStorage still holds
     it for anyone whose last session ended there, and an old bookmark
     may carry it. Without this, every one of those lands on a page that
     does not exist — go() finds no #page-dayof, adds .visible to
     nothing, and the app shows a blank body with no error to explain it.

     (The whiteboard surface also called "dayof" is a different thing
     entirely — it is a key into state.whiteboards for the Scratch board
     on the Personal page, and is untouched by this.) */
  if (page === "dayof") page = "overview";

  // A page change is *supposed* to jump to the top; don't let a render
  // queued by this navigation restore the old page's scroll position.
  skipScrollRestoreBriefly();
  document.querySelectorAll(".page").forEach(p => p.classList.remove("visible"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.page === page));
  const el = document.getElementById("page-" + page);
  if (el) {
    el.classList.add("visible");
    markPageEntering(el);
    try { localStorage.setItem("lifeos-last-page", page); } catch (e) { /* private browsing etc. — non-critical */ }
    // Textareas/maps rendered while their page was hidden can't be measured
    // correctly (hidden elements report scrollHeight/size 0) — fix them up
    // now that the page is actually visible and layout can be computed.
    el.querySelectorAll(".mm-section textarea").forEach(autoGrow);
    el.querySelectorAll(".gsi-title").forEach(autoGrow);
    el.querySelectorAll(".t-title").forEach(autoGrow);
    el.querySelectorAll(".pw-board-card-title").forEach(autoGrow);
    el.querySelectorAll(".task-row textarea").forEach(autoGrow);
    /* Same reason as the textareas above, and the same fix: a board
       column capped while its page was hidden was capped against zeroed
       offsets. Dynamically imported to keep ui.js free of a static
       dependency on tasks.js, which imports from here. */
    import("./tasks.js?v=202609041600").then(m => m.capBoardColumnHeights()).catch(() => {});
    if (page === "work") resizeWhiteboardIfVisible("gsi");
    /* The Whiteboard's surface is still called "overview" for data
       compatibility, but the card renders on Communication now. */
    if (page === "communication") resizeWhiteboardIfVisible("overview");
    /* The Scratch board's surface is still called "dayof" for data
       compatibility, but the card renders on the Personal page now. */
    if (page === "personal") resizeWhiteboardIfVisible("dayof");
    if (page === "reference") import("./reference.js?v=202609041600").then(m => m.showWorldMap());
  }
  document.getElementById("sidebar").classList.remove("open");
  window.scrollTo({ top: 0 });
  revealActiveTab();
}

/* ---------- phone only: keep the active tab on screen ----------
   Under 600px the sidebar becomes a fixed bottom bar with
   overflow-x:auto, and there are more sections than fit across 440pt —
   so the tab you just navigated to is frequently off the edge of the
   strip. Nothing in the app was scrolling it back, which made the bar
   look like it had lost the selection.

   Guarded on the same 600px breakpoint the bar itself uses, so the
   601-1024px icon rail and the desktop sidebar — both vertical, both
   fully visible already — are never touched. inline:"nearest" so it
   only moves when the item really is out of view, and block:"nearest"
   so it can never scroll the PAGE while centring a tab. */
function revealActiveTab() {
  try {
    if (!window.matchMedia || !matchMedia("(max-width:600px)").matches) return;
    const active = document.querySelector(".sidebar .nav-item.active");
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
    }
  } catch (e) { /* scrollIntoView options are advisory; never break navigation over it */ }
}

export function scrollToEl(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function setSyncPill(kind, text) {
  const p = document.getElementById("syncPill");
  p.className = "pill dot " + (kind || ""); p.textContent = text;
}

export const nowTime = () =>
  new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

export function renderHeader() {
  const h = new Date().getHours();
  const part = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  document.getElementById("greeting").textContent = `${part}, ${state.name}`;
  document.getElementById("todayDate").textContent =
    new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/* ---------- full-data backup / restore ---------- */
/* exportBackup / importBackup now live in backup.js, which adds a
   snapshot-before-restore, file validation and last-backup tracking.
   app.js still exposes the same two global names, so the sidebar
   buttons in index.html are unchanged. */

/* Keeps a board where the person left it across a re-render.

   Every board is one horizontal flex row with `overflow-x:auto`. On a
   phone a column is 78vw wide, so the row genuinely scrolls; on a desktop
   all the columns fit and scrollLeft is always 0. Dropping a card
   re-renders the board by rewriting innerHTML, which resets scrollLeft to
   0 — invisible on a desktop, but on a phone it throws you back to the
   first column every single time you move a task. That is why this only
   ever showed up on mobile.

   Vertical page scroll is captured too: a board rebuilt below the fold can
   change height and shift the page under the person's thumb.

   Boards are keyed by their container id rather than by position, so the
   right scroll offset is restored even when several boards are on screen
   at once. */
export function preserveBoardScroll(render) {
  const boards = [...document.querySelectorAll(".t-board")];
  const saved = boards.map(el => [el.closest("[id]")?.id || "", el.scrollLeft]);
  const pageY = window.scrollY;

  /* On the fold/phone breakpoint a board scrolls horizontally with
     scroll-snap-type:x mandatory (see responsive-foldable.css). Setting
     el.scrollLeft below is a programmatic jump straight to where the
     person had scrolled to, which is rarely a snap point itself — left
     as mandatory, the browser "corrects" it to whichever column edge is
     nearest on the very next layout, so the restore visibly lands on a
     different column than the one being dragged into. Suspending
     snapping for the length of the restore, then handing it back once
     scrollLeft has actually settled, is what keeps the drop where the
     person put it. body.is-dragging (style.css) covers the equivalent
     problem during the live drag itself — this covers the moment after. */
  boards.forEach(el => { el.style.scrollSnapType = "none"; });

  const result = render();   // pass the render's own return value through

  const restore = () => {
    document.querySelectorAll(".t-board").forEach(el => {
      const key = el.closest("[id]")?.id || "";
      const hit = saved.find(([k]) => k === key);
      if (hit && hit[1]) el.scrollLeft = hit[1];
    });
    if (Math.abs(window.scrollY - pageY) > 1) window.scrollTo({ top: pageY });
  };
  /* Once synchronously, so there is no visible flash, and once after the
     next paint, because a board whose columns were re-created can clamp
     scrollLeft to 0 until it has been laid out. Snapping is only handed
     back a further frame after that, once the restored scrollLeft has
     actually taken — re-enabling it in the same frame that sets it
     re-triggers the exact snap-correction this is working around. */
  restore();
  requestAnimationFrame(() => {
    restore();
    requestAnimationFrame(() => {
      document.querySelectorAll(".t-board").forEach(el => { el.style.scrollSnapType = ""; });
    });
  });
  return result;
}

/* ---------- keep the page still across ANY re-render ----------

   preserveBoardScroll above only wraps drag-and-drop. Every other
   re-render — a cloud pull landing, a Google Calendar sync finishing, a
   timer, an edit made in a completely different card — went through
   renderAll() unprotected, which rewrites innerHTML across the whole
   interface. Anything above the viewport that changes height drags the
   page out from under you, which is what "the page suddenly moved while I
   was typing" actually is.

   Focus and caret position are restored too, for elements that carry an
   id (the Add-a-task box, the composer fields). Elements rebuilt without
   an id can't be re-found, which is exactly why isUserTyping() above
   stops most of these renders from happening mid-entry in the first
   place — this is the second line of defence, not the first. */
let skipScrollUntil = 0;
export function skipScrollRestoreBriefly(ms = 500) { skipScrollUntil = Date.now() + ms; }

export function preserveScrollAndFocus(render) {
  const boardEls = [...document.querySelectorAll(".t-board")];
  const savedBoards = boardEls.map(el => [el.closest("[id]")?.id || "", el.scrollLeft]);
  const pageY = window.scrollY;

  // Same scroll-snap workaround as preserveBoardScroll above — any
  // re-render that restores a board's scrollLeft can land on the wrong
  // column if snapping is left on to "correct" it. See that function's
  // comment for the full explanation.
  boardEls.forEach(el => { el.style.scrollSnapType = "none"; });

  const active = document.activeElement;
  const focusId = (active && active.id) ? active.id : "";
  let selStart = null, selEnd = null;
  if (focusId) {
    try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (e) { /* not a text field */ }
  }

  const result = render();

  const restore = () => {
    document.querySelectorAll(".t-board").forEach(el => {
      const key = el.closest("[id]")?.id || "";
      const hit = savedBoards.find(([k]) => k === key);
      if (hit && hit[1]) el.scrollLeft = hit[1];
    });
    if (Date.now() > skipScrollUntil && Math.abs(window.scrollY - pageY) > 1) {
      window.scrollTo({ top: pageY });
    }
    if (focusId) {
      const el = document.getElementById(focusId);
      // preventScroll matters on mobile: re-focusing without it scrolls
      // the field into view all over again, which is its own page jump.
      if (el && el !== document.activeElement && typeof el.focus === "function") {
        try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
        if (selStart !== null && typeof el.setSelectionRange === "function") {
          try { el.setSelectionRange(selStart, selEnd); } catch (e) { /* type doesn't support selection */ }
        }
      }
    }
  };
  restore();
  requestAnimationFrame(() => {
    restore();
    requestAnimationFrame(() => {
      document.querySelectorAll(".t-board").forEach(el => { el.style.scrollSnapType = ""; });
    });
  });
  return result;
}

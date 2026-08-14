/* Navigation, toasts, header, sync pill. */
import { state, esc } from './state.js';
import { resizeWhiteboardIfVisible } from './whiteboard.js';

let toastTimer = null;
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

export function go(page) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("visible"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.page === page));
  const el = document.getElementById("page-" + page);
  if (el) {
    el.classList.add("visible");
    try { localStorage.setItem("lifeos-last-page", page); } catch (e) { /* private browsing etc. — non-critical */ }
    // Textareas/maps rendered while their page was hidden can't be measured
    // correctly (hidden elements report scrollHeight/size 0) — fix them up
    // now that the page is actually visible and layout can be computed.
    el.querySelectorAll(".mm-section textarea").forEach(autoGrow);
    el.querySelectorAll(".gsi-title").forEach(autoGrow);
    el.querySelectorAll(".t-title").forEach(autoGrow);
    el.querySelectorAll(".pw-board-card-title").forEach(autoGrow);
    el.querySelectorAll(".task-row textarea").forEach(autoGrow);
    if (page === "work") resizeWhiteboardIfVisible("gsi");
    /* The Whiteboard's surface is still called "overview" for data
       compatibility, but the card renders on Communication now. */
    if (page === "communication") resizeWhiteboardIfVisible("overview");
    /* The Scratch board's surface is still called "dayof" for data
       compatibility, but the card renders on the Personal page now. */
    if (page === "personal") resizeWhiteboardIfVisible("dayof");
    if (page === "reference") import("./reference.js").then(m => m.showWorldMap());
  }
  document.getElementById("sidebar").classList.remove("open");
  window.scrollTo({ top: 0 });
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
     scrollLeft to 0 until it has been laid out. */
  restore();
  requestAnimationFrame(restore);
  return result;
}

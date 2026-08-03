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
   used anywhere a box should always show everything typed into it. */
export function autoGrow(el) {
  if (!el) return;
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
    el.querySelectorAll(".task-row textarea").forEach(autoGrow);
    if (page === "overview") resizeWhiteboardIfVisible("overview");
    if (page === "work") resizeWhiteboardIfVisible("gsi");
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

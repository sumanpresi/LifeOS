/* Navigation, toasts, header, sync pill. */
import { state, replaceState, persist, rerender } from './state.js';

export function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
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
    // Textareas/maps rendered while their page was hidden can't be measured
    // correctly (hidden elements report scrollHeight/size 0) — fix them up
    // now that the page is actually visible and layout can be computed.
    el.querySelectorAll(".mm-section textarea").forEach(autoGrow);
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
export function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `lifeos-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Backup downloaded");
}

export function importBackup(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (!confirm("Restoring a backup replaces ALL current LifeOS data on this device (and will overwrite your cloud data once synced). Continue?")) {
    event.target.value = ""; return;
  }
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const data = JSON.parse(e.target.result);
      if (typeof data !== "object" || data === null) throw new Error("Invalid file");
      replaceState(data);
      persist();
      rerender();
      const { pushCommunicationUpdate } = await import("./communication-bridge.js");
      const { pushNgdrTrackerUpdate } = await import("./ngdr-tracker-bridge.js");
      pushCommunicationUpdate();
      pushNgdrTrackerUpdate();
      toast("Backup restored");
    } catch (err) {
      alert("Could not read that file — expected a LifeOS backup JSON export.");
    }
  };
  reader.readAsText(file);
  event.target.value = "";
}

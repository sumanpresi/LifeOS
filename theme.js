/* ============================================================
   Theme
   ============================================================
   Three states, not two: "light", "dark", and no stored choice at all.
   The third is the default and means "follow the operating system", so a
   phone that switches to dark at sunset takes the app with it without
   anyone having configured anything.

   The preference is stored in localStorage rather than in `state`. It is
   a per-device setting — a desktop under office lighting and a phone in
   bed reasonably want different answers — and keeping it out of the
   synced document means toggling it can never bump updatedAt, and so can
   never win or lose a sync conflict on behalf of real data. Same
   reasoning as the task view preference and the trash collapse state.

   The flip itself is a single attribute on <html>; css/style.css
   redefines its custom properties under html[data-theme="dark"]. No
   component knows the theme exists.
   ============================================================ */

const KEY = "lifeos-theme";

function stored() {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : null; }
  catch (_) { return null; }
}

function systemPrefersDark() {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/* What is actually on screen right now, as opposed to what was chosen. */
export function effectiveTheme() {
  return stored() || (systemPrefersDark() ? "dark" : "light");
}

function apply(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  // Keeps the browser UI (form controls, scrollbars, address bar on
  // mobile) in step with the page instead of leaving a light strip.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#1A1917" : "#F3EEE4");
  syncToggleUi(theme);
}

function syncToggleUi(theme) {
  const btn = document.getElementById("themeToggle");
  if (!btn) return;
  const dark = theme === "dark";
  const icon = btn.querySelector(".theme-icon");
  const label = btn.querySelector(".theme-label");
  if (icon) icon.textContent = dark ? "☀" : "☾";
  if (label) label.textContent = dark ? "Light" : "Dark";
  btn.setAttribute("aria-pressed", String(dark));
  btn.title = dark ? "Switch to light theme" : "Switch to dark theme";
}

export function toggleTheme() {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem(KEY, next); } catch (_) { /* private browsing */ }
  apply(next);
}

export function initTheme() {
  apply(effectiveTheme());
  /* Follow the OS only while no explicit choice has been made — once
     someone has picked a side, the app should not override them at
     sunset. */
  if (typeof matchMedia === "function") {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if (!stored()) apply(systemPrefersDark() ? "dark" : "light"); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange); // older WebKit
  }
}

/* ============================================================
   Theme
   ============================================================
   Three named themes — "light", "dark", "warm" — plus no stored choice at
   all, which is the default and means "follow the operating system", so a
   phone that switches to dark at sunset takes the app with it without
   anyone having configured anything.

   "warm" (Warm Glass) is not a third data-theme value. It IS the dark
   theme with a different palette: it sets data-theme="dark" alongside
   data-skin="warm", so all 117 dark rules in the stylesheet apply
   untouched and only the hues are overridden. Adding a genuine third
   value would have meant duplicating every one of them, and remembering
   to duplicate every future one.

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
export const THEMES = ["light", "dark", "warm"];
const LABEL = { light: "Light", dark: "Dark", warm: "Warm Glass" };
const ICON = { light: "☀", dark: "☾", warm: "✦" };

function stored() {
  try { const v = localStorage.getItem(KEY); return THEMES.includes(v) ? v : null; }
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
  const root = document.documentElement;
  // Warm Glass rides on the dark rules; see the note at the top.
  root.setAttribute("data-theme", theme === "warm" ? "dark" : theme);
  if (theme === "warm") root.setAttribute("data-skin", "warm");
  else root.removeAttribute("data-skin");
  // Keeps the browser UI (form controls, scrollbars, address bar on
  // mobile) in step with the page instead of leaving a light strip.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content",
    theme === "warm" ? "#2A211A" : theme === "dark" ? "#1A1917" : "#F3EEE4");
  syncToggleUi(theme);
}

function nextTheme(theme) {
  const i = THEMES.indexOf(theme);
  return THEMES[(i < 0 ? 0 : i + 1) % THEMES.length];
}

/* One swatch per theme rather than one button that cycles. A cycle can
   only ever announce where the NEXT click goes; three circles show all
   three destinations at once, and any of them is one tap away instead of
   up to two. The marking of the current one is the only state to keep in
   step. */
function syncToggleUi(theme) {
  document.querySelectorAll("[data-theme-pick]").forEach(btn => {
    const isThis = btn.dataset.themePick === theme;
    btn.classList.toggle("is-active", isThis);
    btn.setAttribute("aria-checked", String(isThis));
    btn.title = LABEL[btn.dataset.themePick] + (isThis ? " (current)" : "");
  });
  // The old single toggle, if a build still has it in the markup.
  const btn = document.getElementById("themeToggle");
  if (btn) {
    const next = nextTheme(theme);
    const icon = btn.querySelector(".theme-icon");
    const label = btn.querySelector(".theme-label");
    if (icon) icon.textContent = ICON[next];
    if (label) label.textContent = LABEL[next];
    btn.setAttribute("aria-pressed", String(theme !== "light"));
    btn.title = "Currently " + LABEL[theme] + " — switch to " + LABEL[next];
  }
}

export function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  try { localStorage.setItem(KEY, theme); } catch (_) { /* private browsing */ }
  apply(theme);
}

/* Kept so anything still bound to it keeps working. */
export function toggleTheme() {
  setTheme(nextTheme(effectiveTheme()));
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

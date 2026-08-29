/* ============================================================
   Theme
   ============================================================
   Three named themes — "light", "dark", "warm" — plus no stored choice at
   all, which is the default and means "follow the operating system", so a
   phone that switches to dark at sunset takes the app with it without
   anyone having configured anything.

   Only two of them are real data-theme values. "warm" (Warm Glass) is the
   DARK theme repainted, and "quantiva" is the LIGHT theme repainted: each
   sets its base in data-theme and its palette in data-skin, so all 117
   dark rules and every light rule apply untouched and only the variables
   change. Genuine extra data-theme values would have meant duplicating
   every one of those rules, and remembering to duplicate every future
   one. See the BASE/SKIN table below.

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
export const THEMES = ["light", "advocate", "belle", "empowerx", "procyon", "quantiva", "egnis", "warm"];
const LABEL = { light: "Light", advocate: "Advocate", belle: "Belle Amour", empowerx: "EmpowerX",
                procyon: "Procyon", quantiva: "Quantiva", egnis: "Egnis", warm: "Warm Glass" };
const ICON = { light: "☀", advocate: "§", belle: "❦", empowerx: "◆", procyon: "▤",
               quantiva: "◈", egnis: "◐", warm: "✦" };

/* Dark is no longer offered, but it is still REACHABLE state: it is the
   base Warm Glass is built on, and anyone who chose it before this change
   still has "dark" in their localStorage. Rather than leave them on a
   theme with no swatch to match, it resolves to Warm Glass — which is the
   dark option now. Same for a device whose OS asks for dark. */
const RETIRED = { dark: "warm" };

/* A theme is a BASE plus an optional SKIN. The base decides which of the
   two big rule sets applies — the 117 dark rules or the default light
   ones — and the skin repaints the variables on top. Warm Glass is dark
   repainted; Quantiva is light repainted. Keeping this as a table means a
   new theme is one row here rather than another branch in four places. */
const BASE = { light: "light", advocate: "light", belle: "light", empowerx: "light",
               procyon: "light", quantiva: "light", egnis: "dark", warm: "dark" };
const SKIN = { warm: "warm", quantiva: "quantiva", advocate: "advocate", belle: "belle",
               empowerx: "empowerx", procyon: "procyon", egnis: "egnis" };
const BAR  = { light: "#F3EEE4", advocate: "#EEF1F4", belle: "#F7F1EE", empowerx: "#F5F1F1",
               procyon: "#FDF3EA", quantiva: "#FBF5E8", egnis: "#0B1519", warm: "#2A211A" };

function stored() {
  try {
    const v = localStorage.getItem(KEY);
    if (RETIRED[v]) return RETIRED[v];
    return THEMES.includes(v) ? v : null;
  } catch (_) { return null; }
}

function systemPrefersDark() {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/* What is actually on screen right now, as opposed to what was chosen. */
export function effectiveTheme() {
  return stored() || (systemPrefersDark() ? "warm" : "light");
}

function apply(theme) {
  const root = document.documentElement;
  root.setAttribute("data-theme", BASE[theme] || "light");
  if (SKIN[theme]) root.setAttribute("data-skin", SKIN[theme]);
  else root.removeAttribute("data-skin");
  // Keeps the browser UI (form controls, scrollbars, address bar on
  // mobile) in step with the page instead of leaving a light strip.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", BAR[theme] || BAR.light);
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
    const onChange = () => { if (!stored()) apply(systemPrefersDark() ? "warm" : "light"); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange); // older WebKit
  }
}

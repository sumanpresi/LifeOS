/* Central state, defaults, persistence and shared helpers. */

export const DEFAULT_STATE = {
  v: 2,
  name: "Suman Das",
  tasks: [
    { id: "t1", text: "Review NGDR upload tracker", done: false },
    { id: "t2", text: "Plan UAT test cases", done: false }
  ],
  goals: [
    { id: "g1", name: "Improve communication", pct: 20 },
    { id: "g2", name: "Leadership", pct: 15 },
    { id: "g3", name: "Wealth creation", pct: 10 },
    { id: "g4", name: "Physical & mental health", pct: 25 }
  ],
  habits: [
    { id: "h1", name: "Gym" },
    { id: "h2", name: "10 mins reading" },
    { id: "h3", name: "Interact with people" },
    { id: "h4", name: "10 min speak in English" }
  ],
  habitLog: {},              // { "2026-07-19": { h1:true } }
  links: [
    { id: "l1", title: "PM GatiShakti portal", url: "https://www.pmgatishakti.gov.in", desc: "NGDR staging / UAT" },
    { id: "l2", title: "GSI Bhukosh", url: "https://bhukosh.gsi.gov.in", desc: "Geoscience data" }
  ],
  feeds: [
    { id: "f1", name: "The Hindu", url: "https://www.thehindu.com" },
    { id: "f2", name: "Indian Express", url: "https://indianexpress.com" },
    { id: "f3", name: "Anandabazar Patrika", url: "https://www.anandabazar.com" }
  ],
  quotes: [
    "Small daily improvements are the key to staggering long-term results.",
    "What gets measured gets managed.",
    "You do not rise to the level of your goals. You fall to the level of your systems.",
    "The best time to plant a tree was 20 years ago. The second best time is now.",
    "Discipline is choosing between what you want now and what you want most."
  ],
  quoteOffset: 0,
  meditation: {},            // { "2026-07-19": minutes }
  journal: {},               // { "2026-07-19": "text" }
  sections: {
    communication: { notes: "", links: [] }, finance: { notes: "", links: [] },
    health: { notes: "", links: [] }, travel: { notes: "", links: [] },
    reference: { notes: "", links: [] }, work: { notes: "", links: [] }
  },
  gsi: {
    ngdr: [
      { id: "n1", text: "UAT — NGDR 2.0 AI module (staging)", status: "progress" },
      { id: "n2", text: "Report upload tracker — monthly refresh", status: "todo" }
    ],
    log: [],                 // [{id, date:"2026-07-19", text}]
    meetings: [],            // [{id, date, title, notes}]
    links: [
      { id: "gl1", title: "GSI portal", url: "https://www.gsi.gov.in" },
      { id: "gl2", title: "Bhukosh", url: "https://bhukosh.gsi.gov.in" }
    ]
  },
  updatedAt: 0
};

/* Section pages generated generically (Work has its own GSI page). */
export const SECTION_META = {
  communication: "Communication", finance: "Finance", health: "Health",
  travel: "Travel Plan", reference: "Reference"
};

/* localStorage may be unavailable in some contexts — never crash. */
export const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

function load() {
  try {
    const raw = store.get("lifeos-data");
    if (raw) return merge(JSON.parse(raw));
  } catch (e) {}
  return structuredClone(DEFAULT_STATE);
}
function merge(saved) {
  const s = Object.assign(structuredClone(DEFAULT_STATE), saved);
  /* deep-default the containers that older versions may lack */
  s.sections = Object.assign(structuredClone(DEFAULT_STATE.sections), saved.sections || {});
  s.gsi = Object.assign(structuredClone(DEFAULT_STATE.gsi), saved.gsi || {});
  return s;
}

export let state = load();

/* Replace state wholesale (used when cloud data arrives). */
export function replaceState(remote) {
  delete remote._client;
  state = merge(remote);
  store.set("lifeos-data", JSON.stringify(state));
}

/* ---------- helpers ---------- */
export const uid = () => Math.random().toString(36).slice(2, 9);
export const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const todayKey = (d = new Date()) =>
  d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

/* ---------- persistence + render wiring ---------- */
let remoteSaver = null;      // set by supabase.js
let renderer = null;         // set by app.js
let saveTimer = null;

export function setRemoteSaver(fn) { remoteSaver = fn; }
export function setRenderer(fn) { renderer = fn; }
export function rerender() { if (renderer) renderer(); }

export function persist(pushRemote = true) {
  state.updatedAt = Date.now();
  store.set("lifeos-data", JSON.stringify(state));
  if (pushRemote && remoteSaver) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(remoteSaver, 1500);
  }
}

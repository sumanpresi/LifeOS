/* Central state, defaults, persistence and shared helpers. */

export const DEFAULT_STATE = {
  v: 2,
  name: "Suman",
  tasks: [
    { id: "t1", text: "Review NGDR upload tracker", done: false, category: "work", flag: false, link: "", dueDate: "" },
    { id: "t2", text: "Plan UAT test cases", done: false, category: "work", flag: false, link: "", dueDate: "" }
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
    communication: { notes: "", links: [] },
    work: { notes: "", links: [] }
  },
  gsi: {
    /* Multiple named projects, each with its own task list (with dates).
       Replaces the old single flat "ngdr" list — see merge() for the
       one-time migration of any existing ngdr items into a default project. */
    projects: [
      { id: "p1", name: "NGDR", tasks: [
        { id: "n1", text: "UAT — NGDR 2.0 AI module (staging)", status: "progress", date: "" },
        { id: "n2", text: "Report upload tracker — monthly refresh", status: "todo", date: "" }
      ] }
    ],
    activeProject: "p1",
    log: [],                 // [{id, date:"2026-07-19", text}]
    /* Meeting minutes: structured fields matching a standard minutes template. */
    meetings: [],            // [{id, date, time, title, duration, agenda, updates, actionItems, link, open}]
    links: [
      { id: "gl1", title: "GSI portal", url: "https://www.gsi.gov.in" },
      { id: "gl2", title: "Bhukosh", url: "https://bhukosh.gsi.gov.in" }
    ],
    personalDocs: [],        // [{id, name, url}]
    workDocs: []              // [{id, name, url}]
  },
  /* Data for the Communication module (pages/communication.html). The module
     itself renders in an isolated iframe (separate CSS/JS, no id/class clashes
     with the rest of LifeOS), but its DATA lives here so it saves through the
     same persist() -> Supabase pipeline as everything else and syncs across
     devices. See js/communication-bridge.js for the postMessage handshake. */
  communication: {
    streak: { count: 0, last: null },
    mission: { date: null, done: { speak: false, word: false, grammar: false, phrase: false, writing: false, review: false } },
    stats: { speakingSeconds: 0, writingEntries: 0, mistakesCorrected: 0, presentations: 0 },
    vocab: [],
    mistakes: [
      { id: 1, wrong: "He don't know.", right: "He doesn't know.", cat: "Subject–Verb", fav: false },
      { id: 2, wrong: "I am agree.", right: "I agree.", cat: "Grammar", fav: false },
      { id: 3, wrong: "Discuss about the report.", right: "Discuss the report.", cat: "Preposition", fav: false }
    ],
    writing: [],
    favWord: {}, favTopic: {},
    activity: {},
    quizIndex: 0, quizRight: 0, quizSeen: 0,
    continueYesterday: null
  },
  /* Data for the NGDR Upload Tracker module (pages/ngdr-tracker.html), same
     isolated-iframe-plus-bridge pattern as Communication. An array of daily
     upload records: [{date, gsiLegacy, gsiRecent, otherLegacy, otherRecent, total}] */
  ngdrTracker: [],
  finance: {
    notes: "", links: [],
    grocery: [],   // [{id, name, date, link}]
    shopping: [],  // [{id, name, date, link}]
    wishlist: []   // [{id, name, date, link}]
  },
  health: {
    notes: "", links: [],
    medicines: [],      // [{id, name}]
    medicineLog: {},    // { "2026-07-19": { medId: {morning:bool, afternoon:bool, night:bool} } }
    prescriptions: []   // [{id, name, url, date}]
  },
  travel: {
    plans: [
      { id: "tp1", name: "General", notes: "", packing: "",
        stops: [] }   // [{id, place, duration, hotel, bookedHotel, mapDrawing}] — mapDrawing is a saved GeoJSON FeatureCollection or null
    ],
    activePlan: "tp1"
  },
  reference: {
    pages: [
      { id: "r1", name: "General", notes: "", links: [] }
    ],
    activePage: "r1",
    worldMapDrawing: null   // one shared world map's saved GeoJSON FeatureCollection
  },
  /* One shared recycle bin for deletions from anywhere in the app.
     [{id, type, payload, meta, deletedAt}] — see js/trash.js */
  trash: [],
  updatedAt: 0
};

/* Section pages generated generically. Nothing uses this template anymore —
   Communication, Finance, Health, Travel, Reference and Work all have
   dedicated pages — but the mechanism is kept in case a future space wants
   the plain notes+links layout without custom building. */
export const SECTION_META = {};
/* Note: "Communication" now has its own dedicated page (pages/communication.html,
   loaded via iframe) instead of the generic notes+links template above. */

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
  s.communication = Object.assign(structuredClone(DEFAULT_STATE.communication), saved.communication || {});
  s.ngdrTracker = Array.isArray(saved.ngdrTracker) ? saved.ngdrTracker : structuredClone(DEFAULT_STATE.ngdrTracker);
  s.finance = Object.assign(structuredClone(DEFAULT_STATE.finance), saved.finance || {});
  s.health = Object.assign(structuredClone(DEFAULT_STATE.health), saved.health || {});
  s.travel = Object.assign(structuredClone(DEFAULT_STATE.travel), saved.travel || {});
  s.reference = Object.assign(structuredClone(DEFAULT_STATE.reference), saved.reference || {});
  s.trash = Array.isArray(saved.trash) ? saved.trash : [];
  /* One-time migration: earlier versions stored Finance/Health/Travel notes
     and links under the generic sections.* template. Carry them forward so
     nothing already saved gets lost when those pages became dedicated. */
  const oldSections = saved.sections || {};
  if (oldSections.finance && !saved.finance) {
    s.finance.notes = oldSections.finance.notes || "";
    s.finance.links = oldSections.finance.links || [];
  }
  if (oldSections.health && !saved.health) {
    s.health.notes = oldSections.health.notes || "";
    s.health.links = oldSections.health.links || [];
  }
  if (oldSections.travel && !saved.travel) {
    const p = s.travel.plans[0];
    p.notes = oldSections.travel.notes || "";
    s.travel.planLinks = oldSections.travel.links || []; // kept, not shown by default UI
  }
  if (oldSections.reference && !saved.reference) {
    const p = s.reference.pages[0];
    p.notes = oldSections.reference.notes || "";
    p.links = oldSections.reference.links || [];
  }
  /* One-time migration: the old flat gsi.ngdr list becomes the default
     project's task list (tasks gain a blank "date" field). */
  if (saved.gsi && Array.isArray(saved.gsi.ngdr) && !Array.isArray(saved.gsi.projects)) {
    s.gsi.projects = [{
      id: "p1", name: "NGDR",
      tasks: saved.gsi.ngdr.map(t => ({ id: t.id, text: t.text, status: t.status, date: t.date || "" }))
    }];
    s.gsi.activeProject = "p1";
  }
  delete s.gsi.ngdr;
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

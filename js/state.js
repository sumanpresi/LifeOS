/* Central state, defaults, persistence and shared helpers. */

/* Public-domain philosophical quotes — used to top up state.quotes (see
   the migration in merge() below) rather than replace it, so existing
   saved quotes are kept and this just adds breadth beyond the five
   modern productivity-style ones LifeOS shipped with originally. Every
   author here has been dead well over a century, so there's no
   copyright question with using their words verbatim. */
export const PHILOSOPHICAL_QUOTES = [
  "The unexamined life is not worth living. — Socrates",
  "He who is not contented with what he has would not be contented with what he would like to have. — Socrates",
  "You have power over your mind — not outside events. Realize this, and you will find strength. — Marcus Aurelius",
  "Waste no more time arguing about what a good man should be. Be one. — Marcus Aurelius",
  "The impediment to action advances action. What stands in the way becomes the way. — Marcus Aurelius",
  "It is not that we have a short time to live, but that we waste a lot of it. — Seneca",
  "Luck is what happens when preparation meets opportunity. — Seneca",
  "He suffers more than necessary, who suffers before it is necessary. — Seneca",
  "Wealth consists not in having great possessions, but in having few wants. — Epictetus",
  "It's not what happens to you, but how you react to it that matters. — Epictetus",
  "First say to yourself what you would be, and then do what you have to do. — Epictetus",
  "Man is not worried by real problems so much as by his imagined anxieties about real problems. — Epictetus",
  "Knowing yourself is the beginning of all wisdom. — Aristotle",
  "We are what we repeatedly do. Excellence, then, is not an act, but a habit. — Aristotle",
  "The whole is greater than the sum of its parts. — Aristotle",
  "Man is condemned to be free; because once thrown into the world, he is responsible for everything he does. — Jean-Paul Sartre",
  "Life has no meaning a priori. It is up to you to give it a meaning. — Jean-Paul Sartre",
  "He who has a why to live can bear almost any how. — Friedrich Nietzsche",
  "That which does not kill us makes us stronger. — Friedrich Nietzsche",
  "To live is to suffer, to survive is to find some meaning in the suffering. — Friedrich Nietzsche",
  "Two things fill the mind with ever new and increasing admiration and awe: the starry heavens above me and the moral law within me. — Immanuel Kant",
  "Act only according to that maxim whereby you can, at the same time, will that it should become a universal law. — Immanuel Kant",
  "Man is born free, and everywhere he is in chains. — Jean-Jacques Rousseau",
  "The mind is everything. What you think you become. — attributed to the Buddha",
  "Peace comes from within. Do not seek it without. — attributed to the Buddha",
  "The journey of a thousand miles begins with a single step. — Laozi",
  "Nature does not hurry, yet everything is accomplished. — Laozi",
  "It does not matter how slowly you go as long as you do not stop. — Confucius",
  "Our life is what our thoughts make it. — Marcus Aurelius",
  "The soul becomes dyed with the color of its thoughts. — Marcus Aurelius",
  "I count him braver who overcomes his desires than him who conquers his enemies. — Aristotle",
  "The greatest wealth is to live content with little. — Plato",
  "Wonder is the feeling of the philosopher, and philosophy begins in wonder. — Plato",
  "Courage is knowing what not to fear. — Plato",
  "The only thing I know is that I know nothing. — Socrates",
  "Fortune favors the bold. — Virgil",
  "What we do now echoes in eternity. — Marcus Aurelius",
  "He who fears he shall suffer, already suffers what he fears. — Michel de Montaigne",
  "The value of life lies not in the length of days, but in the use we make of them. — Michel de Montaigne",
  "Doubt is the origin of wisdom. — René Descartes",
  "I think, therefore I am. — René Descartes",
];

export const DEFAULT_STATE = {
  v: 2,
  taskViewPref: "board", // "board" | "list" | "calendar" — persisted like any other setting, so it syncs across devices the same way everything else does
  gsiTaskViewPref: "board", // "board" | "list" — same idea, for GSI Workspace's own task list
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
  calendarScribbles: {},     // { "2026-07-19": { strokes: [{points:[{x,y}],...}] } } — one freehand note per date
  whiteboards: {
    overview: { strokes: [], objects: [] },
    gsi: { strokes: [], objects: [] }
  }, // keyed by board id — flat, single-canvas: {strokes:[{points,color,width,erase}], objects:[{id,x,y,w,h,text,color}]}
  // Brainstorming board tabs — the GSI "Brainstorming board" is backed by
  // one of these (whichever matches activeBrainstormBoard) instead of the
  // fixed whiteboards.gsi entry above. Overview's "Whiteboard" is
  // unaffected and still reads whiteboards.overview exactly as before.
  brainstormBoards: [
    { id: "legacy-gsi", name: "Brainstorming", archived: false, strokes: [], objects: [], zoom: 100, pan: { x: 0, y: 0 }, createdAt: 0, updatedAt: 0 }
  ],
  activeBrainstormBoard: "legacy-gsi",
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
    communication: { notes: "", noteList: [], links: [] },
    work: { notes: "", noteList: [], links: [] }
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
    wishlist: [],  // [{id, name, date, link}]
    externalSheetUrl: "https://docs.google.com/spreadsheets/d/19RqVQburOvAEe1UgHiESOkgzsi_DyAJP/edit?usp=sharing&ouid=100091168235788573849&rtpof=true&sd=true",
    monthlyExpenses: { months: {} }, // { "2026-07": { rows: [{id,date,category,description,amount,payment,notes}] } }
    emiTable: {
      // Remaining Amount and Months Remaining are never stored — they're
      // derived fresh from monthlyAmount/endDate on every render, so they
      // always reflect the current date rather than going stale like a
      // one-time-computed value would.
      rows: [],  // [{id, expense, monthlyAmount, startDate, endDate, bank, term, status, notes}]
      banks: ["ICICI Amazon Pay", "SBI Credit Card", "HDFC Finance", "Bajaj", "Cred Cash"],
      terms: ["Short", "Medium", "Long"],
      statuses: ["Active", "Paid", "Closed", "Paused"]
    }
  },
  health: {
    notes: "", links: [],
    medicines: [],      // [{id, name}]
    medicineLog: {},    // { "2026-07-19": { medId: {morning:bool, afternoon:bool, night:bool} } }
    prescriptions: []   // [{id, name, url, date}]
  },
  travel: {
    plans: [
      { id: "tp1", name: "General", notes: "", packing: [],  // legacy single list — migrated into packLists below
        // Several named packing lists per plan, e.g. "Documents", "Field kit".
        // Each: {id, name, notes (rich-text HTML), items: [{id, text, done}]}
        packLists: [], activePackList: "",
        stops: [] }   // [{id, place, duration, hotel, bookedHotel, mapDrawing}] — mapDrawing is a saved GeoJSON FeatureCollection or null
    ],
    activePlan: "tp1"
  },
  reference: {
    pages: [
      { id: "r1", name: "General", notes: "", links: [] }
    ],
    activePage: "r1",
    worldMapDrawing: null,  // one shared world map's saved GeoJSON FeatureCollection
    penAnnotations: { strokes: [] } // [{id, points:[{lat,lng,pressure,t}], color, width, opacity}] — stylus-only layer, separate from the finger/mouse/stylus freehand scribble above
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
  /* One-time migration: a section's single free-text Notes box becomes a
     list of separately-titled rich-text notes. Whatever was already
     written is carried in as the first note rather than dropped, and
     `notes` is emptied straight after so a second load can't duplicate
     it. The id is fixed rather than random for the same reason
     "legacy-gsi" is below: two devices that each still hold the old
     shape will migrate to the *same* id and merge instead of ending up
     with two copies of the same note. */
  Object.keys(s.sections).forEach(k => {
    const sec = s.sections[k];
    if (!Array.isArray(sec.noteList)) sec.noteList = [];
    const legacy = (sec.notes || "").trim();
    if (legacy && !sec.noteList.length) {
      const escText = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      sec.noteList.push({
        id: "note-legacy-" + k,
        title: "Notes",
        html: legacy.split(/\r?\n/).map(line => `<p>${escText(line) || "<br>"}</p>`).join(""),
        open: true,
        updated: Date.now()
      });
    }
    sec.notes = "";
  });
  s.gsi = Object.assign(structuredClone(DEFAULT_STATE.gsi), saved.gsi || {});
  // Work documents move from one shared list to per-project — each
  // project now keeps its own workDocs array, so switching workspaces
  // shows a different set of links. Existing links (from before this
  // change) land on whichever project is currently active rather than
  // being lost; this only has something to do once, since s.gsi.workDocs
  // is emptied out immediately after.
  if (Array.isArray(s.gsi.workDocs) && s.gsi.workDocs.length && s.gsi.projects.length) {
    const target = s.gsi.projects.find(p => p.id === s.gsi.activeProject) || s.gsi.projects[0];
    target.workDocs = [...(target.workDocs || []), ...s.gsi.workDocs];
    s.gsi.workDocs = [];
  }
  s.gsi.projects.forEach(p => { p.workDocs = p.workDocs || []; }); // additive field — older saved projects predate per-project work docs
  s.communication = Object.assign(structuredClone(DEFAULT_STATE.communication), saved.communication || {});
  // Top up with richer philosophical quotes rather than replacing the
  // list — keeps whatever the user already has (including any they've
  // added themselves) and just adds the ones not already present.
  // Naturally idempotent: once added, a quote is in saved.quotes on
  // every future load, so this becomes a no-op for it from then on.
  s.quotes = Array.from(new Set([...(s.quotes || []), ...PHILOSOPHICAL_QUOTES]));
  if (Array.isArray(s.tasks) && s.tasks.some(t => t.position == null)) {
    const ranked = s.tasks.slice().sort((a, b) => {
      if (!!b.flag !== !!a.flag) return b.flag ? 1 : -1; // flagged first, same as the existing default List sort
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    });
    ranked.forEach((t, i) => { if (t.position == null) t.position = (i + 1) * 1000; });
  }
  s.ngdrTracker = Array.isArray(saved.ngdrTracker) ? saved.ngdrTracker : structuredClone(DEFAULT_STATE.ngdrTracker);
  s.finance = Object.assign(structuredClone(DEFAULT_STATE.finance), saved.finance || {});
  s.health = Object.assign(structuredClone(DEFAULT_STATE.health), saved.health || {});
  s.travel = Object.assign(structuredClone(DEFAULT_STATE.travel), saved.travel || {});
  (s.travel.plans || []).forEach(p => {
    if (typeof p.packing === "string") {
      p.packing = p.packing.split("\n").map(line => line.trim()).filter(Boolean)
        .map(text => ({ id: uid(), text, done: false }));
    } else if (!Array.isArray(p.packing)) {
      p.packing = [];
    }
    /* One-time migration: a plan's single packing list becomes the first of
       several named lists. The existing items move across rather than being
       rebuilt, so their ids — and anything in Trash pointing at them — stay
       valid. p.packing is emptied straight after so a second load can't
       duplicate the list. The list id is derived from the plan id rather
       than random, so two devices still holding the old shape migrate to
       the same id and merge instead of producing two identical lists. */
    if (!Array.isArray(p.packLists)) p.packLists = [];
    if (!p.packLists.length) {
      p.packLists.push({
        id: "pl-legacy-" + p.id, name: "Packing list", notes: "",
        items: p.packing.length ? p.packing : []
      });
    }
    p.packing = [];
    p.packLists.forEach(l => { if (!Array.isArray(l.items)) l.items = []; });
    if (!p.packLists.some(l => l.id === p.activePackList)) p.activePackList = p.packLists[0].id;
  });
  s.reference = Object.assign(structuredClone(DEFAULT_STATE.reference), saved.reference || {});
  s.trash = Array.isArray(saved.trash) ? saved.trash : [];
  /* One-time migrations for the whiteboard: it went from a single canvas,
     to 10 scrollable pages, to multiple independent boards, and now back
     to a single canvas per board — the 10-page version turned out to
     introduce a nested scrollable region that was the actual source of
     real drawing/scroll conflicts on touchscreen hardware, something no
     amount of downstream JS fixing could fully guarantee against, so it
     was removed rather than patched further. Whatever shape was actually
     saved gets flattened forward: for the 10-page shapes, page 1's
     content is kept (the safest unambiguous choice — spatially merging
     multiple pages onto one canvas would just overlap into an unreadable
     mess) rather than silently discarding everything. */
  s.whiteboards = structuredClone(DEFAULT_STATE.whiteboards);
  /* The current multi-board field takes priority. It used to be checked
     last, behind two legacy-singular-field branches sharing the same
     if/else-if chain — meaning that whenever an old saved.whiteboard
     (singular) field was still lingering on a payload (nothing ever
     deleted it, so once present it re-saved forward indefinitely), this
     chain took the legacy branch and restored ONLY the overview board
     from stale singular data, while the branch that restores every
     board from saved.whiteboards — including gsi — never ran at all.
     That's what caused overview to silently diverge from gsi's sync
     behavior even though every other part of the pipeline is identical
     between boards. Checking saved.whiteboards first, and only falling
     back to the singular shapes for genuinely pre-migration saves that
     never had a whiteboards field, removes that asymmetry. */
  if (saved.whiteboards) {
    Object.keys(saved.whiteboards).forEach(k => {
      const board = saved.whiteboards[k];
      if (!board) return;
      s.whiteboards[k] = s.whiteboards[k] || { strokes: [], objects: [], connectors: [] };
      if (Array.isArray(board.strokes)) {
        s.whiteboards[k] = { strokes: board.strokes, objects: board.objects || [], connectors: board.connectors || [] };
      } else if (Array.isArray(board.pages)) {
        const p0 = board.pages[0] || {};
        s.whiteboards[k] = { strokes: p0.strokes || [], objects: p0.objects || [], connectors: [] };
      }
    });
  } else if (saved.whiteboard && Array.isArray(saved.whiteboard.strokes)) {
    s.whiteboards.overview.strokes = saved.whiteboard.strokes;
  } else if (saved.whiteboard && Array.isArray(saved.whiteboard.pages)) {
    const p0 = saved.whiteboard.pages[0] || {};
    s.whiteboards.overview.strokes = p0.strokes || [];
    s.whiteboards.overview.objects = p0.objects || [];
  }
  delete s.whiteboard; // never let the legacy singular field persist forward once migrated

  /* One-time migration: fold the pre-tabs single Brainstorming board
     (whiteboards.gsi, already restored above) into the new multi-tab
     brainstormBoards array as one tab named "Brainstorming". Once this
     has run and saved once, saved.brainstormBoards exists on every
     future payload and this branch never runs again — same
     self-perpetuating pattern as the whiteboards singular->plural
     migration above. A fixed id ("legacy-gsi") is used deliberately: if
     two devices each still have the pre-tabs shape and migrate
     independently before either has synced the new field, they still
     produce a tab with the same id, so the ordinary per-tab merge (see
     mergeIncomingBrainstormBoards in supabase.js) combines their
     strokes/notes into one tab instead of leaving two duplicates
     sitting side by side after the first sync. */
  if (Array.isArray(saved.brainstormBoards) && saved.brainstormBoards.length) {
    s.brainstormBoards = saved.brainstormBoards;
  } else {
    const legacy = s.whiteboards.gsi || { strokes: [], objects: [] };
    s.brainstormBoards = [{
      id: "legacy-gsi", name: "Brainstorming", archived: false,
      strokes: legacy.strokes || [], objects: legacy.objects || [],
      zoom: 100, pan: { x: 0, y: 0 }, createdAt: Date.now(), updatedAt: Date.now()
    }];
  }
  s.activeBrainstormBoard =
    (saved.activeBrainstormBoard && s.brainstormBoards.some(b => b.id === saved.activeBrainstormBoard && !b.deleted))
      ? saved.activeBrainstormBoard
      : (s.brainstormBoards.find(b => !b.archived && !b.deleted) || s.brainstormBoards[0]).id;

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
  /* pushRemote=false marks a purely local UI-state change — which tab is
     active, whether a card is expanded, which quote is showing — not
     something the person actually typed or edited. Bumping updatedAt for
     these too would be a real bug: it's the exact same class of issue as
     the Communication iframe's old unconditional save() — an action that
     LOOKS like "this device has newer data" without any real edit behind
     it, which can make a genuinely older, stale local copy of everything
     else win the cross-device sync comparison and overwrite newer data
     elsewhere. Any real edit that follows will bump updatedAt properly on
     its own and carry this UI state along with it in the same snapshot. */
  if (pushRemote) state.updatedAt = Date.now();
  store.set("lifeos-data", JSON.stringify(state));
  if (pushRemote && remoteSaver) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; remoteSaver(); }, 1500);
  }
}

/* Fires a pending debounced cloud save immediately instead of waiting out
   the full delay. Called when the tab is about to go into the background
   or close — without this, a quick edit (a map scribble, a habit tick)
   followed right away by switching apps or closing the tab would never
   reach the cloud at all, since the debounce timer simply never gets the
   chance to fire. */
export function flushPendingSave() {
  if (saveTimer && remoteSaver) {
    clearTimeout(saveTimer);
    saveTimer = null;
    remoteSaver();
  }
}

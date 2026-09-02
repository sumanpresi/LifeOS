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
  calendarScalePref: "month", // "week" | "month" | "year" | "years" — which range the Calendar view opens on, chosen from the dropdown beside Today
  gsiTaskViewPref: "board", // "board" | "list" — same idea, for GSI Workspace's own task list
  pwTaskViewPref: "board", // "board" | "list" — same idea again, for Personal Workspace
  /* Order of the Spaces in the sidebar, as data-page keys. Has to exist in
     DEFAULT_STATE rather than only being written when someone drags
     something: merge() builds every document from these defaults, so a key
     that is absent here is a key the cloud copy will not carry, and the
     sidebar order would be dropped the first time any device saved. */
  navOrder: [],
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
  /* When each day's ticks last changed, per date — the same device-clock-
     free trick journalUpdated uses. Without it a day's habit ticks could
     only be reconciled by asking which whole document was newer, so the
     losing device's ticks were discarded wholesale. Written by habits.js
     on every toggle. */
  habitLogUpdated: {},       // { "2026-07-19": 1755436800000 }
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
  /* Day Of gets the same tabbed board as GSI, with its own separate set
     of tabs — see TAB_SURFACES in whiteboard.js for why they aren't
     shared. Same shape as brainstormBoards so one set of tab code drives
     both. */
  dayofBoards: [
    { id: "db_first", name: "Scratch", archived: false, strokes: [], objects: [], zoom: 100, pan: { x: 0, y: 0 }, createdAt: 0, updatedAt: 0 }
  ],
  activeDayofBoard: "db_first",
  /* Communication's whiteboard tabs. The first tab keeps the id "overview"
     deliberately: that is where this board's content used to live as a flat
     whiteboards.overview entry, and merge() copies it in on first load so an
     existing drawing simply becomes tab one. */
  commBoards: [
    { id: "overview", name: "Whiteboard", archived: false, strokes: [], objects: [], zoom: 100, pan: { x: 0, y: 0 }, createdAt: 0, updatedAt: 0 }
  ],
  activeCommBoard: "overview",
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
  /* When each day's entry was last edited, per date, so two devices that
     both wrote the same day can be reconciled on that day alone instead
     of on whichever whole document happens to be newer. Written by
     widgets.js on every journal save; absent for entries created before
     this existed, which fall back to the older comparison. */
  journalUpdated: {},        // { "2026-07-19": 1755436800000 }
  // Personal catalogue of books, music and video.
  // items: [{id, type, title, creator, url, note, tag, rating, progress, featured, addedAt}]
  entertainment: { items: [] },
  sections: {
    communication: { notes: "", noteList: [], links: [] },
    work: { notes: "", noteList: [], links: [] },
    /* Backs the Notes card on the Personal Workspace page. Same shape and
       same sections.js code path as Work's — the page is hand-written in
       index.html rather than generated from SECTION_META, exactly like
       Work·GSI, so this entry exists purely to give those notes somewhere
       to live. */
    personal: { notes: "", noteList: [], links: [] },
    /* Health and Finance keep their own hand-written pages too, but their
       Notes cards now use the same multi-note rich editor as Work's. The
       old single `notes` string is migrated into noteList by merge(). */
    health: { notes: "", noteList: [], links: [] },
    finance: { notes: "", noteList: [], links: [] }
  },
  /* Personal Workspace — the same projects/board/documents machinery as
     state.gsi below, kept as a completely separate tree. Nothing here
     merges into Overview's task list or into GSI's project picker; see the
     header of js/personal.js for why that separation is deliberate. */
  personal: {
    projects: [
      { id: "pp1", name: "Home", tasks: [], workDocs: [], workDocsLabel: "Documents", archivedTasks: [] }
    ],
    activeProject: "pp1",
    links: [],
    docs: []
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
    workDocs: [],             // legacy flat list — migrated into workDocGroups below
    // Documents are grouped under named tabs. Each group:
    // {id, name, archived, docs: [{id, name, url, archived}]}
    workDocGroups: [], activeWorkDocGroup: ""
  },
  /* Data for the Communication module (pages/communication.html) — now the
     Class 8 English course. The module renders in an isolated iframe
     (separate CSS/JS, no id/class clashes with the rest of LifeOS), but its
     DATA lives here so it saves through the same persist() -> Supabase
     pipeline as everything else and syncs across devices. See
     js/communication-bridge.js for the postMessage handshake.

     Deliberately holds only the DURABLE half of the module's state. What
     lesson is open, which of the six steps is showing and whether the
     Student/Teacher toggle is set are per-device view state, like a scroll
     position — they stay in the iframe and are never sent here, so opening
     the course on the desk doesn't move the phone to a different lesson.

     The old Communication module's fields (mission, vocab, writing, streak,
     quizIndex...) are gone; see migrateCommunication() below for what
     happens to data still carrying them. */
  communication: {
    progress: {},   // lessonId -> { steps:{}, practice:{}, test:{}, writes:{}, speak:{} }
    errors: {},     // category -> { wrong, total }
    mistakes: [],   // notebook: [{topic, q, mine, right, why, lesson, at}]
    schedule: {}    // lessonId -> [{due, label, done}] spaced revision
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
    medicineLogUpdated: {}, // { "2026-07-19": 1755436800000 } — per-day stamp, so two devices' dose ticks merge by day instead of one document overwriting the other

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
    /* Uploaded .kml files, parsed to GeoJSON so they sync like any other
       data: [{id, name, fileName, addedAt, visible, color, features:[...]}].
       Kept here rather than in a browser file store precisely so a map
       marked up on the desktop is there on the phone too. */
    kmlLayers: [],
    activeKmlLayer: "",
    penAnnotations: { strokes: [] } // [{id, points:[{lat,lng,pressure,t}], color, width, opacity}] — stylus-only layer, separate from the finger/mouse/stylus freehand scribble above
  },
  /* Notebook: OneNote-style two-level hierarchy — several named sections,
     each holding several named rich-text pages. Both section and page
     names are freely editable. */
  notebook: {
    sections: [
      { id: "nbs1", name: "General", color: 0, pages: [
          { id: "nbp1", name: "Untitled page", html: "", createdAt: 0, updatedAt: 0 }
        ], activePage: "nbp1" }
    ],
    activeSection: "nbs1"
  },
  /* One shared recycle bin for deletions from anywhere in the app.
     [{id, type, payload, meta, deletedAt}] — see js/trash.js */
  trash: [],
  updatedAt: 0,
  /* Increments on every real edit. Unlike updatedAt this is not a clock
     reading, so it can't be thrown off by a device whose time is wrong —
     see the reconcile logic in supabase.js. */
  rev: 0,
  /* Rewritten on every successful upload. A device compares the token it
     last agreed with against the one in the cloud to tell "the cloud has
     changed since I last looked" apart from "nothing has moved". */
  syncToken: ""
};

/* Section pages generated generically. Nothing uses this template anymore —
   Communication, Finance, Health, Travel, Reference and Work all have
   dedicated pages — but the mechanism is kept in case a future space wants
   the plain notes+links layout without custom building. */
export const SECTION_META = {};
/* Note: "Communication" now has its own dedicated page (pages/communication.html,
   loaded via iframe) instead of the generic notes+links template above. */

/* The Communication slot used to hold a different module entirely — daily
   missions, a vocabulary list, writing entries, a quiz cursor. That module
   is gone, replaced by the Class 8 English course, and the two shapes have
   nothing in common.

   Old data is not silently merged into the new shape: a `mistakes` array
   exists in both but means different things ({wrong, right, cat} then,
   {topic, q, mine, right, why, lesson, at} now), and feeding one to the
   other would put malformed rows in the notebook. It is set aside under
   `legacy` instead — still synced, still in every backup, recoverable if
   it turns out to matter, and ignored by everything. */
export function migrateCommunication(saved) {
  const fresh = structuredClone(DEFAULT_STATE.communication);
  if (!saved || typeof saved !== "object") return fresh;

  const isOld = ("mission" in saved) || ("vocab" in saved) || ("quizIndex" in saved);
  if (isOld) {
    // Keep it only if it actually held anything worth keeping.
    const used = (saved.vocab || []).length || (saved.writing || []).length ||
                 (saved.mistakes || []).length > 3 || (saved.streak && saved.streak.count);
    if (used) fresh.legacy = saved;
    return fresh;
  }

  fresh.progress = (saved.progress && typeof saved.progress === "object") ? saved.progress : {};
  fresh.errors   = (saved.errors   && typeof saved.errors   === "object") ? saved.errors   : {};
  fresh.schedule = (saved.schedule && typeof saved.schedule === "object") ? saved.schedule : {};
  fresh.mistakes = Array.isArray(saved.mistakes) ? saved.mistakes : [];
  if (saved.legacy) fresh.legacy = saved.legacy;
  return fresh;
}

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
  /* Journal keys must be zero-padded ISO ("2026-08-02"), because the Past
     entries list, the calendar and the date filters all compare them as
     plain strings — a stray "2026-8-2" from an older build or a manual
     import would sort into the wrong place and never match a filter.
     Rewrite anything repairable; leave genuinely unparseable keys alone
     rather than silently dropping someone's writing. */
  if (s.journal && typeof s.journal === "object") {
    const fixed = {};
    Object.keys(s.journal).forEach(k => {
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(k).trim());
      const key = m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : k;
      // If both forms exist, keep the longer entry rather than letting
      // whichever happens to come last win.
      if (fixed[key] && String(fixed[key]).length > String(s.journal[k]).length) return;
      fixed[key] = s.journal[k];
    });
    s.journal = fixed;
  }
  if (!s.journalUpdated || typeof s.journalUpdated !== "object") s.journalUpdated = {};
  s.entertainment = Object.assign({ items: [] }, saved.entertainment || {});
  if (!Array.isArray(s.entertainment.items)) s.entertainment.items = [];
  /* One-time migration: a single free-text `tag` becomes a list, and every
     entry gains a status. An entry is only ever gaining fields here — the
     old `tag` string is carried into the list rather than dropped, and
     status is inferred from progress so a part-read book doesn't come back
     as untouched. */
  s.entertainment.items.forEach(it => {
    if (!Array.isArray(it.tags)) {
      it.tags = it.tag && String(it.tag).trim() ? [String(it.tag).trim()] : [];
    }
    delete it.tag;
    if (!it.status) {
      const p = Number(it.progress) || 0;
      it.status = p >= 100 ? "done" : p > 0 ? "doing" : "want";
    }
  });
  /* Guard against a saved document whose notebook tree is missing or
     malformed (e.g. an older backup, or a sync race) — fall back to a
     single empty section/page rather than leaving the page with nothing
     to show. */
  if (!s.notebook || !Array.isArray(s.notebook.sections) || !s.notebook.sections.length) {
    s.notebook = structuredClone(DEFAULT_STATE.notebook);
  }
  s.notebook.sections.forEach(sec => {
    if (!Array.isArray(sec.pages) || !sec.pages.length) {
      sec.pages = [{ id: uid(), name: "Untitled page", html: "", createdAt: Date.now(), updatedAt: Date.now() }];
    }
    if (!sec.pages.some(p => p.id === sec.activePage)) sec.activePage = sec.pages[0].id;
    if (typeof sec.color !== "number") sec.color = 0;
  });
  if (!s.notebook.sections.some(sec => sec.id === s.notebook.activeSection)) {
    s.notebook.activeSection = s.notebook.sections[0].id;
  }
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
  /* Personal Workspace. Anyone whose save predates this page has no
     saved.personal at all, so they get the default single "Home" project;
     anyone who does gets their own data with any newer fields filled in.
     The per-project normalisation below is the same additive-field pass
     s.gsi.projects gets — a project saved before archivedTasks/workDocs
     existed must not come back with those undefined, because the render
     path reads .length off them. */
  /* Health and Finance Notes used to be one plain textarea backed by
     state.health.notes / state.finance.notes. They are now the same list of
     titled rich-text notes as Work's, so any existing text is lifted into a
     first note rather than disappearing behind the new UI. The original
     string is left in place: it costs a few bytes and means rolling back to
     an older build still shows the text. */
  ["health", "finance"].forEach(key => {
    const sec = s.sections[key] || (s.sections[key] = { notes: "", noteList: [], links: [] });
    sec.noteList = Array.isArray(sec.noteList) ? sec.noteList : [];
    sec.links = Array.isArray(sec.links) ? sec.links : [];
    const legacy = (saved[key] && typeof saved[key].notes === "string") ? saved[key].notes.trim() : "";
    const alreadyMigrated = saved.sections && saved.sections[key] && Array.isArray(saved.sections[key].noteList);
    if (legacy && !alreadyMigrated) {
      sec.noteList.unshift({
        id: "mig_" + key,
        title: key === "health" ? "Health notes" : "Finance notes",
        // Plain text, so newlines become breaks and the markup is escaped —
        // otherwise a stray "<" in the old note would eat the rest of it.
        html: "<p>" + legacy.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])).replace(/\n/g, "<br>") + "</p>",
        open: false,
        updated: Date.now()
      });
    }
  });

  s.personal = Object.assign(structuredClone(DEFAULT_STATE.personal), saved.personal || {});
  if (!Array.isArray(s.personal.projects) || !s.personal.projects.length) {
    s.personal.projects = structuredClone(DEFAULT_STATE.personal.projects);
  }
  s.personal.links = Array.isArray(s.personal.links) ? s.personal.links : [];
  s.personal.docs = Array.isArray(s.personal.docs) ? s.personal.docs : [];
  s.personal.projects.forEach(p => {
    p.tasks = Array.isArray(p.tasks) ? p.tasks : [];
    p.workDocs = Array.isArray(p.workDocs) ? p.workDocs : [];
    p.archivedTasks = Array.isArray(p.archivedTasks) ? p.archivedTasks : [];
    p.workDocsLabel = p.workDocsLabel || "Documents";
    p.tasks.forEach(t => {
      t.status = t.status || "todo";
      t.date = t.date || "";
      t.link = t.link || "";
      t.flag = !!t.flag;
    });
  });
  if (!s.personal.projects.some(p => p.id === s.personal.activeProject)) {
    s.personal.activeProject = s.personal.projects[0].id;
  }

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
  s.gsi.projects.forEach(p => {
    p.workDocs = p.workDocs || []; // additive field — older saved projects predate per-project work docs
    /* One-time migration: a project's flat document list becomes the first
       of several named tabs. Existing documents move across rather than
       being rebuilt, so their ids stay valid and anything already in Trash
       still points at something real. p.workDocs is emptied straight after
       so a second load can't duplicate them. The group id is derived from
       the project id rather than random, for the same reason "legacy-gsi"
       is above: two devices still holding the old shape migrate to the
       same id and merge instead of creating two identical tabs. */
    if (!Array.isArray(p.workDocGroups)) p.workDocGroups = [];
    if (!p.workDocGroups.length) {
      p.workDocGroups.push({
        id: "wdg-legacy-" + p.id, name: "General", archived: false,
        docs: p.workDocs.length ? p.workDocs : []
      });
    }
    p.workDocs = [];
    p.workDocGroups.forEach(gr => {
      if (!Array.isArray(gr.docs)) gr.docs = [];
      gr.archived = !!gr.archived;
      gr.docs.forEach(d => { d.archived = !!d.archived; });
    });
    // The selected tab must be one that's actually on screen. Fall back to
    // the first live tab, and only to an archived one if every tab is
    // archived — in which case the card shows its empty state, not a crash.
    if (!p.workDocGroups.some(gr => gr.id === p.activeWorkDocGroup && !gr.archived)) {
      p.activeWorkDocGroup = (p.workDocGroups.find(gr => !gr.archived) || p.workDocGroups[0]).id;
    }
  });
  s.communication = migrateCommunication(saved.communication);
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
  /* Saves made before the per-day stamps existed have no map at all, and
     the sync merge reads it on every pull. */
  if (!s.health.medicineLogUpdated || typeof s.health.medicineLogUpdated !== "object") s.health.medicineLogUpdated = {};
  if (!s.habitLogUpdated || typeof s.habitLogUpdated !== "object") s.habitLogUpdated = {};
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

  /* Day Of's boards. No migration needed — nothing existed before — but
     the same guarantees apply: always at least one live tab, and the
     active id must point at a tab that is really there. */
  /* Communication whiteboard tabs. Anyone whose save predates tabs here has
     no commBoards but may well have a drawing in whiteboards.overview — that
     content is lifted into the first tab rather than stranded. The flat entry
     is left in place: it costs nothing, and removing it would make a rollback
     to an older build lose the drawing. */
  /* Whiteboard keys deliberately removed by Reclaim space. Kept in the
     synced document so every device learns the deletion; without it the
     merge treats a missing key as "the other device has something new"
     and restores it. */
  /* Set once an account has been written by a build that can read the
     compressed transport. Plain boolean in ordinary JSON, so older builds
     carry it along harmlessly without understanding it. */
  s.compressionReady = !!saved.compressionReady;

  s.removedWhiteboards = Array.isArray(saved.removedWhiteboards) ? saved.removedWhiteboards : [];
  if (s.removedWhiteboards.length && s.whiteboards) {
    s.removedWhiteboards.forEach(k => { delete s.whiteboards[k]; });
  }

  s.commBoards = Array.isArray(saved.commBoards) && saved.commBoards.length
    ? saved.commBoards
    : structuredClone(DEFAULT_STATE.commBoards);
  if (!Array.isArray(saved.commBoards) || !saved.commBoards.length) {
    const flat = saved.whiteboards?.overview;
    const first = s.commBoards[0];
    if (flat && first) {
      if (Array.isArray(flat.strokes) && flat.strokes.length) first.strokes = flat.strokes;
      if (Array.isArray(flat.objects) && flat.objects.length) first.objects = flat.objects;
      if (Array.isArray(flat.connectors) && flat.connectors.length) first.connectors = flat.connectors;
    }
  }
  s.commBoards.forEach(b => {
    b.strokes = Array.isArray(b.strokes) ? b.strokes : [];
    b.objects = Array.isArray(b.objects) ? b.objects : [];
    b.connectors = Array.isArray(b.connectors) ? b.connectors : [];
    b.zoom = b.zoom || 100;
    b.pan = b.pan || { x: 0, y: 0 };
  });
  const liveComm = s.commBoards.filter(b => !b.archived && !b.deleted);
  s.activeCommBoard =
    (saved.activeCommBoard && s.commBoards.some(b => b.id === saved.activeCommBoard && !b.deleted))
      ? saved.activeCommBoard
      : (liveComm[0] || s.commBoards[0]).id;

  s.dayofBoards = Array.isArray(saved.dayofBoards) && saved.dayofBoards.length
    ? saved.dayofBoards
    : structuredClone(DEFAULT_STATE.dayofBoards);
  s.dayofBoards.forEach(b => {
    b.strokes = Array.isArray(b.strokes) ? b.strokes : [];
    b.objects = Array.isArray(b.objects) ? b.objects : [];
  });
  const liveDayof = s.dayofBoards.filter(b => !b.archived && !b.deleted);
  s.activeDayofBoard =
    (saved.activeDayofBoard && s.dayofBoards.some(b => b.id === saved.activeDayofBoard && !b.deleted))
      ? saved.activeDayofBoard
      : (liveDayof[0] || s.dayofBoards[0]).id;

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
/* Fired whenever the whole state object is swapped out — a cloud load, a
   realtime push from another device, or a backup restore. A board deep
   link needs this: the link is opened before Supabase has answered, so the
   board it names usually doesn't exist yet on the first pass. Polling for
   it would be guesswork; this is the actual moment the data arrives. */
const stateReplacedSubs = [];
export function onStateReplaced(fn) { if (typeof fn === "function") stateReplacedSubs.push(fn); }

export function replaceState(remote) {
  delete remote._client;
  state = merge(remote);
  store.set("lifeos-data", JSON.stringify(state));
  // Never let a misbehaving subscriber take down a cloud sync.
  stateReplacedSubs.forEach(fn => { try { fn(); } catch (e) { console.warn("[state] subscriber failed", e); } });
}

/* ---------- helpers ---------- */
/* Stamps the moment a single record changed.

   Sync merges tasks per item now, so when the same task was edited on two
   devices it needs to know which edit is newer. Without this it can only
   fall back to comparing whole documents, which is the coarse behaviour
   the per-item merge exists to replace. Cheap to write, and only ever
   read by the merge. */
export const touch = rec => { if (rec) rec.updatedAt = Date.now(); return rec; };

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
/* A single interaction often calls rerender() more than once — a handler
   that edits data and then a sibling that re-sorts, or several fields
   saved in a row. renderAll() redraws every module on every call, so
   those duplicates were full extra passes over the whole interface.
   Coalescing to one animation frame collapses a burst into a single
   redraw, and lands it just before the browser paints rather than
   between paints where the work is invisible anyway. */
let renderQueued = false;
/* A render that lands mid-drag rewrites the board's innerHTML, which
   destroys the very card the pointer is holding and leaves SortableJS
   working against detached nodes — and, because init*Sorting() destroys
   its instances first, strands the <body>-mounted drag clone permanently
   (the whole story is in js/drag-cleanup.js). Renders arrive unbidden
   from sync, so this was intermittent: it needed a background pull to
   coincide with a lift.

   Holding the frame until the lift ends fixes it at the source, and
   costs nothing — the burst that arrives during a drag still collapses
   into the single redraw the coalescing was already there to produce.

   The deadline is the safety valve. body.is-dragging is cleared by
   Sortable's own onEnd AND by the pointer-release net in app.js, so it
   should never stick; if it somehow does, a stalled interface is a far
   worse failure than a redraw landing mid-drag, so after the deadline the
   render goes through regardless.

   1000ms used to be that deadline, but a deliberate human drag — pausing
   over a column, dragging on a touch screen, crossing a wide board —
   routinely runs longer than a second on its own. Any background render
   that arrived during that first second (a sync pull, a calendar refresh)
   would then force itself through WHILE the card was still actually being
   held, rewriting the board out from under the pointer: the exact
   mid-drag flash/reset this whole mechanism exists to prevent. Stretching
   the valve to 8s keeps it as a backstop for a genuinely stuck flag
   without it firing on ordinary, unhurried drags. */
const DRAG_RENDER_DEADLINE_MS = 8000;

/* ---------- committing a change WITHOUT repainting ----------

   Every mutation helper (toggleTask, editTaskMeta, archiveTask, and the
   GSI/Personal equivalents) ends in rerender(), which is right for a tap
   on a checkbox: the caller has no idea what the change looks like, so
   the app redraws and finds out.

   A DROP is the one case where that is exactly backwards. SortableJS has
   already put the card where the person let go of it — the screen is
   ALREADY correct — and the only thing left to do is write the data down.
   Redrawing then rebuilds the board out from under a finger that has only
   just lifted: #taskList is replaced wholesale, the page height collapses
   and re-expands, the scroll position gets clamped on the way through, and
   the board lands somewhere other than where it was. That is the "page
   moves after I move a card" report, and it is not a bug in the scroll
   restore — the restore is fighting a repaint that should never have been
   asked for.

   Todoist does not repaint on a drop, and neither do we now. This lets the
   drop handler run the ordinary mutation helpers — so sync, Google
   Calendar, Trash and persistence all still go through the one code path
   they always did — while swallowing the repaint each of them requests,
   and then patch the single card that actually changed.

   Deliberately a counter and not a boolean: nested suppressed commits
   (moveTaskToColumn calls toggleTask, which is itself suppressible) must
   not have the inner one hand the repaint back early. */
let renderSuppressed = 0;
export function commitWithoutRender(fn) {
  renderSuppressed++;
  try { return fn(); } finally { renderSuppressed--; }
}

export function rerender() {
  /* Swallowed, not deferred. Deferring would only move the repaint one
     frame later, which is precisely the flash being removed — the caller
     inside commitWithoutRender() has taken responsibility for updating
     the DOM itself. */
  if (renderSuppressed) return;
  if (!renderer || renderQueued) return;
  renderQueued = true;
  const deadline = Date.now() + DRAG_RENDER_DEADLINE_MS;
  const frame = () => {
    if (document.body.classList.contains("is-dragging") && Date.now() < deadline) {
      requestAnimationFrame(frame);
      return;
    }
    renderQueued = false;
    renderer();
  };
  requestAnimationFrame(frame);
}
// For the few places that must see the DOM updated on the next line.
export function rerenderNow() { if (renderer) renderer(); }

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
  if (pushRemote) {
    state.updatedAt = Date.now();
    state.rev = (state.rev || 0) + 1; // clock-independent "something really changed here"
  }
  /* JSON.stringify over the entire state — whiteboard strokes included —
     ran on every single keystroke that reached persist(). On a large
     board that is megabytes of serialisation per character typed, on the
     main thread, and it was the biggest cause of typing feeling heavy.

     The write is now coalesced over a short window. state itself is
     already updated synchronously, so nothing reads stale data; only the
     disk copy lags, and by at most a moment. flushLocalSave() below
     forces it out before the tab can go away, so the window can't turn
     into lost work. */
  scheduleLocalWrite();
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
let localWriteTimer = null;
function scheduleLocalWrite() {
  if (localWriteTimer) return;
  localWriteTimer = setTimeout(() => { localWriteTimer = null; writeLocalNow(); }, 400);
}
function writeLocalNow() {
  store.set("lifeos-data", JSON.stringify(state));
}
export function flushLocalSave() {
  if (localWriteTimer) { clearTimeout(localWriteTimer); localWriteTimer = null; }
  writeLocalNow();
}

export function flushPendingSave() {
  flushLocalSave(); // never let the cloud copy be newer than the disk copy
  if (saveTimer && remoteSaver) {
    clearTimeout(saveTimer);
    saveTimer = null;
    remoteSaver();
  }
}

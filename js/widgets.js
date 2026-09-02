/* Links, news feeds, quotes, meditation, Day Of page + journal. */
import { state, uid, esc, persist, rerender, todayKey } from './state.js?v=202609041000';
import { toast, autoGrow, registerBusyCheck, markFieldClean } from './ui.js?v=202609041000';
import { moveToTrash } from './trash.js?v=202609041000';
import { isLogged, streak } from './habits.js?v=202609041000';
import { getAllGsiTasksFlat } from './gsi.js?v=202609041000';
import { getAllPwTasksFlat } from './personal.js?v=202609041000';
import { mountRichEditor, getRichEditor } from './rich-text.js?v=202609041000';
import { sanitizeHtml } from './sanitize.js?v=202609041000';

/* ---------- important links ---------- */
let openLinkEditId = null; // which single link's inline edit panel is open — UI-only, not persisted
export function renderLinks() {
  /* The label lives INSIDE #linksGrid, not in a wrapper around it, for
     two reasons: it shares the pill row's flex line so it reads as the
     row's leading label, and — importantly — wrapping #linksGrid would
     break the `#linksGrid + .add-inline` adjacent-sibling selectors that
     both style.css and the collapse rule depend on. */
  const label = `<span class="card-head-section link-grid-label">Important links</span>`;
  document.getElementById("linksGrid").innerHTML = label + state.links.map(l => `
    <div class="link-row" data-link-id="${l.id}">
      <a href="${esc(l.url)}" target="_blank" rel="noopener" class="link-row-title" onclick="linkClickPulse(this)">${esc(l.title)}</a>
      <button class="link-edit-btn" onclick="toggleLinkEdit('${l.id}')" title="Edit link">✎</button>
      <button class="del link-del-btn" onclick="delLink('${l.id}')" title="Delete">✕</button>
      <div class="link-edit-panel ${openLinkEditId === l.id ? "open" : ""}" id="linkEdit-${l.id}">
        <div class="link-edit-panel-inner">
          <input type="text" value="${esc(l.title)}" placeholder="Title" onchange="editLink('${l.id}','title',this.value)">
          <input type="text" value="${esc(l.url)}" placeholder="https://…" onchange="editLink('${l.id}','url',this.value)">
          <input type="text" value="${esc(l.desc || "")}" placeholder="Description (optional)" onchange="editLink('${l.id}','desc',this.value)">
        </div>
      </div>
    </div>`).join("") || `<p class="hint">Save the links you reach for every day.</p>`;
  /* The three-field add row below is always visible on desktop, where
     there is room for it. On the foldable/tablet/phone widths it is
     collapsed behind this "+" chip instead (CSS-only, see section 9 of
     responsive-foldable.css) so the links card stays the single compact
     pill row the reference shows. The toggle is a class on the card, not
     state, so re-rendering the grid — which replaces this button — can
     never leave the row stranded open or shut. */
  document.getElementById("linksGrid").insertAdjacentHTML("beforeend",
    `<button type="button" class="link-add-btn" title="Add link" aria-label="Add link"
       onclick="this.closest('.card').classList.toggle('adding')">+</button>`);
}
export function toggleLinkEdit(id) {
  openLinkEditId = openLinkEditId === id ? null : id;
  renderLinks();
  // The popover's own z-index only has authority within its containing
  // .card's stacking context (backdrop-filter gives every .card its own
  // one) — it can never paint above a completely separate sibling card
  // like Tasks below it, no matter how high that number is set. Instead
  // the containing card itself gets promoted for as long as a popover
  // inside it is open, which lets its content — the popover included —
  // paint above the next card in normal document flow.
  const card = document.getElementById("linksGrid")?.closest(".card");
  if (card) card.classList.toggle("has-open-popover", !!openLinkEditId);
  if (openLinkEditId) document.querySelector(`#linkEdit-${id} input`)?.focus();
}
document.addEventListener("pointerdown", (evt) => {
  if (!openLinkEditId) return;
  if (evt.target.closest(".link-edit-panel") || evt.target.closest(".link-edit-btn")) return;
  toggleLinkEdit(openLinkEditId); // same id toggles it closed
});
export function editLink(id, field, value) {
  const l = state.links.find(x => x.id === id);
  if (!l) return;
  if (field === "url") { value = value.trim(); if (value && !/^https?:\/\//i.test(value)) value = "https://" + value; }
  l[field] = value.trim ? value.trim() : value;
  persist(); rerender();
}
// A quick, satisfying press animation on the link itself — the click
// still opens the link normally (this doesn't preventDefault anything),
// this just gives it some tactile feedback beyond the plain color change
// a bare <a> gets. Remove-then-reflow-then-add is needed so the
// animation reliably restarts even if you click the same link twice in
// a row, rather than silently doing nothing the second time because the
// class was already present.
export function linkClickPulse(el) {
  el.classList.remove("clicked");
  void el.offsetWidth;
  el.classList.add("clicked");
}
export function addLink() {
  const t = document.getElementById("linkTitle"), u = document.getElementById("linkUrl"), d = document.getElementById("linkDesc");
  if (!t.value.trim() || !u.value.trim()) return toast("Title and URL are required");
  let url = u.value.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  state.links.push({ id: uid(), title: t.value.trim(), url, desc: d.value.trim() });
  t.value = u.value = d.value = "";
  persist(); rerender();
}
export function delLink(id) {
  const l = state.links.find(x => x.id === id);
  if (l) moveToTrash("bookmarkLink", l);
  state.links = state.links.filter(x => x.id !== id); persist(); rerender();
}

/* ---------- news feeds ---------- */
export function renderFeeds() {
  document.getElementById("newsList").innerHTML = state.feeds.map(f => `
    <a href="${esc(f.url)}" target="_blank" rel="noopener">
      <span class="fav">${esc((f.name || "?")[0])}</span>${esc(f.name)}
      <button class="del" style="margin-left:auto;opacity:.35" onclick="event.preventDefault();delFeed('${f.id}')">✕</button>
    </a>`).join("");
}
export function addFeed() {
  const n = document.getElementById("feedName"), u = document.getElementById("feedUrl");
  if (!n.value.trim() || !u.value.trim()) return toast("Name and URL are required");
  let url = u.value.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  state.feeds.push({ id: uid(), name: n.value.trim(), url }); n.value = u.value = "";
  persist(); rerender();
}
export function delFeed(id) {
  const f = state.feeds.find(x => x.id === id);
  if (f) moveToTrash("feed", f);
  state.feeds = state.feeds.filter(x => x.id !== id); persist(); rerender();
}

/* ---------- quotes ---------- */
const dayIndex = () => {
  const start = new Date(new Date().getFullYear(), 0, 0);
  return Math.floor((Date.now() - start) / 864e5);
};
export function renderQuote() {
  if (!state.quotes.length) {
    document.getElementById("quoteBox").textContent = "Add some quotes you love."; return;
  }
  const q = state.quotes[(dayIndex() + state.quoteOffset) % state.quotes.length];
  document.getElementById("quoteBox").innerHTML = `<span class="mark">“</span>${esc(q)}`;
}
export function nextQuote() { state.quoteOffset++; persist(false); renderQuote(); }

/* ---------- meditation ---------- */
let medSecs = 600, medLeft = 600, medTimer = null;
const fmtClock = s => String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");

export function setMed(min) {
  stopMed(); medSecs = medLeft = min * 60;
  document.getElementById("medClock").textContent = fmtClock(medLeft);
}
export function toggleMed() { medTimer ? stopMed() : startMed(); }
function startMed() {
  document.getElementById("medStartBtn").textContent = "Pause";
  medTimer = setInterval(() => {
    medLeft--; document.getElementById("medClock").textContent = fmtClock(medLeft);
    if (medLeft <= 0) {
      stopMed(); logMed(Math.round(medSecs / 60)); medLeft = medSecs;
      document.getElementById("medClock").textContent = fmtClock(medLeft);
      toast("Meditation complete 🌿");
    }
  }, 1000);
}
function stopMed() {
  clearInterval(medTimer); medTimer = null;
  document.getElementById("medStartBtn").textContent = "Start";
}
function logMed(min) {
  const k = todayKey();
  state.meditation[k] = (state.meditation[k] || 0) + min;
  persist(); renderMedStat();
}
export function renderMedStat() {
  const today = state.meditation[todayKey()] || 0;
  document.getElementById("medStat").textContent = today ? `${today} min logged today` : "No session logged today yet";
  document.getElementById("medTodayHint").textContent = today ? `${today} min today` : "";
  const catMedSub = document.getElementById("catMedSub");
  if (catMedSub) catMedSub.textContent = today ? `${today} min done today 🌿` : "Breathe for a while.";
}

/* ---------- Day Of page ---------- */
let currentJournalDate = null; // null = today (re-evaluated each render so it stays "today" across midnight)

export function renderDayOf() {
  const k = todayKey();
  const viewDate = currentJournalDate || k;

  // "Today's focus" mixes urgency and importance: due today, overdue
  // (still needs attention), finished today (so the day's progress is
  // visible) — and now also anything flagged as important, regardless of
  // its date, since a flagged task is one you've deliberately said matters
  // right now even if it isn't formally due. Applies to both personal
  // tasks and GSI Workspace tasks — toggling or editing either one here
  // routes through tasks.js's toggleTask/editTask, which already handle
  // GSI-sourced IDs transparently (same routing Overview's own merged
  // task view relies on), so nothing GSI-specific is needed here beyond
  // supplying the merged list itself.
  const personal = state.tasks.map(t => ({ ...t, isGsi: false, source: null }));
  const gsi = getAllGsiTasksFlat().map(t => ({
    id: t.id, text: t.text, done: t.status === "done", flag: !!t.flag,
    link: t.link || "", dueDate: t.date || "", completedAt: null,
    isGsi: true, source: t.projectName
  }));
  /* Personal Workspace tasks belong here for the same reason GSI ones do:
     Day Of answers "what is due today", and a task being due doesn't
     depend on which tree it lives in. Same normalisation, and the id is
     all any action needs — findAnyTask routes it back to the real object. */
  const pw = getAllPwTasksFlat().map(t => ({
    id: t.id, text: t.text, done: t.status === "done", flag: !!t.flag,
    link: t.link || "", dueDate: t.date || "", completedAt: null,
    isPersonal: true, source: t.projectName
  }));
  /* Strictly the day being viewed.

     Two rules used to widen this well past "today":
       - `if (t.flag) return true` put every flagged task here forever,
         whatever its date and even with no date at all. Flagging marks a
         task important, not due — those two are different things, and
         conflating them meant a handful of permanently-flagged items
         crowded out the day's actual work.
       - `t.dueDate <= k` swept in everything overdue as well.

     Overdue tasks still matter, so they are not simply dropped: they are
     counted and surfaced as a line beneath the list, which keeps a missed
     deadline visible without letting it fill the card. */
  const all = [...personal, ...gsi, ...pw];
  const dayTaskList = all.filter(t => {
    if (t.done) return t.completedAt && todayKey(new Date(t.completedAt)) === k;
    return t.dueDate === k;
  }).sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1; // completed sinks to the bottom
    if (!!a.flag !== !!b.flag) return a.flag ? -1 : 1; // flagged/important first
    return (a.dueDate || "").localeCompare(b.dueDate || ""); // then overdue (earlier date) first
  });

  document.getElementById("dayTasks").innerHTML = dayTaskList.map((t, i) => `
    <div class="task-row ${t.done ? "done" : ""}">
      <button class="chk ${t.done ? "on" : ""}" onclick="toggleTask('${t.id}')"><svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <span class="task-num">${i + 1}</span>
      <textarea class="${t.link ? "task-text-linked" : ""}" rows="1" onclick="event.stopPropagation()" onchange="editTask('${t.id}',this.value)" oninput="autoGrow(this)">${esc(t.text)}</textarea>
      ${t.source ? `<span class="task-source-badge">${esc(t.source)}</span>` : ""}
      ${t.link ? `<a href="${esc(t.link.startsWith("http")?t.link:"https://"+t.link)}" target="_blank" rel="noopener" class="task-link-go-inline" title="Open link">🔗</a>` : ""}
    </div>`).join("") || `<p class="hint">Nothing due today.</p>`;

  /* Anything still open with a date before the day being viewed. Shown as
     a single line rather than as rows, so it informs without competing
     with today's list. */
  const overdue = all.filter(t => !t.done && t.dueDate && t.dueDate < k);
  const overdueEl = document.getElementById("dayOverdue");
  if (overdueEl) {
    overdueEl.innerHTML = overdue.length
      ? `<button class="day-overdue-line" onclick="go('overview')">
           <span class="due-pill overdue">${overdue.length} overdue</span>
           <span>${esc(overdue.slice(0, 2).map(t => t.text).join(" · "))}${overdue.length > 2 ? " …" : ""}</span>
         </button>`
      : "";
  }
  // Same "measure after render" requirement as everywhere else this
  // input→textarea fix has been applied — see go() in ui.js for the
  // re-run when this page was hidden at the moment this render happened.
  document.getElementById("dayTasks").querySelectorAll("textarea").forEach(autoGrow);
  document.getElementById("dayHabits").innerHTML = state.habits.map(h => `
    <div class="task-row">
      <button class="chk ${isLogged(k, h.id) ? "on" : ""}" onclick="toggleHabit('${k}','${h.id}')"><svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <span style="font-weight:600;flex:1">${esc(h.name)}</span>
      <span class="streak">${streak(h.id)}🔥</span>
    </div>`).join("");
  renderJournalEditor(viewDate);
  renderJournalList(viewDate);
}

function fmtJournalDate(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
/* The journal editor is one Quill instance showing many documents — one
   per date — unlike the meeting-minutes editors, which get an instance
   each. mountRichEditor only consults its initial-HTML callback on the
   very first mount, so switching dates has to swap the content in
   explicitly, and this tracks which date the editor is currently
   holding so an edit always saves to the right day. */
const JOURNAL_EDITOR_ID = "dayJournalEditor";
let journalLoadedDate = null;

/* ---------- the journal editor's unsaved state ----------

   True from the first keystroke until the text has been written into
   `state`. This is the ONLY thing that should stop a background pull on
   the journal page: the editor holding focus must not, or parking the
   cursor here — the normal way to sit on this page — would switch off
   cross-device sync for as long as the tab is open.

   `journalApplyingRemote` guards the other direction: while a merged
   remote entry is being loaded into Quill, that must not be mistaken for
   the user editing, or reading someone else's update would stamp the day
   and push it straight back. Quill's own 'api' source handles this for
   text-change (see rich-text.js) — this is belt and braces for anything
   reading the flag directly. */
let journalEditorDirty = false;
let journalApplyingRemote = false;
export function hasUnsavedJournalEdit() { return journalEditorDirty; }
registerBusyCheck(hasUnsavedJournalEdit);

/* Exported so the app can force a pending edit out to `state` before the
   tab backgrounds, closes, or pulls from the cloud. Quill's change event
   is debounced by 500ms (see rich-text.js); on mobile a tab that goes
   into the background can have its timers frozen before that fires, so
   the last thing typed would never reach `state` at all — not saved, not
   synced, and invisible to Undo and Trash because nothing ever saw it. */
export function flushJournalEditor() {
  // Quill's change events are debounced, so a pending edit can still be
  // in flight when the date changes. Writing the current contents back
  // to the date they belong to *before* swapping avoids that edit
  // landing on the day being switched to.
  const q = getRichEditor(JOURNAL_EDITOR_ID);
  if (!q || !journalLoadedDate) { journalEditorDirty = false; return; }
  const html = q.root.innerHTML;
  journalEditorDirty = false; // whatever is in the editor is about to be in `state`
  markFieldClean(q.root);
  if (isEmptyRichText(html)) {
    if (state.journal[journalLoadedDate]) {
      delete state.journal[journalLoadedDate];
      stampJournalDay(journalLoadedDate);
      persist();
    }
  } else if (state.journal[journalLoadedDate] !== html) {
    state.journal[journalLoadedDate] = html;
    stampJournalDay(journalLoadedDate);
    persist();
  }
}
// Quill never leaves its root truly empty — an untouched editor still
// holds "<p><br></p>" — so a blank day has to be recognised by content,
// not by string length, or every date visited would gain an entry.
/* Records WHEN this day was last touched on this device. The sync merge
   reads it to settle a day that was written on two devices — without it
   the only tiebreak is which whole document is newer, which is why an
   entry written on the phone and an entry written at the desk could take
   turns replacing each other instead of settling. Deletions are stamped
   too: "cleared at 19:10" has to be able to beat "written at 18:40". */
function stampJournalDay(date) {
  if (!date) return;
  if (!state.journalUpdated || typeof state.journalUpdated !== "object") state.journalUpdated = {};
  state.journalUpdated[date] = Date.now();
}

function isEmptyRichText(html) {
  return !String(html || "").replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "").trim();
}

function renderJournalEditor(viewDate) {
  const isToday = viewDate === todayKey();
  document.getElementById("journalEditingLabel").textContent = isToday ? "Today — " + fmtJournalDate(viewDate) : fmtJournalDate(viewDate);
  document.getElementById("journalDatePicker").value = viewDate;
  document.getElementById("journalTodayBtn").style.display = isToday ? "none" : "";

  const quill = mountRichEditor(JOURNAL_EDITOR_ID, () => state.journal[viewDate] || "", html => {
    const d = journalLoadedDate;
    if (!d) return;
    if (isEmptyRichText(html)) {
      // Selecting a day's writing and deleting it used to remove the entry
      // outright, with nothing anywhere to get it back from. Keep a copy.
      const previous = state.journal[d];
      if (previous && !isEmptyRichText(previous)) {
        moveToTrash("journalEntry", { id: "journal-" + d, date: d, html: previous }, { date: d });
        toast(`Entry for ${fmtJournalDate(d)} moved to Trash`);
      }
      delete state.journal[d];
    } else {
      state.journal[d] = html;
    }
    stampJournalDay(d);
    journalEditorDirty = false; // committed — a pull is safe again
    // The editor still holds this text and may still have focus; without
    // this it would read as permanently modified against its focus-time
    // baseline and go on blocking sync long after it was saved.
    const q = getRichEditor(JOURNAL_EDITOR_ID);
    if (q) markFieldClean(q.root);
    persist();
    renderJournalList(d);
  }, () => { journalEditorDirty = true; });
  if (!quill) return; // Quill CDN unavailable — nothing to load into
  // Quill renders .ql-blank::before from this attribute, so the original
  // textarea's prompt survives the switch to a rich-text editor.
  quill.root.dataset.placeholder = "How did that day go?";
  if (journalLoadedDate === null) { journalLoadedDate = viewDate; return; } // just mounted with this date's content

  if (journalLoadedDate === viewDate) {
    /* The day on screen is the day already loaded. Normally there is
       nothing to do — reloading it would throw the cursor to the start on
       every repaint.

       But a repaint is also how a merged remote entry announces itself,
       and returning unconditionally here meant the editor kept showing
       its old text after a pull had already updated `state`. The Past
       entries list beside it (rebuilt from `state` every time) showed the
       new version, the editor showed the old one, and whichever was
       typed into next overwrote the other. Cloud, state and screen have
       to agree; two out of three is how a good merge still loses text. */
    adoptRemoteJournalContent(quill, viewDate);
    return;
  }

  flushJournalEditor();
  journalLoadedDate = viewDate;
  const html = state.journal[viewDate] || "";
  // Source is 'api' for both of these, which rich-text.js deliberately
  // ignores — loading a day must not count as editing it.
  // Date-to-date content swaps bypass mountRichEditor's own sanitizing,
  // so this second entry point needs the same guard.
  if (html) quill.clipboard.dangerouslyPasteHTML(sanitizeHtml(html));
  else quill.setText("");
}
/* Compared on visible text, not markup. Quill rewrites HTML as it
   normalises it, so `state` and `quill.root.innerHTML` routinely differ
   by a wrapper or an attribute while reading identically — comparing raw
   HTML would repaste on every single repaint and throw the cursor to the
   start each time. The trade-off is that a remote change of formatting
   alone (same words, newly bolded) waits for the next date switch. */
function journalVisibleText(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* Loads a remotely-merged entry into the editor that is already open on
   that date. Deliberately does NOT persist, stamp journalUpdated, or
   touch the revision: this is displaying someone else's edit, not making
   one. Quill's 'api' source keeps text-change from firing as a user
   edit, so nothing here can bounce back to the cloud. */
function adoptRemoteJournalContent(quill, date) {
  if (!quill || journalApplyingRemote) return;
  // Never overwrite an edit in progress. The merge in supabase.js has
  // already resolved the day; the version being typed here reaches it on
  // the next flush, and a genuine conflict is preserved in Trash.
  if (journalEditorDirty) return;

  const want = state.journal[date] || "";
  const shown = quill.root.innerHTML;
  if (journalVisibleText(want) === journalVisibleText(shown)) return;

  journalApplyingRemote = true;
  try {
    const hadFocus = quill.hasFocus();
    if (want) quill.clipboard.dangerouslyPasteHTML(sanitizeHtml(want));
    else quill.setText("");
    // Put the caret back at the end of the adopted text rather than
    // letting it snap to position 0 under someone's hands.
    if (hadFocus) { try { quill.setSelection(quill.getLength(), 0, "silent"); } catch (e) {} }
    markFieldClean(quill.root); // adopted text is the new baseline, not a pending edit
  } finally {
    journalApplyingRemote = false;
  }
}

let journalFilterFrom = "", journalFilterTo = "";
let journalSearchQuery = "";
let journalSortDesc = true; // newest first by default

/* The dates that currently pass the date range *and* the text search,
   newest first. Shared by the Past-entries list and the .txt export so
   the export button always writes out exactly what the list is showing —
   one filter, one definition of "what's selected". */
/* Order by the actual date the key represents rather than by string
   comparison. Padded ISO keys sort identically either way, but a key that
   slipped through in another shape would land arbitrarily under a plain
   sort — here it still falls in the right place. */
function journalDateValue(k) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(k).trim());
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : -1;
}
function filteredJournalDates() {
  let dates = Object.keys(state.journal).filter(d => (state.journal[d] || "").trim())
    .sort((a, b) => journalSortDesc
      ? journalDateValue(b) - journalDateValue(a)
      : journalDateValue(a) - journalDateValue(b));
  if (journalFilterFrom) dates = dates.filter(d => d >= journalFilterFrom);
  if (journalFilterTo) dates = dates.filter(d => d <= journalFilterTo);
  if (journalSearchQuery) {
    const q = journalSearchQuery.toLowerCase();
    dates = dates.filter(d => journalPlainText(state.journal[d]).toLowerCase().includes(q));
  }
  return dates;
}

/* Some older journal entries are stored as HTML ("<p>Weekly-off</p>")
   rather than plain text. Stored values are left exactly as they are —
   this only flattens the markup for *reading*: the list snippets and the
   exported file. DOMParser is used instead of innerHTML so nothing in
   that markup can execute or fetch anything while being unwrapped. */
function journalPlainText(raw) {
  const s = String(raw ?? "");
  if (!/<[a-z!\/][^>]*>/i.test(s)) return s.trim(); // plain text already — leave it alone
  const withBreaks = s
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\u2022 ")
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote|tr|ul|ol)\s*>/gi, "\n");
  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

/* Every occurrence of the search term inside one entry, each as a short
   window of surrounding text with the hit marked — a day mentioning
   "BISAG-N" three times should show all three, not just the first. The
   pieces are escaped individually and only the <mark> is real markup, so
   entry text can never inject HTML into the list. */
const MATCH_CONTEXT = 45; // characters shown either side of a hit
const MAX_MATCHES_PER_ENTRY = 12;
function matchOffsets(plain, q) {
  const hay = plain.toLowerCase(), needle = q.toLowerCase(), out = [];
  let i = hay.indexOf(needle);
  while (i !== -1 && out.length < MAX_MATCHES_PER_ENTRY) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}
function matchSnippetsHtml(plain, q) {
  return matchOffsets(plain, q).map(i => {
    const end = i + q.length;
    const s = Math.max(0, i - MATCH_CONTEXT), e = Math.min(plain.length, end + MATCH_CONTEXT);
    return `<span class="jd-snip">${s > 0 ? "…" : ""}${esc(plain.slice(s, i))}` +
      `<mark class="jd-hit">${esc(plain.slice(i, end))}</mark>` +
      `${esc(plain.slice(end, e))}${e < plain.length ? "…" : ""}</span>`;
  }).join("");
}
function countMatches(plain, q) {
  const hay = plain.toLowerCase(), needle = q.toLowerCase();
  let n = 0, i = hay.indexOf(needle);
  while (i !== -1) { n++; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

function renderJournalList(viewDate) {
  const box = document.getElementById("journalList");
  if (!box) return;
  const dates = filteredJournalDates();
  const q = journalSearchQuery;
  const filterActive = journalFilterFrom || journalFilterTo;
  const exportBtn = document.getElementById("journalExportBtn");
  if (exportBtn) {
    exportBtn.disabled = !dates.length;
    exportBtn.title = dates.length
      ? `Export ${dates.length} ${dates.length === 1 ? "entry" : "entries"} as a .txt file`
      : "No entries to export";
  }

  let totalMatches = 0;
  box.innerHTML = dates.map(d => {
    const plain = journalPlainText(state.journal[d] || "");
    let body, badge = "";
    if (q) {
      const n = countMatches(plain, q);
      totalMatches += n;
      body = matchSnippetsHtml(plain, q);
      if (n > 1) badge = `<span class="jd-hit-count">${n} matches</span>`;
    } else {
      body = `<span class="jd-snip">${esc(plain)}</span>`;
    }
    return `
    <button class="journal-list-item ${d === viewDate ? "active" : ""}" onclick="selectJournalDate('${d}')">
      <span class="jd-head"><span class="jd-date">${fmtJournalDate(d)}</span>${badge}</span>
      ${body}
    </button>`;
  }).join("") || `<p class="hint">${
    q ? "No entries contain that." : filterActive ? "No entries in that date range." : "Past entries will appear here."
  }</p>`;

  const stat = document.getElementById("journalSearchStat");
  if (stat) {
    stat.textContent = q
      ? `${totalMatches} ${totalMatches === 1 ? "match" : "matches"} in ${dates.length} ${dates.length === 1 ? "entry" : "entries"}`
      : "";
  }
  const clearBtn = document.getElementById("journalSearchClearBtn");
  if (clearBtn) clearBtn.style.display = q ? "" : "none";
  // Entry dots go stale the moment an entry is written or the selection
  // moves, and every one of those paths already ends here.
  renderJournalCalendar();
}

export function toggleJournalSort() {
  journalSortDesc = !journalSortDesc;
  const btn = document.getElementById("journalSortBtn");
  if (btn) {
    btn.textContent = journalSortDesc ? "↓ Most recent first" : "↑ Oldest first";
    btn.title = journalSortDesc ? "Showing newest first — click for oldest first" : "Showing oldest first — click for newest first";
  }
  renderJournalList(currentJournalDate || todayKey());
}

export function applyJournalSearch() {
  journalSearchQuery = (document.getElementById("journalSearchInput")?.value || "").trim();
  renderJournalList(currentJournalDate || todayKey());
}
export function clearJournalSearch() {
  journalSearchQuery = "";
  const el = document.getElementById("journalSearchInput");
  if (el) { el.value = ""; el.focus(); }
  renderJournalList(currentJournalDate || todayKey());
}

/* ---------- export the selected date range to a .txt file ---------- */
export function exportJournalRange() {
  // The file is written in the same order the list is showing, so the
  // export can never disagree with what's on screen.
  const dates = filteredJournalDates();
  if (!dates.length) { toast("No entries in that date range to export."); return; }
  const first = dates[0], last = dates[dates.length - 1];
  const from = journalSortDesc ? last : first, to = journalSortDesc ? first : last;
  const rule = "=".repeat(56);
  const out = [
    "LifeOS — Journal export",
    `Range:    ${fmtJournalDate(from)}  to  ${fmtJournalDate(to)}`,
    ...(journalSearchQuery ? [`Matching: "${journalSearchQuery}"`] : []),
    `Entries:  ${dates.length}`,
    `Exported: ${new Date().toLocaleString("en-IN")}`,
    ""
  ];
  dates.forEach(d => out.push(rule, fmtJournalDate(d), rule, journalPlainText(state.journal[d] || ""), ""));
  // CRLF so the file opens with its line breaks intact in Notepad too.
  const blob = new Blob([out.join("\r\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = from === to ? `journal-${from}.txt` : `journal-${from}_to_${to}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${dates.length} ${dates.length === 1 ? "entry" : "entries"}.`);
}

/* ---------- month calendar marking the days that have entries ----------
   The browser's own <input type="date"> popup is native UI: its day
   cells cannot be styled or annotated from the page, so days holding an
   entry can never be marked inside it. This is a small in-page calendar
   that can — the same Monday-start grid the habits month view uses, with
   a dot under every date that has a journal entry. The native input is
   kept alongside it for typing a date directly. */
let journalCalCursor = null; // first of the month on screen; null until first opened

export function toggleJournalCalendar(evt) {
  if (evt) evt.stopPropagation();
  const pop = document.getElementById("journalCalPop");
  if (!pop) return;
  const opening = !pop.classList.contains("open");
  pop.classList.toggle("open", opening);
  // backdrop-filter gives every .card its own stacking context, so the
  // popover's z-index can't escape it — see toggleLinkEdit above.
  pop.closest(".card")?.classList.toggle("has-open-popover", opening);
  if (opening) {
    const [y, m] = (currentJournalDate || todayKey()).split("-").map(Number);
    journalCalCursor = new Date(y, m - 1, 1);
    renderJournalCalendar();
  }
}
export function closeJournalCalendar() {
  const pop = document.getElementById("journalCalPop");
  if (!pop || !pop.classList.contains("open")) return;
  pop.classList.remove("open");
  pop.closest(".card")?.classList.remove("has-open-popover");
}
export function shiftJournalCalMonth(delta) {
  journalCalCursor = journalCalCursor || new Date();
  journalCalCursor = new Date(journalCalCursor.getFullYear(), journalCalCursor.getMonth() + delta, 1);
  renderJournalCalendar();
}
export function journalCalPick(d) {
  selectJournalDate(d);
  closeJournalCalendar();
}
function renderJournalCalendar() {
  const grid = document.getElementById("journalCalGrid");
  if (!grid || !journalCalCursor) return;
  const year = journalCalCursor.getFullYear(), month = journalCalCursor.getMonth();
  document.getElementById("journalCalLabel").textContent =
    journalCalCursor.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const startOffset = (new Date(year, month, 1).getDay() + 6) % 7; // Monday-start, matching habits.js
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const tKey = todayKey(), selected = currentJournalDate || tKey;
  let cells = "", monthCount = 0;
  for (let i = 0; i < startOffset; i++) cells += `<div class="jcal-cell empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const k = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const has = !!(state.journal[k] || "").trim();
    if (has) monthCount++;
    cells += `<button class="jcal-cell${has ? " has-entry" : ""}${k === selected ? " sel" : ""}${k === tKey ? " today" : ""}"
      onclick="journalCalPick('${k}')" title="${fmtJournalDate(k)}${has ? " — has an entry" : ""}">${day}</button>`;
  }
  grid.innerHTML = cells;
  document.getElementById("journalCalCount").textContent =
    monthCount ? `${monthCount} ${monthCount === 1 ? "entry" : "entries"}` : "No entries";
}
document.addEventListener("pointerdown", (e) => {
  if (e.target.closest && e.target.closest(".jcal-wrap")) return;
  closeJournalCalendar();
});
export function applyJournalFilter() {
  journalFilterFrom = document.getElementById("journalFilterFrom").value;
  journalFilterTo = document.getElementById("journalFilterTo").value;
  document.getElementById("journalFilterClearBtn").style.display = (journalFilterFrom || journalFilterTo) ? "" : "none";
  renderJournalList(currentJournalDate || todayKey());
}
export function clearJournalFilter() {
  journalFilterFrom = journalFilterTo = "";
  document.getElementById("journalFilterFrom").value = "";
  document.getElementById("journalFilterTo").value = "";
  document.getElementById("journalFilterClearBtn").style.display = "none";
  renderJournalList(currentJournalDate || todayKey());
}
export function selectJournalDate(d) {
  currentJournalDate = d;
  // Whichever route picked the date — the grid, the native input, the
  // Today button, a past-entry row — the month popover has served its
  // purpose and should get out of the way.
  closeJournalCalendar();
  renderJournalEditor(d);
  renderJournalList(d);
}
export function journalGoToday() { selectJournalDate(todayKey()); }

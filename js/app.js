/* LifeOS v0.3 — entry point: wires modules together and boots the app. */
import { setRenderer } from './state.js';
import * as ui from './ui.js';
import * as tasks from './tasks.js';
import * as goals from './goals.js';
import * as habits from './habits.js';
import * as widgets from './widgets.js';
import * as sections from './sections.js';
import * as gsi from './gsi.js';
import * as search from './search.js';
import * as cloud from './supabase.js';
import { initCommunicationBridge } from './communication-bridge.js';

/* One render pass repaints everything — the app is small enough
   that this keeps every module fully decoupled. */
function renderAll() {
  ui.renderHeader();
  tasks.renderTasks();
  goals.renderGoals();
  habits.renderHabits();
  widgets.renderLinks();
  widgets.renderFeeds();
  widgets.renderQuote();
  widgets.renderMedStat();
  widgets.renderDayOf();
  sections.renderSections();
  gsi.renderGsi();
}

/* The markup uses plain onclick="…" handlers; expose them globally. */
Object.assign(window,
  { go: ui.go, scrollToEl: ui.scrollToEl },
  { addTask: tasks.addTask, toggleTask: tasks.toggleTask, editTask: tasks.editTask, delTask: tasks.delTask },
  { addGoal: goals.addGoal, editGoal: goals.editGoal, delGoal: goals.delGoal },
  { toggleHabit: habits.toggleHabit, addHabit: habits.addHabit, delHabit: habits.delHabit,
    setHabitView: habits.setHabitView, shiftWeek: habits.shiftWeek },
  { addLink: widgets.addLink, delLink: widgets.delLink, addFeed: widgets.addFeed, delFeed: widgets.delFeed,
    nextQuote: widgets.nextQuote, setMed: widgets.setMed, toggleMed: widgets.toggleMed,
    saveJournal: widgets.saveJournal },
  { saveSectionNotes: sections.saveSectionNotes, addSectionLink: sections.addSectionLink,
    delSectionLink: sections.delSectionLink },
  { addNgdr: gsi.addNgdr, editNgdr: gsi.editNgdr, setNgdrStatus: gsi.setNgdrStatus, delNgdr: gsi.delNgdr,
    addLog: gsi.addLog, delLog: gsi.delLog, addMeeting: gsi.addMeeting, editMeeting: gsi.editMeeting,
    editMeetingNotes: gsi.editMeetingNotes, delMeeting: gsi.delMeeting,
    addGsiLink: gsi.addGsiLink, delGsiLink: gsi.delGsiLink },
  { openSearch: search.openSearch, closeSearch: search.closeSearch,
    searchHover: search.searchHover, searchPick: search.searchPick },
  { openGhModal: cloud.openGhModal, closeGhModal: cloud.closeGhModal, ghButton: cloud.ghButton,
    signIn: cloud.signIn, signOut: cloud.signOut, syncNow: cloud.syncNow });

/* ---- boot ---- */
setRenderer(renderAll);
sections.buildSectionPages();
renderAll();
ui.setSyncPill("", "Local only");
search.initSearch();
initCommunicationBridge();
cloud.initSupabase();

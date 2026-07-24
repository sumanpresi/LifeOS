/* LifeOS v0.3 — entry point: wires modules together and boots the app. */
import { setRenderer } from './state.js';
import * as ui from './ui.js';
import * as tasks from './tasks.js';
import * as goals from './goals.js';
import * as habits from './habits.js';
import * as widgets from './widgets.js';
import * as sections from './sections.js';
import * as gsi from './gsi.js';
import * as finance from './finance.js';
import * as health from './health.js';
import * as travel from './travel.js';
import * as reference from './reference.js';
import * as trash from './trash.js';
import * as expandView from './expand-view.js';
import * as mapCoords from './map-click-coords.js';
import * as search from './search.js';
import * as cloud from './supabase.js';
import { initCommunicationBridge } from './communication-bridge.js';
import { initNgdrTrackerBridge } from './ngdr-tracker-bridge.js';

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
  finance.renderFinance();
  health.renderHealth();
  travel.renderTravel();
  reference.renderReference();
  trash.renderTrash();
}

/* The markup uses plain onclick="…" handlers; expose them globally. */
Object.assign(window,
  { go: ui.go, scrollToEl: ui.scrollToEl },
  { addTask: tasks.addTask, toggleTask: tasks.toggleTask, editTask: tasks.editTask, delTask: tasks.delTask,
    toggleFlag: tasks.toggleFlag, editTaskMeta: tasks.editTaskMeta, setTaskFilter: tasks.setTaskFilter,
    toggleSortByDate: tasks.toggleSortByDate },
  { addGoal: goals.addGoal, editGoal: goals.editGoal, delGoal: goals.delGoal },
  { toggleHabit: habits.toggleHabit, addHabit: habits.addHabit, delHabit: habits.delHabit,
    setHabitView: habits.setHabitView, shiftWeek: habits.shiftWeek,
    setCalendarHabit: habits.setCalendarHabit, shiftCalendarMonth: habits.shiftCalendarMonth },
  { addLink: widgets.addLink, delLink: widgets.delLink, addFeed: widgets.addFeed, delFeed: widgets.delFeed,
    nextQuote: widgets.nextQuote, setMed: widgets.setMed, toggleMed: widgets.toggleMed,
    saveJournal: widgets.saveJournal, selectJournalDate: widgets.selectJournalDate, journalGoToday: widgets.journalGoToday },
  { saveSectionNotes: sections.saveSectionNotes, addSectionLink: sections.addSectionLink,
    delSectionLink: sections.delSectionLink },
  { addNgdr: gsi.addNgdr, editProjectTask: gsi.editProjectTask, setTaskStatus: gsi.setTaskStatus, delProjectTask: gsi.delProjectTask,
    addProject: gsi.addProject, switchProject: gsi.switchProject, renameProject: gsi.renameProject, delProject: gsi.delProject,
    addLog: gsi.addLog, delLog: gsi.delLog, addMeeting: gsi.addMeeting, editMeeting: gsi.editMeeting,
    toggleMeetingOpen: gsi.toggleMeetingOpen, delMeeting: gsi.delMeeting,
    addGsiLink: gsi.addGsiLink, delGsiLink: gsi.delGsiLink,
    addPersonalDoc: gsi.addPersonalDoc, delPersonalDoc: gsi.delPersonalDoc,
    addWorkDoc: gsi.addWorkDoc, delWorkDoc: gsi.delWorkDoc,
    runGrammarCheck: gsi.runGrammarCheck, applyGrammarFix: gsi.applyGrammarFix },
  { saveFinanceNotes: finance.saveFinanceNotes, addFinanceLink: finance.addFinanceLink, delFinanceLink: finance.delFinanceLink,
    addFinanceItem: finance.addFinanceItem, delFinanceItem: finance.delFinanceItem, editFinanceItem: finance.editFinanceItem },
  { saveHealthNotes: health.saveHealthNotes, addHealthLink: health.addHealthLink, delHealthLink: health.delHealthLink,
    addMedicine: health.addMedicine, delMedicine: health.delMedicine, toggleDose: health.toggleDose,
    shiftMedWeek: health.shiftMedWeek, setMedLogFilter: health.setMedLogFilter,
    addPrescription: health.addPrescription, delPrescription: health.delPrescription },
  { addTravelPlan: travel.addTravelPlan, switchTravelPlan: travel.switchTravelPlan,
    renameTravelPlan: travel.renameTravelPlan, delTravelPlan: travel.delTravelPlan,
    addStop: travel.addStop, editStop: travel.editStop, toggleStopMap: travel.toggleStopMap, delStop: travel.delStop,
    locateStop: travel.locateStop, locateMeOnStopMap: travel.locateMeOnStopMap,
    saveTravelPacking: travel.saveTravelPacking, switchTravelView: travel.switchTravelView },
  { addRefPage: reference.addRefPage, switchRefPage: reference.switchRefPage, renameRefPage: reference.renameRefPage,
    delRefPage: reference.delRefPage, saveReferenceNotes: reference.saveReferenceNotes,
    addRefLink: reference.addRefLink, delRefLink: reference.delRefLink, searchWorldMap: reference.searchWorldMap,
    locateMeOnWorldMap: reference.locateMeOnWorldMap, useMyLocationForRouteFrom: reference.useMyLocationForRouteFrom,
    clearRouteFromLocation: reference.clearRouteFromLocation, calculateWorldMapRoute: reference.calculateWorldMapRoute,
    resetWorldMapRoute: reference.resetWorldMapRoute },
  { restoreFromTrash: trash.restoreFromTrash, permanentlyDeleteFromTrash: trash.permanentlyDeleteFromTrash },
  { expandView: expandView.expandView, closeExpandView: expandView.closeExpandView },
  { copyCoordsToClipboard: mapCoords.copyCoordsToClipboard },
  { openSearch: search.openSearch, closeSearch: search.closeSearch,
    searchHover: search.searchHover, searchPick: search.searchPick },
  { openGhModal: cloud.openGhModal, closeGhModal: cloud.closeGhModal, ghButton: cloud.ghButton,
    signIn: cloud.signIn, signOut: cloud.signOut, syncNow: cloud.syncNow },
  { exportBackup: ui.exportBackup, importBackup: ui.importBackup, autoGrow: ui.autoGrow });

/* ---- boot ---- */
setRenderer(renderAll);
sections.buildSectionPages();
trash.purgeOldTrash();
renderAll();
try {
  const lastPage = localStorage.getItem("lifeos-last-page");
  if (lastPage && document.getElementById("page-" + lastPage)) ui.go(lastPage);
} catch (e) { /* private browsing etc. — just stays on the default page */ }
ui.setSyncPill("", "Local only");
search.initSearch();
initCommunicationBridge();
initNgdrTrackerBridge();
cloud.initSupabase();

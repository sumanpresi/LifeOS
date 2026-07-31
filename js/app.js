/* LifeOS v0.3 — entry point: wires modules together and boots the app. */
import { setRenderer } from './state.js';
import * as ui from './ui.js';
import * as tasks from './tasks.js';
import * as goals from './goals.js';
import * as habits from './habits.js';
import * as widgets from './widgets.js';
import * as sections from './sections.js';
import * as gsi from './gsi.js';
import * as personal from './personal.js';
import * as widgetLayout from './widget-layout.js';
import * as finance from './finance.js';
import * as health from './health.js';
import * as travel from './travel.js';
import * as reference from './reference.js';
import * as trash from './trash.js';
import * as dateShortcuts from './date-shortcuts.js';
import * as expandView from './expand-view.js';
import * as mapCoords from './map-click-coords.js';
import * as calScribble from './calendar-scribble.js';
import * as whiteboard from './whiteboard.js';
import * as search from './search.js';
import * as cloud from './supabase.js';
import * as gcal from './google-calendar.js';
import { initCommunicationBridge } from './communication-bridge.js';
import { initNgdrTrackerBridge } from './ngdr-tracker-bridge.js';

/* One render pass repaints everything — the app is small enough
   that this keeps every module fully decoupled. */
function renderAll() {
  ui.renderHeader();
  gcal.renderGoogleCalendarStatus();
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
  personal.renderPersonalWorkspace();
  finance.renderFinance();
  health.renderHealth();
  travel.renderTravel();
  reference.renderReference();
  trash.renderTrash();
  whiteboard.initWhiteboard("overview");
  whiteboard.initWhiteboard("gsi");
  whiteboard.initWhiteboard("personal"); // plain single-board instance (no tab-switching) — see personal.js's file header for why
}

/* The markup uses plain onclick="…" handlers; expose them globally. */
Object.assign(window,
  { go: ui.go, scrollToEl: ui.scrollToEl },
  { addTask: tasks.addTask, toggleTask: tasks.toggleTask, editTask: tasks.editTask, delTask: tasks.delTask,
    toggleFlag: tasks.toggleFlag, editTaskMeta: tasks.editTaskMeta, setTaskFilter: tasks.setTaskFilter,
    toggleSortByDate: tasks.toggleSortByDate, toggleTaskSection: tasks.toggleTaskSection, toggleTaskExpanded: tasks.toggleTaskExpanded,
    setTaskView: tasks.setTaskView, calendarPrevMonth: tasks.calendarPrevMonth, calendarNextMonth: tasks.calendarNextMonth, calendarGoToday: tasks.calendarGoToday,
    openTaskPopup: tasks.openTaskPopup, closeTaskPopup: tasks.closeTaskPopup, popupToggleDone: tasks.popupToggleDone, popupToggleFlag: tasks.popupToggleFlag,
    popupEditDate: tasks.popupEditDate, openDueDatePicker: tasks.openDueDatePicker, openPopupDueDatePicker: tasks.openPopupDueDatePicker,
    toggleTaskLinkEdit: tasks.toggleTaskLinkEdit,
    quickAddBoardTask: tasks.quickAddBoardTask, calendarQuickAdd: tasks.calendarQuickAdd,
    archiveTask: tasks.archiveTask, archiveAllCompleted: tasks.archiveAllCompleted,
    restoreArchivedTaskEntry: tasks.restoreArchivedTaskEntry, deleteArchivedTaskPermanently: tasks.deleteArchivedTaskPermanently,
    setArchivedSort: tasks.setArchivedSort, openArchivedTasksModal: tasks.openArchivedTasksModal,
    closeArchivedTasksModal: tasks.closeArchivedTasksModal, changeTaskProject: tasks.changeTaskProject },
  { addGoal: goals.addGoal, editGoal: goals.editGoal, delGoal: goals.delGoal },
  { toggleHabit: habits.toggleHabit, addHabit: habits.addHabit, delHabit: habits.delHabit,
    setHabitView: habits.setHabitView, shiftWeek: habits.shiftWeek,
    setCalendarHabit: habits.setCalendarHabit, shiftCalendarMonth: habits.shiftCalendarMonth,
    toggleDayPopover: habits.toggleDayPopover, goToCalendarTask: habits.goToCalendarTask,
    toggleScribbleMode: habits.toggleScribbleMode },
  { addLink: widgets.addLink, delLink: widgets.delLink, editLink: widgets.editLink,
    toggleLinkEdit: widgets.toggleLinkEdit, linkClickPulse: widgets.linkClickPulse,
    addFeed: widgets.addFeed, delFeed: widgets.delFeed,
    nextQuote: widgets.nextQuote, setMed: widgets.setMed, toggleMed: widgets.toggleMed,
    saveJournal: widgets.saveJournal, selectJournalDate: widgets.selectJournalDate, journalGoToday: widgets.journalGoToday,
    exportJournalRange: widgets.exportJournalRange,
    applyJournalFilter: widgets.applyJournalFilter, clearJournalFilter: widgets.clearJournalFilter },
  { saveSectionNotes: sections.saveSectionNotes, addSectionLink: sections.addSectionLink,
    delSectionLink: sections.delSectionLink },
  { addNgdr: gsi.addNgdr, quickAddGsiTask: gsi.quickAddGsiTask, editProjectTask: gsi.editProjectTask, setTaskStatus: gsi.setTaskStatus, delProjectTask: gsi.delProjectTask,
    toggleProjectTaskFlag: gsi.toggleProjectTaskFlag, setGsiSortMode: gsi.setGsiSortMode,
    archiveCompletedTasks: gsi.archiveCompletedTasks, archiveGsiTaskEntry: gsi.archiveGsiTaskEntry, toggleGsiLinkEdit: gsi.toggleGsiLinkEdit,
    openGsiDatePicker: gsi.openGsiDatePicker,
    openArchiveView: gsi.openArchiveView, closeArchiveView: gsi.closeArchiveView,
    restoreArchivedTask: gsi.restoreArchivedTask, removeFromArchive: gsi.removeFromArchive,
    restoreLastDeletedProject: gsi.restoreLastDeletedProject,
    addProject: gsi.addProject, switchProject: gsi.switchProject, renameProject: gsi.renameProject, delProject: gsi.delProject,
    setGsiTaskView: gsi.setGsiTaskView,
    renameWorkDocsLabel: gsi.renameWorkDocsLabel,
    chooseWorkspace: gsi.chooseWorkspace,
    addLog: gsi.addLog, delLog: gsi.delLog, addMeeting: gsi.addMeeting, editMeeting: gsi.editMeeting,
    toggleMeetingOpen: gsi.toggleMeetingOpen, delMeeting: gsi.delMeeting,
    addGsiLink: gsi.addGsiLink, delGsiLink: gsi.delGsiLink, editGsiLink: gsi.editGsiLink,
    toggleDocEdit: gsi.toggleDocEdit, undoLastDeleted: gsi.undoLastDeleted,
    editPersonalDoc: gsi.editPersonalDoc, editWorkDoc: gsi.editWorkDoc,
    addPersonalDoc: gsi.addPersonalDoc, delPersonalDoc: gsi.delPersonalDoc,
    addWorkDoc: gsi.addWorkDoc, delWorkDoc: gsi.delWorkDoc,
    runGrammarCheck: gsi.runGrammarCheck, applyGrammarFix: gsi.applyGrammarFix },
  { addPwTask: personal.addPwTask, quickAddPwTask: personal.quickAddPwTask, editPwProjectTask: personal.editPwProjectTask,
    setPwTaskStatus: personal.setPwTaskStatus, delPwProjectTask: personal.delPwProjectTask,
    togglePwProjectTaskFlag: personal.togglePwProjectTaskFlag, setPwSortMode: personal.setPwSortMode,
    archivePwCompletedTasks: personal.archivePwCompletedTasks, archivePwTaskEntry: personal.archivePwTaskEntry,
    togglePwTaskLinkEdit: personal.togglePwTaskLinkEdit, openPwDatePicker: personal.openPwDatePicker,
    openPwArchiveView: personal.openPwArchiveView, closePwArchiveView: personal.closePwArchiveView,
    restorePwArchivedTask: personal.restorePwArchivedTask, removePwFromArchive: personal.removePwFromArchive,
    restorePwLastDeletedProject: personal.restorePwLastDeletedProject,
    addPwProject: personal.addPwProject, switchPwProject: personal.switchPwProject,
    renamePwProject: personal.renamePwProject, delPwProject: personal.delPwProject,
    setPwTaskView: personal.setPwTaskView,
    renamePwProjectDocsLabel: personal.renamePwProjectDocsLabel,
    choosePersonalWorkspace: personal.choosePersonalWorkspace,
    addPwLink: personal.addPwLink, delPwLink: personal.delPwLink, editPwLink: personal.editPwLink,
    togglePwDocEdit: personal.togglePwDocEdit, undoPwLastDeleted: personal.undoPwLastDeleted,
    editPwDoc: personal.editPwDoc, editPwProjectDoc: personal.editPwProjectDoc,
    addPwDoc: personal.addPwDoc, delPwDoc: personal.delPwDoc,
    addPwProjectDoc: personal.addPwProjectDoc, delPwProjectDoc: personal.delPwProjectDoc },
  { saveFinanceNotes: finance.saveFinanceNotes, addFinanceLink: finance.addFinanceLink, delFinanceLink: finance.delFinanceLink,
    addFinanceItem: finance.addFinanceItem, delFinanceItem: finance.delFinanceItem, editFinanceItem: finance.editFinanceItem,
    addEmiRow: finance.addEmiRow, editEmiRow: finance.editEmiRow, delEmiRow: finance.delEmiRow,
    openEmiDropdownManager: finance.openEmiDropdownManager, closeEmiDropdownManager: finance.closeEmiDropdownManager,
    addEmiDropdownOption: finance.addEmiDropdownOption, renameEmiDropdownOption: finance.renameEmiDropdownOption,
    deleteEmiDropdownOption: finance.deleteEmiDropdownOption, saveExternalSheetUrl: finance.saveExternalSheetUrl,
    setActiveExpenseMonth: finance.setActiveExpenseMonth, addExpenseMonthBefore: finance.addExpenseMonthBefore,
    addExpenseMonthAfter: finance.addExpenseMonthAfter, addExpenseRow: finance.addExpenseRow,
    editExpenseRow: finance.editExpenseRow, delExpenseRow: finance.delExpenseRow },
  { saveHealthNotes: health.saveHealthNotes, addHealthLink: health.addHealthLink, delHealthLink: health.delHealthLink,
    addMedicine: health.addMedicine, delMedicine: health.delMedicine, toggleDose: health.toggleDose,
    shiftMedWeek: health.shiftMedWeek, setMedLogFilter: health.setMedLogFilter,
    addPrescription: health.addPrescription, delPrescription: health.delPrescription },
  { addTravelPlan: travel.addTravelPlan, switchTravelPlan: travel.switchTravelPlan,
    renameTravelPlan: travel.renameTravelPlan, delTravelPlan: travel.delTravelPlan,
    addStop: travel.addStop, editStop: travel.editStop, toggleStopMap: travel.toggleStopMap, delStop: travel.delStop,
    locateStop: travel.locateStop, locateMeOnStopMap: travel.locateMeOnStopMap,
    addPackingItem: travel.addPackingItem, togglePackingItem: travel.togglePackingItem, delPackingItem: travel.delPackingItem,
    switchTravelView: travel.switchTravelView },
  { addRefPage: reference.addRefPage, switchRefPage: reference.switchRefPage, renameRefPage: reference.renameRefPage,
    delRefPage: reference.delRefPage, saveReferenceNotes: reference.saveReferenceNotes,
    addRefLink: reference.addRefLink, delRefLink: reference.delRefLink, searchWorldMap: reference.searchWorldMap,
    locateMeOnWorldMap: reference.locateMeOnWorldMap, useMyLocationForRouteFrom: reference.useMyLocationForRouteFrom,
    clearRouteFromLocation: reference.clearRouteFromLocation, calculateWorldMapRoute: reference.calculateWorldMapRoute,
    resetWorldMapRoute: reference.resetWorldMapRoute },
  { restoreFromTrash: trash.restoreFromTrash, permanentlyDeleteFromTrash: trash.permanentlyDeleteFromTrash },
  { resetPageLayout: widgetLayout.resetPageLayout },
  { toggleDatePopover: dateShortcuts.toggleDatePopover, setQuickDate: dateShortcuts.setQuickDate },
  { expandView: expandView.expandView, closeExpandView: expandView.closeExpandView },
  { copyCoordsToClipboard: mapCoords.copyCoordsToClipboard },
  { openScribbleFor: calScribble.openScribbleFor, closeScribbleModal: calScribble.closeScribbleModal,
    clearScribble: calScribble.clearScribble },
  { setWhiteboardColor: whiteboard.setWhiteboardColor, setWhiteboardWidth: whiteboard.setWhiteboardWidth,
    selectPenTool: whiteboard.selectPenTool, selectEraserTool: whiteboard.selectEraserTool,
    setEraserSize: whiteboard.setEraserSize, undoWhiteboardStroke: whiteboard.undoWhiteboardStroke,
    clearWhiteboardPage: whiteboard.clearWhiteboardPage, zoomWhiteboardIn: whiteboard.zoomWhiteboardIn,
    zoomWhiteboardOut: whiteboard.zoomWhiteboardOut, resetWhiteboardZoom: whiteboard.resetWhiteboardZoom,
    selectStickyTool: whiteboard.selectStickyTool, toggleWhiteboardFullscreen: whiteboard.toggleWhiteboardFullscreen,
    deleteConnector: whiteboard.deleteConnector, clearBoardConnectors: whiteboard.clearBoardConnectors,
    openStickyArchive: whiteboard.openStickyArchive, closeStickyArchive: whiteboard.closeStickyArchive,
    restoreStickyNote: whiteboard.restoreStickyNote, deleteStickyNotePermanently: whiteboard.deleteStickyNotePermanently,
    addBrainstormBoard: whiteboard.addBrainstormBoard, duplicateBrainstormBoard: whiteboard.duplicateBrainstormBoard,
    archiveBrainstormBoard: whiteboard.archiveBrainstormBoard, deleteBrainstormBoardFromTabBar: whiteboard.deleteBrainstormBoardFromTabBar,
    openBrainstormArchive: whiteboard.openBrainstormArchive, closeBrainstormArchive: whiteboard.closeBrainstormArchive,
    restoreBrainstormBoard: whiteboard.restoreBrainstormBoard, deleteBrainstormBoardPermanently: whiteboard.deleteBrainstormBoardPermanently },
  { openSearch: search.openSearch, closeSearch: search.closeSearch,
    searchHover: search.searchHover, searchPick: search.searchPick, setSearchIncludeArchived: search.setSearchIncludeArchived },
  { openGhModal: cloud.openGhModal, closeGhModal: cloud.closeGhModal, ghButton: cloud.ghButton,
    signIn: cloud.signIn, signOut: cloud.signOut, syncNow: cloud.syncNow },
  { connectGoogleCalendar: gcal.connectGoogleCalendar, disconnectGoogleCalendar: gcal.disconnectGoogleCalendar },
  { exportBackup: ui.exportBackup, importBackup: ui.importBackup, autoGrow: ui.autoGrow });

/* ---- boot ---- */
setRenderer(renderAll);
sections.buildSectionPages();
trash.purgeOldTrash();
renderAll();
try {
  const lastPage = localStorage.getItem("lifeos-last-page");
  if (lastPage && document.getElementById("page-" + lastPage)) ui.go(lastPage);
  else widgetLayout.initPageLayout("overview"); // go() wasn't called — this is the page still marked visible in the static markup
} catch (e) { widgetLayout.initPageLayout("overview"); }
ui.setSyncPill("", "Local only");
search.initSearch();
initCommunicationBridge();
initNgdrTrackerBridge();
cloud.initSupabase();
gcal.handleGoogleCalendarCallback();

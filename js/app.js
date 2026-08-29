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
import * as share from './share.js';
import * as theme from './theme.js';
import * as composer from './composer.js';
import { initDropToAttach, handleIncomingShare } from './attach.js';
import * as finance from './finance.js';
import * as health from './health.js';
import * as travel from './travel.js';
import * as reference from './reference.js';
import * as notebook from './notebook.js';
import * as trash from './trash.js';
import * as backup from './backup.js';
import * as entertainment from './entertainment.js';
import * as taskModal from './task-modal.js';
import { decorateLinkRows } from './link-preview.js';
import { flushLocalSave } from './state.js';
import * as healthCheck from './health-check.js';
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
  // Every repaint rewrites innerHTML across the app. Wrapping the whole
  // pass keeps the scroll position, the board's horizontal offset and the
  // caret exactly where the person left them, whatever triggered it.
  return ui.preserveScrollAndFocus(renderEverything);
}
function renderEverything() {
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
  notebook.renderNotebook();
  trash.renderTrash();
  entertainment.renderEntertainment();
  backup.renderBackupPanel();
  /* One call covers GSI links, Work documents and Reference links: they
     are all rebuilt by innerHTML on each render, which discards any
     decoration, so it has to be reapplied here rather than inside each
     module. decorateLinkRows skips rows it has already handled and reads
     from cache, so repeating it costs nothing. */
  decorateLinkRows();
  whiteboard.initWhiteboard("overview");
  whiteboard.initWhiteboard("gsi");
  whiteboard.initWhiteboard("dayof");
}

/* The markup uses plain onclick="…" handlers; expose them globally. */
Object.assign(window,
  { go: ui.go, scrollToEl: ui.scrollToEl, toggleSidebar: ui.toggleSidebar },
  { addTask: tasks.addTask, saveNewTaskDraft: tasks.saveNewTaskDraft, toggleTask: tasks.toggleTask, editTask: tasks.editTask, delTask: tasks.delTask,
    toggleFlag: tasks.toggleFlag, editTaskMeta: tasks.editTaskMeta, setTaskFilter: tasks.setTaskFilter,
    toggleSortByDate: tasks.toggleSortByDate, toggleTaskSection: tasks.toggleTaskSection, toggleTaskExpanded: tasks.toggleTaskExpanded,
    setTaskView: tasks.setTaskView, calendarPrevMonth: tasks.calendarPrevMonth, calendarNextMonth: tasks.calendarNextMonth, calendarGoToday: tasks.calendarGoToday, setCalendarScale: tasks.setCalendarScale, calendarZoomTo: tasks.calendarZoomTo, toggleCalendarDay: tasks.toggleCalendarDay, toggleBoardCol: tasks.toggleBoardCol,
    openTaskPopup: tasks.openTaskPopup, closeTaskPopup: tasks.closeTaskPopup, popupToggleDone: tasks.popupToggleDone, popupToggleFlag: tasks.popupToggleFlag,
    popupEditDate: tasks.popupEditDate, openDueDatePicker: tasks.openDueDatePicker, openPopupDueDatePicker: tasks.openPopupDueDatePicker,
    toggleTaskLinkEdit: tasks.toggleTaskLinkEdit,
    quickAddBoardTask: tasks.quickAddBoardTask, calendarQuickAdd: tasks.calendarQuickAdd,
    openDayView: tasks.openDayView, closeDayView: tasks.closeDayView, dayViewToggleTask: tasks.dayViewToggleTask,
    dayViewOpenTask: tasks.dayViewOpenTask, dayViewAddTask: tasks.dayViewAddTask,
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
    selectJournalDate: widgets.selectJournalDate, journalGoToday: widgets.journalGoToday,
    applyJournalFilter: widgets.applyJournalFilter, clearJournalFilter: widgets.clearJournalFilter,
    exportJournalRange: widgets.exportJournalRange, toggleJournalCalendar: widgets.toggleJournalCalendar,
    applyJournalSearch: widgets.applyJournalSearch, clearJournalSearch: widgets.clearJournalSearch,
    toggleJournalSort: widgets.toggleJournalSort,
    shiftJournalCalMonth: widgets.shiftJournalCalMonth, journalCalPick: widgets.journalCalPick },
  { addSectionLink: sections.addSectionLink, delSectionLink: sections.delSectionLink,
    toggleNoteFullscreen: sections.toggleNoteFullscreen, addSectionNote: sections.addSectionNote, delSectionNote: sections.delSectionNote,
    selectSectionNote: sections.selectSectionNote, editSectionNoteTitle: sections.editSectionNoteTitle },
  { addNgdr: gsi.addNgdr, quickAddGsiTask: gsi.quickAddGsiTask, editProjectTask: gsi.editProjectTask, setTaskStatus: gsi.setTaskStatus, delProjectTask: gsi.delProjectTask,
    toggleGsiAddOptions: gsi.toggleGsiAddOptions, clearGsiAddTarget: gsi.clearGsiAddTarget,
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
    addWorkDoc: gsi.addWorkDoc, addWorkDocGroup: gsi.addWorkDocGroup, switchWorkDocGroup: gsi.switchWorkDocGroup,
    renameWorkDocGroup: gsi.renameWorkDocGroup, archiveWorkDocGroup: gsi.archiveWorkDocGroup, delWorkDocGroup: gsi.delWorkDocGroup,
    restoreWorkDocGroup: gsi.restoreWorkDocGroup, archiveWorkDoc: gsi.archiveWorkDoc, restoreWorkDoc: gsi.restoreWorkDoc,
    toggleWorkDocArchive: gsi.toggleWorkDocArchive, delWorkDoc: gsi.delWorkDoc,
    runGrammarCheck: gsi.runGrammarCheck, applyGrammarFix: gsi.applyGrammarFix },
  { addPwTask: personal.addPwTask, quickAddPwTask: personal.quickAddPwTask,
    editPwProjectTask: personal.editPwProjectTask, setPwTaskStatus: personal.setPwTaskStatus,
    delPwProjectTask: personal.delPwProjectTask, togglePwProjectTaskFlag: personal.togglePwProjectTaskFlag,
    setPwSortMode: personal.setPwSortMode, setPwTaskView: personal.setPwTaskView,
    openPwDatePicker: personal.openPwDatePicker, togglePwTaskLinkEdit: personal.togglePwTaskLinkEdit,
    addPwProject: personal.addPwProject, switchPwProject: personal.switchPwProject,
    renamePwProject: personal.renamePwProject, delPwProject: personal.delPwProject,
    choosePersonalWorkspace: personal.choosePersonalWorkspace,
    renamePwProjectDocsLabel: personal.renamePwProjectDocsLabel,
    archivePwCompletedTasks: personal.archivePwCompletedTasks, archivePwTaskEntry: personal.archivePwTaskEntry,
    openPwArchiveView: personal.openPwArchiveView, closePwArchiveView: personal.closePwArchiveView,
    restorePwArchivedTask: personal.restorePwArchivedTask, removePwFromArchive: personal.removePwFromArchive,
    restorePwLastDeletedProject: personal.restorePwLastDeletedProject,
    togglePwDocEdit: personal.togglePwDocEdit, undoPwLastDeleted: personal.undoPwLastDeleted,
    editPwLink: personal.editPwLink, addPwLink: personal.addPwLink, delPwLink: personal.delPwLink,
    editPwDoc: personal.editPwDoc, addPwDoc: personal.addPwDoc, delPwDoc: personal.delPwDoc,
    editPwProjectDoc: personal.editPwProjectDoc, addPwProjectDoc: personal.addPwProjectDoc,
    delPwProjectDoc: personal.delPwProjectDoc },
  { openComposer: composer.openComposer, closeComposer: composer.closeComposer,
    composerSubmit: composer.composerSubmit, composerKey: composer.composerKey,
    composerToggleFlag: composer.composerToggleFlag,
    composerSetQuickDate: composer.composerSetQuickDate,
    composerDateChanged: composer.composerDateChanged, composerSyncText: composer.composerSyncText },
  { toggleTheme: theme.toggleTheme, setTheme: theme.setTheme },
  { copyShareLink: share.copyShareLink, shareLinkViaSheet: share.shareLinkViaSheet,
    closeShareBoardDialog: share.closeShareBoardDialog },
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
    addPackList: travel.addPackList, switchPackList: travel.switchPackList,
    renamePackList: travel.renamePackList, delPackList: travel.delPackList,
    switchTravelView: travel.switchTravelView },
  { addRefPage: reference.addRefPage, switchRefPage: reference.switchRefPage, renameRefPage: reference.renameRefPage,
    delRefPage: reference.delRefPage, saveReferenceNotes: reference.saveReferenceNotes,
    addRefLink: reference.addRefLink, delRefLink: reference.delRefLink, searchWorldMap: reference.searchWorldMap,
    locateMeOnWorldMap: reference.locateMeOnWorldMap, useMyLocationForRouteFrom: reference.useMyLocationForRouteFrom,
    clearRouteFromLocation: reference.clearRouteFromLocation, calculateWorldMapRoute: reference.calculateWorldMapRoute,
    resetWorldMapRoute: reference.resetWorldMapRoute,
    uploadKmlFiles: reference.uploadKmlFiles, selectKmlLayer: reference.selectKmlLayer,
    deleteKmlLayer: reference.deleteKmlLayer, flyToKmlFeature: reference.flyToKmlFeature },
  { addNotebookSection: notebook.addNotebookSection, switchNotebookSection: notebook.switchNotebookSection,
    renameNotebookSection: notebook.renameNotebookSection, delNotebookSection: notebook.delNotebookSection,
    addNotebookPage: notebook.addNotebookPage, switchNotebookPage: notebook.switchNotebookPage,
    renameNotebookPage: notebook.renameNotebookPage, delNotebookPage: notebook.delNotebookPage,
    startNotebookRename: notebook.startNotebookRename, commitNotebookRename: notebook.commitNotebookRename,
    renameOnDoubleClick: notebook.renameOnDoubleClick,
    toggleNotebookSectionOpen: notebook.toggleNotebookSectionOpen,
    notebookSectionClick: notebook.notebookSectionClick,
    notebookPageClick: notebook.notebookPageClick,
    addNotebookPageTo: notebook.addNotebookPageTo,
    toggleNotebookTree: notebook.toggleNotebookTree },
  { toggleTrashList: trash.toggleTrashList, restoreFromTrash: trash.restoreFromTrash, permanentlyDeleteFromTrash: trash.permanentlyDeleteFromTrash },
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
  { connectGoogleCalendar: gcal.connectGoogleCalendar, disconnectGoogleCalendar: gcal.disconnectGoogleCalendar, syncAllPendingToGoogle: gcal.syncAllPendingToGoogle },
  { reclaimSpace: backup.reclaimSpace, exportBackup: backup.downloadBackup, importBackup: backup.importBackupFile, autoGrow: ui.autoGrow },
  { downloadBackup: backup.downloadBackup, importBackupFile: backup.importBackupFile,
    restoreSnapshot: backup.restoreSnapshot, deleteSnapshot: backup.deleteSnapshot,
    takeSnapshotNow: () => { backup.takeSnapshot("manual"); backup.renderBackupPanel(); },
    runDataHealthCheck: healthCheck.runDataHealthCheck, repairDataProblems: healthCheck.repairDataProblems },
  { addEntertainment: entertainment.addEntertainment, delEntertainment: entertainment.delEntertainment,
    rateEntertainment: entertainment.rateEntertainment, toggleEntertainmentFocus: entertainment.toggleEntertainmentFocus,
    setEntertainmentProgress: entertainment.setEntertainmentProgress,
    previewEntertainmentProgress: entertainment.previewEntertainmentProgress,
    setEntertainmentStatus: entertainment.setEntertainmentStatus,
    filterEntertainment: entertainment.filterEntertainment, searchEntertainment: entertainment.searchEntertainment,
    filterEntertainmentStatus: entertainment.filterEntertainmentStatus,
    toggleEntertainmentTag: entertainment.toggleEntertainmentTag,
    sortEntertainment: entertainment.sortEntertainment, setEntertainmentView: entertainment.setEntertainmentView,
    showMoreEntertainment: entertainment.showMoreEntertainment,
    clearEntertainmentFilters: entertainment.clearEntertainmentFilters,
    openTaskCardDetail: tasks.openTaskCardDetail,
    openTaskModal: taskModal.openTaskModal, closeTaskModal: taskModal.closeTaskModal,
    taskModalStep: taskModal.taskModalStep, renderTaskModalSide: taskModal.renderTaskModalSide, editTaskProperty: taskModal.editTaskProperty,
    taskModalEditTitle: taskModal.taskModalEditTitle, taskModalEditField: taskModal.taskModalEditField,
    taskModalToggleDone: taskModal.taskModalToggleDone, taskModalSetDate: taskModal.taskModalSetDate,
    taskModalSetProject: taskModal.taskModalSetProject, taskModalSetPriority: taskModal.taskModalSetPriority,
    taskModalSetStatus: taskModal.taskModalSetStatus, taskModalSetLabels: taskModal.taskModalSetLabels,
    taskModalDelete: taskModal.taskModalDelete, taskModalAddSubtask: taskModal.taskModalAddSubtask,
    taskModalToggleSubtask: taskModal.taskModalToggleSubtask, taskModalEditSubtask: taskModal.taskModalEditSubtask,
    taskModalDelSubtask: taskModal.taskModalDelSubtask,
    openEntertainmentEdit: entertainment.openEntertainmentEdit,
    closeEntertainmentEdit: entertainment.closeEntertainmentEdit,
    saveEntertainmentEdit: entertainment.saveEntertainmentEdit,
    deleteFromEntertainmentEdit: entertainment.deleteFromEntertainmentEdit,
    undoEntertainmentDelete: entertainment.undoEntertainmentDelete,
    archiveEntertainment: entertainment.archiveEntertainment,
    unarchiveEntertainment: entertainment.unarchiveEntertainment,
    toggleEntertainmentArchivePanel: entertainment.toggleEntertainmentArchivePanel });

/* ---- boot ---- */
setRenderer(renderAll);
sections.buildSectionPages();
trash.purgeOldTrash();
// Before renderAll, so the very first snapshot captures the data exactly
// as it was loaded rather than after any render-time normalisation.
backup.autoSnapshotIfDue();
renderAll();
try {
  const lastPage = localStorage.getItem("lifeos-last-page");
  ui.syncSidebarToggle(); // the class is already applied pre-paint; this labels the button to match
  ui.initStickyHeader();
  /* Diagnostic only, and only on request: ?debug=shake. Dynamically
     imported so the file is never fetched on a normal load. */
  if (/[?&]debug=shake\b/.test(location.search)) {
    import("./shake-probe.js")
      .then(m => m.startShakeProbe())
      .catch(e => console.warn("[shake] probe failed to load", e));
  }
  if (lastPage && document.getElementById("page-" + lastPage)) ui.go(lastPage);
} catch (e) { /* private browsing etc. — just stays on the default page */ }
ui.setSyncPill("", "Local only");
search.initSearch();
initCommunicationBridge();
initNgdrTrackerBridge();
cloud.initSupabase();
backup.backupReminderIfDue();
// A page loaded with ?task=… reopens that task's detail view.
/* The pre-paint script in index.html already set data-theme. This
   re-applies it (so the toggle button's icon/label match), and attaches
   the OS-preference listener that only a module can hold. */
/* Safety net for the drag flag: if a lift is abandoned in a way Sortable
   does not report — the app backgrounded mid-drag, a cancelled pointer —
   the board would keep its blur disabled until the next reload. */
["pointerup", "pointercancel", "touchend", "touchcancel", "blur"].forEach(evt =>
  window.addEventListener(evt, () => document.body.classList.remove("is-dragging")));

initDropToAttach();
handleIncomingShare();
theme.initTheme();
taskModal.syncModalFromUrl();
// A page loaded with ?board=… opens that board, once the account it
// belongs to has finished loading. Wired with callbacks rather than
// imports so share.js stays unaware of routing and whiteboard internals.
share.initBoardDeepLink({ go: ui.go, switchBoard: whiteboard.switchBrainstormBoard });

/* The disk write is now coalesced (see persist() in state.js), so it has
   to be forced out before the tab can disappear. supabase.js registers a
   flush too, but only once signed in — this pair runs regardless, so a
   signed-out session can't lose the last few hundred milliseconds of
   work. pagehide is the reliable one on iOS, where visibilitychange
   often doesn't fire before an actual close. */
/* The journal editor's own debounce has to be forced out FIRST, or the
   flush below writes a copy of state that doesn't yet contain the last
   sentence typed into it. */
function flushEverything() {
  try { widgets.flushJournalEditor(); } catch (e) { console.warn("[journal] flush failed", e); }
  try { notebook.flushNotebookEditor(); } catch (e) { console.warn("[notebook] flush failed", e); }
  flushLocalSave();
}
document.addEventListener("visibilitychange", () => { if (document.hidden) flushEverything(); });
window.addEventListener("pagehide", flushEverything);
// A phone rotating, the keyboard closing, switching to another app — all
// blur the window without necessarily hiding the document.
window.addEventListener("blur", flushEverything);
gcal.handleGoogleCalendarCallback();

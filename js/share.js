/* ============================================================
   Private board links
   ============================================================
   A board link is a pointer, not a copy.

   The first version of this file encoded the whole board into the URL so
   anyone could open it without an account. That is the right shape for
   publishing something outward, and the wrong shape for this: these
   boards hold internal GSI reconciliation notes — names, counts, who is
   holding what. A link that works for anyone who receives it is a link
   that works for anyone who receives it by accident.

   So the link now carries one thing: the board's id. Everything that
   makes it private falls out of that.

   - The board content never leaves the account. Nothing is encoded into
     the URL, so forwarding the link forwards nothing.
   - Access is decided by Supabase RLS, not by this file. A board only
     resolves against `state`, which is only ever populated from the
     signed-in user's own row. There is no code path here that could read
     another account's data even if it tried.
   - Opened signed out, it lands on the normal app, which asks for a login
     first. Opened under a different account, no board with that id
     exists and it says so.
   - It opens the real, editable board rather than a snapshot. Edits sync
     the usual way, because it IS the usual board.

   The id is not a secret and is not treated as one: it is meaningless
   without the account it belongs to, the way a page number is meaningless
   without the book.

   WHY A QUERY PARAM AND NOT A FRAGMENT: the app already deep-links task
   detail views with `?task=…`. Following that convention rather than
   inventing a second one keeps a single mental model, and lets both use
   the same history handling.
   ============================================================ */

import { state, onStateReplaced } from './state.js?v=202609032200';
import { toast } from './ui.js?v=202609032200';

/* surface -> the page that surface's boards live on */
/* Surface -> the page that surface's boards are rendered on. "dayof" is a
   historical id: those boards live on the Personal page now, and a board
   link must open the page that actually shows them. */
const SURFACE_PAGE = { gsi: "work", dayof: "personal", overview: "communication" };

let dlgState = null;

/* ---------- building the link ---------- */

export function boardLinkFor(boardId, surface) {
  const url = new URL(location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set("board", boardId);
  if (surface && surface !== "gsi") url.searchParams.set("s", surface);
  return url.toString();
}

/* ---------- dialog ---------- */

export function copyShareLink() {
  const input = document.getElementById("shareBoardUrl");
  if (!input) return;
  input.select();
  input.setSelectionRange(0, input.value.length); // iOS ignores select() alone
  const done = () => toast("Board link copied");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(input.value).then(done, () => {
      // The Clipboard API refuses on insecure origins and inside several
      // in-app browsers; the legacy path still works there.
      try { document.execCommand("copy"); done(); }
      catch (_) { toast("Press and hold the link to copy it"); }
    });
  } else {
    try { document.execCommand("copy"); done(); }
    catch (_) { toast("Press and hold the link to copy it"); }
  }
}

export async function shareLinkViaSheet() {
  if (!dlgState?.url) return;
  if (!navigator.share) { copyShareLink(); return; }
  try { await navigator.share({ title: dlgState.name, url: dlgState.url }); }
  catch (_) { /* dismissed — not an error */ }
}

export function closeShareBoardDialog() {
  document.getElementById("shareBoardModalBg")?.classList.remove("open");
  dlgState = null;
}

export function openShareBoardDialog(boardId, name, surface) {
  const url = boardLinkFor(boardId, surface);
  dlgState = { boardId, name, surface, url };

  const bg = document.getElementById("shareBoardModalBg");
  if (!bg) return;
  document.getElementById("shareBoardTitle").textContent = name;
  document.getElementById("shareBoardUrl").value = url;
  document.getElementById("shareNativeBtn").style.display = navigator.share ? "" : "none";
  bg.classList.add("open");
}

/* ---------- opening a link ---------- */

/* Resolution is deliberately allowed to fail quietly on the first pass.
   At boot the app renders from whatever localStorage holds, and Supabase
   answers a moment later; a board made on another device simply is not
   there yet. Rather than guessing at a delay, this re-runs each time the
   state is replaced, and only gives up once sync has had a fair chance —
   at which point a still-missing board really is missing, and saying so
   is the correct answer rather than a bug. */
let pending = null;
let resolved = false;
let gaveUp = false;

function tryResolve(deps) {
  if (resolved || gaveUp || !pending) return;
  const { boardId, surface } = pending;
  const list = surface === "dayof" ? state.dayofBoards : state.brainstormBoards;
  const found = Array.isArray(list) && list.find(b => b.id === boardId);
  if (!found) return;

  resolved = true;
  if (found.archived) {
    // Landing on a blank page because the board was archived is a
    // confusing dead end; say what happened instead.
    toast(`"${found.name}" is archived — restore it from the Archived list to open it`);
  }
  deps.go(SURFACE_PAGE[surface] || "work");
  deps.switchBoard(boardId, surface);

  /* Drop the parameter once used, so a later refresh doesn't yank the
     person back to this board from wherever they have since navigated. */
  const url = new URL(location.href);
  url.searchParams.delete("board");
  url.searchParams.delete("s");
  history.replaceState(null, "", url.toString());
}

export function initBoardDeepLink(deps) {
  const params = new URL(location.href).searchParams;
  const boardId = params.get("board");
  if (!boardId) return;
  pending = { boardId, surface: params.get("s") === "dayof" ? "dayof" : "gsi" };

  tryResolve(deps);
  onStateReplaced(() => tryResolve(deps));

  /* If it hasn't turned up once the cloud has had a fair chance, it is
     not in this account. That is the honest outcome for a link opened
     under the wrong login, and the wording says so without implying the
     link itself was malformed. */
  setTimeout(() => {
    if (resolved || gaveUp) return;
    gaveUp = true;
    toast("That board isn't in this account — check you're signed in to the right one");
  }, 12000);
}

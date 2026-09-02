/* Bridge between the isolated Communication iframe (pages/communication.html
   — the Class 8 English course) and LifeOS's shared state. The iframe keeps
   its own DOM/CSS/JS (avoids id and class clashes — both apps use names like
   .card, .btn, #toast), but its DATA round-trips through state.js ->
   persist() -> Supabase, exactly like every other module. */
import { state, persist } from './state.js?v=202609041000';

let iframeEl = null;

function sendInit() {
  if (!iframeEl || !iframeEl.contentWindow) return;
  iframeEl.contentWindow.postMessage({ type: "lifeos:comm:init", data: state.communication }, "*");
}

export function initCommunicationBridge() {
  iframeEl = document.querySelector("#page-communication iframe");
  if (!iframeEl) return;

  window.addEventListener("message", e => {
    // Only accept messages from our own Communication iframe.
    if (!iframeEl || e.source !== iframeEl.contentWindow) return;
    const msg = e.data || {};
    if (msg.type === "lifeos:comm:ready") {
      sendInit();
    } else if (msg.type === "lifeos:comm:save") {
      /* Merge rather than assign. The iframe sends the whole object, and a
         straight assignment is last-writer-wins across devices: finish a
         lesson on the Fold, another on the iPad before the first syncs, and
         one evening's work disappears. Progress here is append-shaped —
         steps get done, mistakes get added — so the two copies can be
         combined instead of one replacing the other. */
      state.communication = mergeCommunication(state.communication, msg.data);
      persist();               // localStorage + scheduled Supabase push
    }
  });
}

/* ---------- merge ----------
   Every field is monotonic in practice: a finished step doesn't unfinish, a
   score doesn't drop, the notebook only grows. So "the better of the two"
   is the right rule almost everywhere, and it has the property that
   matters — merging twice changes nothing, so a value can't creep upward
   each time the devices talk. Counters are therefore MAXED, never summed. */
export function mergeCommunication(a, b) {
  a = a || {}; b = b || {};
  return {
    progress: mergeProgress(a.progress, b.progress),
    errors:   mergeErrors(a.errors, b.errors),
    schedule: mergeSchedule(a.schedule, b.schedule),
    mistakes: mergeMistakes(a.mistakes, b.mistakes),
    ...(a.legacy || b.legacy ? { legacy: a.legacy || b.legacy } : {})
  };
}

/* Truthy wins, higher wins, longer wins — in that order. Covers a step
   flag, a test score and a written answer without needing to know which
   is which. */
function better(x, y) {
  if (x == null) return y;
  if (y == null) return x;
  if (typeof x === "boolean" || typeof y === "boolean") return x || y;
  if (typeof x === "number" && typeof y === "number") return Math.max(x, y);
  if (typeof x === "string" && typeof y === "string") return y.length > x.length ? y : x;
  if (typeof x === "object" && typeof y === "object") return mergeShallow(x, y);
  return y;
}
function mergeShallow(x, y) {
  const out = { ...x };
  Object.keys(y || {}).forEach(k => { out[k] = better(x ? x[k] : undefined, y[k]); });
  return out;
}

function mergeProgress(x, y) {
  const out = {};
  new Set([...Object.keys(x || {}), ...Object.keys(y || {})]).forEach(id => {
    const l = (x || {})[id], r = (y || {})[id];
    if (!l) { out[id] = r; return; }
    if (!r) { out[id] = l; return; }
    out[id] = {
      steps:    mergeShallow(l.steps, r.steps),
      practice: mergeShallow(l.practice, r.practice),
      /* `test` is null until a test is actually taken, and the page treats
         that null as "not attempted". Merging two nulls into {} would
         quietly promote every untouched lesson to attempted, so the
         absence is preserved rather than filled in. */
      test:     (l.test || r.test) ? mergeShallow(l.test, r.test) : null,
      writes:   mergeShallow(l.writes, r.writes),
      speak:    mergeShallow(l.speak, r.speak),
    };
  });
  return out;
}

/* {wrong, total} per category. Summing would double-count every time the
   same state came back round, inflating the error rate on every sync. */
function mergeErrors(x, y) {
  const out = {};
  new Set([...Object.keys(x || {}), ...Object.keys(y || {})]).forEach(cat => {
    const l = (x || {})[cat] || {}, r = (y || {})[cat] || {};
    out[cat] = { wrong: Math.max(l.wrong || 0, r.wrong || 0),
                 total: Math.max(l.total || 0, r.total || 0) };
  });
  return out;
}

/* Revision dates per lesson, keyed by due date so the same slot from two
   devices is one slot, done if either device did it. */
function mergeSchedule(x, y) {
  const out = {};
  new Set([...Object.keys(x || {}), ...Object.keys(y || {})]).forEach(id => {
    const seen = new Map();
    [...((x || {})[id] || []), ...((y || {})[id] || [])].forEach(item => {
      if (!item) return;
      const key = String(item.due) + "|" + String(item.label);
      const prev = seen.get(key);
      seen.set(key, prev ? { ...prev, done: prev.done || item.done } : item);
    });
    out[id] = [...seen.values()].sort((p, q) => (p.due || 0) - (q.due || 0));
  });
  return out;
}

/* The notebook only ever grows, so it is a union. Identity is the moment it
   was recorded plus the question — two devices can't produce the same
   millisecond for different mistakes, and the same entry arriving twice
   collapses to one. */
function mergeMistakes(x, y) {
  const seen = new Map();
  [...(Array.isArray(x) ? x : []), ...(Array.isArray(y) ? y : [])].forEach(m => {
    if (!m) return;
    seen.set(String(m.at) + "|" + String(m.q), m);
  });
  return [...seen.values()].sort((p, q) => (p.at || 0) - (q.at || 0));
}

/* Called by supabase.js after a remote pull / realtime update lands, so an
   already-open Communication tab picks up the freshest data immediately
   instead of waiting for a manual reload. */
export function pushCommunicationUpdate() {
  sendInit();
}

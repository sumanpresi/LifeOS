/* Per-section cloud transport — pure helpers, no DOM, no Supabase.

   The LifeOS document used to travel to and from Supabase as one value:
   every save uploaded all of it and every pull downloaded all of it
   (~650 KB compressed), even when one checkbox had changed. This module
   cuts the document into SECTIONS along its top-level keys so only the
   sections that actually differ need to move.

     doc  ──split──▶  core  (every top-level value that is not an object:
                             updatedAt, rev, syncToken, preferences …)
                      parts (one JSON string per object/array value:
                             tasks, journal, notebook, whiteboards …)

   Each part is fingerprinted (SHA-256 of its JSON, 16 hex chars). The
   cloud keeps one row per part plus a small HEAD in `lifeos_data`:

     { _transport: "lifeos-gzip-v1", z: "",   ← makes every older build fail
       _layout: "lifeos-sections-v1",           SAFE: it can't decode this
       m: { tasks: "a1b2…", journal: "…" },     and so never saves over it
       core: { updatedAt, rev, syncToken, … },
       compressionReady: true, updatedAt: 0, rev: 0 }

   Older builds: decodeCloudRow() in those builds throws "compressed cloud
   data is incomplete" on an empty `z`, which leaves their save gate shut.
   They show "Sync failed" until reloaded onto this build — they cannot
   overwrite the head with a stale copy from a fresh page load.

   Nothing here decides WHAT to merge. Reassembly produces exactly the
   same plain document the old whole-row read produced, so every merge
   function downstream runs unchanged. */

export const LAYOUT = "lifeos-sections-v1";
const LEGACY_TRANSPORT = "lifeos-gzip-v1";
/* Below this a section is sent as plain JSON — gzip+base64 would make
   small sections bigger, not smaller. */
const GZIP_MIN_CHARS = 1024;

export function isSectionHead(data) {
  return !!(data && typeof data === "object" && data._layout === LAYOUT &&
            data.m && typeof data.m === "object" && data.core && typeof data.core === "object");
}

export function sectionsSupported() {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof crypto.subtle.digest === "function" &&
         typeof TextEncoder !== "undefined";
}

const isPart = v => v !== null && typeof v === "object";

/* Splits a document into core + JSON strings. Values that JSON drops
   (undefined, functions) are dropped here too, exactly as JSON.stringify
   of the whole document would have dropped them. */
export function splitDoc(doc) {
  const core = {};
  const parts = new Map();
  for (const key of Object.keys(doc || {})) {
    const v = doc[key];
    if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
    if (isPart(v)) parts.set(key, JSON.stringify(v));
    else core[key] = v;
  }
  return { core, parts };
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
export async function hashText(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const b = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < 8; i++) out += HEX[b[i]];
  return out;
}

/* { core, parts: Map(key → json), hashes: { key → hash } } */
export async function fingerprintDoc(doc) {
  const { core, parts } = splitDoc(doc);
  const hashes = {};
  for (const [k, json] of parts) hashes[k] = await hashText(json);
  return { core, parts, hashes };
}

/* ---------- section bodies ---------- */
function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function gzip(text) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (_) { return null; }
}
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

export async function encodeSection(json) {
  if (json.length >= GZIP_MIN_CHARS) {
    const gz = await gzip(json);
    if (gz) {
      const b64 = bytesToB64(gz);
      if (b64.length < json.length) return { enc: "gz", body: b64 };
    }
  }
  return { enc: "json", body: json };
}

export async function decodeSection(row) {
  if (!row || typeof row.body !== "string") throw new Error("cloud section is incomplete");
  if (row.enc === "gz") {
    if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot read compressed cloud data");
    return gunzip(b64ToBytes(row.body));
  }
  if (row.enc && row.enc !== "json") throw new Error("unknown cloud section encoding: " + row.enc);
  return row.body;
}

/* ---------- head ---------- */
export function buildHead(core, hashes) {
  return {
    _transport: LEGACY_TRANSPORT, z: "",
    _layout: LAYOUT,
    m: hashes,
    core,
    compressionReady: true, updatedAt: 0, rev: 0,
  };
}

/* Rebuilds the plain document from a head, the sections the server sent,
   and the JSON this device already holds for every section it did not
   send (because the fingerprints matched). Throws rather than returning a
   partial document: the merges read an absent key as "the other side
   deleted all of it", so a gap here must never reach them. */
export async function assembleDoc(head, rows, localParts, localHashes) {
  if (!isSectionHead(head)) throw new Error("not a sectioned cloud head");
  const fetched = new Map();
  for (const r of rows || []) fetched.set(r.key, r);
  const doc = Object.assign({}, head.core);
  for (const [key, want] of Object.entries(head.m)) {
    let json;
    const row = fetched.get(key);
    if (row) {
      if (row.hash !== want) throw new Error("cloud section '" + key + "' changed mid-read");
      json = await decodeSection(row);
    } else if (localHashes && localHashes[key] === want && localParts && localParts.has(key)) {
      json = localParts.get(key);
    } else {
      throw new Error("cloud section '" + key + "' was not sent");
    }
    doc[key] = JSON.parse(json);
  }
  return doc;
}

/* ---------- what changed since the cloud version this device agreed with ----------
   `known` is that version's manifest, or null when unknown (first push,
   legacy row, a state this device can't vouch for) — then everything goes. */
export async function planPush(doc, known) {
  const { core, parts, hashes } = await fingerprintDoc(doc);
  const sections = {};
  let wire = 0;
  for (const [k, json] of parts) {
    if (known && known[k] === hashes[k]) continue;
    const enc = await encodeSection(json);
    sections[k] = { hash: hashes[k], enc: enc.enc, body: enc.body };
    wire += enc.body.length + k.length + 40;
  }
  const head = buildHead(core, hashes);
  wire += JSON.stringify(head).length;
  return { head, sections, hashes, changed: Object.keys(sections), wire };
}

/* ---------- timestamps ----------
   Supabase hands timestamps back as "2026-11-22T04:05:06.123+00:00"
   (REST) or "2026-11-22 04:05:06.123+00" (realtime), while this app
   writes "2026-11-22T04:05:06.123Z". Same instant, three spellings —
   compared as strings they never match. Everything that compares a stamp
   goes through this, which reduces any spelling to epoch milliseconds. */
export function normStamp(s) {
  if (s === null || s === undefined || s === "") return "";
  if (typeof s === "number") return Number.isFinite(s) ? String(Math.trunc(s)) : "";
  const str = String(s).trim();
  if (/^\d{10,}$/.test(str)) return str;                       // already normalised
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i);
  if (!m) { const t = Date.parse(str); return Number.isNaN(t) ? str : String(t); }
  const ms = m[7] ? Number((m[7] + "00").slice(0, 3)) : 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
  const z = m[8];
  if (z && z.toUpperCase() !== "Z") {
    const sign = z[0] === "-" ? -1 : 1;
    const rest = z.slice(1).replace(":", "");
    const hh = +rest.slice(0, 2), mm = +(rest.slice(2) || 0);
    t -= sign * (hh * 60 + mm) * 60000;
  }
  return String(t);
}
export function stampToIso(norm) {
  const n = Number(norm);
  return norm && Number.isFinite(n) ? new Date(n).toISOString() : null;
}

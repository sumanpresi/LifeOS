/* One LifeOS "device": the real index.html and the real js/app.js module
   graph, booted in a worker thread with its own DOM and its own
   localStorage, talking to the shared test Postgres through the fake
   supabase-js client. Several of these run side by side to reproduce
   cross-device sync exactly as the app performs it. */
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { createFakeClient } from "./fake-supabase.mjs";

const { root, dbUrl, uid, name, seedLocal, version } = workerData;
const egress = [];          // [kind, bytes] downloaded by this device
const uploads = [];         // [kind, bytes] uploaded by this device
const diag = [];
const errors = [];

const html = readFileSync(join(root, "index.html"), "utf8")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");   // scripts are imported below, not run by jsdom
const dom = new JSDOM(html, { url: "https://lifeos.test/", pretendToBeVisual: true });
const w = dom.window;

if (seedLocal) for (const [k, v] of Object.entries(seedLocal)) w.localStorage.setItem(k, v);

/* Expose the DOM as globals, the way a browser module sees them. Node's
   own fetch/crypto/streams/TextEncoder/BroadcastChannel stay. */
const keep = new Set(["crypto", "fetch", "Request", "Response", "Headers", "TextEncoder", "TextDecoder",
  "CompressionStream", "DecompressionStream", "Blob", "ReadableStream", "WritableStream", "TransformStream",
  "BroadcastChannel", "structuredClone", "atob", "btoa", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "queueMicrotask", "performance", "URL", "URLSearchParams", "AbortController", "AbortSignal",
  "console", "Event", "EventTarget", "MessageChannel", "MessagePort", "navigator"]);
for (const k of Object.getOwnPropertyNames(w)) {
  if (keep.has(k) || k in globalThis && !["window", "document", "localStorage", "sessionStorage", "location", "history"].includes(k)) continue;
  try { globalThis[k] = w[k]; } catch (_) {}
}
globalThis.window = w; globalThis.document = w.document; globalThis.self = w;
globalThis.localStorage = w.localStorage; globalThis.sessionStorage = w.sessionStorage;
globalThis.location = w.location; globalThis.history = w.history;
try { Object.defineProperty(globalThis, "navigator", { value: w.navigator, configurable: true }); } catch (_) {}
for (const k of ["crypto", "fetch", "CompressionStream", "DecompressionStream", "Blob", "Response", "TextEncoder", "TextDecoder"]) {
  try { w[k] = globalThis[k]; } catch (_) {}
}
/* Separate devices don't share a BroadcastChannel (Node's is shared by
   every worker in the process, which would make the devices behave like
   tabs of one browser). Tabs of one device can be modelled by giving
   them the same workerData.tabGroup. */
{
  const groups = globalThis.__bcGroups || (globalThis.__bcGroups = new Map());
  class LocalBC {
    constructor(n) { this.name = n; this.onmessage = null; const g = groups.get(n) || new Set(); g.add(this); groups.set(n, g); }
    postMessage(data) { for (const o of groups.get(this.name) || []) if (o !== this && o.onmessage) setTimeout(() => o.onmessage({ data }), 0); }
    close() { (groups.get(this.name) || new Set()).delete(this); }
    addEventListener() {} removeEventListener() {}
  }
  globalThis.BroadcastChannel = w.BroadcastChannel = LocalBC;
}
globalThis.requestAnimationFrame = w.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = w.cancelAnimationFrame = id => clearTimeout(id);
globalThis.matchMedia = w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.ResizeObserver = w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.scrollTo = w.scrollTo = () => {};
w.HTMLElement.prototype.scrollIntoView = function () {};
/* CDN libraries index.html normally loads. Sortable and Quill are only
   constructed by UI code; minimal stand-ins keep that code from throwing. */
const anything = () => { const f = function () { return anything(); }; return new Proxy(f, {
  get: (t, p) => p === Symbol.toPrimitive ? () => "" : p === "then" ? undefined : anything(),
  set: () => true, apply: () => anything(), construct: () => anything() }); };
globalThis.Sortable = w.Sortable = class { static create() { return { destroy() {}, option() {} }; } constructor() { this.destroy = () => {}; this.option = () => {}; } };
globalThis.Quill = w.Quill = class {
  constructor(el) {
    const self = {
      root: el,
      clipboard: { dangerouslyPasteHTML(h) { el.innerHTML = h; }, convert() { return {}; } },
      getText() { return el.textContent || ""; }, setText(t) { el.textContent = t; },
      getLength() { return (el.textContent || "").length + 1; }, getSemanticHTML() { return el.innerHTML; },
      getSelection() { return null; }, hasFocus() { return false; },
    };
    return new Proxy(self, { get: (t, p) => (p in t ? t[p] : () => undefined) });
  }
  static register() {} static import() { return anything(); }
};

w.addEventListener("error", e => errors.push(String(e.message || e.error)));
process.on("unhandledRejection", e => errors.push("unhandled: " + (e && e.stack || e)));

const client = createFakeClient({
  dbUrl, uid,
  onEgress: (kind, bytes) => egress.push([kind, bytes]),
  onRequest: (kind, bytes) => { if (bytes) uploads.push([kind, bytes]); },
});
globalThis.supabase = w.supabase = { createClient: () => client };

/* authDiag writes its last 10 lines to #ghDiag; keep all of them. */
const diagEl = w.document.getElementById("ghDiag");
let lastDiag = "";
setInterval(() => {
  const t = diagEl ? diagEl.textContent : "";
  if (t && t !== lastDiag) {
    const lines = t.split("\n"); const prev = new Set(lastDiag.split("\n"));
    for (const l of lines) if (!prev.has(l)) diag.push(l.replace(/^.*? · /, ""));
    lastDiag = t;
  }
}, 20);

const mod = p => import(pathToFileURL(join(root, "js", p)).href + "?v=" + version);
let S = null;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
parentPort.on("message", async ({ id, cmd, code }) => {
  try {
    let result;
    if (cmd === "boot") {
      await mod("app.js");
      S = { state: await mod("state.js"), cloud: await mod("supabase.js"), ui: await mod("ui.js"), window: w, document: w.document };
      result = "booted";
    } else if (cmd === "run") {
      result = await new AsyncFunction("S", code)(S);
    } else if (cmd === "stats") {
      result = { egress: egress.slice(), uploads: uploads.slice(), diag: diag.slice(), errors: errors.slice(),
                 pill: (w.document.getElementById("syncPill") || {}).textContent || "" };
    } else if (cmd === "reset-stats") {
      egress.length = 0; uploads.length = 0; diag.length = 0; result = true;
    } else if (cmd === "close") {
      await client.close(); result = true;
      setTimeout(() => process.exit(0), 10);
    }
    parentPort.postMessage({ id, ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e && e.stack || e) });
  }
});
parentPort.postMessage({ ready: true });

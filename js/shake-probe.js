/* ---------------------------------------------------------------------
   SHAKE PROBE — a diagnostic, not a feature.

   The "page keeps moving" report has survived three attempted fixes, each
   aimed at a cause reasoned from a screenshot rather than measured. This
   stops the guessing: it watches every element under .main and records
   which ones actually change size, how often, and what the DOM is doing
   while they do it.

   It is loaded ONLY when the URL carries ?debug=shake — app.js imports it
   dynamically, so on a normal page load this file is never even fetched.
   Nothing here writes to state, touches persist(), or changes layout; the
   overlay is position:fixed and pointer-transparent except for its own
   buttons.

   To use it:  https://life-os-endk.vercel.app/?debug=shake
   Leave it running until the movement happens, then press Copy and send
   the text. A "shake" shows up as one element with a resize count that
   keeps climbing while nothing is being touched.
   --------------------------------------------------------------------- */

const WINDOW_MS = 2000;   // how often the readout refreshes
const MAX_WATCHED = 900;  // ceiling on observed elements, to stay cheap

/* A short, human-readable handle for an element: enough to find it in the
   source, short enough to read in a list. */
function label(el) {
  if (!el || el === document.body) return "body";
  const id = el.id ? "#" + el.id : "";
  const cls = (el.className && typeof el.className === "string")
    ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
    : "";
  return el.tagName.toLowerCase() + id + cls;
}

export function startShakeProbe() {
  if (typeof ResizeObserver === "undefined") {
    console.warn("[shake] ResizeObserver unavailable — probe cannot run");
    return;
  }
  const main = document.querySelector(".main") || document.body;

  const resizeCounts = new Map();  // label -> times its size CHANGED
  const lastSize = new WeakMap();  // element -> last seen "WxH"
  const watched = new WeakSet();
  let mutations = 0;
  let roLoopErrors = 0;
  let windowStart = Date.now();
  let peak = { label: "—", count: 0 };

  const ro = new ResizeObserver(entries => {
    for (const e of entries) {
      const el = e.target;
      const size = Math.round(e.contentRect.width) + "x" + Math.round(e.contentRect.height);
      const prev = lastSize.get(el);
      lastSize.set(el, size);
      if (prev === undefined || prev === size) continue; // first sighting, or genuinely unchanged
      const k = label(el);
      const n = (resizeCounts.get(k) || 0) + 1;
      resizeCounts.set(k, n);
      if (n > peak.count) peak = { label: k, count: n };
    }
  });

  /* Re-scanned rather than observed once: renders replace elements, and an
     element that has been removed and rebuilt is a different node. */
  function scan() {
    let n = 0;
    for (const el of main.querySelectorAll("*")) {
      if (n++ > MAX_WATCHED) break;
      if (watched.has(el)) continue;
      watched.add(el);
      try { ro.observe(el); } catch (_) {}
    }
  }

  const mo = new MutationObserver(list => { mutations += list.length; });
  mo.observe(main, { subtree: true, childList: true, attributes: true, characterData: false });

  /* Chrome reports "ResizeObserver loop completed with undelivered
     notifications" when an observer's callback resizes something that the
     observer itself watches — the textbook signature of a layout loop. If
     this number is climbing, that IS the bug. */
  window.addEventListener("error", e => {
    if (String(e.message || "").includes("ResizeObserver loop")) roLoopErrors++;
  });

  // ---- overlay ----
  const box = document.createElement("div");
  box.id = "shakeProbe";
  box.style.cssText = [
    "position:fixed", "left:12px", "bottom:12px", "z-index:99999",
    "width:340px", "max-height:46vh", "overflow:auto",
    "background:rgba(20,18,30,.92)", "color:#EDE9E0",
    "font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace",
    "padding:10px 12px", "border-radius:10px",
    "box-shadow:0 8px 30px rgba(0,0,0,.35)", "white-space:pre-wrap"
  ].join(";");
  const pre = document.createElement("div");
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:6px;margin-top:8px";
  const mk = (text, fn) => {
    const b = document.createElement("button");
    b.textContent = text;
    b.style.cssText = "flex:1;padding:5px;border-radius:6px;border:1px solid #555;" +
      "background:#2A2736;color:#EDE9E0;font:inherit;cursor:pointer";
    b.onclick = fn;
    return b;
  };
  let report = "";
  bar.append(
    mk("Copy", () => {
      navigator.clipboard?.writeText(report).then(
        () => { bar.children[0].textContent = "Copied"; setTimeout(() => (bar.children[0].textContent = "Copy"), 1200); },
        () => { window.prompt("Copy this:", report); }
      );
    }),
    mk("Reset", () => { resizeCounts.clear(); mutations = 0; peak = { label: "—", count: 0 }; }),
    mk("Close", () => { ro.disconnect(); mo.disconnect(); clearInterval(timer); box.remove(); })
  );
  box.append(pre, bar);
  document.body.appendChild(box);

  const timer = setInterval(() => {
    scan();
    const secs = Math.max(1, Math.round((Date.now() - windowStart) / 1000));
    const top = [...resizeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    report =
      "LifeOS shake probe — " + secs + "s of observation\n" +
      "page: " + (document.querySelector(".page.visible")?.id || "?") + "\n" +
      "viewport: " + window.innerWidth + "x" + window.innerHeight +
      "  scrollY: " + Math.round(window.scrollY) + "\n" +
      "DOM mutations: " + mutations + "  (" + (mutations / secs).toFixed(1) + "/s)\n" +
      "ResizeObserver loop errors: " + roLoopErrors + "\n" +
      "\nmost-resized elements (count = times its size changed):\n" +
      (top.length
        ? top.map(([k, v]) => "  " + String(v).padStart(5) + "  " + k).join("\n")
        : "  (nothing has changed size yet)");
    pre.textContent = report;
  }, WINDOW_MS);

  console.log("[shake] probe running — reproduce the movement, then press Copy");
}

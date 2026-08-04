/* Link preview cards.

   A pasted link renders as a small card — title, site, thumbnail —
   instead of bare text. The metadata comes from /api/link-preview,
   because a browser can't read another site's HTML (see that file).

   Two things shape this module:

   CACHING. A preview for a given URL barely changes, and re-fetching one
   every time a note is drawn would be slow, would flicker, and would hit
   the linked site far more often than it deserves. Results are cached in
   localStorage — deliberately not in `state`, since a cache of other
   people's page titles is not the person's data and has no business
   being synced between devices or landing in their backups.

   FAILING QUIETLY. Plenty of links have no metadata at all: an internal
   GSI page, a PDF, a site that's down, a file:// path. None of that is
   an error worth showing. When there's no preview the link simply stays
   as it was, which is why every failure path here ends in "do nothing"
   rather than an error message. */

const CACHE_KEY = "lifeos-link-previews";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // a week
const MAX_CACHED = 200;                          // keeps localStorage use bounded
const inFlight = new Map();                      // url -> Promise, so one URL is never fetched twice at once

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
  catch (e) { return {}; }
}
function writeCache(cache) {
  try {
    const entries = Object.entries(cache);
    if (entries.length > MAX_CACHED) {
      // Oldest out first. A preview cache is worth nothing if keeping it
      // costs the app the storage its real data needs.
      entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
      cache = Object.fromEntries(entries.slice(0, MAX_CACHED));
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch (e) { /* full or unavailable — previews are not worth failing over */ }
}

export function clearLinkPreviewCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
}

/* YouTube is handled without the proxy. Its oEmbed endpoint sends CORS
   headers, so the browser can call it directly — one less server round
   trip, and it still works if the serverless function is unavailable. */
function youtubeId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}
async function fetchYouTube(url) {
  const res = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url));
  if (!res.ok) throw new Error("oembed " + res.status);
  const d = await res.json();
  return {
    title: d.title || "",
    description: d.author_name ? "by " + d.author_name : "",
    image: d.thumbnail_url || "",
    siteName: "youtube.com",
    url,
  };
}

async function fetchPreview(url) {
  const yt = youtubeId(url);
  if (yt) {
    try { return await fetchYouTube(url); }
    catch (e) { /* fall through to the proxy */ }
  }
  const res = await fetch("/api/link-preview?url=" + encodeURIComponent(url));
  if (!res.ok) throw new Error("preview " + res.status);
  const data = await res.json();
  if (data.error || !data.title) throw new Error(data.error || "no metadata");
  return data;
}

/* Returns the preview, or null when there isn't one. Never throws — a
   caller decorating a note shouldn't have to guard every link. */
export async function getLinkPreview(url) {
  if (!/^https?:\/\//i.test(url)) return null;
  const cache = readCache();
  const hit = cache[url];
  if (hit && Date.now() - (hit.at || 0) < CACHE_TTL_MS) {
    return hit.failed ? null : hit.data;
  }
  if (inFlight.has(url)) return inFlight.get(url);

  const job = (async () => {
    try {
      const data = await fetchPreview(url);
      const c = readCache();
      c[url] = { at: Date.now(), data };
      writeCache(c);
      return data;
    } catch (e) {
      // Remember the failure too, otherwise every render retries a link
      // that has no preview and never will.
      const c = readCache();
      c[url] = { at: Date.now(), failed: true };
      writeCache(c);
      return null;
    } finally {
      inFlight.delete(url);
    }
  })();
  inFlight.set(url, job);
  return job;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text; // textContent, never innerHTML: this is data from someone else's page
  return n;
}

/* Builds the card as DOM nodes rather than an HTML string. The title and
   description come from a third-party page, so they are treated as text
   throughout — there is no point in the sanitizer if remote page titles
   get to build markup. */
function buildCard(preview) {
  const card = el("div", "link-preview-card");
  card.contentEditable = "false";  // one solid object inside an editable note
  card.dataset.previewUrl = preview.url;

  if (preview.image) {
    const thumb = el("img", "link-preview-thumb");
    thumb.src = preview.image;
    thumb.alt = "";
    thumb.loading = "lazy";
    thumb.referrerPolicy = "no-referrer";
    // A thumbnail that 404s should leave a tidy card, not a broken icon.
    thumb.addEventListener("error", () => thumb.remove());
    card.appendChild(thumb);
  }
  const body = el("div", "link-preview-body");
  body.appendChild(el("div", "link-preview-title", preview.title));
  if (preview.description) body.appendChild(el("div", "link-preview-desc", preview.description));
  body.appendChild(el("div", "link-preview-site", preview.siteName));
  card.appendChild(body);

  card.addEventListener("click", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    window.open(preview.url, "_blank", "noopener,noreferrer");
  });
  return card;
}

/* Finds links inside `container` and appends a card after each one.
   Safe to call repeatedly — an already-decorated link is skipped, which
   matters because notes re-render on every board change. */
export async function decorateLinks(container, onDone) {
  if (!container) return;
  const anchors = Array.from(container.querySelectorAll("a[href^='http']"))
    .filter(a => !a.dataset.previewChecked);

  for (const a of anchors) {
    a.dataset.previewChecked = "1"; // set before awaiting, so a re-entrant call skips it
    const url = a.href;
    // Don't stack duplicate cards for the same link in the same note.
    if (container.querySelector(`.link-preview-card[data-preview-url="${CSS.escape(url)}"]`)) continue;
    const preview = await getLinkPreview(url);
    if (!preview || !preview.title) continue;
    if (!container.isConnected) return; // note was closed or deleted while fetching
    const card = buildCard(preview);
    // After the line the link sits on, not inline, so it doesn't split text.
    const line = a.closest("div, p, li") || a;
    line.parentNode.insertBefore(card, line.nextSibling);
    if (onDone) onDone();
  }
}

/* Preview cards are generated from the link, not typed by the person, so
   they must not be written into the note's saved HTML — otherwise every
   save embeds a stale copy of someone else's page title, and the cards
   accumulate. Strip them before saving; decorateLinks puts them back. */
export function stripPreviewCards(html) {
  if (!html || !html.includes("link-preview-card")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(".link-preview-card").forEach(n => n.remove());
  return doc.body.innerHTML;
}

/* ---------- previews for the link lists ----------

   GSI links, Work documents and Reference links are compact pills, not
   editable notes. Dropping a full card under each one would turn a tidy
   row of chips into a wall of boxes, so these get a different treatment:
   a small thumbnail inside the pill for instant recognition, and the
   full preview on hover — or on tap, since hover doesn't exist on a
   phone and a preview only reachable by mouse is no use on the iPhone.

   These rows already carry a title the person chose. What they don't
   show is what the page actually *is*, which is exactly what the
   preview supplies — so the person's own title is never overwritten. */

let popEl = null;
function previewPopover() {
  if (popEl) return popEl;
  popEl = document.createElement("div");
  popEl.className = "link-preview-pop";
  document.body.appendChild(popEl);
  return popEl;
}
function hidePreviewPop() { if (popEl) popEl.classList.remove("open"); }

function showPreviewPop(anchorEl, preview) {
  const pop = previewPopover();
  pop.textContent = "";
  if (preview.image) {
    const img = document.createElement("img");
    img.className = "link-preview-pop-thumb";
    img.src = preview.image;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => img.remove());
    pop.appendChild(img);
  }
  const body = document.createElement("div");
  body.className = "link-preview-pop-body";
  body.appendChild(el("div", "link-preview-title", preview.title));
  if (preview.description) body.appendChild(el("div", "link-preview-desc", preview.description));
  body.appendChild(el("div", "link-preview-site", preview.siteName));
  pop.appendChild(body);
  pop.classList.add("open");

  /* Positioned against the viewport rather than the row's container: the
     popover lives on <body> precisely so it isn't clipped by a card's
     overflow, which means it can't inherit that container's coordinates
     either. Flips above the row when there's no room below. */
  const r = anchorEl.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const margin = 8;
  let left = Math.min(r.left, window.innerWidth - pr.width - margin);
  let top = r.bottom + 6;
  if (top + pr.height > window.innerHeight - margin) top = r.top - pr.height - 6;
  pop.style.left = Math.max(margin, left) + "px";
  pop.style.top = Math.max(margin, top) + "px";
}

/* Building the anchor selector by hand rather than writing
   `${ROW_SELECTOR} a[href]`. A comma-separated list doesn't distribute
   over what follows it: ".link-row, .link-card a[href]" means "any
   .link-row" OR "an a[href] inside .link-card" — so the first three
   selectors would match the row containers themselves and hand back
   elements that have no href at all. The descendant part has to be
   repeated per selector. */
const ROW_SELECTORS = [".link-row", ".link-card", ".gsi-link-row", ".meeting-link-row"];
const ROW_SELECTOR = ROW_SELECTORS.join(", ");
const ROW_ANCHOR_SELECTOR = ROW_SELECTORS.map(sel => `${sel} a[href^='http']`).join(", ");

export async function decorateLinkRows(root = document) {
  const anchors = Array.from(root.querySelectorAll(ROW_ANCHOR_SELECTOR))
    .filter(a => !a.dataset.previewChecked);

  for (const a of anchors) {
    a.dataset.previewChecked = "1";
    const preview = await getLinkPreview(a.href);
    if (!preview || !preview.title) continue;
    const row = a.closest(ROW_SELECTOR);
    // Rows are rebuilt by innerHTML on every render, so a row that has
    // gone from the document mid-fetch must be left alone.
    if (!row || !row.isConnected || row.querySelector(".link-preview-chip")) continue;

    if (preview.image) {
      const chip = document.createElement("img");
      chip.className = "link-preview-chip";
      chip.src = preview.image;
      chip.alt = "";
      chip.loading = "lazy";
      chip.referrerPolicy = "no-referrer";
      chip.addEventListener("error", () => chip.remove());
      row.insertBefore(chip, row.firstChild);
    }
    // The page's real title, available on hover even without a thumbnail.
    row.setAttribute("title", preview.title + (preview.siteName ? " — " + preview.siteName : ""));

    row.addEventListener("mouseenter", () => showPreviewPop(row, preview));
    row.addEventListener("mouseleave", hidePreviewPop);
    // Touch: the chip is the preview control. Tapping the link itself
    // must still just open the link — hijacking that to show a preview
    // would make every link take two taps.
    const chipEl = row.querySelector(".link-preview-chip");
    if (chipEl) {
      chipEl.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (popEl && popEl.classList.contains("open")) hidePreviewPop();
        else showPreviewPop(row, preview);
      });
    }
  }
}

document.addEventListener("pointerdown", (evt) => {
  if (evt.target.closest && (evt.target.closest(".link-preview-pop") || evt.target.closest(".link-preview-chip"))) return;
  hidePreviewPop();
});
window.addEventListener("scroll", hidePreviewPop, true);

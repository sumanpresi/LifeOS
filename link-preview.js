/* Link previews — fetches a page and returns its title, description,
   site name and thumbnail so a pasted link can show a card instead of
   bare text.

   This has to run on the server. A browser can't read another site's
   HTML: the same-origin policy blocks it, and almost no site sends the
   CORS headers that would allow it. So the page is fetched here and only
   the handful of fields the card needs are sent back.

   THE RISK THIS FILE HAS TO MANAGE

   An endpoint that fetches any URL it's handed is a server-side request
   forgery (SSRF) tool. Left open, anyone who finds the URL could aim it
   at addresses only this server can reach — cloud metadata endpoints
   that hand out credentials, private network services, localhost — and
   read back the response. The guards below exist for that, not for
   tidiness:

     • only http and https (no file:, ftp:, gopher:, data:)
     • the resolved address must be public — loopback, link-local,
       private ranges and cloud metadata IPs are all refused
     • redirects are followed manually so each hop is re-checked; a
       public URL that redirects to 169.254.169.254 is the classic bypass
     • a response size cap and a timeout, so one slow or enormous page
       can't tie up the function

   Nothing here needs a key or a session: it returns only what any
   visitor to that page would see, and it doesn't touch user data. */

const dns = require("dns").promises;

const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 512 * 1024;   // plenty for <head>; full pages get truncated
const MAX_REDIRECTS = 3;

/* Every range that is not reachable from the public internet, plus the
   cloud metadata address. Checked against the *resolved* IP, because a
   hostname can be made to point anywhere. */
function isBlockedAddress(ip) {
  if (!ip) return true;
  // IPv6
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fc") || v6.startsWith("fd")) return true;   // unique local
    if (v6.startsWith("fe80")) return true;                        // link-local
    // ::ffff:127.0.0.1 style IPv4-mapped addresses
    const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;               // this/private/loopback
  if (a === 169 && b === 254) return true;                         // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;                // private
  if (a === 192 && b === 168) return true;                         // private
  if (a === 100 && b >= 64 && b <= 127) return true;               // carrier NAT
  if (a >= 224) return true;                                       // multicast / reserved
  return false;
}

async function assertPublicHost(hostname) {
  // A bare IP in the URL never reaches DNS, so check it directly too.
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) {
    if (isBlockedAddress(hostname)) throw new Error("blocked address");
    return;
  }
  let records;
  try { records = await dns.lookup(hostname, { all: true }); }
  catch (e) { throw new Error("cannot resolve host"); }
  if (!records.length) throw new Error("cannot resolve host");
  // Every resolved address must be public — one bad record is enough to
  // refuse, since which one gets used isn't under this code's control.
  for (const r of records) if (isBlockedAddress(r.address)) throw new Error("blocked address");
}

function parseUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error("not a valid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http and https");
  return u;
}

/* Redirects are followed by hand rather than by fetch's own `follow`,
   because each new location has to go through assertPublicHost again. */
async function safeFetch(startUrl) {
  let url = parseUrl(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // Some sites serve no metadata to unrecognised clients.
          "User-Agent": "Mozilla/5.0 (compatible; LifeOSLinkPreview/1.0)",
          "Accept": "text/html,application/xhtml+xml",
        },
      });
    } finally { clearTimeout(timer); }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("redirect without a location");
      url = parseUrl(new URL(loc, url.href).href);
      continue;
    }
    if (!res.ok) throw new Error("site returned " + res.status);

    const type = res.headers.get("content-type") || "";
    if (!type.includes("html")) throw new Error("not an HTML page");

    // Read incrementally and stop at the cap: a page that streams
    // forever must not be able to exhaust this function's memory.
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    try { await reader.cancel(); } catch (e) { /* already closed */ }
    return { html: Buffer.concat(chunks).toString("utf8"), finalUrl: url.href };
  }
  throw new Error("too many redirects");
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function metaContent(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1] && m[1].trim()) return decodeEntities(m[1].trim()).slice(0, 300);
  }
  return "";
}

function extract(html, finalUrl) {
  const prop = (name) => [
    new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, "i"),
  ];
  const title =
    metaContent(html, [...prop("og:title"), ...prop("twitter:title")]) ||
    metaContent(html, [/<title[^>]*>([\s\S]*?)<\/title>/i]);
  const description = metaContent(html, [...prop("og:description"), ...prop("twitter:description"), ...prop("description")]);
  let image = metaContent(html, [...prop("og:image"), ...prop("twitter:image"), ...prop("og:image:url")]);
  const siteName = metaContent(html, [...prop("og:site_name")]);

  // Relative image paths are common; make them absolute so the card can
  // actually load them.
  if (image) {
    try { image = new URL(image, finalUrl).href; } catch (e) { image = ""; }
    if (image && !/^https?:\/\//i.test(image)) image = "";
  }
  return {
    title: title || "",
    description: description || "",
    image: image || "",
    siteName: siteName || new URL(finalUrl).hostname.replace(/^www\./, ""),
    url: finalUrl,
  };
}

module.exports = async (req, res) => {
  const target = (req.query && req.query.url) || "";
  if (!target) return res.status(400).json({ error: "url is required" });

  // Previews for a given link don't change often, and re-fetching on
  // every render would be slow and rude to the site being previewed.
  res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");

  try {
    const { html, finalUrl } = await safeFetch(target);
    return res.status(200).json(extract(html, finalUrl));
  } catch (e) {
    // 200 with an error field, not a failure status: the caller treats
    // "no preview available" as an ordinary outcome and just shows the
    // plain link, which is what most pages without metadata will hit.
    return res.status(200).json({ error: String(e.message || e), url: target });
  }
};

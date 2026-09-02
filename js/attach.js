/* ============================================================
   Attaching things from other apps
   ============================================================
   What is genuinely possible here differs a lot by platform, and it is
   worth being precise rather than promising a single feature that only
   half works.

   DRAGGING IN — iPadOS and desktop only.
   iPadOS Safari does deliver real drop events when you drag a link, a
   piece of text or a mail message from another app into a web page in
   Split View. Desktop browsers do the same. iPhone Safari does not: there
   is no cross-app drag into web content on a phone, and no amount of code
   changes that.

   SHARING IN — Android only.
   The Web Share Target API lets an installed app appear in the system
   share sheet. Chrome and Samsung Internet support it, so on the Fold a
   note, page or message can be shared straight into LifeOS. iOS has never
   implemented it; a PWA cannot register as a share destination there.

   OPENING BACK OUT — everywhere.
   This part is universal, because it is just a link. A Google Calendar
   event, a Keep note, a Drive document or a mail permalink opens in its
   own app when that app is installed, because the operating system claims
   the https URL. Custom schemes like calshow: are deliberately avoided —
   they fail silently when the app is missing, which is worse than a link
   that opens in a browser.
   ============================================================ */

import { state, uid, persist, rerender } from './state.js?v=202609041200';
import { toast } from './ui.js?v=202609041200';

/* Recognise where a link points so an attachment can be labelled with the
   app it belongs to rather than a bare URL. Matching is on hostname and
   path, never on the whole string, so query parameters can't confuse it. */
const SOURCES = [
  { test: /(^|\.)calendar\.google\.com$/,        icon: "📅", label: "Calendar" },
  { test: /(^|\.)keep\.google\.com$/,            icon: "📝", label: "Keep" },
  { test: /(^|\.)docs\.google\.com$/,            icon: "📄", label: "Docs" },
  { test: /(^|\.)drive\.google\.com$/,           icon: "📁", label: "Drive" },
  { test: /(^|\.)mail\.google\.com$/,            icon: "✉️", label: "Mail" },
  { test: /(^|\.)outlook\.(office|live)\.com$/,  icon: "✉️", label: "Outlook" },
  { test: /(^|\.)teams\.microsoft\.com$/,        icon: "💬", label: "Teams" },
  { test: /(^|\.)notion\.so$/,                   icon: "📓", label: "Notion" },
  { test: /(^|\.)github\.com$/,                  icon: "🐙", label: "GitHub" },
  { test: /(^|\.)wa\.me$|(^|\.)web\.whatsapp\.com$/, icon: "💬", label: "WhatsApp" }
];

export function describeLink(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  let host = "";
  try { host = new URL(raw.startsWith("http") ? raw : "https://" + raw).hostname.toLowerCase(); }
  catch (_) { return { icon: "🔗", label: raw.slice(0, 40) }; }
  const hit = SOURCES.find(s => s.test.test(host));
  return hit
    ? { icon: hit.icon, label: hit.label }
    : { icon: "🔗", label: host.replace(/^www\./, "") };
}

/* ---------- dropping something onto a task ---------- */

/* A drop can carry several representations of the same thing. Prefer a
   real URL, fall back to text that looks like one, and finally to plain
   text used as a title. Apple Mail drags a message as a URL with a
   `message:` scheme, which is worth keeping even though it only resolves
   on a Mac. */
function readDrop(dt) {
  if (!dt) return null;
  const uri = (dt.getData("text/uri-list") || "").split("\n").find(l => l && !l.startsWith("#"));
  const text = dt.getData("text/plain") || "";
  const title = dt.getData("text/html")
    ? (dt.getData("text/html").match(/<title[^>]*>([^<]+)</i)?.[1] || "").trim()
    : "";
  const url = uri || (/^(https?:|message:|mailto:)\S+$/i.test(text.trim()) ? text.trim() : "");
  return { url, text: text.trim(), title: title || "" };
}

function findTask(id) {
  const native = state.tasks.find(t => t.id === id);
  if (native) return native;
  for (const p of state.gsi?.projects || []) {
    const t = (p.tasks || []).find(x => x.id === id);
    if (t) return t;
  }
  for (const p of state.personal?.projects || []) {
    const t = (p.tasks || []).find(x => x.id === id);
    if (t) return t;
  }
  return null;
}

/* One delegated pair of listeners for the whole document rather than one
   per card: cards are re-rendered constantly, and per-element listeners
   would have to be reattached every time. */
export function initDropToAttach() {
  const cardOf = t => t?.closest?.(".t-board-card, .gsi-card");

  document.addEventListener("dragover", evt => {
    const card = cardOf(evt.target);
    if (!card) return;
    // Only claim the event for content from OUTSIDE the app; an internal
    // card drag has to keep reaching SortableJS.
    if (evt.dataTransfer?.types?.includes("application/x-lifeos-card")) return;
    evt.preventDefault();
    evt.dataTransfer.dropEffect = "copy";
    card.classList.add("drop-target");
  });

  document.addEventListener("dragleave", evt => {
    const card = cardOf(evt.target);
    if (card) card.classList.remove("drop-target");
  });

  document.addEventListener("drop", evt => {
    const card = cardOf(evt.target);
    if (!card) return;
    const payload = readDrop(evt.dataTransfer);
    if (!payload || (!payload.url && !payload.text)) return;
    evt.preventDefault();
    card.classList.remove("drop-target");

    const task = findTask(card.dataset.taskId);
    if (!task) return;
    if (payload.url) {
      task.link = payload.url;
      task.updatedAt = Date.now();
      persist(); rerender();
      const d = describeLink(payload.url);
      toast(`${d.icon} ${d.label} attached — tap the link on the card to open it`);
    } else {
      /* Plain text with no URL is far more likely to be a note the person
         wants recorded than a new title, so it goes to the description
         rather than overwriting what the task is called. */
      task.desc = (task.desc || "") + `<p>${payload.text.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</p>`;
      task.updatedAt = Date.now();
      persist(); rerender();
      toast("Added to the task's description");
    }
  });
}

/* ---------- shared in from another app (Android) ---------- */

/* The manifest points the share target at ./?share=1, so a share arrives
   as an ordinary page load with the content in the query string. Handled
   once at startup and then stripped from the URL, so a refresh doesn't
   create the task a second time. */
export function handleIncomingShare() {
  const q = new URLSearchParams(location.search);
  /* Namespaced parameter names, matching the manifest. A share target's
     `action` cannot reliably carry its own marker query string, so the
     parameters themselves have to be unambiguous — otherwise an ordinary
     link containing ?url= would be mistaken for a share and silently
     create a task. */
  const title = (q.get("share_title") || "").trim();
  const text = (q.get("share_text") || "").trim();
  const url = (q.get("share_url") || "").trim();
  if (!title && !text && !url) return;

  // Android often puts the URL inside `text` rather than `url`.
  const foundUrl = url || (text.match(/https?:\/\/\S+/) || [""])[0];
  const name = title || text.replace(foundUrl, "").trim() || (foundUrl ? describeLink(foundUrl).label : "");
  if (!name && !foundUrl) return;

  state.tasks.push({
    id: uid(),
    text: name || foundUrl,
    done: false,
    category: "work",
    flag: false,
    link: foundUrl,
    dueDate: "",
    completedAt: null,
    googleEventId: null,
    updatedAt: Date.now()
  });
  persist(); rerender();
  toast("Added from share: " + (name || foundUrl).slice(0, 48));

  const clean = new URL(location.href);
  ["share_title", "share_text", "share_url"].forEach(k => clean.searchParams.delete(k));
  history.replaceState(null, "", clean.toString());
}

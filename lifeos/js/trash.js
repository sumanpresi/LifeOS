/* One shared recycle bin for every "delete" button in LifeOS. Deleting
   something moves it here instead of erasing it outright; it's restorable
   for 30 days, then quietly cleared out. Each entry knows its own "type"
   so restoring can put it back in the right place — a project task goes
   back into its project, a travel stop back into its plan, and so on. */
import { state, uid, esc, persist, rerender } from './state.js';
import { toast } from './ui.js';

const RETENTION_DAYS = 30;

export function moveToTrash(type, payload, meta) {
  state.trash.unshift({
    id: uid(),
    type,
    payload: structuredClone(payload),
    meta: meta || {},
    deletedAt: Date.now()
  });
  /* Many delete functions re-render only their own local view (e.g.
     renderProjects(), not the whole app), so the Trash page's list
     wouldn't otherwise pick up the new entry until some unrelated global
     render happened to run. Refresh it here so it's always current. */
  renderTrash();
}

export function purgeOldTrash() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const before = state.trash.length;
  state.trash = state.trash.filter(t => t.deletedAt > cutoff);
  const changed = state.trash.length !== before;
  if (changed) persist(); // safe even at boot — persist() queues until the app has reconciled with the cloud
  return changed;
}

/* ---------- human-readable label per type, for the Trash list ---------- */
function labelFor(entry) {
  const p = entry.payload;
  switch (entry.type) {
    case "task": return p.text;
    case "habit": return p.name;
    case "goal": return p.name;
    case "gsiProject": return "Project: " + p.name;
    case "gsiProjectTask": return p.text;
    case "log": return p.text;
    case "meeting": return "Meeting: " + (p.title || "Untitled");
    case "gsiLink": return p.title;
    case "personalDoc": return p.name;
    case "workDoc": return p.name;
    case "travelPlan": return "Travel plan: " + p.name;
    case "travelStop": return p.place || "(unnamed stop)";
    case "packingItem": return p.text;
    case "referencePage": return "Reference page: " + p.name;
    case "referenceLink": return p.title;
    case "financeItem": return p.name;
    case "financeLink": return p.title;
    case "medicine": return p.name;
    case "prescription": return p.name;
    case "healthLink": return p.title;
    case "bookmarkLink": return p.title;
    case "feed": return p.name || p.url;
    case "sectionLink": return p.title;
    default: return "(item)";
  }
}
const TYPE_NAMES = {
  task: "Task", habit: "Habit", goal: "Goal", gsiProject: "GSI project", gsiProjectTask: "GSI task",
  log: "Work log entry", meeting: "Meeting", gsiLink: "GSI link", personalDoc: "Personal document",
  workDoc: "Work document", travelPlan: "Travel plan", travelStop: "Travel stop", packingItem: "Packing item",
  referencePage: "Reference page", referenceLink: "Reference link", financeItem: "Finance item",
  financeLink: "Finance link", medicine: "Medicine", prescription: "Prescription",
  healthLink: "Health link", bookmarkLink: "Link", feed: "News feed", sectionLink: "Link"
};

function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 60) return mins <= 1 ? "just now" : mins + " min ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.round(hrs / 24);
  return days + "d ago";
}

export function renderTrash() {
  const list = document.getElementById("trashList");
  if (!list) return;
  const items = [...state.trash].sort((a, b) => b.deletedAt - a.deletedAt);
  list.innerHTML = items.map(t => `
    <div class="trash-row">
      <span class="trash-type">${esc(TYPE_NAMES[t.type] || t.type)}</span>
      <span class="trash-label">${esc(labelFor(t))}</span>
      <span class="trash-time">${timeAgo(t.deletedAt)}</span>
      <button class="btn btn-ghost" style="padding:6px 12px;font-size:12.5px" onclick="restoreFromTrash('${t.id}')">Restore</button>
      <button class="del" onclick="permanentlyDeleteFromTrash('${t.id}')" title="Delete forever">✕</button>
    </div>`).join("") || `<p class="hint">Nothing in the trash. Deleted items stay here for ${RETENTION_DAYS} days before they're cleared for good.</p>`;
  const count = document.getElementById("trashCount");
  if (count) count.textContent = items.length ? items.length + (items.length === 1 ? " item" : " items") : "";
  const navCount = document.getElementById("trashNavCount");
  if (navCount) navCount.textContent = items.length || "";
}

export function permanentlyDeleteFromTrash(id) {
  if (!confirm("Delete this permanently? It can't be recovered after this.")) return;
  state.trash = state.trash.filter(t => t.id !== id);
  persist(); renderTrash();
}

/* ---------- restore: put the payload back where it came from ---------- */
export function restoreFromTrash(id) {
  const entry = state.trash.find(t => t.id === id);
  if (!entry) return;
  const p = entry.payload, m = entry.meta;

  switch (entry.type) {
    case "task": state.tasks.push(p); break;
    case "habit": state.habits.push(p); break;
    case "goal": state.goals.push(p); break;
    case "gsiProject": state.gsi.projects.push(p); break;
    case "gsiProjectTask": {
      const proj = state.gsi.projects.find(x => x.id === m.projectId) || state.gsi.projects[0];
      if (proj) { proj.tasks.push(p); if (proj.id !== m.projectId) toast("Original project was deleted — restored into \"" + proj.name + "\" instead"); }
      break;
    }
    case "log": state.gsi.log.push(p); break;
    case "meeting": state.gsi.meetings.push(p); break;
    case "gsiLink": state.gsi.links.push(p); break;
    case "personalDoc": state.gsi.personalDocs.push(p); break;
    case "workDoc": state.gsi.workDocs.push(p); break;
    case "travelPlan": state.travel.plans.push(p); break;
    case "travelStop": {
      const plan = state.travel.plans.find(x => x.id === m.planId) || state.travel.plans[0];
      if (plan) { plan.stops.push(p); if (plan.id !== m.planId) toast("Original plan was deleted — restored into \"" + plan.name + "\" instead"); }
      break;
    }
    case "packingItem": {
      const plan = state.travel.plans.find(x => x.id === m.planId) || state.travel.plans[0];
      if (plan) { plan.packing.push(p); if (plan.id !== m.planId) toast("Original plan was deleted — restored into \"" + plan.name + "\" instead"); }
      break;
    }
    case "referencePage": state.reference.pages.push(p); break;
    case "referenceLink": {
      const page = state.reference.pages.find(x => x.id === m.pageId) || state.reference.pages[0];
      if (page) { page.links.push(p); if (page.id !== m.pageId) toast("Original page was deleted — restored into \"" + page.name + "\" instead"); }
      break;
    }
    case "financeItem": state.finance[m.listKey || "grocery"].push(p); break;
    case "financeLink": state.finance.links.push(p); break;
    case "medicine": state.health.medicines.push(p); break;
    case "prescription": state.health.prescriptions.push(p); break;
    case "healthLink": state.health.links.push(p); break;
    case "bookmarkLink": state.links.push(p); break;
    case "feed": state.feeds.push(p); break;
    case "sectionLink": {
      const key = m.sectionKey;
      if (state.sections[key]) state.sections[key].links.push(p);
      break;
    }
  }

  state.trash = state.trash.filter(t => t.id !== id);
  persist(); rerender();
  toast("Restored");
}

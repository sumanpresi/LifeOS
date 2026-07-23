/* Travel Plan page: multiple named plans as tabs (e.g. "Sikkim", "Ladakh"),
   each with an itinerary of stops (place / duration / hotel / booked hotel)
   and a packing list. Maps use Google's no-API-key embed URL format, so no
   setup or billing account is needed — just internet access. */
import { state, uid, esc, persist, rerender } from './state.js';
import { toast } from './ui.js';

function activePlan() {
  return state.travel.plans.find(p => p.id === state.travel.activePlan) || state.travel.plans[0];
}
function mapUrl(query) {
  return "https://www.google.com/maps?q=" + encodeURIComponent(query) + "&output=embed";
}

export function renderTravel() {
  const plans = state.travel.plans;
  const active = activePlan();
  if (active && state.travel.activePlan !== active.id) state.travel.activePlan = active.id;

  const tabs = document.getElementById("travelPlanTabs");
  if (tabs) {
    tabs.innerHTML = plans.map(p => `
      <button class="tab ${p.id === active.id ? "active" : ""}" onclick="switchTravelPlan('${p.id}')">${esc(p.name)}</button>`).join("")
      + `<button class="tab tab-add" onclick="addTravelPlan()" title="New travel plan">＋</button>`;
  }

  const nameEl = document.getElementById("travelPlanName");
  if (nameEl && document.activeElement !== nameEl) nameEl.value = active.name;
  const delBtn = document.getElementById("travelPlanDelBtn");
  if (delBtn) delBtn.style.display = plans.length > 1 ? "" : "none";

  const stopsBox = document.getElementById("travelStops");
  if (stopsBox) {
    stopsBox.innerHTML = (active.stops || []).map(s => {
      const hasPlace = (s.place || "").trim();
      const query = (s.bookedHotel || "").trim()
        ? s.bookedHotel + (hasPlace ? ", " + s.place : "")
        : hasPlace ? "hotels near " + s.place : "";
      return `
      <div class="travel-stop" data-open="${s.mapOpen ? "1" : "0"}">
        <div class="travel-stop-row">
          <input type="text" placeholder="Place name" value="${esc(s.place)}" onchange="editStop('${s.id}','place',this.value)">
          <input type="text" placeholder="Duration, e.g. 3 nights" value="${esc(s.duration)}" onchange="editStop('${s.id}','duration',this.value)">
          <input type="text" placeholder="Hotel (searching)" value="${esc(s.hotel)}" onchange="editStop('${s.id}','hotel',this.value)">
          <input type="text" placeholder="Booked hotel" value="${esc(s.bookedHotel)}" onchange="editStop('${s.id}','bookedHotel',this.value)">
          <button class="btn btn-ghost" style="padding:6px 10px;font-size:12.5px" onclick="toggleStopMap('${s.id}')">${s.mapOpen ? "Hide map" : "🗺️ Map"}</button>
          <button class="del" onclick="delStop('${s.id}')">✕</button>
        </div>
        ${s.mapOpen && query ? `<iframe class="travel-map" src="${mapUrl(query)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>` : ""}
        ${s.mapOpen && !query ? `<p class="hint" style="padding:8px 0">Enter a place name to preview the map.</p>` : ""}
      </div>`;
    }).join("") || `<p class="hint">Add a stop to start planning this trip.</p>`;
  }

  const packEl = document.getElementById("travelPacking");
  if (packEl && document.activeElement !== packEl) packEl.value = active.packing || "";
}

export function addTravelPlan() {
  const name = prompt("Name this travel plan (e.g. Sikkim, Rajasthan, Ladakh):");
  if (!name || !name.trim()) return;
  const p = { id: uid(), name: name.trim(), notes: "", packing: "", stops: [] };
  state.travel.plans.push(p);
  state.travel.activePlan = p.id;
  persist(); renderTravel();
}
export function switchTravelPlan(id) {
  state.travel.activePlan = id;
  persist(false); renderTravel();
}
export function renameTravelPlan(v) {
  const p = activePlan(); if (!p || !v.trim()) return;
  p.name = v.trim();
  persist(); renderTravel();
}
export function delTravelPlan() {
  if (state.travel.plans.length <= 1) return;
  const p = activePlan();
  if (!confirm(`Delete the "${p.name}" travel plan? This cannot be undone.`)) return;
  state.travel.plans = state.travel.plans.filter(x => x.id !== p.id);
  state.travel.activePlan = state.travel.plans[0].id;
  persist(); renderTravel();
}

export function addStop() {
  const p = activePlan();
  p.stops.push({ id: uid(), place: "", duration: "", hotel: "", bookedHotel: "", mapOpen: false });
  persist(); renderTravel();
}
export function editStop(id, field, v) {
  const p = activePlan();
  const s = p.stops.find(x => x.id === id); if (!s) return;
  s[field] = v;
  persist();
  if (s.mapOpen) renderTravel(); // refresh the map query
}
export function toggleStopMap(id) {
  const p = activePlan();
  const s = p.stops.find(x => x.id === id); if (!s) return;
  s.mapOpen = !s.mapOpen;
  persist(false); renderTravel();
}
export function delStop(id) {
  const p = activePlan();
  p.stops = p.stops.filter(x => x.id !== id);
  persist(); renderTravel();
}

let packTimer = null;
export function saveTravelPacking(v) {
  const p = activePlan();
  p.packing = v;
  clearTimeout(packTimer);
  packTimer = setTimeout(() => persist(), 800);
}

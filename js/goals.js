/* Life goals with progress sliders. */
import { state, uid, esc, persist, rerender } from './state.js';
import { moveToTrash } from './trash.js';

export function renderGoals() {
  document.getElementById("goalsList").innerHTML = state.goals.map((g, i) => `
    <div class="goal">
      <div class="goal-top">
        <span class="task-num">${i + 1}</span>
        <input type="text" value="${esc(g.name)}" onchange="editGoal('${g.id}','name',this.value)">
        <span class="pct">${g.pct}%</span>
        <button class="del" onclick="delGoal('${g.id}')">✕</button>
      </div>
      <div class="bar"><span style="width:${g.pct}%"></span></div>
      <input type="range" min="0" max="100" value="${g.pct}" oninput="editGoal('${g.id}','pct',this.value,this)">
    </div>`).join("") || `<p class="hint">Add the areas of life you're pushing forward.</p>`;
}
export function addGoal() {
  const el = document.getElementById("newGoal"); const v = el.value.trim(); if (!v) return;
  state.goals.push({ id: uid(), name: v, pct: 0 }); el.value = "";
  persist(); rerender();
}
export function editGoal(id, field, v, slider) {
  const g = state.goals.find(x => x.id === id); if (!g) return;
  if (field === "pct") {
    g.pct = +v;
    /* live-update this goal only, so the slider doesn't lose the drag */
    const goal = slider.closest(".goal");
    goal.querySelector(".pct").textContent = g.pct + "%";
    goal.querySelector(".bar span").style.width = g.pct + "%";
  } else g.name = v;
  persist();
}
export function delGoal(id) {
  const g = state.goals.find(x => x.id === id);
  if (g) moveToTrash("goal", g);
  state.goals = state.goals.filter(x => x.id !== id);
  persist(); rerender();
}

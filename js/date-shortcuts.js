/* A small popover of quick date presets (Today / Tomorrow / Next week /
   Clear) attached to any existing <input type="date">. This is UI-only:
   it sets the input's value and dispatches the same "change" event a
   person picking a date manually would trigger, so it always runs
   through whatever save logic that specific input already had —
   editTaskMeta(), editProjectTask(), or anything else — without this
   module needing to know or duplicate that logic. */

function fmt(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

export function toggleDatePopover(evt, inputId) {
  evt.stopPropagation();
  const pop = document.getElementById("pop-" + inputId);
  if (!pop) return;
  const opening = !pop.classList.contains("open");
  document.querySelectorAll(".date-popover.open").forEach(p => p.classList.remove("open"));
  if (opening) pop.classList.add("open");
}

export function setQuickDate(inputId, which) {
  const input = document.getElementById(inputId);
  if (!input) return;
  let value = "";
  if (which !== "clear") {
    const d = new Date();
    if (which === "tomorrow") d.setDate(d.getDate() + 1);
    if (which === "nextweek") d.setDate(d.getDate() + 7);
    value = fmt(d);
  }
  input.value = value;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const pop = document.getElementById("pop-" + inputId);
  if (pop) pop.classList.remove("open");
}

document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest(".date-popover-wrap")) return;
  document.querySelectorAll(".date-popover.open").forEach(p => p.classList.remove("open"));
});

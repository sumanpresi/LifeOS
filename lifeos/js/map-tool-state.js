/* Single source of truth for which drawing tool is active on a given map.
   Two independent drawing systems share the same map — the original
   freehand scribble tool (draw/erase, any input) and the newer pen-only
   annotation tool (pen/erase, stylus-only) — and neither knew about the
   other, so both could show "active" at once even though only one can
   actually be drawing. This coordinator is what makes them mutually
   exclusive, replacing each tool's separate internal on/off boolean with
   one shared currentTool value per map. */
export function createToolCoordinator() {
  let currentTool = "none"; // "none" | any registered tool name
  const tools = {}; // toolName -> deactivate()

  function register(toolName, deactivateFn) {
    tools[toolName] = deactivateFn;
  }

  /* The single entry point every tool button must go through — never
     toggle a class directly. Selecting the tool that's already active
     turns it off (preserves the existing "click again to stop drawing"
     behavior); selecting any other tool deactivates every other
     registered tool first, so exactly one (or none) is ever active. */
  function setActiveTool(toolName) {
    currentTool = (currentTool === toolName) ? "none" : toolName;
    console.log("Current tool:", currentTool === "none" ? "None" : currentTool.charAt(0).toUpperCase() + currentTool.slice(1));
    Object.keys(tools).forEach(name => {
      if (name !== currentTool) tools[name]();
    });
    return currentTool;
  }

  function getCurrentTool() { return currentTool; }

  return { register, setActiveTool, getCurrentTool };
}

/* Console tap. The app logs one `[diag]` line a second carrying its own
   counters and gauges; keeping them where the run can read them back is
   what lets a frame that came out wrong be explained rather than only
   re-run. Installed once — the prelude is re-evaluated before each step
   — and bounded, so a long walk can't grow it without limit. */
if (!window.__shotLog) {
  window.__shotLog = [];
  const passthrough = console.log.bind(console);
  console.log = (...a) => {
    try {
      window.__shotLog.push(
        a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "),
      );
      if (window.__shotLog.length > 4000) window.__shotLog.shift();
    } catch (e) {
      /* the tap must never be able to break the app it is watching */
    }
    passthrough(...a);
  };
}
window.__shot = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  settle: async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await window.__shot.sleep(400);
  },
  /* Click a toolbar button by its exact label. */
  toolbar: async (label) => {
    const b = [...document.querySelectorAll(".toolbar button")].find(
      (e) => e.textContent.trim() === label,
    );
    if (!b) throw new Error("no toolbar button " + JSON.stringify(label));
    b.click();
    await window.__shot.settle();
  },
  /* Open the command palette (the real Mod+Shift+P chord). The
     dispatcher matches modifiers exactly and rejects a Meta stroke off
     mac, so Control alone — this harness is Windows-only anyway. */
  openPalette: async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "P", ctrlKey: true, shiftKey: true, bubbles: true,
      }),
    );
    await window.__shot.settle();
    if (!document.querySelector(".palette-input")) throw new Error("palette did not open");
  },
  /* Run a palette command by its exact label. */
  command: async (label) => {
    await window.__shot.openPalette();
    const item = [...document.querySelectorAll(".palette-item")].find(
      (e) => e.textContent.trim().startsWith(label),
    );
    if (!item) throw new Error("no palette item " + JSON.stringify(label));
    item.click();
    await window.__shot.settle();
  },
  /* Poll `fn` until it returns something truthy, or give up saying what
     was being waited for. A step driving an import waits on the app's
     own progress, which is seconds of file walking and pumping — a
     fixed sleep would either be a guess or a tax on every run. */
  waitFor: async (what, fn, ms) => {
    const deadline = Date.now() + ms;
    for (;;) {
      let v = false;
      try { v = fn(); } catch (e) { v = false; }
      if (v) return v;
      if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
      await window.__shot.sleep(100);
    }
  },
  /* Open the toolbar's Recent menu and pick its one entry — the capture
     this run seeded into its own profile's recents. Driven
     structurally rather than by the path's text, because the path is a
     property of the machine the run is on. This is the dialog-free way
     into a capture: the file picker is a native dialog the page cannot
     reach, and `Recent` calls the same import with a path. */
  openSeededCapture: async () => {
    const trigger = document.querySelector(".recent-captures > button");
    if (!trigger) throw new Error("no Recent menu — this profile's recents were not seeded");
    trigger.click();
    await window.__shot.settle();
    const item = document.querySelector(".recent-captures-menu button");
    if (!item) throw new Error("the Recent menu is empty");
    item.click();
    await window.__shot.settle();
  },
  /* Move the pointer into a plot area and leave it there, so the
     shutter falls on a hovered panel. uPlot binds its cursor to
     `mousemove` on its own overlay (`.u-over`) and handles only events
     whose target *is* that element, so the event is dispatched on it
     rather than bubbled from the page; the panel folds every area's
     report into the one shared hover x. `which` picks the area by its
     `data-area-id` — the shared enum-lanes axis is the one whose id
     ends in `/u:enum`. */
  hoverPlot: async (which, fracX) => {
    const areas = [...document.querySelectorAll(".plot-area[data-area-id]")];
    const isLanes = (e) => (e.getAttribute("data-area-id") || "").endsWith("/u:enum");
    const area = areas.find((e) => (which === "lanes" ? isLanes(e) : !isLanes(e)));
    if (!area) throw new Error("no " + which + " plot area");
    const over = area.querySelector(".u-over");
    if (!over) throw new Error("the " + which + " plot area has no uPlot overlay");
    const r = over.getBoundingClientRect();
    const at = {
      clientX: r.left + r.width * fracX,
      clientY: r.top + r.height / 2,
      bubbles: true,
    };
    /* A real pointer is in one place: leaving the areas it is not in is
       part of moving into this one, and skipping it would leave the
       previous step's hover standing in the frame beside this one. */
    for (const other of document.querySelectorAll(".u-over")) {
      if (other !== over) other.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    }
    over.dispatchEvent(new MouseEvent("mouseenter", at));
    over.dispatchEvent(new MouseEvent("mousemove", at));
    await window.__shot.settle();
  },
  /* Click a modal's button by its exact label. */
  modal: async (label) => {
    const b = [...document.querySelectorAll(".modal-buttons button")].find(
      (e) => e.textContent.trim() === label,
    );
    if (!b) throw new Error("no modal button " + JSON.stringify(label));
    b.click();
    await window.__shot.settle();
  },
  /* What the app says about itself right now, in text a run can put in
     its notes: the status line (which carries the frame count, so an
     empty plot over a full buffer is distinguishable from an import
     that never landed) and the plot panel's own text, readouts
     included. */
  state: () => ({
    status: (document.querySelector(".status") || {}).textContent || "",
    plot: (document.querySelector(".plot-panel") || {}).innerText || "",
  }),
  /* True while no trace import is running. The toolbar's import chip
     is the app's own statement about it: it carries `aria-busy` from
     the first byte of the census to the pump's `log-finished` (its
     label stays "Import" throughout — the busy state is a chip
     attribute now, not a relabel). */
  importIdle: () => !document.querySelector('.toolbar button[aria-busy="true"]'),
};

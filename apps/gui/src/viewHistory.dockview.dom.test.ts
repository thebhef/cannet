// @vitest-environment jsdom
//
// Structural-key dedupe against REAL dockview serialization (not the
// hand-built fixtures in viewHistory.test.ts): focus changes,
// maximize, and window blur/focus must not alter the structural key,
// or they'd become phantom undo steps; add/close/move must alter it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DockviewComponent } from "dockview";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

import { recordLayout, initLayoutHistory, structuralKey, undoLayout } from "./viewHistory";

function createDock(): DockviewComponent {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: () => {
      const element = document.createElement("div");
      return { element, init: () => {} };
    },
  });
  dock.layout(800, 600);
  return dock;
}

const key = (dock: DockviewComponent) => structuralKey(JSON.stringify(dock.toJSON()));

describe("structural key over real dockview layouts", () => {
  it("is stable across panel focus changes and window blur/focus", () => {
    const dock = createDock();
    const a = dock.addPanel({ id: "a", component: "test" });
    const b = dock.addPanel({
      id: "b",
      component: "test",
      position: { direction: "right" },
    });
    dock.addPanel({ id: "c", component: "test", position: { referencePanel: "b" } });

    const k0 = key(dock);
    a.api.setActive();
    expect(key(dock)).toBe(k0);
    b.api.setActive();
    expect(key(dock)).toBe(k0);
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    expect(key(dock)).toBe(k0);
  });

  it("is stable across maximize and exit", () => {
    const dock = createDock();
    const a = dock.addPanel({ id: "a", component: "test" });
    dock.addPanel({ id: "b", component: "test", position: { direction: "right" } });
    const k0 = key(dock);
    // The component-level call takes the group (DockviewApi.maximizeGroup
    // unwraps `panel.group` the same way).
    dock.maximizeGroup(a.group);
    expect(key(dock)).toBe(k0);
    dock.exitMaximizedGroup();
    expect(key(dock)).toBe(k0);
  });

  it("changes when a panel is added, closed, or moved", () => {
    const dock = createDock();
    const a = dock.addPanel({ id: "a", component: "test" });
    const k0 = key(dock);
    const b = dock.addPanel({
      id: "b",
      component: "test",
      position: { direction: "right" },
    });
    const k1 = key(dock);
    expect(k1).not.toBe(k0);
    b.api.moveTo({ group: a.group });
    const k2 = key(dock);
    expect(k2).not.toBe(k1);
    b.api.close();
    expect(key(dock)).toBe(k0);
  });

  it("undo over real layout-change events restores the closed panel", async () => {
    // onDidLayoutChange is an AsapEvent — it fires on a microtask, not
    // synchronously with the mutation. Flush between steps like the
    // real event loop would.
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    const dock = createDock();
    dock.addPanel({ id: "a", component: "test" });
    const b = dock.addPanel({
      id: "b",
      component: "test",
      position: { direction: "right" },
    });
    await flush();

    // Mirror App.tsx's wiring: every layout-change event feeds
    // recordLayout; focus flips in between must not add steps.
    let history = initLayoutHistory(JSON.stringify(dock.toJSON()));
    dock.onDidLayoutChange(() => {
      history = recordLayout(history, JSON.stringify(dock.toJSON()));
    });

    b.api.setActive();
    await flush();
    b.api.close();
    await flush();
    dock.getGroupPanel("a")!.api.setActive();
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    await flush();

    const undone = undoLayout(history);
    expect(undone).not.toBeNull();
    dock.fromJSON(JSON.parse(undone!.layout));
    expect(dock.getGroupPanel("b")).toBeDefined();
    // Exactly one structural step was pending — the close. The next
    // undo has nothing left.
    expect(undoLayout(undone!.history)).toBeNull();
  });
});

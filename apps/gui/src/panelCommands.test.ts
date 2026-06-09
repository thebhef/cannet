import { describe, expect, it, vi } from "vitest";

import { createPanelCommandRegistry } from "./panelCommands";

describe("createPanelCommandRegistry", () => {
  it("invokes a registered handler for the element", () => {
    const reg = createPanelCommandRegistry();
    const fit = vi.fn();
    reg.register("el-1", () => ({ "plot.fitXAxis": fit }));
    expect(reg.invoke("el-1", "plot.fitXAxis")).toBe(true);
    expect(fit).toHaveBeenCalledOnce();
  });

  it("returns false for an unknown element or command", () => {
    const reg = createPanelCommandRegistry();
    reg.register("el-1", () => ({ "plot.fitXAxis": () => {} }));
    expect(reg.invoke("el-2", "plot.fitXAxis")).toBe(false);
    expect(reg.invoke("el-1", "plot.followLive.enable")).toBe(false);
  });

  it("unregister removes the panel's handlers", () => {
    const reg = createPanelCommandRegistry();
    const unregister = reg.register("el-1", () => ({ "plot.fitXAxis": () => {} }));
    unregister();
    expect(reg.invoke("el-1", "plot.fitXAxis")).toBe(false);
  });

  it("a stale unregister does not clobber a newer registration", () => {
    // Panel remount: the new instance registers before the old one's
    // cleanup runs (React strict/concurrent ordering) — the late
    // unregister must not remove the live handlers.
    const reg = createPanelCommandRegistry();
    const first = reg.register("el-1", () => ({}));
    const fit = vi.fn();
    reg.register("el-1", () => ({ "plot.fitXAxis": fit }));
    first();
    expect(reg.invoke("el-1", "plot.fitXAxis")).toBe(true);
  });
});

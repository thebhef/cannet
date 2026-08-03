import { beforeEach, describe, expect, it, vi } from "vitest";

// Stand-in for `settings.json` plus the host's ingress validation: a
// below-minimum cap is refused, and `set_settings` answers with what it
// actually stored.
const minCap = 64 * 1024 * 1024;
let stored: Record<string, unknown> = {};
let writes: Record<string, unknown>[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_settings":
        return { ...stored };
      case "set_settings": {
        const next = { ...(args?.settings as Record<string, unknown>) };
        writes.push({ ...next });
        const cap = next.scratch_cap_bytes;
        if (typeof cap === "number" && cap < minCap) next.scratch_cap_bytes = null;
        stored = next;
        return { ...stored };
      }
      default:
        return null;
    }
  }),
}));

import {
  defaultSettings,
  hostSettings,
  hydrateSettings,
  subscribeSettings,
  updateSettings,
} from "./hostSettings";

beforeEach(async () => {
  stored = { scratch_cap_bytes: null, clear_scratch_on_exit: false, keybindings: null };
  writes = [];
  await hydrateSettings();
});

describe("hostSettings", () => {
  it("reads synchronously after the boot hydrate", async () => {
    stored = { ...stored, clear_scratch_on_exit: true };
    await hydrateSettings();
    expect(hostSettings().clear_scratch_on_exit).toBe(true);
  });

  it("falls back to the documented defaults when the host is missing keys", async () => {
    stored = {};
    await hydrateSettings();
    expect(hostSettings()).toEqual(defaultSettings());
  });

  // The whole point of routing writes through here: the cache is a *read*
  // convenience, never the base of a write. A hand-edit (or another panel's
  // write) since the last hydrate must survive the next patch.
  it("merges a patch over a fresh read, not over the cache", async () => {
    const rebound = [{ chord: "Mod+k", commandId: "palette.show" }];
    stored = { ...stored, keybindings: rebound };

    await updateSettings({ clear_scratch_on_exit: true });

    expect(writes).toHaveLength(1);
    expect(writes[0].keybindings).toEqual(rebound);
    expect(hostSettings().keybindings).toEqual(rebound);
  });

  it("notifies subscribers with what the host accepted, not what was sent", async () => {
    const seen: unknown[] = [];
    const off = subscribeSettings((s) => seen.push(s.scratch_cap_bytes));

    await updateSettings({ scratch_cap_bytes: 128 * 1024 * 1024 });
    // Below the host's minimum: refused, so the cache and the subscribers
    // must see the refusal rather than the value that was sent.
    await updateSettings({ scratch_cap_bytes: 1024 });

    expect(seen).toEqual([128 * 1024 * 1024, null]);
    expect(hostSettings().scratch_cap_bytes).toBeNull();

    off();
    await updateSettings({ clear_scratch_on_exit: true });
    expect(seen).toHaveLength(2);
  });

  // A hand-edit while the app runs used to need a restart. A re-hydrate
  // now reaches every consumer.
  it("notifies subscribers on a re-hydrate", async () => {
    const seen: boolean[] = [];
    const off = subscribeSettings((s) => seen.push(s.clear_scratch_on_exit));
    stored = { ...stored, clear_scratch_on_exit: true };

    await hydrateSettings();

    expect(seen).toEqual([true]);
    off();
  });
});

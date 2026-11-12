// The frontend's one door to the host. Every `invoke` goes through
// `./ipc`, which — once the hang recorder arms it — keeps a map of the
// calls still waiting on the host, so a stall can name what was
// outstanding when it began. Disarmed (every test that never boots
// `main.tsx`) it is the core `invoke` and nothing else.

/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke as coreInvoke } from "@tauri-apps/api/core";

import { armInvokeTracking, invoke, pendingInvokes } from "./ipc";

afterEach(() => {
  armInvokeTracking(false);
  vi.mocked(coreInvoke).mockReset();
});

describe("ipc invoke", () => {
  it("passes the call through untouched while tracking is off", async () => {
    vi.mocked(coreInvoke).mockResolvedValue(7);
    await expect(invoke<number>("get_x", { a: 1 })).resolves.toBe(7);
    // Exactly the caller's arguments — no padded `undefined` — so the
    // suite's `toHaveBeenCalledWith` assertions see what they always did.
    expect(vi.mocked(coreInvoke).mock.calls[0]).toEqual(["get_x", { a: 1 }]);
    expect(pendingInvokes()).toEqual([]);
  });

  it("lists armed calls by command, count and oldest start until they settle", async () => {
    armInvokeTracking(true);
    let resolveA: (v: unknown) => void = () => {};
    let rejectB: (e: unknown) => void = () => {};
    vi.mocked(coreInvoke)
      .mockReturnValueOnce(new Promise((r) => (resolveA = r)))
      .mockReturnValueOnce(new Promise(() => {}))
      .mockReturnValueOnce(new Promise((_, j) => (rejectB = j)));
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const a = invoke("sample_signals");
    now.mockReturnValue(1_200);
    void invoke("sample_signals");
    now.mockReturnValue(1_500);
    const b = invoke("save_project");
    expect(pendingInvokes()).toEqual([
      { cmd: "sample_signals", n: 2, since: 1_000 },
      { cmd: "save_project", n: 1, since: 1_500 },
    ]);
    resolveA("ok");
    rejectB("no");
    await expect(a).resolves.toBe("ok");
    // The caller still sees the rejection; tracking never swallows it.
    await expect(b).rejects.toBe("no");
    expect(pendingInvokes()).toEqual([{ cmd: "sample_signals", n: 1, since: 1_200 }]);
    now.mockRestore();
  });
});

describe("the invoke choke point", () => {
  it("is the only module that imports invoke from @tauri-apps/api/core", () => {
    // A call that bypasses `./ipc` is invisible to the hang recorder, so
    // a new direct import would quietly blind it. Tests may mock core
    // directly; product sources may not import from it.
    const sources = import.meta.glob<string>(
      ["./*.ts", "./*.tsx", "!./*.test.ts", "!./*.test.tsx", "!./*TestKit*", "!./ipc.ts"],
      { query: "?raw", import: "default", eager: true },
    );
    const offenders = Object.entries(sources)
      .filter(([, text]) =>
        /import\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*"@tauri-apps\/api\/core"/.test(text),
      )
      .map(([path]) => path);
    // The glob must actually be reading the sources, or this passes on
    // nothing.
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});

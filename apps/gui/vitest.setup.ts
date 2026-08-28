// Arm the frontend diagnostic counters for the test suite.
//
// They ship **off** (`diag.ts`; the host arms them from `--diag`), but a
// large family of tests reads them back through `diagCounts()` to assert
// that a change re-renders one area and not the panel, that a scroll
// rebuilds no index, and so on. Left disarmed those assertions would all
// compare 0 against 0 and pass whatever the code did — so the suite runs
// with the machinery on, and `diag.gate.test.ts` disarms it explicitly to
// test the shipped default.
//
// The import is deferred into a hook rather than taken at the top of this
// file on purpose: a setup file is evaluated before the test file, so a
// static import here would pull `diag.ts` (and the real
// `@tauri-apps/api/core` it imports) into the registry ahead of the test
// file's `vi.mock` of that module, and every mocked `invoke` assertion
// would miss.
import { beforeAll } from "vitest";

// Node ≥22 defines its own experimental `localStorage` / `sessionStorage`
// on `globalThis` — getters that return `undefined` unless Node was
// started with `--localstorage-file`. When vitest populates the jsdom
// globals it skips any key the Node global already has, so jsdom's
// working storages never land and every test touching `localStorage`
// throws "Cannot read properties of undefined". jsdom's own storages
// are unreachable from here (the env aliases `window` to `globalThis`,
// whose getter is Node's), so substitute a minimal in-memory Storage.
// Fresh per test file (setup files run per worker file), and a no-op on
// Node versions without the shadowing getter.
class MemoryStorage implements Storage {
  #map = new Map<string, string>();
  get length(): number {
    return this.#map.size;
  }
  clear(): void {
    this.#map.clear();
  }
  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#map.set(String(key), String(value));
  }
  removeItem(key: string): void {
    this.#map.delete(key);
  }
}
for (const key of ["localStorage", "sessionStorage"] as const) {
  if (globalThis[key] === undefined) {
    Object.defineProperty(globalThis, key, {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    });
  }
}

beforeAll(async () => {
  const { setDiagEnabled } = await import("./src/diag");
  setDiagEnabled(true);
});

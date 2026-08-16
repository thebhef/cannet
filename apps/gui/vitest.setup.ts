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

beforeAll(async () => {
  const { setDiagEnabled } = await import("./src/diag");
  setDiagEnabled(true);
});

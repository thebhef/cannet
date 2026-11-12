// The hang recorder's Web Worker: binds `RecorderCore` to a file in
// origin-private storage and to this thread's own timer. All logic lives
// in `hangRecorder.ts`; this file is only what cannot run under test.
//
// The file is opened with a synchronous access handle, which only a
// worker may hold, so each record is written and flushed before the
// next message is taken — the most a kill can lose is the record being
// written.

import { type FromWorker, RecorderCore, TICK_MS, type ToWorker } from "./hangRecorder";

/// Origin-private file the records live in between handovers.
const STORE_FILE = "hang-recorder.log";

// The DOM lib this project compiles against types neither the worker
// global nor `createSyncAccessHandle`; these are the slices used.
type SyncHandleFile = { createSyncAccessHandle(): Promise<ConstructorParameters<typeof RecorderCore>[0]> };
const scope = self as unknown as {
  postMessage(m: FromWorker): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  close(): void;
};

async function open(): Promise<void> {
  let core: RecorderCore;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = (await root.getFileHandle(STORE_FILE, { create: true })) as unknown as SyncHandleFile;
    core = new RecorderCore(await handle.createSyncAccessHandle(), () => Date.now());
  } catch (e) {
    scope.postMessage({ t: "unavailable", reason: `origin-private storage: ${String(e)}` });
    scope.close();
    return;
  }
  scope.onmessage = ({ data }) => {
    const reply = core.handle(data);
    if (reply) scope.postMessage(reply);
  };
  setInterval(() => core.tick(), TICK_MS);
  scope.postMessage({ t: "ready" });
}

void open();

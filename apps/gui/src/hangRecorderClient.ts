// The main-thread half of the hang recorder (`hangRecorder.ts` has the
// why). Armed on every launch, so it is kept to a ping every
// `PING_MS`, a listener per suspect event, and one handover every
// `HANDOFF_MS`:
//
// - **Ping.** Carries how long the oldest unanswered heartbeat
//   (`report_js_heap`) has waited and every command outstanding past
//   `PENDING_REPORT_MS`, read from `ipc.ts`'s pending map — so no
//   per-invoke message crosses to the worker. A ping that stops coming
//   is the worker's evidence of a main-thread stall.
// - **Suspect events.** Each `resize`, `devicePixelRatio` change and
//   `visibilitychange` goes to the worker, which coalesces resize bursts.
// - **Handover.** At launch and every `HANDOFF_MS` while the host is
//   acknowledging, the worker's records go to the host
//   (`append_frontend_log` → `frontend.log`) and are removed from the
//   store only once the host has them.
//
// Without a Worker or origin-private storage the recorder is off, and
// the host log says so once.

import { ACK_LOST_MS, type FromWorker, PENDING_REPORT_MS, PING_MS, type ToWorker } from "./hangRecorder";
import { armInvokeTracking, invoke, pendingInvokes } from "./ipc";

/// How often a healthy session hands its records to the host.
export const HANDOFF_MS = 30_000;

/// The part of a `Worker` the client uses.
export interface WorkerPort {
  postMessage(m: ToWorker): void;
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

function makeWorker(): WorkerPort {
  return new Worker(new URL("./hangRecorder.worker.ts", import.meta.url), { type: "module" });
}

function reportOff(reason: string): void {
  void invoke("gui_emit_system_log", {
    level: "warn",
    source: "frontend",
    message: `hang recorder off: ${reason}`,
  }).catch(() => {});
}

/// What the host owes right now: the age of the oldest unanswered
/// heartbeat, and the commands outstanding long enough to name.
function owed(): { ackWaitMs: number; pending: ReturnType<typeof pendingInvokes> } {
  const now = Date.now();
  const groups = pendingInvokes();
  const beat = groups.find((g) => g.cmd === "report_js_heap");
  return {
    ackWaitMs: beat ? now - beat.since : 0,
    pending: groups.filter((g) => now - g.since >= PENDING_REPORT_MS),
  };
}

/// Start the recorder. Returns its stop function.
export function startHangRecorder(create: () => WorkerPort = makeWorker): () => void {
  let worker: WorkerPort;
  try {
    worker = create();
  } catch (e) {
    reportOff(String(e));
    return () => {};
  }
  const post = (m: ToWorker) => worker.postMessage(m);
  const teardown: (() => void)[] = [];
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const f of teardown) f();
    armInvokeTracking(false);
    worker.terminate();
  };

  let draining = false;
  const drain = () => {
    if (draining || owed().ackWaitMs >= ACK_LOST_MS) return;
    draining = true;
    post({ t: "drain" });
  };

  const listen = (target: EventTarget, type: string, f: () => void) => {
    target.addEventListener(type, f);
    teardown.push(() => target.removeEventListener(type, f));
  };

  // A `resolution` query matches only the ratio it was built for, so it
  // fires once on the change away and is rebuilt for the new ratio.
  let dprQuery: MediaQueryList | undefined;
  const watchDpr = () => {
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener("change", onDpr);
  };
  const onDpr = () => {
    dprQuery?.removeEventListener("change", onDpr);
    post({ t: "dpr", dpr: window.devicePixelRatio });
    watchDpr();
  };

  const arm = () => {
    armInvokeTracking(true);
    post({
      t: "hello",
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
      visibility: document.visibilityState,
    });
    const ping = window.setInterval(() => post({ t: "ping", ...owed() }), PING_MS);
    const handoff = window.setInterval(drain, HANDOFF_MS);
    teardown.push(() => {
      window.clearInterval(ping);
      window.clearInterval(handoff);
    });
    listen(window, "resize", () => post({ t: "resize", w: window.innerWidth, h: window.innerHeight }));
    listen(document, "visibilitychange", () => post({ t: "visibility", state: document.visibilityState }));
    watchDpr();
    teardown.push(() => dprQuery?.removeEventListener("change", onDpr));
    drain();
  };

  worker.onerror = () => {
    reportOff("the worker failed to load");
    stop();
  };
  worker.onmessage = ({ data: m }) => {
    switch (m.t) {
      case "ready":
        arm();
        return;
      case "unavailable":
        reportOff(m.reason);
        stop();
        return;
      case "drained":
        if (!m.text) {
          draining = false;
          return;
        }
        void invoke("append_frontend_log", { text: m.text })
          .then(
            () => post({ t: "commit", bytes: m.bytes, gen: m.gen }),
            () => {
              /* kept in the store; the next handover sends it again */
            },
          )
          .finally(() => {
            draining = false;
          });
        return;
    }
  };
  return stop;
}

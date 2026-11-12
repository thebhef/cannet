// Frontend failures the host log would otherwise never hear of.
//
// An uncaught exception or unhandled promise rejection in the webview
// lands in the devtools console and nowhere else, and a field machine
// never has the console open — so a frontend that throws itself into a
// broken state leaves `cannet.log` silent. These are forwarded to it at
// `warn` (source `frontend`) through the host's ordinary system-log
// command, along with the 1 Hz reporter's timer lag when it passes a
// threshold (`diag.ts`).
//
// Every forward is rate-limited per kind: the failure worth logging is
// often one a render loop repeats every frame, and a flood would both
// bury the rest of the log and cost the IPC thread the time it is meant
// to be measuring.

import { invoke } from "./ipc";

/// Forwards each kind may make per window before the rest are counted
/// and dropped.
export const FORWARD_MAX_PER_WINDOW = 5;
const FORWARD_WINDOW_MS = 60_000;
/// Longest message forwarded; a stack trace past this is cut.
const MAX_MESSAGE_CHARS = 2_000;

/// A fixed-window limiter: `max` admissions per `windowMs`, counting the
/// refusals. The first admission of a new window reports how many the
/// previous one refused, so a burst leaves a trace instead of a gap.
export function makeWindowLimiter(
  max: number,
  windowMs: number,
): (now: number) => { ok: boolean; suppressed: number } {
  let start = -Infinity;
  let used = 0;
  let refused = 0;
  return (now) => {
    let suppressed = 0;
    if (now - start >= windowMs) {
      start = now;
      used = 0;
      suppressed = refused;
      refused = 0;
    }
    if (used >= max) {
      refused += 1;
      return { ok: false, suppressed: 0 };
    }
    used += 1;
    return { ok: true, suppressed };
  };
}

const limiters = new Map<string, ReturnType<typeof makeWindowLimiter>>();

/// Forget every kind's budget (tests).
export function resetForwardLimits(): void {
  limiters.clear();
}

/// Write `message` to `cannet.log` at `warn`, subject to `kind`'s budget.
export function forwardWarn(kind: string, message: string): void {
  let admit = limiters.get(kind);
  if (!admit) {
    admit = makeWindowLimiter(FORWARD_MAX_PER_WINDOW, FORWARD_WINDOW_MS);
    limiters.set(kind, admit);
  }
  const { ok, suppressed } = admit(Date.now());
  if (!ok) return;
  let text = message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message;
  if (suppressed > 0) text += ` (${suppressed} similar suppressed)`;
  void invoke("gui_emit_system_log", { level: "warn", source: "frontend", message: text }).catch(
    () => {},
  );
}

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`;
  return String(reason);
}

/// Forward `target`'s uncaught errors and unhandled rejections to the
/// host log. Returns the uninstaller.
export function installFailureForwarding(target: Window): () => void {
  const onError = (e: ErrorEvent) => {
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : "";
    const stack = e.error instanceof Error && e.error.stack ? `\n${e.error.stack}` : "";
    forwardWarn("error", `uncaught error: ${e.message}${where}${stack}`);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    forwardWarn("rejection", `unhandled rejection: ${describeReason(e.reason)}`);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

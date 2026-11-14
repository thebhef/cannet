// The working project: the open project as the user has it right now,
// saved or not — what Save would write — pushed to the host with its
// dirty flag (`working_project.rs`), so the host holds it and a frontend
// reload need not revert to the file.
//
// One push site. The App reads the document through the same
// `gatherProject` Save uses and schedules a push whenever an input to it
// changes; this module debounces the burst, drops a push whose document
// and dirty flag are what it last sent, and sends the rest. In memory
// only on the host: nothing here writes a file (the working layout's own
// push, ADR 0032, is separate and unchanged).
//
// Never per frame and never on a timer: a push follows a project edit.
// The registry's trace-window mirror and a live count tick change no
// field of the document, so they schedule nothing (the App keys its
// trigger on the element objects, which the mirror leaves alone).

import { diagCount } from "./diag";
import { invoke } from "./ipc";
import type { Project } from "./types";

/// What is pushed: the save payload and whether it has unsaved changes.
export interface WorkingProjectPush {
  document: Project;
  dirty: boolean;
}

/// Quiet time after the last edit before the push goes. Long enough to
/// fold a drag or a typing burst into one push, short enough that a
/// reload a moment later finds it (and `pagehide` flushes anyway).
export const WORKING_PROJECT_PUSH_DELAY_MS = 300;

/// The host command behind the push.
export function setWorkingProject(push: WorkingProjectPush): Promise<void> {
  return invoke<void>("set_working_project", { document: push.document, dirty: push.dirty });
}

export interface WorkingProjectPusher {
  /// An input to the document may have changed: push it after the
  /// debounce, read at that moment.
  schedule(): void;
  /// Send a pending push now (a reload is about to tear the page down).
  flush(): void;
  /// Drop any pending push.
  dispose(): void;
}

/// A debounced, de-duplicating pusher. `read` answers the document to
/// push, or `null` while there is none to send (the boot has not applied
/// a project yet — pushing then would overwrite the host's copy with a
/// default one).
export function createWorkingProjectPusher(
  read: () => WorkingProjectPush | null,
  send: (push: WorkingProjectPush) => Promise<void> = setWorkingProject,
  delayMs: number = WORKING_PROJECT_PUSH_DELAY_MS,
): WorkingProjectPusher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSent: string | null = null;

  const fire = () => {
    timer = null;
    const push = read();
    if (push === null) return;
    const key = JSON.stringify(push);
    if (key === lastSent) return;
    lastSent = key;
    diagCount("workingProject.push"); // DIAG
    // A refused push leaves the host's copy behind; forget it so the
    // next schedule sends again.
    send(push).catch(() => {
      if (lastSent === key) lastSent = null;
    });
  };

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    schedule() {
      cancel();
      timer = setTimeout(fire, delayMs);
    },
    flush() {
      if (timer === null) return;
      cancel();
      fire();
    },
    dispose: cancel,
  };
}

/// Whether two element lists are the same element objects in the same
/// order. The registry rebuilds its entries when only a trace window
/// moves but keeps each element object, so this tells a document edit
/// from a mirror update without serializing anything.
export function sameElements(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((e, i) => e === b[i]);
}

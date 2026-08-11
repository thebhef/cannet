// @vitest-environment jsdom
//
// The subscription half of `useSidecarStatus`. `listen` is async, so
// there is a window between the mount snapshot and the listener being
// registered in which a published transition reaches nobody: the host
// emits into a webview that isn't subscribed yet, and the hook keeps
// reporting the pre-transition status for the rest of the session.
//
// That window is not theoretical. The sidecar publishes its `listening`
// banner ~1.3 s after launch — the same moment the webview is booting —
// and a `--connect-on-start` run that misses it sits at "sidecar not
// ready" until its readiness timeout fires, with the host having been
// listening the whole time.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import type { SidecarStatus } from "./types";

type Handler = (e: { payload: SidecarStatus }) => void;

const STARTING: SidecarStatus = { phase: "starting", address: null };
const READY: SidecarStatus = { phase: "ready", address: "127.0.0.1:60245" };

/// What the host would answer `get_sidecar_status` with right now.
let hostStatus: SidecarStatus = STARTING;
/// The handler the hook passed to `listen`, live only once the
/// registration promise has resolved — the async gap this file is about.
let liveHandler: Handler | null = null;
/// Completes the pending `listen` registration.
let registerListener: (() => void) | null = null;

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { useSidecarStatus } from "./sidecarStatus";

/// The host moving to a new status: the state the snapshot command
/// reads moves, and the event goes out to whoever is subscribed *at
/// that instant* — nobody, if the registration is still in flight.
function publish(status: SidecarStatus) {
  hostStatus = status;
  liveHandler?.({ payload: status });
}

beforeEach(() => {
  hostStatus = STARTING;
  liveHandler = null;
  registerListener = null;
  invokeMock.mockImplementation((async (cmd: string) => {
    if (cmd === "get_sidecar_status") return hostStatus;
    return undefined;
  }) as never);
  listenMock.mockImplementation(((_event: string, handler: Handler) => {
    return new Promise<() => void>((resolve) => {
      registerListener = () => {
        liveHandler = handler;
        resolve(() => {
          liveHandler = null;
        });
      };
    });
  }) as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useSidecarStatus", () => {
  it("picks up a transition published while the listener was still registering", async () => {
    const { result } = renderHook(() => useSidecarStatus());
    // The mount snapshot lands first — the sidecar is still starting.
    await waitFor(() => expect(result.current.phase).toBe("starting"));
    // The sidecar reports its bound address before the subscription is
    // live, so the event reaches nobody.
    act(() => publish(READY));
    expect(result.current.phase).toBe("starting");
    // Registration completes. Nothing more will ever be published — the
    // sidecar stays up — so the hook has to close the gap itself.
    await act(async () => {
      registerListener?.();
    });
    await waitFor(() => expect(result.current).toEqual(READY));
  });

  it("still follows transitions published after the listener is live", async () => {
    const { result } = renderHook(() => useSidecarStatus());
    await waitFor(() => expect(result.current.phase).toBe("starting"));
    await act(async () => {
      registerListener?.();
    });
    await act(async () => {
      publish(READY);
    });
    await waitFor(() => expect(result.current).toEqual(READY));
  });
});

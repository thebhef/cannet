// @vitest-environment jsdom
//
// Unit tests for the shared signal-catalog provider: fetches
// `list_signals` once, scoped to the project's bus list, and refetches
// on the triggers the four panels it replaces relied on independently
// — a bus-list change, the loaded DBC-path set changing, and the
// host's `dbc-changed` filesystem-watch event — plus `log-finished`,
// since an import can add file-backed signals to it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import type { SignalDescriptorRecord } from "./types";

let SIGNALS: SignalDescriptorRecord[] = [];
let REJECT_NEXT = false;
const calls: Array<{ cmd: string; args: unknown }> = [];
let dbcChangedHandler: (() => void) | null = null;
let logFinishedHandler: (() => void) | null = null;
let fileSignalsChangedHandler: (() => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    if (cmd === "list_signals") {
      if (REJECT_NEXT) {
        REJECT_NEXT = false;
        throw new Error("boom");
      }
      return SIGNALS;
    }
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    if (event === "dbc-changed") dbcChangedHandler = handler;
    if (event === "log-finished") logFinishedHandler = handler;
    if (event === "file-signals-changed") fileSignalsChangedHandler = handler;
    return () => {
      dbcChangedHandler = null;
      logFinishedHandler = null;
      fileSignalsChangedHandler = null;
    };
  }),
}));

import { SignalCatalogProvider, useSignalCatalog } from "./signalCatalogContext";
import { ProjectContext, type ProjectContextValue } from "./projectContext";

function baseProjectCtx(over: Partial<ProjectContextValue> = {}): ProjectContextValue {
  return {
    projectPath: null,
    dirty: false,
    dbcPaths: [],
    dbcBuses: {},
    buses: [],
    interfaceBindings: [],
    connectedAddresses: [],
    connectedBusIds: [],
    remoteConnected: false,
    blfPath: null,
    onNewProject: () => {},
    onOpenProject: () => {},
    onSaveProject: () => {},
    onSaveProjectAs: () => {},
    onAddDbc: () => {},
    onRemoveDbc: () => {},
    onReloadDbc: () => {},
    onSetDbcBuses: () => {},
    onAddBus: () => {},
    onRemoveBus: () => {},
    onUpdateBus: () => {},
    busesWithPendingHwConfig: [],
    onAddBinding: () => {},
    onRemoveBinding: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    localVirtualBuses: [],
    onAddVirtualBus: () => {},
    onRemoveVirtualBus: () => {},
    onUpdateVirtualBus: () => {},
    signalColors: {},
    onSetSignalColor: () => {},
    ...over,
  };
}

function Consumer() {
  const { catalog } = useSignalCatalog();
  return (
    <ul data-testid="catalog">
      {catalog.map((s) => (
        <li key={s.signal_name}>{s.signal_name}</li>
      ))}
    </ul>
  );
}

function renderProvider(projectCtx: ProjectContextValue) {
  return render(
    <ProjectContext.Provider value={projectCtx}>
      <SignalCatalogProvider>
        <Consumer />
      </SignalCatalogProvider>
    </ProjectContext.Provider>,
  );
}

beforeEach(() => {
  SIGNALS = [];
  REJECT_NEXT = false;
  calls.length = 0;
  dbcChangedHandler = null;
  logFinishedHandler = null;
  fileSignalsChangedHandler = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SignalCatalogProvider / useSignalCatalog", () => {
  it("fetches on mount, scoped to the project's bus ids", async () => {
    SIGNALS = [
      { bus_id: "b1", message_id: 1, extended: false, message_name: "M", transmitter: null, signal_name: "S1", unit: "" },
    ];
    renderProvider(baseProjectCtx({ buses: [{ id: "b1", name: "Bus 1" }] }));
    await waitFor(() => expect(screen.getByText("S1")).toBeInTheDocument());
    const call = calls.find((c) => c.cmd === "list_signals");
    expect((call?.args as { projectBuses: string[] }).projectBuses).toEqual(["b1"]);
  });

  it("refetches when the project's bus list changes", async () => {
    const { rerender } = renderProvider(baseProjectCtx({ buses: [] }));
    await waitFor(() => expect(calls.filter((c) => c.cmd === "list_signals")).toHaveLength(1));

    SIGNALS = [
      { bus_id: "b2", message_id: 1, extended: false, message_name: "M", transmitter: null, signal_name: "S2", unit: "" },
    ];
    rerender(
      <ProjectContext.Provider value={baseProjectCtx({ buses: [{ id: "b2", name: "Bus 2" }] })}>
        <SignalCatalogProvider>
          <Consumer />
        </SignalCatalogProvider>
      </ProjectContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText("S2")).toBeInTheDocument());
  });

  it("refetches when the loaded DBC-path set changes, even if buses stay the same", async () => {
    const buses = [{ id: "b1", name: "Bus 1" }];
    const { rerender } = renderProvider(baseProjectCtx({ buses, dbcPaths: ["/a.dbc"] }));
    await waitFor(() => expect(calls.filter((c) => c.cmd === "list_signals")).toHaveLength(1));

    SIGNALS = [
      { bus_id: "b1", message_id: 1, extended: false, message_name: "M", transmitter: null, signal_name: "S3", unit: "" },
    ];
    rerender(
      <ProjectContext.Provider value={baseProjectCtx({ buses, dbcPaths: ["/a.dbc", "/b.dbc"] })}>
        <SignalCatalogProvider>
          <Consumer />
        </SignalCatalogProvider>
      </ProjectContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText("S3")).toBeInTheDocument());
  });

  it("refetches on the host's dbc-changed event", async () => {
    renderProvider(baseProjectCtx({ buses: [{ id: "b1", name: "Bus 1" }] }));
    await waitFor(() => expect(calls.filter((c) => c.cmd === "list_signals")).toHaveLength(1));

    SIGNALS = [
      { bus_id: "b1", message_id: 1, extended: false, message_name: "M", transmitter: null, signal_name: "S4", unit: "" },
    ];
    await waitFor(() => expect(dbcChangedHandler).not.toBeNull());
    dbcChangedHandler!();
    await waitFor(() => expect(screen.getByText("S4")).toBeInTheDocument());
  });

  it("refetches when a capture import finishes", async () => {
    // The catalog is not purely a function of the DBC set: a capture
    // file can carry file-backed signals (docs/CONTEXT.md), which only
    // exist once the import that read them has run.
    renderProvider(baseProjectCtx({ buses: [] }));
    await waitFor(() => expect(calls.filter((c) => c.cmd === "list_signals")).toHaveLength(1));

    SIGNALS = [
      {
        bus_id: null,
        message_id: 1,
        extended: false,
        message_name: "Analog",
        transmitter: null,
        signal_name: "EngineSpeed",
        unit: "rpm",
        file_backed: true,
      },
    ];
    await waitFor(() => expect(logFinishedHandler).not.toBeNull());
    logFinishedHandler!();
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
  });

  it("refetches on file-signals-changed", async () => {
    // The file-backed half of the catalog is not driven by DBC/import
    // events alone: `clear_trace_store` and `restore_scratch_capture`
    // move the file-backed set too (a Clear, or restoring a scratch
    // capture) without a `dbc-changed` or `log-finished` firing, so this
    // provider would otherwise go stale until an unrelated refetch
    // trigger happened to fire.
    renderProvider(baseProjectCtx({ buses: [] }));
    await waitFor(() => expect(calls.filter((c) => c.cmd === "list_signals")).toHaveLength(1));

    SIGNALS = [
      {
        bus_id: null,
        message_id: 1,
        extended: false,
        message_name: "Analog",
        transmitter: null,
        signal_name: "TankLevel",
        unit: "L",
        file_backed: true,
      },
    ];
    await waitFor(() => expect(fileSignalsChangedHandler).not.toBeNull());
    fileSignalsChangedHandler!();
    await waitFor(() => expect(screen.getByText("TankLevel")).toBeInTheDocument());
  });

  it("falls back to an empty catalog on a failed fetch", async () => {
    REJECT_NEXT = true;
    renderProvider(baseProjectCtx());
    await waitFor(() => expect(screen.getByTestId("catalog").children.length).toBe(0));
  });
});

// @vitest-environment jsdom
//
// The by-id view's fold state: a message's decoded signals fold under
// its ID row, and which rows are open is persisted with the rest of the
// panel's view config (element `config` + dockview `params`) rather
// than dying with the panel. Stored sparsely, as the stable row ids
// (`byIdRowKey` — bus + arbitration id + std/ext) of the rows that are
// *expanded*, since a by-id row defaults to collapsed.
//
// The disclosure control itself is covered by `ByIdTable.dom.test.tsx`;
// this file is about the state travelling.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

let storedSettings: Record<string, unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "fetch_by_id_page") return { count: rows.length, start: 0, rows };
    if (cmd === "get_settings") return { ...storedSettings };
    return [];
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { TracePanel } from "./TracePanel";
import { TraceDataProvider, type TraceData } from "./traceData";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import { freshTrace } from "./trace";
import { byIdRowKey } from "./ByIdTable";
import { hydrateSettings } from "./hostSettings";
import { ROW_HEIGHT, SIGNAL_LINE_HEIGHT } from "./traceViewport";
import type { ByIdSnapshotRecord, ProjectElement, TraceFrameRecord } from "./types";

function makeFrame(id: number, name: string): TraceFrameRecord {
  return {
    index: 0,
    timestamp_seconds: 0,
    channel: 0,
    id,
    extended: false,
    direction: "Rx",
    kind: { kind: "classic" },
    data: [2],
    decoded: {
      name,
      signals: [
        { name: "Gear", value: 2, unit: "", label: "Drive" },
        { name: "Ratio", value: 1.5, unit: "", label: null },
      ],
    },
    bus_id: "b1",
  } as unknown as TraceFrameRecord;
}

const rows: ByIdSnapshotRecord[] = [
  { frame: makeFrame(0x100, "GearBox"), rate: 0, count: 1 },
  { frame: makeFrame(0x101, "PackState"), rate: 0, count: 1 },
];
const gearBoxKey = byIdRowKey(rows[0].frame);
const packStateKey = byIdRowKey(rows[1].frame);

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const traceData: TraceData = {
  count: 100,
  firstIndex: 0,
  truncationTsNs: null,
  sessionStartSeconds: 0,
  epoch: 0,
  fetchRange: async () => [],
  liveTail: { start: 0, rows: [] },
};

const projectCtx = {
  projectPath: null,
  dirty: false,
  dbcPaths: [],
  dbcBuses: {},
  buses: [],
  interfaceBindings: [],
  connectedAddresses: [],
  remoteConnected: false,
  blfPath: null,
} as unknown as ProjectContextValue;

function makeRegistry(elements: ProjectElement[]): ElementRegistry {
  const map = new Map<string, RegistryEntry>();
  for (const element of elements) {
    map.set(element.id, { element, trace: freshTrace(0) });
  }
  return {
    get entries() {
      return [...map.values()];
    },
    get: (id: string) => map.get(id),
    create: () => "",
    ensure: () => {},
    updateTrace: () => {},
    update: (id: string, patch: Partial<ProjectElement>) => {
      const e = map.get(id);
      if (e) map.set(id, { ...e, element: { ...e.element, ...patch } as ProjectElement });
    },
    remove: () => {},
  } as unknown as ElementRegistry;
}

/// Mount the panel in by-id mode with `params` as its reopen blob.
function renderPanel(params: Record<string, unknown>) {
  const api = { updateParameters: vi.fn() };
  const props = {
    params: { elementId: "t1", mode: "by-id", ...params },
    api,
  } as unknown as Parameters<typeof TracePanel>[0];
  const registry = makeRegistry([
    { kind: "trace", id: "t1", sources: ["*"] } as ProjectElement,
  ]);
  const { container, unmount } = render(
    <TraceDataProvider value={traceData}>
      <ProjectContext.Provider value={projectCtx}>
        <ElementRegistryContext.Provider value={registry}>
          <TracePanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>
    </TraceDataProvider>,
  );
  return { container, api, registry, unmount };
}

/// The panel's last dual-write into the dockview params.
function lastParams(api: { updateParameters: ReturnType<typeof vi.fn> }) {
  const calls = api.updateParameters.mock.calls;
  return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
}

/// The row whose message cell reads `name`. The row *is* the disclosure
/// control, so this is both the thing to click and the thing that
/// carries `aria-expanded`.
function rowFor(container: HTMLElement, name: string) {
  const rows = [...container.querySelectorAll<HTMLElement>(".trace-row")];
  return rows.find((r) => r.querySelector(".col-msg")?.textContent?.includes(name));
}

async function waitForRows(container: HTMLElement) {
  await waitFor(() => expect(rowFor(container, "GearBox")).toBeTruthy());
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  storedSettings = {};
  await hydrateSettings();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("by-id fold persistence", () => {
  it("writes the expanded row's stable id into the panel params", async () => {
    const { container, api } = renderPanel({});
    await waitForRows(container);
    expect(lastParams(api).expanded).toEqual([]);
    fireEvent.click(rowFor(container, "GearBox")!);
    await waitFor(() => expect(lastParams(api).expanded).toEqual([gearBoxKey]));
  });

  it("takes the id back out when the row folds again", async () => {
    const { container, api } = renderPanel({});
    await waitForRows(container);
    fireEvent.click(rowFor(container, "GearBox")!);
    await waitFor(() => expect(lastParams(api).expanded).toEqual([gearBoxKey]));
    fireEvent.click(rowFor(container, "GearBox")!);
    await waitFor(() => expect(lastParams(api).expanded).toEqual([]));
  });

  it("mirrors the set onto the element, so a reopen restores it", async () => {
    const { container, registry } = renderPanel({});
    await waitForRows(container);
    fireEvent.click(rowFor(container, "PackState")!);
    await waitFor(() => {
      const cfg = (registry.get("t1")!.element as { config?: { expanded?: unknown } }).config;
      expect(cfg?.expanded).toEqual([packStateKey]);
    });
  });

  it("opens the rows the params name", async () => {
    const { container } = renderPanel({ expanded: [packStateKey] });
    await waitForRows(container);
    expect(rowFor(container, "GearBox")).toHaveAttribute("aria-expanded", "false");
    expect(rowFor(container, "PackState")).toHaveAttribute("aria-expanded", "true");
    // The rows it discloses are rendered, not merely marked.
    expect(container.querySelectorAll(".trace-content-row").length).toBe(2);
  });

  it("survives an unmount / remount through the params it wrote", async () => {
    const first = renderPanel({});
    await waitForRows(first.container);
    fireEvent.click(rowFor(first.container, "GearBox")!);
    await waitFor(() => expect(lastParams(first.api).expanded).toEqual([gearBoxKey]));
    const written = lastParams(first.api);
    first.unmount();

    const second = renderPanel(written);
    await waitForRows(second.container);
    expect(rowFor(second.container, "GearBox")).toHaveAttribute("aria-expanded", "true");
  });

  it("tolerates junk in the persisted set", async () => {
    const { container } = renderPanel({ expanded: [7, null, packStateKey, { a: 1 }] });
    await waitForRows(container);
    expect(rowFor(container, "PackState")).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelectorAll(".trace-row.expanded").length).toBe(1);
  });

  it("keeps the restored fold inside the scroll range", async () => {
    // The anchor/viewport math already sizes an expanded row; a fold
    // restored at mount has to reach it, or the rows below the reopened
    // one are unreachable (the same defect in another guise).
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(2 * ROW_HEIGHT);
    const { container } = renderPanel({ expanded: [gearBoxKey] });
    await waitForRows(container);
    const spacer = container.querySelector(".trace-rows > div") as HTMLElement;
    await waitFor(() =>
      expect(spacer.style.height).toBe(`${2 * ROW_HEIGHT + 2 * SIGNAL_LINE_HEIGHT}px`),
    );
  });
});

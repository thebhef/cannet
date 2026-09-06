// @vitest-environment jsdom
//
// Wiring test for the project logger's panel: the controls edit back
// into the element (the panel starts nothing — the host reconciles from
// "enabled and connected"), the previews are the host's answers, and
// everything that cannot change part-way through a file is locked while
// the host says a file is open.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const statuses = vi.hoisted(() => ({
  value: [] as { id: string; writing: boolean; path: string | null; bytes: number; frameCount: number; error: string | null }[],
}));
const connection = vi.hoisted(() => ({ value: {} as Record<string, { kind: string }> }));
// Which OS the stand-in host is pretending to be: it renders a resolved
// template in that OS's separators and roots a relative folder at that
// OS's project directory, exactly as the real host does.
const host = vi.hoisted(() => ({ sep: "\\", root: "C:\\proj" }));

const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "get_logger_statuses") return statuses.value;
    if (cmd === "get_connection_states") return connection.value;
    if (cmd === "capture_extent") {
      return { firstNs: null, liveEdgeNs: null, sessionStartNs: 1_700_000_000_000_000_000, frameCount: 0 };
    }
    if (cmd === "preview_export_template") {
      const template = String(args?.template);
      if (template.includes("{nope}")) {
        return { resolved: null, error: '"{nope}" is not a token', startResolvedAsNow: false };
      }
      // Stand-in for the host: `{logger}` becomes the slugified name,
      // `{start}` a fixed stamp, separators come out in the host OS's
      // own, and a relative folder gets rooted.
      const resolved = template
        .replace("{logger}", String(args?.logger ?? "").toLowerCase().replace(/\s+/g, "-"))
        .replace("{start}", "20260906T101500-0600")
        .replace(/[/\\]/g, host.sep);
      const absolute = /^[A-Za-z]:/.test(resolved) || resolved.startsWith(host.sep);
      return {
        resolved: args?.isFolder === true && !absolute
          ? `${host.root}${host.sep}${resolved}`
          : resolved,
        error: null,
        startResolvedAsNow: false,
      };
    }
    return null;
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const openDialog = vi.hoisted(() => vi.fn(async () => "D:\\captures"));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));

import { LoggerPanel } from "./LoggerPanel";
import { DEFAULT_LOGGER_FILE, DEFAULT_LOGGER_FOLDER, DEFAULT_LOGGER_MAX_MB } from "./logger";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { ElementRegistryContext, type ElementRegistry, type RegistryEntry } from "./projectElements";
import { freshTrace } from "./trace";
import type { ProjectElement } from "./types";

const projectCtx = {
  projectPath: "C:\\proj\\bench.cannet_prj",
  buses: [{ id: "b1", name: "Chassis" }],
} as unknown as ProjectContextValue;

type LoggerElement = Extract<ProjectElement, { kind: "logger" }>;

function renderPanel(over: Partial<LoggerElement> = {}) {
  const element: ProjectElement = {
    kind: "logger",
    id: "lg1",
    name: "Bench log",
    enabled: false,
    folder: DEFAULT_LOGGER_FOLDER,
    file: DEFAULT_LOGGER_FILE,
    format: "blf",
    maxFileSizeMb: DEFAULT_LOGGER_MAX_MB,
    ...over,
  };
  const map = new Map<string, RegistryEntry>([["lg1", { element, trace: freshTrace(0) }]]);
  const update = vi.fn();
  const registry = {
    get entries() {
      return [...map.values()];
    },
    get: (id: string) => map.get(id),
    create: () => "",
    ensure: () => {},
    updateTrace: () => {},
    update,
    remove: () => {},
  } as unknown as ElementRegistry;

  const props = {
    params: { elementId: "lg1" },
    api: { updateParameters: vi.fn() },
  } as unknown as Parameters<typeof LoggerPanel>[0];
  render(
    <ProjectContext.Provider value={projectCtx}>
      <ElementRegistryContext.Provider value={registry}>
        <LoggerPanel {...props} />
      </ElementRegistryContext.Provider>
    </ProjectContext.Provider>,
  );
  return { update };
}

beforeEach(() => {
  vi.clearAllMocks();
  statuses.value = [];
  connection.value = {};
});
afterEach(cleanup);

describe("LoggerPanel", () => {
  it("lays the controls out folder → file → preview → max size", () => {
    renderPanel();
    const labels = [...document.querySelectorAll(".logger-row")].map((row) =>
      (row.firstElementChild?.textContent ?? "").trim(),
    );
    expect(labels).toEqual(["Folder", "File", "Preview", "Max size"]);
  });

  it("puts token help on both templated fields, logger token included", () => {
    renderPanel();
    const helps = [...document.querySelectorAll(".template-token-help")];
    expect(helps).toHaveLength(2);
    for (const help of helps) expect(help.getAttribute("title")).toContain("{logger}");
  });

  it("starts a fresh logger at the documented defaults", () => {
    renderPanel();
    expect((screen.getByLabelText("Folder") as HTMLInputElement).value).toBe("logs/{logger}");
    expect((screen.getByLabelText("File") as HTMLInputElement).value).toBe("{start}");
    expect((screen.getByLabelText("Max size") as HTMLInputElement).value).toBe("500");
    expect((screen.getByLabelText("Enabled") as HTMLInputElement).checked).toBe(false);
  });

  it("shows the host's resolved folder under the field", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("logger-folder-resolved")).toHaveTextContent(
        "→ C:\\proj\\logs\\bench-log",
      ),
    );
  });

  it("shows the paths in the host OS's separators, not Windows' always", async () => {
    // The panel renders what the host resolved and picks no separator of
    // its own — on a mac that is `/`, and a `\` anywhere in these two
    // lines is the bug this pins.
    host.sep = "/";
    host.root = "/Users/dev/proj";
    try {
      renderPanel({ file: "{start}/{logger}" });
      await waitFor(() =>
        expect(screen.getByTestId("logger-folder-resolved")).toHaveTextContent(
          "→ /Users/dev/proj/logs/bench-log",
        ),
      );
      expect(screen.getByTestId("logger-preview")).toHaveTextContent(
        "20260906T101500-0600/bench-log.blf",
      );
      for (const id of ["logger-folder-resolved", "logger-preview"]) {
        expect(screen.getByTestId(id).textContent).not.toContain("\\");
      }
    } finally {
      host.sep = "\\";
      host.root = "C:\\proj";
    }
  });

  it("previews the file as a label, with the format's extension", async () => {
    renderPanel();
    const preview = screen.getByTestId("logger-preview");
    await waitFor(() => expect(preview).toHaveTextContent("20260906T101500-0600.blf"));
    // A label, not an editable field — ruling 10.
    expect(preview.tagName).toBe("SPAN");
    expect(preview.querySelector("input")).toBeNull();
  });

  it("surfaces the host's template error rather than resolving anything itself", async () => {
    renderPanel({ file: "{nope}" });
    await waitFor(() =>
      expect(screen.getByTestId("logger-message")).toHaveTextContent(
        'is not a token',
      ),
    );
    expect(screen.getByTestId("logger-preview")).toHaveTextContent("—");
  });

  it("edits the folder, file and size cap back into the element", () => {
    const { update } = renderPanel();
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "D:\\logs" } });
    expect(update).toHaveBeenCalledWith("lg1", { kind: "logger", folder: "D:\\logs" });
    fireEvent.change(screen.getByLabelText("File"), { target: { value: "{start}\\{now}" } });
    expect(update).toHaveBeenCalledWith("lg1", { kind: "logger", file: "{start}\\{now}" });
    fireEvent.change(screen.getByLabelText("Max size"), { target: { value: "64" } });
    expect(update).toHaveBeenCalledWith("lg1", { kind: "logger", maxFileSizeMb: 64 });
  });

  it("writes the enabled flag onto the element and issues no start command", () => {
    const { update } = renderPanel();
    fireEvent.click(screen.getByLabelText("Enabled"));
    expect(update).toHaveBeenCalledWith("lg1", { kind: "logger", enabled: true });
    // The panel never starts logging: the host reconciles from the
    // element plus the connection state.
    const commands = invoke.mock.calls.map((c) => c[0]);
    expect(commands).not.toContain("set_loggers");
    expect(commands.some((c) => String(c).includes("start"))).toBe(false);
  });

  it("says an enabled logger is waiting when nothing is connected", async () => {
    renderPanel({ enabled: true });
    await waitFor(() =>
      expect(screen.getByTestId("logger-message")).toHaveTextContent(
        "waiting for connection",
      ),
    );
  });

  it("says nothing about waiting once a bus is connected", async () => {
    connection.value = { b1: { kind: "connected" } };
    renderPanel({ enabled: true });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_connection_states"));
    await waitFor(() => expect(screen.queryByTestId("logger-message")).toBeNull());
  });

  it("locks the folder and size cap while the host says it is writing", async () => {
    statuses.value = [
      { id: "lg1", writing: true, path: "C:\\proj\\logs\\bench-log\\run.blf", bytes: 12, frameCount: 3, error: null },
    ];
    renderPanel({ enabled: true });
    await waitFor(() => expect(screen.getByLabelText("Folder")).toBeDisabled());
    expect(screen.getByLabelText("Max size")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Browse…" })).toBeDisabled();
    // The File template stays editable: it only takes effect at the
    // next start, so nothing about the open file changes under it.
    expect(screen.getByLabelText("File")).not.toBeDisabled();
    // And so does the switch — it is how logging is stopped.
    expect(screen.getByLabelText("Enabled")).not.toBeDisabled();
  });

  it("shows no format control while BLF is the only thing a logger writes", () => {
    // A one-choice control is a control that asks a question with one
    // answer. It comes back when there is a second format to log in.
    const { update } = renderPanel();
    expect(screen.queryByLabelText("Format")).toBeNull();
    expect(document.body.textContent).not.toContain("Vector BLF");
    expect(document.body.textContent).not.toContain("ASAM MDF");
    // The element still carries its format; the panel just never
    // touches it.
    expect(update).not.toHaveBeenCalled();
  });

  it("has no logging status line of its own", async () => {
    statuses.value = [
      { id: "lg1", writing: true, path: "C:\\proj\\logs\\bench-log\\run.blf", bytes: 5_000_000, frameCount: 900, error: null },
    ];
    renderPanel({ enabled: true });
    await waitFor(() => expect(screen.getByLabelText("Folder")).toBeDisabled());
    // Ruling: the writing file's own row is the status; the panel does
    // not restate the path or the size.
    expect(document.body.textContent).not.toContain("run.blf");
    expect(document.body.textContent).not.toContain("MB written");
  });

  it("shows a start failure the host reported", async () => {
    statuses.value = [
      {
        id: "lg1",
        writing: false,
        path: null,
        bytes: 0,
        frameCount: 0,
        error: "a relative folder needs the project open in project-directory mode",
      },
    ];
    renderPanel({ enabled: true });
    await waitFor(() =>
      expect(screen.getByTestId("logger-message")).toHaveTextContent(
        "project-directory mode",
      ),
    );
  });

  it("Browse… puts the chosen directory in the folder field", async () => {
    const { update } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("lg1", { kind: "logger", folder: "D:\\captures" }),
    );
  });
});

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { DockviewDefaultTab, DockviewReact, themeAbyss, themeLight } from "dockview";
import type { DockviewApi, DockviewReadyEvent } from "dockview";

import type {
  BlfScanResult,
  Bus,
  DbcInfo,
  DbcRef,
  InterfaceBinding,
  InterfaceRecord,
  LocalVirtualBusDef,
  LogFinished,
  OpenLogResult,
  Project,
  ProjectElement,
  ProjectElementKind,
  RbsDirtyRecord,
  RemoteSessionResult,
  TraceFrameRecord,
  TraceGrew,
} from "./types";
import {
  PROJECT_SCHEMA_VERSION,
  bindingKind,
  isLocalBinding,
  localVbusId,
  resolveServer,
} from "./types";
import { resolveBindingInterface } from "./bindingResolution";
import { useSidecarStatus } from "./sidecarStatus";
import {
  projectDir,
  relativizeProjectPath,
  resolveProjectPath,
} from "./projectPaths";
import { captureLabel, windowTitle } from "./windowTitle";
import { TracePanel } from "./TracePanel";
import { ProjectPanel } from "./ProjectPanel";
import { ProjectGraphPanel } from "./ProjectGraphPanel";
import { PlotPanel } from "./PlotPanel";
import { SignalsPanel } from "./SignalsPanel";
import { TransmitPanel } from "./TransmitPanel";
import { RbsPanel } from "./RbsPanel";
import { ColorMapPanel } from "./ColorMapPanel";
import { GeneratorPanel } from "./GeneratorPanel";
import { SystemMessagesPanel } from "./SystemMessagesPanel";
import { DbcPanel } from "./DbcPanel";
import { SettingsPanel } from "./SettingsPanel";
import { AboutPanel } from "./AboutPanel";
import { EventsPanel } from "./EventsPanel";
import { SystemLogContext, type SystemLogContextValue } from "./systemLogContext";
import {
  EMPTY_SYSTEM_LOG_MIRROR,
  type SystemLogMirror,
  clearSystemLogMirror,
  markSystemLogRead,
  mergeSystemMessage,
  reconcileSnapshot,
} from "./systemLog";
import { splitStatus, type LogState, type RemoteStatus, type TransientStatus } from "./statusLine";
import { useTransientStatus } from "./useTransientStatus";
import { hostSettings, useSetting } from "./hostSettings";
import { NotesContext, type NotesContextValue } from "./notesContext";
import type { Note } from "./notes";
import { sortNotesChronologically } from "./notes";
import { ShortcutsPanel } from "./ShortcutsPanel";
import { KeybindingsContext } from "./keybindingsContext";
import { recordRecentBlf, forgetRecentBlf } from "./recentBlfs";
import {
  hostState,
  hydrateState,
  setRecentBlfs as persistRecentBlfs,
  setLastProject as persistLastProject,
  setLayout as persistLayout,
  setBlfChannelMaps as persistBlfChannelMaps,
} from "./hostState";
import { recordBlfChannelMap, savedBlfChannelMap } from "./blfChannelMap";
import type { SystemMessage } from "./types";
import { TraceDataProvider, type TraceData } from "./traceData";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { SignalCatalogProvider } from "./signalCatalogContext";
import { SignalGeneratorProvider } from "./signalGeneratorContext";
import { CloseConfirmModal, type CloseChoice } from "./CloseConfirmModal";
import { ClearColorsConfirmModal } from "./ClearColorsConfirmModal";
import { useThemeName } from "./theme";
import { SplashOverlay, useSplashVisible } from "./SplashOverlay";
import { BlfChannelMapModal, type ImportRange } from "./BlfChannelMapModal";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
  applyElementPatch,
  isProjectElement,
  normalizeElement,
} from "./projectElements";
import {
  type TraceState,
  clearedTrace,
  freshTrace,
  reanchorToSession,
  restoredTrace,
} from "./trace";
import { useSessionReset } from "./useSessionReset";
import { assignDefaultNames, defaultElementName, elementLabel } from "./elementLabel";
import {
  BY_ID_PANEL_COMPONENT,
  DBC_PANEL_COMPONENT,
  PLOT_PANEL_COMPONENT,
  PROJECT_GRAPH_PANEL_COMPONENT,
  PROJECT_PANEL_COMPONENT,
  PROJECT_PANEL_ID,
  COLORMAP_PANEL_COMPONENT,
  GENERATOR_PANEL_COMPONENT,
  RBS_PANEL_COMPONENT,
  SETTINGS_PANEL_COMPONENT,
  ABOUT_PANEL_COMPONENT,
  EVENTS_PANEL_COMPONENT,
  SHORTCUTS_PANEL_COMPONENT,
  SIGNALS_PANEL_COMPONENT,
  SYSTEM_MESSAGES_PANEL_COMPONENT,
  TRACE_PANEL_COMPONENT,
  TRANSMIT_PANEL_COMPONENT,
  elementPanelComponent,
  stripMaximizedNode,
  validateLayout,
} from "./dockLayout";
import {
  EMPTY_FOCUS_HISTORY,
  initLayoutHistory,
  recordFocus,
  recordLayout,
  type FocusHistory,
  type LayoutHistory,
} from "./viewHistory";
import { PanelCommandsContext } from "./panelCommands";
import { useCommands } from "./useCommands";
import {
  beginDiagCapture,
  diagCount,
  diagGauge,
  endDiagCapture,
  startDiagReporter,
} from "./diag"; // DIAG
import {
  INTERACT_WARMUP_MS,
  parseInteractScript,
  startPerfInteraction,
} from "./perfInteract";

// BLF + global error state. Remote sessions are tracked separately
// (multi-server: one entry per address in `remoteSessions`).

// Self-driving perf automation config, served by the host's
// `diag_autostart` command from the launch flags (ADR 0031). `null` for
// a normal launch. Field names mirror the host's camelCase serialization.
// Every field is optional in effect: `--project` alone just opens the
// project; adding `connectOnStart` connects; adding `captureSecs` records
// for that span, writes `out`, and exits.
type AutomationConfig = {
  project: string | null;
  connectOnStart: boolean;
  captureSecs: number | null;
  out: string | null;
  label: string | null;
  interact: string | null;
};

// How long to let the connected session settle before bracketing a
// capture — connect clears the buffer and the rest-of-bus simulation
// spins up, so the first second or two isn't representative.
const AUTOMATION_SETTLE_MS = 2000;
// Cap on waiting for connect preconditions (bindings loaded; sidecar
// ready for a local binding) before giving up on the auto-connect.
const AUTOMATION_READY_TIMEOUT_MS = 30000;
// Perf-capture-only retry budget for `--connect-on-start` (ADR 0031): a
// capture that never connects must not run over dead air and write an
// fps-0 report indistinguishable from real idle data (observed
// 2026-08-08 — a fresh-build sidecar startup delay silently skipped
// connect and the capture ran anyway). These bounds only delay *when*
// the capture window starts, never its length — `AUTOMATION_CONNECT_RETRY_ATTEMPTS`
// attempts, each given `AUTOMATION_CONNECT_CONFIRM_MS` to land a running
// session before it's retried after `AUTOMATION_CONNECT_RETRY_DELAY_MS`.
const AUTOMATION_CONNECT_RETRY_ATTEMPTS = 3;
const AUTOMATION_CONNECT_CONFIRM_MS = 3000;
const AUTOMATION_CONNECT_RETRY_DELAY_MS = 1000;

/// Dockview panel-component registry, defined at module scope so
/// dockview never sees a fresh object and re-registers. The
/// chronological and per-id views are one component now (`TracePanel`,
/// mode is the trace element's `view`); the old `"by-id"` name maps to
/// it too so layouts saved before the merge still restore.
const DOCK_COMPONENTS = {
  [TRACE_PANEL_COMPONENT]: TracePanel,
  [BY_ID_PANEL_COMPONENT]: TracePanel,
  [PROJECT_PANEL_COMPONENT]: ProjectPanel,
  [PLOT_PANEL_COMPONENT]: PlotPanel,
  [SIGNALS_PANEL_COMPONENT]: SignalsPanel,
  [TRANSMIT_PANEL_COMPONENT]: TransmitPanel,
  [RBS_PANEL_COMPONENT]: RbsPanel,
  [COLORMAP_PANEL_COMPONENT]: ColorMapPanel,
  [GENERATOR_PANEL_COMPONENT]: GeneratorPanel,
  [PROJECT_GRAPH_PANEL_COMPONENT]: ProjectGraphPanel,
  [SYSTEM_MESSAGES_PANEL_COMPONENT]: SystemMessagesPanel,
  [DBC_PANEL_COMPONENT]: DbcPanel,
  [SETTINGS_PANEL_COMPONENT]: SettingsPanel,
  [ABOUT_PANEL_COMPONENT]: AboutPanel,
  [EVENTS_PANEL_COMPONENT]: EventsPanel,
  [SHORTCUTS_PANEL_COMPONENT]: ShortcutsPanel,
};

/// Rewrite a project's file references into the form it should be
/// *stored* in (ADR 0030): a DBC or `.cannet_rbs` inside the project
/// directory is recorded relative to the project file, so the directory
/// can be copied to another path or another machine and still resolve
/// its own files. Anything outside it stays absolute.
///
/// The exact inverse of what `applyProject` resolves on open, and applied
/// at the same layer — the host commands keep taking ready-to-open paths.
function withStoredPaths(project: Project, projectFilePath: string): Project {
  const dir = projectDir(projectFilePath);
  return {
    ...project,
    dbcs: project.dbcs.map((d) => ({
      ...d,
      path: relativizeProjectPath(dir, d.path),
    })),
    elements: project.elements.map((el) =>
      isProjectElement(el) && el.kind === "rbs" && el.path
        ? { ...el, path: relativizeProjectPath(dir, el.path) }
        : el,
    ),
  };
}

export function App() {
  diagCount("render.App"); // DIAG
  // Dockview paints its own chrome from its own theme object rather
  // than from our token layer, so the tab strip and group borders are
  // the one piece of the window a `data-theme` flip cannot reach. Swap
  // the object instead.
  // Dockview ships two of them, so every light-background theme takes
  // the light one.
  const dockTheme = useThemeName() === "dark" ? themeAbyss : themeLight;
  useEffect(() => startDiagReporter(), []); // DIAG
  const [count, setCount] = useState(0);
  // Windowed-ring low-water mark from `trace-grew` (ADR 0002 DS-8): the
  // chronological window clamps its start up to this so truncated rows below
  // the floor aren't rendered as blank placeholders. `0` until eviction.
  const [firstIndex, setFirstIndex] = useState(0);
  // Absolute ns of the oldest retained frame from `trace-grew` — where the
  // derived truncation marker sits (ADR 0035). `null` until a tick carries it.
  const [firstIndexTsNs, setFirstIndexTsNs] = useState<number | null>(null);
  const [framesPerSecond, setFramesPerSecond] = useState(0);
  const [bufferSeconds, setBufferSeconds] = useState(0);
  // On-disk scratch footprint from the latest `trace-grew`; `null` when the
  // store is in-RAM, which hides the cache-size readout.
  const [scratchBytes, setScratchBytes] = useState<number | null>(null);
  // Whole-app resident memory from the latest `trace-grew` (re-sampled on
  // the host's slow health cadence, so it lags a sudden allocation); the
  // in-memory counterpart to the on-disk cache size.
  const [memBytes, setMemBytes] = useState<number | null>(null);
  // Live sidecar status — needed to resolve the `"local"` sentinel on
  // interface bindings to the sidecar's current bound address before
  // we invoke connect_remote_server (the Rust command takes a
  // concrete host:port, not the sentinel).
  const sidecar = useSidecarStatus();
  const sidecarAddress =
    sidecar.phase === "ready" ? sidecar.address : null;

  // Shared trace-model facts. Each trace panel builds its *own* window
  // over the host capture (`useTrace` → `useWindowedQuery`); the App
  // owns only what every window shares: a re-anchor `epoch` (bumped when
  // the model identity changes), and the live-edge tail carried by the
  // most recent `trace-grew` (a contiguous run ending at the live tip),
  // which the windows overlay so following live never flashes a
  // placeholder at the edge.
  const [traceEpoch, setTraceEpoch] = useState(0);
  const [liveTail, setLiveTail] = useState<{
    start: number;
    rows: TraceFrameRecord[];
  }>({ start: 0, rows: [] });

  const [state, setState] = useState<LogState>({ kind: "idle" });
  // Paths of the loaded DBCs, in priority order (mirrors the host's set
  // — it owns the parsed databases; this is just what the UI shows).
  const [dbcPaths, setDbcPaths] = useState<string[]>([]);
  // Per-DBC bus scoping (path → bus ids). Empty list = unscoped.
  // Mirrors the host's `LoadedDbc.buses`; the project file carries the
  // canonical `dbcs: DbcRef[]` shape.
  const [dbcBuses, setDbcBuses] = useState<Record<string, string[]>>({});
  // Logical buses + interface bindings. Project-owned state.
  const [buses, setBuses] = useState<Bus[]>([]);
  const [interfaceBindings, setInterfaceBindings] = useState<InterfaceBinding[]>([]);
  // Virtual buses owned by the project (ADR 0021).
  const [localVirtualBuses, setLocalVirtualBuses] = useState<LocalVirtualBusDef[]>(
    [],
  );
  // Per-signal color overrides for the signal views (descriptor key →
  // #rrggbb). Project-level so a signal keeps its color across views
  // and sessions; empty = every signal renders its stable wheel color.
  const [signalColors, setSignalColors] = useState<Record<string, string>>({});
  // Multi-server remote-session tracking, keyed by address. Connect/
  // Disconnect drives this; entries clear on a server-side hang up via
  // `log-finished` (which doesn't carry an address — we treat it as
  // "something ended" and re-derive from interaction).
  const [remoteSessions, setRemoteSessions] = useState<Map<string, RemoteStatus>>(
    () => new Map(),
  );
  // Snapshot of the per-bus hardware configuration the host was told
  // to apply on the most recent connect, keyed by bus id. Captured at
  // connect time and cleared on disconnect; the banner compares the
  // live `buses` state against this to flag pending hardware config
  // changes the user must reconnect to apply.
  const [busConfigInFlight, setBusConfigInFlight] = useState<
    Map<string, { speed_bps: number | null; fd: boolean | null; fd_data_speed_bps: number | null }>
  >(() => new Map());
  // Path of the open project file, or null for an unsaved project.
  const [projectPath, setProjectPath] = useState<string | null>(null);
  // Same value for the dockview callbacks, which are registered once in
  // `handleDockReady` and so can't close over the state.
  const projectPathRef = useRef<string | null>(null);
  projectPathRef.current = projectPath;
  // True when the project has changed since it was last saved/opened.
  const [dirty, setDirty] = useState(false);
  // The host build's version string, for the window title. Empty until
  // `app_version` answers.
  const [appVersion, setAppVersion] = useState("");
  // Set once the window-title effect has reported a failure, so a
  // permanently-denied `setTitle` logs once instead of per title change.
  const titleFailureReported = useRef(false);
  // Set while the "unsaved changes — Save / Discard / Cancel?" modal is
  // up (the window-close handler awaits the choice via `resolve`).
  const [pendingClose, setPendingClose] = useState<{
    resolve: (choice: CloseChoice) => void;
  } | null>(null);
  // The project's elements + their runtime state (the element registry,
  // handed down via ElementRegistryContext). Restored from
  // `project.elements`, seeded on first launch / New, serialized back
  // on Save. Starts empty; `seedDefaultLayout` (called below) fills it.
  const [registry, setRegistry] = useState<RegistryEntry[]>([]);

  // Host-side log bus mirror, bounded and carrying its own unread
  // tally. Bootstrapped by `fetch_system_log` and kept current by
  // `system-log-appended` events. Session-scoped, not persisted.
  const [systemLog, setSystemLog] = useState<SystemLogMirror>(EMPTY_SYSTEM_LOG_MIRROR);
  // Session-scoped notes mirror (host owns the canonical
  // list at `src-tauri/src/notes.rs`). Bootstrapped by
  // `fetch_notes` and kept current by `notes-changed` events.
  const [notes, setNotes] = useState<Note[]>([]);
  // Recent BLFs (the N most-recent opened BLF paths, persisted host-side
  // per ADR 0032). Offered in the Open BLF flow and the project panel's
  // BLF import affordance.
  const [recentBlfs, setRecentBlfs] = useState<string[]>(() => hostState().recent_blfs);
  const rememberRecentBlf = useCallback((path: string) => {
    setRecentBlfs((current) => {
      const next = recordRecentBlf(current, path);
      persistRecentBlfs(next);
      return next;
    });
  }, []);
  const dropRecentBlf = useCallback((path: string) => {
    setRecentBlfs((current) => {
      const next = forgetRecentBlf(current, path);
      persistRecentBlfs(next);
      return next;
    });
  }, []);
  // Session-start time (Unix epoch seconds) — every trace view renders
  // frame timestamps relative to this. Driven by the `trace-grew` event,
  // which is in turn driven by `start_session` on the host. Single zero
  // point per session; survives panel close/reopen because it's app
  // state, not panel state. `null` until the first event arrives.
  const [sessionStartSeconds, setSessionStartSeconds] = useState<number | null>(
    null,
  );

  // The dockview layout API, populated once `onReady` fires.
  const dockApiRef = useRef<DockviewApi | null>(null);
  // View navigation history + layout undo/redo (Task-35 commands;
  // pure state in `viewHistory.ts`). `applyingLayoutRef` marks a
  // programmatic `fromJSON` so the layout-change echo it fires isn't
  // recorded as an undo step. `layoutHistoryRef` stays `null` until
  // the initial restore/seed settles.
  const focusHistoryRef = useRef<FocusHistory>(EMPTY_FOCUS_HISTORY);
  const layoutHistoryRef = useRef<LayoutHistory | null>(null);
  const applyingLayoutRef = useRef(false);
  // A view is maximized full-screen (dockview maximized-group).
  // Transient — never persisted (see `stripMaximizedNode`); gates the
  // Escape binding in the command context.
  const [hasMaximizedView, setHasMaximizedView] = useState(false);
  // Current `dirty` / `handleSaveProject`, read by the (once-registered)
  // close-on-quit handler. Updated on every render below.
  const dirtyRef = useRef(false);
  const handleSaveProjectRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  // Current session frame count and session start, mirrored into refs
  // so `create` / `ensure` can tell whether a session buffer exists —
  // and hook a new view straight into it — without taking `count`
  // (changes every tick) or `sessionStartSeconds` as dependencies.
  const countRef = useRef(0);
  countRef.current = count;
  const sessionStartSecondsRef = useRef<number | null>(null);
  sessionStartSecondsRef.current = sessionStartSeconds;
  // Perf self-driving config (ADR 0031), fetched once from the host on
  // boot and handed to the orchestration effect below. `null` = normal
  // launch. The mirrored refs let that once-mounted effect read live
  // connect preconditions without re-subscribing on every change.
  const [automation, setAutomation] = useState<AutomationConfig | null>(null);
  // Process-lifetime latch: the automation run is a one-shot. Without
  // it, StrictMode's dev double-invoke of the onReady init calls
  // `setAutomation` twice with distinct object identities, the
  // `[automation]` effect fires twice, and two racing `handleConnect`s
  // leave the loser's "already connected" error as the visible status
  // (observed 2026-07-25: every self-driving run double-connected).
  const automationRanRef = useRef(false);
  // Same family: dockview re-initializes under StrictMode, so `onReady`
  // fires twice and the boot project-open would run twice — the second
  // `open_project` re-adds every DBC and the dbc-changed refresh storm
  // lands mid-boot (observed 2026-07-25: every self-driving run opened
  // the project twice, and the storm racing live streaming blanked the
  // app). Refs persist across StrictMode effect replays, so this
  // one-shots the boot open; `applyProject` reads `dockApiRef.current`,
  // so the surviving dockview instance still gets the layout.
  const bootOpenRanRef = useRef(false);
  // The boot open has run to a conclusion — project applied, nothing to
  // open, or an error. The prior capture's restore is *not* part of that
  // conclusion: it loads in the background (ADR 0002 DS-7). It only
  // gates the splash, which must come down on every one of those
  // outcomes.
  const [bootSettled, setBootSettled] = useState(false);
  const splashVisible = useSplashVisible(bootSettled);
  // The in-flight restore of the project's prior capture, if any
  // (ADR 0002 DS-7). `applyProject` starts it without waiting, so the
  // app is usable while a large capture reopens; `handleConnect` waits
  // on it, because `try_reload` replaces the raw store wholesale and
  // frames appended into the store it replaces would go with it.
  const restorePendingRef = useRef<Promise<void> | null>(null);
  const interfaceBindingsRef = useRef<InterfaceBinding[]>([]);
  const sidecarAddressRef = useRef<string | null>(null);
  const handleConnectRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // Mirrors `remoteConnected` (below) for the perf-capture connect-retry
  // loop, which needs to poll connectedness from inside a once-mounted
  // effect rather than re-subscribing to it.
  const remoteConnectedRef = useRef(false);

  // --- element registry ops ---
  // Latest bus list, mirrored into a ref so element creation can
  // pre-fill a transmit's `sinks` without taking `buses` as a
  // dependency of every `create` / `ensure` call site (those refs
  // change on every bus add/rename, which would invalidate panel
  // memoisation).
  const busesRef = useRef<readonly Bus[]>([]);
  busesRef.current = buses;

  // A freshly created element of a given kind:
  // - `trace` / `plot` / `filter` default `sources` to `["*"]` (the
  //   wildcard meaning "every bus in the project, including ones
  //   added later"). Future bus additions auto-flow in.
  // - `transmit` defaults `sinks` to an *explicit* snapshot of the
  //   current bus list — no wildcard. A future bus added to the
  //   project is a deliberate decision the user makes via the
  //   transmit panel; it does not silently start receiving the
  //   panel's frames.
  //
  // Every fresh element gets a model-owned display `name` (ADR 0019);
  // callers pass the `${Kind} ${n}` default computed against the
  // registry the element is joining.
  const buildFreshElement = (
    kind: ProjectElementKind,
    id: string,
    name: string,
  ): ProjectElement => {
    switch (kind) {
      case "transmit":
        return { kind, id, name, sinks: busesRef.current.map((b) => b.id), frameIds: [] };
      case "filter":
        return { kind, id, name, sources: ["*"] };
      case "rbs":
        // Path picked in the panel; Run is off by default (ADR 0028 —
        // a fresh reference never transmits unasked).
        return { kind, id, name, path: null, run: false };
      case "colormap":
        // A signal value→color map (ADR 0029): the target signal and
        // rules are filled in via its config panel; it starts inert.
        return { kind, id, name, busId: null, messageId: 0, extended: false, signalName: "", rules: [] };
      case "generator":
        // Signal-name generator rules (ADR 0026): written in its own
        // editor, so a fresh one claims no signal.
        return { kind, id, name, rules: [] };
      default:
        return { kind, id, name, sources: ["*"] };
    }
  };
  // The trace window a brand-new element starts with. When a session
  // buffer exists (live or already holding frames), the new view hooks
  // straight into it — anchored at 0, spanning the buffer, following
  // live — exactly the state `startAllElements` gives views present at
  // session start. With no session yet it's an empty stopped window;
  // the session-start event will start it along with everything else.
  const newElementTrace = (): TraceState =>
    sessionStartSecondsRef.current !== null || countRef.current > 0
      ? freshTrace(0)
      : clearedTrace(0);
  const create = useCallback((kind: ProjectElementKind): string => {
    diagCount("registry.create"); // DIAG
    const id = crypto.randomUUID();
    setRegistry((prev) => {
      const name = defaultElementName(kind, prev.map((e) => e.element));
      return [
        ...prev,
        { element: buildFreshElement(kind, id, name), trace: newElementTrace() },
      ];
    });
    return id;
  }, []);
  const ensure = useCallback((id: string, kind: ProjectElementKind) => {
    setRegistry((prev) => {
      const i = prev.findIndex((e) => e.element.id === id);
      const name = defaultElementName(kind, prev.map((e) => e.element));
      if (i < 0) {
        diagCount("registry.ensure.append"); // DIAG
        return [
          ...prev,
          { element: buildFreshElement(kind, id, name), trace: newElementTrace() },
        ];
      }
      if (prev[i].element.kind === kind) return prev;
      diagCount("registry.ensure.replace"); // DIAG
      const next = prev.slice();
      next[i] = { ...next[i], element: buildFreshElement(kind, id, name) };
      return next;
    });
  }, []);
  const updateTrace = useCallback((id: string, updater: (s: TraceState) => TraceState) => {
    setRegistry((prev) => {
      let changed = false;
      const next = prev.map((e) => {
        if (e.element.id !== id) return e;
        const t = updater(e.trace);
        if (t === e.trace) return e;
        changed = true;
        return { ...e, trace: t };
      });
      if (changed) diagCount("registry.updateTrace"); // DIAG
      return changed ? next : prev;
    });
  }, []);
  // Shallow patch of an element's persisted fields. Used by the
  // per-sink Sources picker (sets `sources`), the filter predicate
  // editor (sets `predicate`), the transmit panel's sinks picker
  // (sets `sinks`), the project panel's inline rename (sets `name`),
  // and the "Insert filter upstream" flow (sets multiple at once).
  // Guards are in the pure helper: kind / id mismatch and filter
  // cycles are silently refused. See `applyElementPatch`.
  //
  // Dirty-marking happens HERE, at the call site, against the last
  // rendered registry — never inside the updater. The updater must be
  // pure: React replays queued updaters (StrictMode, interrupted /
  // entangled renders), and a side effect there re-arms its own render
  // pass — under a high-rate capture this self-scheduled into a
  // permanent render loop that froze the GUI on the first rename
  // keystroke. The call-site check can mis-judge no-op-ness against a
  // one-render-stale base during a rapid edit burst; `dirty` is sticky
  // and the next real edit corrects it, while the state itself keeps
  // exact semantics through the pure updater.
  // `writer` (optional) tags a config write with the panel that made
  // it, so that panel skips the resync its own persist triggers; every
  // other caller leaves it unset and thereby says "this is an external
  // write" — the split the rehydrate path keys on.
  const updateElement = useCallback(
    (id: string, patch: Partial<ProjectElement>, writer?: string) => {
      diagCount("registry.update"); // DIAG
      if (applyElementPatch(registryRef.current, id, patch, writer) !== registryRef.current) {
        diagCount("app.setDirty.callsite"); // DIAG
        setDirty(true);
      }
      setRegistry((prev) => applyElementPatch(prev, id, patch, writer) as RegistryEntry[]);
    },
    [],
  );
  // The one rename path (ADR 0019), handed to the command subsystem so
  // `panel.rename` writes the same model-owned name the project panel's
  // and the tab's inline edits do.
  const renameElement = useCallback(
    (id: string, name: string) => updateElement(id, { name }),
    [updateElement],
  );
  const removeElement = useCallback(
    (id: string) => {
      // Removing a *transmit* element (the explicit "Remove element"
      // action — not closing its panel) deletes its TX messages from
      // the host pool too, which also stops any running periodic. A
      // message still grouped by another transmit element survives
      // (the pool is shared; only this group is going away).
      const removed = registry.find((e) => e.element.id === id);
      // Removing an RBS element tears its host rows down (stopping
      // any running schedule) — the .cannet_rbs file on disk stays.
      if (removed && removed.element.kind === "rbs") {
        void invoke("rbs_unload", { elementId: id }).catch(() => {});
      }
      if (removed && removed.element.kind === "transmit") {
        const stillReferenced = new Set<string>();
        for (const e of registry) {
          if (e.element.id !== id && e.element.kind === "transmit") {
            for (const fid of e.element.frameIds) stillReferenced.add(fid);
          }
        }
        for (const fid of removed.element.frameIds) {
          if (!stillReferenced.has(fid)) {
            void invoke("remove_transmit_frame", { id: fid }).catch(() => {});
          }
        }
      }
      setRegistry((prev) => prev.filter((e) => e.element.id !== id));
      const api = dockApiRef.current;
      const panel = api?.panels.find(
        (p) => (p.params as { elementId?: unknown } | undefined)?.elementId === id,
      );
      if (api && panel) api.removePanel(panel);
    },
    [registry],
  );
  // Latest registry, mirrored into a ref so the add-panel handlers
  // can compute the new element's default name (= the tab title)
  // without taking `registry` as a dependency.
  const registryRef = useRef<readonly RegistryEntry[]>([]);
  registryRef.current = registry;

  // --- command / hotkey framework (ADR 0018) ---
  // The active dockview panel, tracked via `onDidActivePanelChange`
  // (subscribed in `handleDockReady`). The command subsystem
  // (`useCommands`) reads it for the typed command context's
  // `focusedPanelKind` and to route panel-local commands (the plot
  // `f` / `l` hotkeys) to the focused panel's element.
  const [activePanel, setActivePanel] = useState<{
    id: string;
    elementId: string | null;
  } | null>(null);

  // Re-anchor every trace window: bump the epoch (each window folds it
  // into its descriptor and drops/re-fetches) and clear the live tail.
  const invalidateCache = useCallback(() => {
    setTraceEpoch((e) => e + 1);
    setLiveTail({ start: 0, rows: [] });
  }, []);

  // The unfiltered `RowPage` read: raw chronological rows for an
  // absolute index range. A trace window translates its local offset
  // into this range; the host owns the buffer (ADR 0025).
  const fetchRange = useCallback(
    (start: number, end: number): Promise<TraceFrameRecord[]> => {
      diagCount("invoke.fetch_trace_range"); // DIAG
      return invoke<TraceFrameRecord[]>("fetch_trace_range", { start, end });
    },
    [],
  );

  // (Re)starting the session buffer — opening a BLF, connecting to a
  // server, or Clear — also (re)starts every trace / plot element:
  // they all anchor at 0 and run, following the new capture from its
  // start.
  const startAllElements = useCallback(() => {
    setRegistry((prev) => prev.map((e) => ({ ...e, trace: freshTrace(0) })));
  }, []);

  // The shared session (re)start step (clear the host store + reset the
  // frontend's derived session state). Each call site below supplies its
  // own clear-error policy — they differ on purpose.
  const resetSession = useSessionReset({
    invalidateCache,
    setSessionStartSeconds,
    setCount,
    startAllElements,
  });

  // Bootstrap + live-update the system-log mirror. The
  // snapshot is the source of truth on mount; thereafter the host's
  // `system-log-appended` event delivers each new entry. The merge
  // helpers dedupe by `seq` so a snapshot/event race is harmless.
  useEffect(() => {
    let cancelled = false;
    void invoke<SystemMessage[]>("fetch_system_log").then((snap) => {
      if (cancelled) return;
      setSystemLog((current) => reconcileSnapshot(current, snap));
    });
    const unlisten = listen<SystemMessage>("system-log-appended", (event) => {
      diagCount("event.system-log-appended"); // DIAG
      setSystemLog((current) => mergeSystemMessage(current, event.payload));
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Bootstrap + live-update the notes mirror. The host's
  // `notes-changed` event payload is the full, chronologically
  // sorted list — there's no merge step to do.
  useEffect(() => {
    let cancelled = false;
    void invoke<Note[]>("fetch_notes").then((snap) => {
      if (cancelled) return;
      setNotes(sortNotesChronologically(snap));
    });
    const unlisten = listen<Note[]>("notes-changed", (event) => {
      setNotes(sortNotesChronologically(event.payload));
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [];

    unlistens.push(
      listen<TraceGrew>("trace-grew", (event) => {
        diagCount("event.trace-grew"); // DIAG
        const {
          count: newCount,
          first_index,
          first_index_ts_ns,
          frames_per_second,
          frames_per_second_rx,
          frames_per_second_tx,
          frames_per_second_by_bus,
          frames_dropped_before_session,
          session_start_seconds,
          buffer_seconds,
          scratch_bytes,
          mem_bytes,
          tail,
        } = event.payload;
        // DIAG: log buffer size + aggregate/rx/tx/per-bus FPS as gauges so
        // a capture shows throughput against buffer growth, split by
        // direction and per bus.
        diagGauge("count", newCount); // DIAG
        diagGauge("fps", frames_per_second); // DIAG
        diagGauge("fps.rx", frames_per_second_rx); // DIAG
        diagGauge("fps.tx", frames_per_second_tx); // DIAG
        for (const b of frames_per_second_by_bus) {
          diagGauge(`fps.${b.bus_id ?? "(unassigned)"}`, b.frames_per_second); // DIAG
        }
        // DIAG: session-start drop counter (stale pipeline frames after a
        // clear/reconnect race).
        diagGauge("drop.before_session", frames_dropped_before_session); // DIAG
        setCount((prev) => {
          if (newCount < prev) {
            invalidateCache();
          }
          return newCount;
        });
        setSessionStartSeconds(
          session_start_seconds > 0 ? session_start_seconds : null,
        );
        setFramesPerSecond(frames_per_second);
        setBufferSeconds(buffer_seconds);
        setScratchBytes(scratch_bytes);
        setMemBytes(mem_bytes);
        setFirstIndex(first_index);
        setFirstIndexTsNs(first_index_ts_ns);
        setLiveTail({
          start: tail.length > 0 ? tail[0].index : newCount,
          rows: tail,
        });
      }),
    );

    unlistens.push(
      listen<LogFinished>("log-finished", (event) => {
        if (event.payload.status === "ok") {
          const total = event.payload.total;
          setState((s) => {
            if (s.kind === "loading" || s.kind === "running") {
              return { kind: "done", result: s.result, total };
            }
            return s;
          });
          // A remote pump exited cleanly. The host removed its session
          // entry, but the event doesn't carry an address, so we can't
          // know which one — leave the map alone; the user can hit
          // Disconnect (clear-all) or look at the per-server status in
          // the project panel.
        } else {
          setState({ kind: "error", message: event.payload.message });
        }
      }),
    );

    return () => {
      unlistens.forEach((p) => p.then((fn) => fn()));
    };
  }, [invalidateCache]);

  // Re-anchor every trace window when the session buffer shrinks (a new
  // connection cleared it) — a no-op on every other tick.
  useEffect(() => {
    setRegistry((prev) => {
      let changed = false;
      const next = prev.map((e) => {
        const t = reanchorToSession(e.trace, count);
        if (t === e.trace) return e;
        changed = true;
        return { ...e, trace: t };
      });
      if (changed) diagCount("registry.reanchor"); // DIAG
      return changed ? next : prev;
    });
  }, [count]);

  // BLF import has a channel → bus mapping step. The
  // outer pending state holds the picked BLF path + its scan (channel
  // census, metadata, markers) while the modal is open; clicking
  // "Open" in the modal commits and the host pump starts.
  const [pendingBlf, setPendingBlf] = useState<{
    blfPath: string;
    scan: BlfScanResult;
  } | null>(null);

  const handleOpenLog = useCallback(
    async (presetPath?: string) => {
      const selected =
        typeof presetPath === "string" && presetPath.length > 0
          ? presetPath
          : await open({
              multiple: false,
              filters: [{ name: "Vector BLF", extensions: ["blf"] }],
            });
      if (typeof selected !== "string") return;

      try {
        const scan = await invoke<BlfScanResult>("scan_blf_channels", {
          blfPath: selected,
        });
        setPendingBlf({ blfPath: selected, scan });
      } catch (err) {
        setState({ kind: "error", message: String(err) });
        // If we tried to open a recent file and it failed (path
        // moved, file deleted), drop it from the recents list so
        // it doesn't keep being offered.
        if (presetPath) dropRecentBlf(presetPath);
      }
    },
    [dropRecentBlf],
  );

  // Confirm the BLF channel mapping and actually start the pump.
  // `choices[ch] === ""` means "skip this channel"; `range` is the
  // selected import window, resolved to absolute ns (or `null` on
  // either side for unbounded) by the modal.
  const handleBlfMapConfirm = useCallback(
    async (choices: Record<number, string>, range: ImportRange) => {
      if (!pendingBlf) return;
      const { blfPath, scan } = pendingBlf;
      setPendingBlf(null);
      // Remember the accepted mapping (exact path + channel-count
      // fallback) so the next open of this BLF — or a same-shaped one —
      // pre-fills the dialog with it.
      persistBlfChannelMaps(
        recordBlfChannelMap(hostState().blf_channel_maps, blfPath, choices),
      );
      // Abort the import if the host clear fails — and drop the recent
      // entry, since the open won't happen.
      if (
        !(await resetSession({
          onError: (err) => {
            setState({ kind: "error", message: String(err) });
            dropRecentBlf(blfPath);
          },
        }))
      ) {
        return;
      }
      try {
        const channelBusMapping = scan.channels.map((ch) => ({
          channel: ch,
          busId: choices[ch] ? choices[ch] : null,
        }));
        const result = await invoke<OpenLogResult>("open_log", {
          blfPath,
          channelBusMapping,
          startNs: range.startNs,
          endNs: range.endNs,
        });
        setState({ kind: "loading", result });
        // Record on a successful open. Failures don't
        // promote a path — `handleOpenLog` drops it on the
        // recents-launch path.
        rememberRecentBlf(blfPath);
      } catch (err) {
        setState({ kind: "error", message: String(err) });
        dropRecentBlf(blfPath);
      }
    },
    [pendingBlf, resetSession, rememberRecentBlf, dropRecentBlf],
  );

  // Add one or more DBCs to the loaded set (each goes through the host's
  // `add_dbc`, which appends — or reloads in place if the path is
  // already loaded — and hands back the authoritative list).
  const handleAddDbc = useCallback(async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "DBC", extensions: ["dbc"] }],
    });
    const paths = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
    if (paths.length === 0) return;

    let list = dbcPaths;
    const errors: string[] = [];
    for (const path of paths) {
      try {
        list = (await invoke<DbcInfo[]>("add_dbc", { path })).map((d) => d.dbc_path);
      } catch (err) {
        errors.push(`${path}: ${String(err)}`);
      }
    }
    setDbcPaths(list);
    setDirty(true);
    invalidateCache();
    if (errors.length > 0) setState({ kind: "error", message: `DBC: ${errors.join("; ")}` });
  }, [dbcPaths, invalidateCache]);

  const handleRemoveDbc = useCallback(
    (path: string) => {
      void invoke<DbcInfo[]>("remove_dbc", { path })
        .then((list) => {
          setDbcPaths(list.map((d) => d.dbc_path));
          setDirty(true);
          invalidateCache();
        })
        .catch((err) => setState({ kind: "error", message: String(err) }));
    },
    [invalidateCache],
  );

  // Replace the loaded-DBC set with exactly `paths` (clear, then re-add
  // each in order). Used by "open project", "new project" (empty list),
  // and "reload all from disk". Paths that fail to read / parse are
  // dropped and reported together. `scoping` (path → bus_id[])
  // is committed to the host after each add so per-bus DBC scoping
  // survives an open-project round-trip.
  const loadDbcSet = useCallback(
    async (paths: readonly string[], scoping: Record<string, string[]> = {}) => {
      try {
        await invoke("clear_dbcs");
      } catch {
        /* unreachable in practice; the next add_dbc would surface real trouble */
      }
      let list: string[] = [];
      const errors: string[] = [];
      for (const path of paths) {
        try {
          list = (await invoke<DbcInfo[]>("add_dbc", { path })).map((d) => d.dbc_path);
          const buses = scoping[path];
          if (buses && buses.length > 0) {
            await invoke<DbcInfo[]>("set_dbc_buses", { path, buses });
          }
        } catch (err) {
          errors.push(`${path}: ${String(err)}`);
        }
      }
      setDbcPaths(list);
      invalidateCache();
      if (errors.length > 0) setState({ kind: "error", message: `DBC: ${errors.join("; ")}` });
    },
    [invalidateCache],
  );

  const handleClear = useCallback(async () => {
    // Clear continues past a host-clear failure: surface the error but
    // reset the session anyway.
    await resetSession({
      onError: (err) => setState({ kind: "error", message: String(err) }),
      resetOnClearError: true,
    });
  }, [resetSession]);

  // Connect to every server that has at least one binding in the
  // project. Each unique `server` in `interfaceBindings` becomes its
  // own `connect_remote_server` call; the host subscribes only to the
  // bound interfaces on that server. Bindings with the `"local"`
  // sentinel are resolved to the live sidecar address — if the
  // sidecar isn't ready yet they're dropped from this attempt with a
  // System Message rather than failing the whole connect. Bindings
  // with the `local-vbus://` scheme open an in-process session
  // against the named virtual bus (ADR 0021) — the host dispatches on
  // the binding's `kind`; the frontend treats every binding the same.
  const handleConnect = useCallback(async () => {
    if (interfaceBindings.length === 0) {
      setState({
        kind: "error",
        message: "No interface bindings — add at least one in the project panel.",
      });
      return;
    }
    if (
      interfaceBindings.some(isLocalBinding) &&
      sidecarAddress === null
    ) {
      setState({
        kind: "error",
        message:
          "Local sidecar isn't ready yet — wait for the Connection panel's Local row to go green, then Connect.",
      });
      return;
    }
    const servers = Array.from(
      new Set(
        interfaceBindings
          .map((b) => resolveServer(b.server, sidecarAddress))
          .filter((s): s is string => s !== null && s.length > 0),
      ),
    );
    if (servers.length === 0) {
      setState({
        kind: "error",
        message: "No reachable servers — check the Connection panel.",
      });
      return;
    }

    // Pre-flight stale-binding guard. Bindings persist the full
    // channel id, but parts of it are positional (PCAN slot names /
    // handles shift with USB port), so an exact id can go stale while
    // the device is right there on another slot. Check each remote
    // binding against the server's attached-channel snapshot:
    // re-resolve by device identity when possible (and update the
    // binding), abort with a pointer at the project panel when the
    // interface is genuinely absent — instead of subscribing to
    // nothing and looking connected.
    let effectiveBindings = interfaceBindings;
    const missing: string[] = [];
    const busName = (busId: string) =>
      buses.find((bb) => bb.id === busId)?.name ?? busId;
    for (const address of servers) {
      let attachedIds: string[];
      try {
        const records = await invoke<InterfaceRecord[]>("get_interfaces", {
          address,
        });
        attachedIds = records.map((r) => r.id);
      } catch {
        continue; // no snapshot for this server — let subscribe decide
      }
      // An empty list is ambiguous ("no snapshot yet" vs "nothing
      // attached"); only classify against a real enumeration.
      if (attachedIds.length === 0) continue;
      const snapshot = effectiveBindings;
      const rebinds = new Map<InterfaceBinding, string>();
      for (const b of snapshot) {
        if (bindingKind(b) !== "remote") continue;
        if (resolveServer(b.server, sidecarAddress) !== address) continue;
        const res = resolveBindingInterface(b.interface, attachedIds);
        if (res.kind === "rebound") {
          rebinds.set(b, res.interface);
          void invoke("gui_emit_system_log", {
            level: "warn",
            source: "connection",
            message:
              `bound interface ${b.interface} is not attached; ` +
              `rebinding ${busName(b.bus_id)} to ${res.interface} ` +
              `(same device identity on a different slot)`,
          }).catch(() => {});
        } else if (res.kind === "missing") {
          missing.push(`${busName(b.bus_id)} → ${b.interface}`);
        }
      }
      if (rebinds.size > 0) {
        effectiveBindings = snapshot.map((b) => {
          const to = rebinds.get(b);
          return to === undefined ? b : { ...b, interface: to };
        });
      }
    }
    if (missing.length > 0) {
      setState({
        kind: "error",
        message:
          `Bound interface not attached: ${missing.join("; ")}. ` +
          `Rebind the bus in the project panel (or reattach the device), then Connect.`,
      });
      return;
    }
    if (effectiveBindings !== interfaceBindings) {
      setInterfaceBindings(effectiveBindings);
    }

    // First statement that touches the trace store, so this is where a
    // still-loading prior capture is waited out (ADR 0002 DS-7).
    // `try_reload` swaps the raw store wholesale, so a clear or an
    // append racing it works on a store that is about to be discarded.
    // The wait is the reopen's `O(segment files)`, and only right after
    // a launch — the GUI itself never waited for it.
    await restorePendingRef.current;

    // Connect aborts on a host-clear failure: don't touch the session or
    // open any server if the buffer couldn't be cleared.
    if (
      !(await resetSession({
        onError: (err) => setState({ kind: "error", message: String(err) }),
      }))
    ) {
      return;
    }

    // Mark each target server as "connecting" so the UI shows progress.
    setRemoteSessions(() => {
      const next = new Map<string, RemoteStatus>();
      for (const s of servers) next.set(s, { kind: "connecting" });
      return next;
    });

    for (const address of servers) {
      const bindings = effectiveBindings
        .filter((b) => resolveServer(b.server, sidecarAddress) === address)
        .map((b) => {
          const bus = buses.find((bb) => bb.id === b.bus_id);
          return {
            interface: b.interface,
            busId: b.bus_id,
            speedBps: bus?.speed_bps ?? null,
            fd: bus?.fd ?? null,
            fdDataSpeedBps: bus?.fd_data_speed_bps ?? null,
          };
        });
      try {
        const result = await invoke<RemoteSessionResult>(
          "connect_remote_server",
          { address, bindings },
        );
        setRemoteSessions((prev) => {
          const next = new Map(prev);
          next.set(address, { kind: "running", result });
          return next;
        });
        // Snapshot the hardware config we just pushed so the pending-
        // change banner can spot subsequent edits.
        setBusConfigInFlight((prev) => {
          const next = new Map(prev);
          for (const b of bindings) {
            next.set(b.busId, {
              speed_bps: b.speedBps ?? null,
              fd: b.fd ?? null,
              fd_data_speed_bps: b.fdDataSpeedBps ?? null,
            });
          }
          return next;
        });
      } catch (err) {
        setRemoteSessions((prev) => {
          const next = new Map(prev);
          next.set(address, { kind: "error", message: String(err) });
          return next;
        });
      }
    }
  }, [buses, interfaceBindings, sidecarAddress, resetSession]);

  // Tear down every active session. The host drains its session map.
  const handleDisconnect = useCallback(async () => {
    try {
      await invoke("disconnect_remote_server", { address: null });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
    setRemoteSessions(new Map());
    // Disconnecting voids the pending-change comparison: there's
    // nothing in flight to compare against.
    setBusConfigInFlight(new Map());
  }, []);

  // Reset to the seed project: one trace element + its panel, plus
  // the project panel. Shared by first launch (no saved layout) and
  // "New project". Reads `dockApiRef.current`, so call it after
  // `onReady` has populated it.
  const seedDefaultLayout = useCallback(() => {
    const api = dockApiRef.current;
    if (!api) return;
    setRegistry([]);
    const elementId = create("trace");
    // A seeded project is a fresh starting point, not a step in the
    // old one — build it under the applying guard and restart both
    // view histories from it.
    applyingLayoutRef.current = true;
    try {
      api.clear();
      api.addPanel({
        id: `trace-${elementId}`,
        component: TRACE_PANEL_COMPONENT,
        title: "Trace 1",
        params: { elementId, mode: "by-id" },
      });
      api.addPanel({
        // Fixed id — there's only ever one project panel; the toolbar's
        // "Project panel" button toggles it (show/hide).
        id: PROJECT_PANEL_ID,
        component: PROJECT_PANEL_COMPONENT,
        title: "Project",
        position: { direction: "left" },
      });
    } finally {
      applyingLayoutRef.current = false;
    }
    layoutHistoryRef.current = initLayoutHistory(JSON.stringify(api.toJSON()));
    focusHistoryRef.current = api.activePanel
      ? recordFocus(EMPTY_FOCUS_HISTORY, api.activePanel.id)
      : EMPTY_FOCUS_HISTORY;
  }, [create]);

  /// Snapshot the open project into a `Project` (the elements, not
  /// their runtime state — that re-anchors on reload). Emits
  /// `buses`, `interface_bindings`, and `dbcs` (per-DBC bus scoping).
  const gatherProject = useCallback(
    (): Project => {
      const dbcs: DbcRef[] = dbcPaths.map((path) => ({
        path,
        buses: dbcBuses[path] ?? [],
      }));
      return {
        schema_version: PROJECT_SCHEMA_VERSION,
        // Full-screen (`grid.maximizedNode`) is transient view state —
        // a saved project must not reopen maximized.
        layout: dockApiRef.current
          ? stripMaximizedNode(dockApiRef.current.toJSON())
          : { grid: {}, panels: {} },
        elements: registry.map((e) => e.element),
        buses,
        interface_bindings: interfaceBindings,
        dbcs,
        // remote_address is no longer a project-level field — server
        // addresses now live per-binding on `interface_bindings`. Kept
        // null for v3 schema compatibility.
        remote_address: null,
        local_virtual_buses: localVirtualBuses,
        signal_colors: signalColors,
      };
    },
    [registry, dbcPaths, dbcBuses, buses, interfaceBindings, localVirtualBuses, signalColors],
  );

  // Record which project is "open" — both the React state and the
  // host-side pointer (ADR 0032) that reopens it on the next launch.
  // `null` means an unsaved project.
  const rememberProject = useCallback((path: string | null) => {
    setProjectPath(path);
    persistLastProject(path);
  }, []);

  // Apply an opened project: restore the panel layout (incl. per-panel
  // config in the panel params), the remote-address field, and the
  // loaded DBC set (replaces whatever's loaded with the project's list).
  // Doesn't touch a live connection: the project's bus is configured
  // into the fields; hit Connect to switch.
  const applyProject = useCallback(
    async (project: Project, projectFilePath: string) => {
      // DBC and `.cannet_rbs` references in the project may be relative
      // to the project file's own directory (ADR 0030); resolve them to
      // absolute before they reach the host commands, which read from
      // disk directly.
      const dir = projectDir(projectFilePath);
      // `project.remote_address` is ignored — addresses now live per-
      // binding (see `gatherProject`); reading a v3 file's value would
      // re-introduce the toolbar-level address we removed.
      const incomingBuses = Array.isArray(project.buses) ? project.buses : [];
      const incomingBindings = Array.isArray(project.interface_bindings)
        ? project.interface_bindings
        : [];
      const incomingDbcs: DbcRef[] = (Array.isArray(project.dbcs) ? project.dbcs : []).map(
        (d) => ({ ...d, path: resolveProjectPath(dir, d.path) }),
      );
      const incomingVbuses: LocalVirtualBusDef[] = Array.isArray(
        project.local_virtual_buses,
      )
        ? project.local_virtual_buses
        : [];
      setBuses(incomingBuses);
      setInterfaceBindings(incomingBindings);
      setLocalVirtualBuses(incomingVbuses);
      setSignalColors(
        project.signal_colors != null && typeof project.signal_colors === "object"
          ? { ...project.signal_colors }
          : {},
      );
      const scoping: Record<string, string[]> = {};
      for (const d of incomingDbcs) scoping[d.path] = d.buses ?? [];
      setDbcBuses(scoping);
      // Open path ordering (ADR 0033): DBCs → RBS elements → views →
      // replayed capture. The loaded DBC set is foundational model state
      // — decoding, RBS message resolution, and plot labels all read it —
      // so every view must validate against a *settled* set, not the
      // partial set an interleaved `add_dbc` loop exposes. `loadDbcSet`
      // clears then re-adds each DBC; awaiting it to completion first is
      // what keeps RBS load, the restored layout, and the sampled capture
      // below from racing a half-loaded set (which left the later-loaded
      // buses' views empty). `loadDbcSet` takes the scoping map so each
      // DBC is committed with the right `buses`.
      await loadDbcSet(
        incomingDbcs.map((d) => d.path),
        scoping,
      );
      // Restore the element registry before the panels `fromJSON` creates
      // (which reference elements by `params.elementId`) so they find
      // their entries. (A panel that doesn't still self-heals.) RBS
      // elements now load against the settled DBC set above.
      // `assignDefaultNames` backfills `${Kind} ${n}` names onto elements
      // saved before display names existed (ADR 0019).
      setRegistry(
        assignDefaultNames(
          (Array.isArray(project.elements) ? project.elements : [])
            .filter(isProjectElement)
            .map(normalizeElement)
            .map((el) =>
              el.kind === "rbs" && el.path
                ? { ...el, path: resolveProjectPath(dir, el.path) }
                : el,
            ),
        ).map((el) => ({ element: el, trace: clearedTrace(countRef.current) })),
      );
      const api = dockApiRef.current;
      const layout = validateLayout(project.layout);
      if (api && layout) {
        // An opened project replaces what was open wholesale; its
        // layout is a fresh baseline, not an undoable step from the
        // previous one — apply under the guard and restart both view
        // histories (same as `seedDefaultLayout`).
        applyingLayoutRef.current = true;
        try {
          api.fromJSON(layout);
        } catch {
          /* keep the current layout if the saved one won't load */
        } finally {
          applyingLayoutRef.current = false;
        }
        layoutHistoryRef.current = initLayoutHistory(JSON.stringify(api.toJSON()));
        focusHistoryRef.current = api.activePanel
          ? recordFocus(EMPTY_FOCUS_HISTORY, api.activePanel.id)
          : EMPTY_FOCUS_HISTORY;
      }
      // Rebuild host-side virtual buses from project defs
      // (ADR 0021). Per-binding session participants are opened on
      // Connect, not here.
      await invoke("replay_local_virtual_buses", {
        defs: incomingVbuses,
      }).catch((err) => {
        console.error("replay_local_virtual_buses failed", err);
      });
      // DS-7 (ADR 0002): restore a prior capture that belongs to this
      // project as a stopped historical trace — last, so the plot and
      // filtered views sample the replayed frames against the fully
      // loaded DBC set above. Doing it here — after the open clears the
      // view, not inside `open_project` — keeps the clear from clobbering
      // the restored history.
      //
      // Deliberately *not* awaited: reopening a large capture costs
      // `O(segment files)` and the rest of the open is done, so the app
      // goes interactive now and the history lands when it lands. The
      // views are windows over a host-side model that already grows
      // under them, so history arriving after they mounted is the
      // ordinary case, not a special one. What does wait is `connect`
      // (see `restorePendingRef`): the reload swaps the raw store
      // wholesale, so frames appended while it is in flight would be
      // dropped with the store they landed in.
      restorePendingRef.current = (async () => {
        try {
          const restored = await invoke<{
            count: number;
            first_index: number;
            first_index_ts_ns: number | null;
            session_start_seconds: number;
          }>("restore_scratch_capture");
          if (restored.count <= 0) return;
          invalidateCache();
          setCount(restored.count);
          setFirstIndex(restored.first_index);
          setFirstIndexTsNs(restored.first_index_ts_ns);
          setSessionStartSeconds(
            restored.session_start_seconds > 0 ? restored.session_start_seconds : null,
          );
          setRegistry((reg) => reg.map((e) => ({ ...e, trace: restoredTrace(restored.count) })));
        } catch {
          /* no scratch capture to restore */
        }
      })();
    },
    [loadDbcSet, invalidateCache],
  );

  const handleNewProject = useCallback(() => {
    // A fresh unsaved project: seed layout, no project file, no DBCs, no
    // session — disconnect and clear the buffer too. RBS elements
    // unload first (stopping their schedules).
    for (const e of registryRef.current) {
      if (e.element.kind === "rbs") {
        void invoke("rbs_unload", { elementId: e.element.id }).catch(() => {});
      }
    }
    seedDefaultLayout();
    rememberProject(null);
    void loadDbcSet([], {});
    setDbcBuses({});
    setBuses([]);
    setInterfaceBindings([]);
    setLocalVirtualBuses([]);
    setSignalColors({});
    void invoke("disconnect_remote_server", { address: null }).catch(() => {});
    setRemoteSessions(new Map());
    setBusConfigInFlight(new Map());
    // Drop any host-side local virtual buses left from the
    // previous project (ADR 0021).
    void invoke("replay_local_virtual_buses", {
      defs: [],
    }).catch(() => {});
    // Drop the host TX-message pool too, so a New
    // project starts with no transmit frames.
    void invoke("clear_transmit_frames").catch(() => {});
    // Fire-and-forget the host clear + reset the session synchronously.
    // `seedDefaultLayout` already reseeded the registry, so don't restart
    // elements.
    void resetSession({ fireAndForget: true, startElements: false });
    setDirty(false);
  }, [seedDefaultLayout, rememberProject, loadDbcSet, resetSession]);

  const handleOpenProject = useCallback(async () => {
    const selected = await open({
      multiple: false,
      // `.cannet_prj` is the convention; `.json` (the same content)
      // stays accepted for projects saved before the extension.
      filters: [{ name: "cannet project", extensions: ["cannet_prj", "json"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const project = await invoke<Project>("open_project", { path: selected });
      // Opening a project re-roots the host onto that project's own
      // directory (ADR 0042 §1), so the project-scoped half of the host
      // state — the layout, its recent BLFs, its channel maps — is a
      // different file's now. Re-read before anything writes the previous
      // project's values into it.
      await hydrateState();
      void applyProject(project, selected);
      rememberProject(selected);
      setDirty(false);
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, [applyProject, rememberProject]);

  // Returns true if the project was written, false if it wasn't (e.g.
  // the user cancelled the file picker, or the write failed).
  //
  // `promote` picks the command: `save_project_as` also makes the
  // destination a project directory and moves the session into it,
  // carrying the project's data along (ADR 0042 §6). Plain Save writes
  // the file and touches no directory — cannet never creates a
  // `.cannet/` as a side effect, only where the user pointed it.
  const saveProjectTo = useCallback(
    async (path: string, promote = false): Promise<boolean> => {
      try {
        await invoke<string>(promote ? "save_project_as" : "save_project", {
          path,
          project: withStoredPaths(gatherProject(), path),
        });
        // The project directory may have moved, so the project-scoped
        // half of the host state now resolves somewhere else; re-read it
        // before anything writes the stale copy back.
        if (promote) await hydrateState();
        rememberProject(path);
        setDirty(false);
        return true;
      } catch (err) {
        setState({ kind: "error", message: String(err) });
        return false;
      }
    },
    [gatherProject, rememberProject],
  );

  const handleSaveProjectAs = useCallback(async (): Promise<boolean> => {
    const path = await save({
      filters: [{ name: "cannet project", extensions: ["cannet_prj"] }],
      defaultPath: projectPath ?? "cannet-project.cannet_prj",
    });
    if (!path) return false;
    return saveProjectTo(path, true);
  }, [projectPath, saveProjectTo]);

  const handleSaveProject = useCallback(
    (): Promise<boolean> => (projectPath ? saveProjectTo(projectPath) : handleSaveProjectAs()),
    [projectPath, saveProjectTo, handleSaveProjectAs],
  );

  // Save All: the project plus every dirty `.cannet_rbs` (ADR 0028 —
  // Save Project saves the project only; this is the catch-all the
  // exit prompt uses too). Returns false if any step failed or was
  // cancelled.
  const handleSaveAll = useCallback(async (): Promise<boolean> => {
    const projectOk = await handleSaveProject();
    if (!projectOk) return false;
    try {
      const dirtyRbs = await invoke<RbsDirtyRecord[]>("rbs_dirty");
      for (const d of dirtyRbs) {
        if (d.path == null) {
          // Never-saved config: prompt for its first path.
          const picked = await save({
            filters: [{ name: "cannet RBS config", extensions: ["cannet_rbs"] }],
            defaultPath: "simulation.cannet_rbs",
          });
          if (typeof picked !== "string" || picked.length === 0) return false;
          await invoke("rbs_save_as", { elementId: d.elementId, path: picked });
          updateElement(d.elementId, { kind: "rbs", path: picked });
        } else {
          await invoke("rbs_save", { elementId: d.elementId });
        }
      }
      return true;
    } catch {
      return false; // failures land on the system log
    }
  }, [handleSaveProject, updateElement]);
  const handleSaveAllRef = useRef(handleSaveAll);
  handleSaveAllRef.current = handleSaveAll;

  // Save Capture: write the session buffer to a BLF.
  // System Messages handle the user-visible success / failure
  // feedback; this just routes through the host command.
  //
  // The project's ordered `buses` list IS the BLF channel order
  // (see CLAUDE.md § File formats). Frames get re-channeled by the
  // host so that bus index N → BLF channel N; on reload the channel
  // map modal seeds matching pairs.
  const handleSaveCapture = useCallback(async () => {
    if (count === 0) return;
    const path = await save({
      defaultPath: "capture.blf",
      filters: [{ name: "Vector BLF", extensions: ["blf"] }],
    });
    if (typeof path !== "string" || path.length === 0) return;
    try {
      await invoke("save_capture", {
        blfPath: path,
        buses: buses.map((b) => b.id),
      });
      // Newly-saved captures are reasonable Recent BLF candidates
      // (the user just produced this file; re-opening it is the
      // archetypal "what did I just save?" gesture).
      rememberRecentBlf(path);
    } catch {
      // Failure surfaces in the System Messages panel via the
      // host's `capture`-tagged error log; nothing more to do here.
    }
  }, [buses, count, rememberRecentBlf]);

  // The close-on-quit handler is registered once; give it refs to the
  // current values rather than re-registering on every change.
  dirtyRef.current = dirty;
  handleSaveProjectRef.current = handleSaveProject;
  // Mirror the connect preconditions + action for the once-mounted perf
  // orchestration effect (ADR 0031).
  interfaceBindingsRef.current = interfaceBindings;
  sidecarAddressRef.current = sidecarAddress;
  handleConnectRef.current = handleConnect;

  // Self-driving perf run (ADR 0031). When the host hands us an
  // automation config, connect (if asked), capture for the requested
  // span, write the report, and exit — without an operator. The project
  // has already been opened in `onReady`; everything the workload needs
  // (layout, bindings, the RBS run flag) rides in the saved project, so
  // the flags add only the two decisions a project deliberately doesn't
  // persist: touch interfaces, and record.
  useEffect(() => {
    if (!automation) return;
    if (automationRanRef.current) return; // one-shot (see the ref's docs)
    automationRanRef.current = true;
    let cancelled = false;
    let stopInteraction: (() => void) | null = null;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    // Poll `pred` until it holds or `timeoutMs` elapses (returns whether
    // it held) — waits out the async settle after the project applies:
    // bindings load into state, and the local sidecar comes up.
    const waitUntil = async (pred: () => boolean, timeoutMs: number) => {
      const start = performance.now();
      while (!pred()) {
        if (cancelled || performance.now() - start > timeoutMs) return false;
        await sleep(100);
      }
      return true;
    };
    // Mirrors the System Messages / cannet.log sink so a never-connected
    // run leaves a cause behind instead of the silent skip this guards
    // against (2026-08-08: a fresh-build sidecar startup delay skipped
    // `handleConnect` with zero logging, and the capture ran empty anyway).
    const logAutomation = (level: "warn" | "error", message: string) => {
      void invoke("gui_emit_system_log", {
        level,
        source: "automation",
        message,
      }).catch(() => {});
    };
    // Captured once: narrows `automation.captureSecs` for TypeScript at
    // every use below, and names the "this run must produce a report"
    // condition the retry/assert/fail-loud behaviour is scoped to. A
    // plain `--connect-on-start` (no capture) still just connects once,
    // unretried — there's no capture window whose absence needs a report
    // suppressed.
    const captureSecs = automation.captureSecs;
    void (async () => {
      let failed = false;
      try {
        if (automation.connectOnStart) {
          const ready = await waitUntil(
            () =>
              interfaceBindingsRef.current.length > 0 &&
              (!interfaceBindingsRef.current.some(isLocalBinding) ||
                sidecarAddressRef.current !== null),
            AUTOMATION_READY_TIMEOUT_MS,
          );
          if (cancelled) return;
          if (!ready) {
            logAutomation(
              "error",
              `perf automation: connect preconditions not ready after ` +
                `${AUTOMATION_READY_TIMEOUT_MS}ms (bindings=` +
                `${interfaceBindingsRef.current.length}, sidecar=` +
                `${sidecarAddressRef.current ?? "not ready"})`,
            );
            failed = captureSecs != null;
          } else if (captureSecs != null) {
            // Bounded retry (ADR 0031): only delays *when* the capture
            // window starts below, never its length.
            let connected = false;
            for (
              let attempt = 1;
              attempt <= AUTOMATION_CONNECT_RETRY_ATTEMPTS;
              attempt++
            ) {
              await handleConnectRef.current();
              if (cancelled) return;
              connected = await waitUntil(
                () => remoteConnectedRef.current,
                AUTOMATION_CONNECT_CONFIRM_MS,
              );
              if (connected || cancelled) break;
              if (attempt < AUTOMATION_CONNECT_RETRY_ATTEMPTS) {
                logAutomation(
                  "warn",
                  `perf automation: connect attempt ${attempt} did not ` +
                    `establish a session; retrying`,
                );
                await sleep(AUTOMATION_CONNECT_RETRY_DELAY_MS);
                if (cancelled) return;
              }
            }
            if (!connected) {
              logAutomation(
                "error",
                `perf automation: failed to connect after ` +
                  `${AUTOMATION_CONNECT_RETRY_ATTEMPTS} attempts; failing ` +
                  `the capture`,
              );
              failed = true;
            }
          } else {
            await handleConnectRef.current();
          }
        }
        if (captureSecs != null) {
          if (failed) {
            // Failure contract: no report (`beginDiagCapture` /
            // `endDiagCapture` are never called, so the host never arms —
            // absence is the one signal no consumer can misread) and a
            // non-zero exit so the launching CLI sees a failed run. The
            // frontend has no other way to set the process exit code.
            await invoke("exit_process", { code: 1 }).catch(() => {});
            return;
          }
          // Synthetic interaction (ADR 0031) starts *before* the capture
          // brackets: its warm-up zooms the plot from whatever width the
          // project was saved at down to a working one, and those 30-odd
          // zoom steps are setup, not the workload under measurement.
          if (automation.interact != null) {
            stopInteraction = startPerfInteraction(
              document,
              parseInteractScript(automation.interact),
            );
            await sleep(INTERACT_WARMUP_MS);
            if (cancelled) return;
          }
          await sleep(AUTOMATION_SETTLE_MS);
          if (cancelled) return;
          await beginDiagCapture(
            automation.label ?? automation.project ?? "perf",
          );
          await sleep(captureSecs * 1000);
          if (cancelled) return;
          await endDiagCapture(automation.out ?? undefined);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("perf automation run failed", err);
        // A capture run has no code after `endDiagCapture` inside the
        // try, so any exception here — a rejected `handleConnect`, a
        // `beginDiagCapture` failure, anything — means the report is
        // absent or unfinished. Same failure contract as a never-
        // connected run: fail loudly and exit non-zero instead of the
        // `finally` block's normal `destroy()`, which would otherwise
        // reach the same quiet exit-0-no-report outcome the retry/
        // assert logic above exists to prevent.
        if (captureSecs != null) {
          logAutomation(
            "error",
            `perf automation: capture run failed: ${String(err)}`,
          );
          failed = true;
          await invoke("exit_process", { code: 1 }).catch(() => {});
        }
      } finally {
        stopInteraction?.();
        // A capture run is unattended — exit so the launching CLI
        // returns. `destroy` skips the dirty-close prompt (applying the
        // project marks it dirty). A connect-only / project-only run
        // leaves the app open for interactive use. A failed capture has
        // already exited non-zero via `exit_process` above.
        if (!cancelled && captureSecs != null && !failed) {
          getCurrentWindow().destroy();
        }
      }
    })();
    return () => {
      cancelled = true;
      stopInteraction?.();
    };
  }, [automation]);

  // The build version, for the title bar's trailing `cannet <version>`
  // segment. Same host command the About view reads — the version is
  // stamped into the binary, so one fetch per session is enough.
  useEffect(() => {
    let live = true;
    invoke<string>("app_version")
      .then((v) => {
        if (live) setAppVersion(v);
      })
      .catch(() => {
        /* no host — the title just omits the version */
      });
    return () => {
      live = false;
    };
  }, []);

  // Native window title: `<project> — <capture source> — cannet
  // <version>`, with a `• ` prefix while unsaved. The OS chrome is the
  // only title surface (no custom title bar).
  //
  // A rejection here is *reported*, not swallowed: `setTitle` needs the
  // `core:window:allow-set-title` capability, which Tauri's
  // `core:default` does not include, and without it every call rejects
  // and the static `tauri.conf.json` title silently survives. That
  // shipped undetected once already.
  useEffect(() => {
    void getCurrentWindow()
      .setTitle(
        windowTitle({
          projectPath,
          dirty,
          capture: captureLabel(state, remoteSessions),
          version: appVersion,
        }),
      )
      .catch((err: unknown) => {
        // Once per session: a `setTitle` that fails fails on every
        // subsequent change too, always for the same reason.
        if (titleFailureReported.current) return;
        titleFailureReported.current = true;
        const message =
          `window title could not be set: ${String(err)} — the host may be ` +
          `missing the core:window:allow-set-title capability`;
        // eslint-disable-next-line no-console
        console.error(message);
        void invoke("gui_emit_system_log", {
          level: "error",
          source: "window",
          message,
        }).catch(() => {
          /* headless test host — nowhere to report to */
        });
      });
  }, [projectPath, dirty, state, remoteSessions, appVersion]);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win
      .onCloseRequested(async (event) => {
        // Unsaved state = a dirty project OR any dirty
        // `.cannet_rbs` (the exit prompt covers both — ADR 0028).
        let rbsDirty = false;
        try {
          rbsDirty = (await invoke<RbsDirtyRecord[]>("rbs_dirty")).length > 0;
        } catch {
          /* host gone — nothing to save */
        }
        if (!dirtyRef.current && !rbsDirty) return; // nothing unsaved — let it close
        event.preventDefault();

        // Autosave-on-exit: a dirty close saves silently instead of
        // showing the prompt below, but only for a project directory
        // the user pointed cannet at explicitly. An auto-located or
        // never-saved session is inert here — never auto-mint a
        // project file — so it falls through unchanged, and so does a
        // failed save: losing the close request silently would be
        // worse than one more prompt.
        if (hostSettings().autosave_on_exit) {
          const autoLocated = await invoke<boolean>(
            "active_project_is_auto_located",
          ).catch(() => true); // host unreachable — fall back to the prompt below
          if (!autoLocated && (await handleSaveAllRef.current())) {
            void win.destroy();
            return;
          }
        }

        const choice = await new Promise<CloseChoice>((resolve) =>
          setPendingClose({ resolve }),
        );
        setPendingClose(null);
        if (choice === "cancel") return;
        if (choice === "save" && !(await handleSaveAllRef.current())) return; // picker cancelled
        void win.destroy();
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  // Re-read every loaded DBC from disk (a file that's gone or no longer
  // parses drops out, with an error). No-op when none are loaded.
  // Preserve per-DBC bus scoping across the reload.
  const handleReloadDbc = useCallback(() => {
    if (dbcPaths.length > 0) void loadDbcSet(dbcPaths, dbcBuses);
  }, [dbcPaths, dbcBuses, loadDbcSet]);

  // Update a single DBC's bus scoping and push it to the host.
  const handleSetDbcBuses = useCallback(
    (path: string, scopedBuses: string[]) => {
      setDbcBuses((prev) => ({ ...prev, [path]: scopedBuses }));
      setDirty(true);
      invalidateCache(); // decoded view changes
      void invoke<DbcInfo[]>("set_dbc_buses", { path, buses: scopedBuses }).catch((err) =>
        setState({ kind: "error", message: String(err) }),
      );
    },
    [invalidateCache],
  );

  // Bus list mutations (add / rename / remove). Pure project
  // state; the host doesn't need a separate command (the buses ride
  // through the project file, and the per-DBC scoping refresh below
  // re-publishes the canonical set when a rename / remove changes ids).
  const handleAddBus = useCallback((bus: Bus) => {
    setBuses((prev) => {
      if (prev.some((b) => b.id === bus.id)) return prev;
      // A new bus carries no bitrate — the adapter's own default stays
      // in charge until one is set — and no color: an uncustomized bus
      // renders the active theme's wheel entry for its list position,
      // derived where it's drawn. Only a color the user picked is
      // project data.
      return [...prev, bus];
    });
    setDirty(true);
  }, []);
  const handleRemoveBus = useCallback((id: string) => {
    setBuses((prev) => prev.filter((b) => b.id !== id));
    setInterfaceBindings((prev) => prev.filter((b) => b.bus_id !== id));
    setDbcBuses((prev) => {
      const next: Record<string, string[]> = {};
      for (const [path, scoped] of Object.entries(prev)) {
        next[path] = scoped.filter((b) => b !== id);
      }
      return next;
    });
    setDirty(true);
    invalidateCache();
  }, [invalidateCache]);
  // Shallow patch of one bus's persisted fields — inline rename, graph
  // color, and the hardware-config knobs (nominal speed / FD toggle /
  // data-phase speed) all go through here (mirrors
  // `handleUpdateVirtualBus`'s patch shape). Pure project state; the
  // host applies any hardware change on the next Connect.
  const handleUpdateBus = useCallback((id: string, patch: Partial<Bus>) => {
    setBuses((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
    setDirty(true);
  }, []);
  // Interface-binding mutations. Each project bus has at
  // most one binding (key is `bus_id`); multiple bindings may target
  // the same source — the sidecar and the
  // in-process bus both fan out to N subscribers. Binding mutations
  // are pure project state — the host-side session for the binding
  // is opened on Connect, not on bind.
  const handleAddBinding = useCallback((binding: InterfaceBinding) => {
    setInterfaceBindings((prev) => {
      const filtered = prev.filter((b) => b.bus_id !== binding.bus_id);
      return [...filtered, binding];
    });
    setDirty(true);
  }, []);
  const handleRemoveBinding = useCallback((bus_id: string) => {
    setInterfaceBindings((prev) => prev.filter((b) => b.bus_id !== bus_id));
    setDirty(true);
  }, []);

  // Virtual-bus mutations (ADR 0021).
  const handleAddVirtualBus = useCallback((def: LocalVirtualBusDef) => {
    setLocalVirtualBuses((prev) => {
      if (prev.some((v) => v.id === def.id)) return prev;
      return [...prev, def];
    });
    setDirty(true);
    void invoke("create_local_virtual_bus", {
      id: def.id,
      name: def.name,
    }).catch((err) => {
      console.error("create_local_virtual_bus failed", err);
    });
  }, []);

  const handleRemoveVirtualBus = useCallback((id: string) => {
    setLocalVirtualBuses((prev) => prev.filter((v) => v.id !== id));
    setInterfaceBindings((prev) =>
      prev.filter((b) => localVbusId(b) !== id),
    );
    setDirty(true);
    void invoke("drop_local_virtual_bus", { id }).catch((err) => {
      console.error("drop_local_virtual_bus failed", err);
    });
  }, []);

  const handleUpdateVirtualBus = useCallback(
    (id: string, patch: Partial<LocalVirtualBusDef>) => {
      setLocalVirtualBuses((prev) =>
        prev.map((v) => (v.id === id ? { ...v, ...patch } : v)),
      );
      setDirty(true);
    },
    [],
  );

  /// Whether the "Clear project colors" confirmation is up. The command
  /// discards deliberate choices with no partial undo, so it asks first.
  const [confirmingClearColors, setConfirmingClearColors] = useState(false);

  /// Drop every color the user picked: each bus's `color` field and the
  /// whole `signal_colors` map, so both populations fall back to the
  /// active theme's wheels. Color-map rules are deliberately untouched —
  /// a rule says what a *value* means, which is authored data rather
  /// than cosmetic identity.
  const handleClearProjectColors = useCallback(() => {
    setBuses((prev) =>
      prev.map((b) => {
        if (b.color == null) return b;
        const { color: _dropped, ...rest } = b;
        return rest;
      }),
    );
    setSignalColors({});
    setDirty(true);
  }, []);

  /// Set (or clear, with `null`) one signal's project-level color
  /// override — a model edit, so it marks the project dirty.
  const handleSetSignalColor = useCallback((key: string, color: string | null) => {
    setSignalColors((prev) => {
      if (color == null) {
        if (!(key in prev)) return prev;
        const { [key]: _dropped, ...rest } = prev;
        return rest;
      }
      if (prev[key] === color) return prev;
      return { ...prev, [key]: color };
    });
    setDirty(true);
  }, []);

  // Add a fresh element of `kind` and open its dockview panel. The
  // kind→component map is `elementPanelComponent` (dockLayout), and the
  // panel id is `${component}-${elementId}` — the same scheme
  // `openElementView` and the saved-layout restore use, so a panel
  // added here reopens to the same id. A new trace opens in by-id mode
  // (toggle it in the panel toolbar). Tab titles come from the
  // element's model-owned name (ADR 0019): the same `${Kind} ${n}`
  // default `create` assigns (against the registry the element is
  // joining); the title-sync effect below keeps the tab current
  // thereafter.
  const addPanel = useCallback(
    (kind: ProjectElementKind) => {
      const api = dockApiRef.current;
      if (!api) return;
      const component = elementPanelComponent(kind);
      if (!component) return; // panel-less kind (`filter`)
      const title = defaultElementName(kind, registryRef.current.map((e) => e.element));
      const elementId = create(kind);
      api.addPanel({
        id: `${component}-${elementId}`,
        component,
        title,
        params: kind === "trace" ? { elementId, mode: "by-id" } : { elementId },
      });
    },
    [create],
  );

  // --- RBS host lifecycle (ADR 0028) ---
  // The host resolves `.cannet_rbs` bus-name keys against the
  // project's logical buses; push the (id, name) map on every change.
  useEffect(() => {
    void invoke("rbs_sync_project_buses", {
      buses: buses.map((b) => [b.id, b.name]),
    }).catch(() => {});
  }, [buses]);
  // Reconcile host-loaded RBS elements with the registry: load when a
  // path appears / changes, unload when the element goes away, and
  // push the Run flag. Owned here (not by the panel) so an enabled
  // RBS resumes on project open even when its panel isn't in the
  // layout.
  const rbsHostStateRef = useRef<Map<string, { path: string | null; run: boolean }>>(
    new Map(),
  );
  // Per-element op queue: the reconciler fires across renders (a
  // layout-restored panel ensures a pathless element moments before
  // the opened project replaces it with the saved path), and the
  // rbs_* commands run concurrently on the async pool — unserialized,
  // an early rbs_init's set_run could land after the project's
  // rbs_load chain. Chaining per element keeps host ops in dispatch
  // order.
  const rbsOpsRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const queueRbsOp = useCallback((id: string, op: () => Promise<unknown>) => {
    const prev = rbsOpsRef.current.get(id) ?? Promise.resolve();
    const next = prev.then(op).catch(() => {});
    rbsOpsRef.current.set(id, next);
  }, []);
  useEffect(() => {
    const current = new Map<string, { path: string | null; run: boolean }>();
    for (const e of registry) {
      if (e.element.kind === "rbs") {
        current.set(e.element.id, { path: e.element.path, run: e.element.run });
      }
    }
    for (const [id, prev] of rbsHostStateRef.current) {
      const now = current.get(id);
      if (!now || (prev.path != null && now.path != null && now.path !== prev.path)) {
        queueRbsOp(id, () => invoke("rbs_unload", { elementId: id }));
      }
    }
    for (const [id, now] of current) {
      const prev = rbsHostStateRef.current.get(id);
      if (now.path != null && (!prev || prev.path !== now.path)) {
        // A path appearing for an element the host already has in
        // memory (first save) is a no-op host-side: rbs_load re-reads
        // the file just written.
        const path = now.path;
        queueRbsOp(id, () =>
          invoke("rbs_load", { elementId: id, path }).then(() =>
            invoke("rbs_set_run", { elementId: id, run: now.run }),
          ),
        );
      } else if (now.path == null && !prev) {
        // A fresh element needs no file: the host seeds an in-memory
        // config from the project's current buses (saving is explicit).
        queueRbsOp(id, () =>
          invoke("rbs_init", { elementId: id }).then(() =>
            invoke("rbs_set_run", { elementId: id, run: now.run }),
          ),
        );
      } else if (prev && prev.run !== now.run) {
        queueRbsOp(id, () => invoke("rbs_set_run", { elementId: id, run: now.run }));
      }
    }
    rbsHostStateRef.current = current;
  }, [registry, queueRbsOp]);
  // The global RBS kill-switch is runtime-only host state; mirror it
  // through its dedicated event so the palette toggle and the panel
  // button stay in sync.
  const rbsKillSwitchRef = useRef(false);
  useEffect(() => {
    const un = listen<boolean>("rbs-kill-switch", (event) => {
      rbsKillSwitchRef.current = event.payload;
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);
  const toggleRbsKillSwitch = useCallback(() => {
    void invoke("rbs_set_kill_switch", { on: !rbsKillSwitchRef.current }).catch(
      () => {},
    );
  }, []);

  // Keep every element-backed dockview tab title in lockstep with the
  // model-owned name (ADR 0019): covers rename from the project
  // panel, project open (layouts saved with stale titles), and the
  // self-healing `ensure` path.
  useEffect(() => {
    const api = dockApiRef.current;
    if (!api) return;
    for (const panel of api.panels) {
      const elementId = (panel.params as { elementId?: unknown } | undefined)
        ?.elementId;
      if (typeof elementId !== "string") continue;
      const entry = registry.find((e) => e.element.id === elementId);
      if (!entry) continue;
      const label = elementLabel(entry.element);
      if (panel.title !== label) {
        diagCount("dockview.setTitle"); // DIAG
        panel.api.setTitle(label);
      }
    }
  }, [registry]);


  // System-log context: mirror + clear + markRead. `clear` empties both
  // the host's ring and the frontend's mirror; the mirror keeps its read
  // mark across one, since the host does *not* reset its seq counter
  // (callers rely on monotonicity).
  const clearSystemLog = useCallback(() => {
    void invoke("clear_system_log").catch(() => { /* best effort */ });
    setSystemLog(clearSystemLogMirror);
  }, []);
  const markLogRead = useCallback(() => setSystemLog(markSystemLogRead), []);
  const systemLogValue: SystemLogContextValue = useMemo(
    () => ({
      messages: systemLog.messages,
      unread: systemLog.unread,
      clear: clearSystemLog,
      markRead: markLogRead,
    }),
    [systemLog, clearSystemLog, markLogRead],
  );

  // Notes context: dispatchers forward to the host; the
  // mirror updates from the `notes-changed` event, not from
  // optimistic local state, so a panel-A add shows up on panel B
  // through the same code path.
  const addNoteRemote = useCallback(
    (id: string, timestampNs: number, label: string, color?: string) => {
      // `color` rides the note payload directly — `Note.color` is
      // `#[serde(default)]`, so omitting it yields `None` (the view
      // default) with no host-side change.
      const note = color ? { id, timestampNs, label, color } : { id, timestampNs, label };
      void invoke("add_note", { note }).catch(() => {
        /* best effort — error surfaces in System Messages */
      });
    },
    [],
  );
  const renameNoteRemote = useCallback((id: string, label: string) => {
    void invoke("rename_note", { id, label }).catch(() => { /* best effort */ });
  }, []);
  const recolorNoteRemote = useCallback((id: string, color: string | null) => {
    void invoke("recolor_note", { id, color }).catch(() => { /* best effort */ });
  }, []);
  const removeNoteRemote = useCallback((id: string) => {
    void invoke("remove_note", { id }).catch(() => { /* best effort */ });
  }, []);
  const notesValue: NotesContextValue = useMemo(
    () => ({
      notes,
      addNote: addNoteRemote,
      renameNote: renameNoteRemote,
      recolorNote: recolorNoteRemote,
      removeNote: removeNoteRemote,
    }),
    [notes, addNoteRemote, renameNoteRemote, recolorNoteRemote, removeNoteRemote],
  );

  // The app-domain commands (ADR 0018): the toolbar/menu actions the
  // command subsystem dispatches by id. Rebuilt every render (cheap);
  // `useCommands` merges these with its own framework / view / palette /
  // panel-show commands and reads the union through a ref, so the
  // once-registered keydown listener and the palette see current
  // closures. The panel-show / view-navigation / palette commands live
  // in the hook — these are the ones backed by App-owned handlers.
  const appCommands: Record<string, () => void> = {
    "project.open": () => void handleOpenProject(),
    "project.save": () => void handleSaveProject(),
    "project.saveAs": () => void handleSaveProjectAs(),
    // Close project = return to a fresh unsaved project (same reset
    // the New-project action performs).
    "project.close": handleNewProject,
    "blf.open": () => void handleOpenLog(),
    "dbc.add": () => void handleAddDbc(),
    "connection.connect": () => void handleConnect(),
    "connection.disconnect": () => void handleDisconnect(),
    "capture.clear": () => void handleClear(),
    "capture.save": () => void handleSaveCapture(),
    "panel.add.trace": () => addPanel("trace"),
    "panel.add.plot": () => addPanel("plot"),
    "panel.add.signals": () => addPanel("signals"),
    "panel.add.transmit": () => addPanel("transmit"),
    "panel.add.rbs": () => addPanel("rbs"),
    "panel.add.colormap": () => addPanel("colormap"),
    "panel.add.generator": () => addPanel("generator"),
    "project.saveAll": () => void handleSaveAllRef.current(),
    "project.clearColors": () => setConfirmingClearColors(true),
    "rbs.killSwitch": toggleRbsKillSwitch,
    // Quit via the window's own close path: runs the unsaved-changes
    // prompt (`onCloseRequested`) and the clean-shutdown flush, exactly
    // like clicking the title-bar close button.
    "app.exit": () => void getCurrentWindow().close(),
  };
  const commands = useCommands({
    dockApiRef,
    focusHistoryRef,
    layoutHistoryRef,
    applyingLayoutRef,
    registry,
    activePanel,
    projectPath,
    hasMaximizedView,
    notes,
    firstIndex,
    firstIndexTsNs,
    sessionStartSeconds,
    renameElement,
    appCommands,
  });
  const runCommand = commands.runCommand;

  const handleDockReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      dockApiRef.current = api;

      // Track the focused panel for the command context (ADR 0018)
      // and the back/forward navigation history (`recordFocus` is a
      // no-op when a programmatic back/forward jump echoes here).
      api.onDidActivePanelChange((panel) => {
        diagCount("app.setActivePanel"); // DIAG
        if (!panel) {
          setActivePanel(null);
          return;
        }
        focusHistoryRef.current = recordFocus(focusHistoryRef.current, panel.id);
        const elementId = (panel.params as { elementId?: unknown } | undefined)
          ?.elementId;
        setActivePanel({
          id: panel.id,
          elementId: typeof elementId === "string" ? elementId : null,
        });
      });

      // The persisted layout snapshot belongs to a project session; a
      // launch that opens nothing starts from the default seed instead
      // (window size and position are a separate, plugin-owned track and
      // do resume). The reopen decision itself is made below — but the
      // half that decides *whether* one is coming is synchronous, so it
      // can be read here, before the dock's first paint. Automation's
      // `--project` (fetched asynchronously below) is the one case this
      // reads as "no reopen": that run seeds the default layout and
      // `applyProject` replaces it a moment later. Deliberate — waiting
      // for that answer would push the restore behind an IPC round trip
      // and flash an empty dock on *every* launch, to spare an unwatched
      // self-driving run one extra layout swap.
      const reopenComing =
        hostSettings().reopen_last_project && hostState().last_project != null;
      let restored = false;
      const saved = reopenComing ? validateLayout(hostState().layout) : null;
      if (saved) {
        try {
          api.fromJSON(saved);
          restored = api.panels.length > 0;
        } catch {
          restored = false;
        }
      }
      if (!restored) {
        seedDefaultLayout();
      }

      // Full-screen state for the command context (gates Escape).
      api.onDidMaximizedGroupChange(() => {
        setHasMaximizedView(api.hasMaximizedGroup());
      });

      api.onDidLayoutChange(() => {
        diagCount("dockview.layoutChange"); // DIAG
        // Strip the transient full-screen marker so neither the
        // persisted layout nor the undo history reopens maximized.
        const json = stripMaximizedNode(api.toJSON());
        // Only a project's working layout is recorded (best-effort, ADR
        // 0032; it lands in that project's own state file, ADR 0042). A
        // session with nothing open leaves no view state behind — its
        // next launch starts from the default seed, matching the restore
        // gate above. Registered after the initial restore/seed, so this
        // never writes an empty or half-built layout either.
        if (projectPathRef.current !== null) persistLayout(json);
        // Any layout change (panels added / dragged / closed, columns
        // resized) also marks the project dirty.
        setDirty(true);
        // Feed the undo stack — except while a programmatic
        // `fromJSON`/seed is echoing (the guard) or before the initial
        // layout has settled (`null` history).
        if (!applyingLayoutRef.current && layoutHistoryRef.current) {
          layoutHistoryRef.current = recordLayout(
            layoutHistoryRef.current,
            JSON.stringify(json),
          );
        }
      });
      // The restore/seed above is the baseline the first undo steps
      // back toward. (`seedDefaultLayout` set this itself; a restored
      // saved layout hasn't yet.)
      layoutHistoryRef.current = initLayoutHistory(JSON.stringify(api.toJSON()));

      // Perf self-driving flags (ADR 0031) override the last-opened
      // pointer: `--project` names the project deterministically. Fetch
      // the config first so the project it names is the one we open.
      // One-shot (see `bootOpenRanRef`): the StrictMode re-init of
      // dockview must not open the project a second time.
      if (bootOpenRanRef.current) return;
      bootOpenRanRef.current = true;
      void (async () => {
        let cfg: AutomationConfig | null = null;
        try {
          cfg = await invoke<AutomationConfig | null>("diag_autostart");
        } catch {
          /* no host / not armed — fall through to the last-opened path */
        }
        // Reopen the named project (automation) or the last one opened —
        // it replaces the layout restored above (and re-applies the
        // bus/DBC config). A stale pointer (file moved/deleted) is
        // cleared so it stops failing.
        //
        // `reopen_last_project` gates only the pointer: automation names
        // its project outright, and a run driven by `--project` must not
        // depend on a persisted preference. The host makes the same
        // decision for the project *directory* before the WebView
        // exists, so with the setting off this session is already rooted
        // in the auto-located directory and there is nothing to open.
        const projectToOpen =
          cfg?.project ??
          (hostSettings().reopen_last_project ? hostState().last_project : null);
        if (projectToOpen) {
          try {
            const p = await invoke<Project>("open_project", { path: projectToOpen });
            // Awaited: the automation handoff below must not connect
            // while the project is still applying — a capture started
            // mid-apply flips views live and `applyProject`'s
            // `setRegistry(clearedTrace)` then stomps them back to
            // stopped (observed as every view born stopped in
            // self-driving runs).
            await applyProject(p, projectToOpen);
            rememberProject(projectToOpen);
            setDirty(false);
          } catch {
            rememberProject(null);
          }
        }
        // The boot has reached a conclusion either way — drop the
        // splash's hold on the app (the 5 s floor may still hold it).
        setBootSettled(true);
        // Say so in the log a launch already writes: this line and the
        // restore's own "restored N frames … in X ms" bracket what a
        // launch cost, so a slow one can be attributed without a
        // stopwatch. Elapsed is measured from the frontend's load, which
        // the log's own timestamps place against process start.
        void invoke("gui_emit_system_log", {
          level: "info",
          source: "startup",
          message: `startup: interactive ${Math.round(performance.now())} ms after the frontend loaded`,
        }).catch(() => {});
        // Hand off to the orchestration effect, which connects /
        // captures / exits per the flags once the project has applied.
        if (cfg) setAutomation(cfg);
      })();
    },
    [seedDefaultLayout, applyProject, rememberProject],
  );

  const { resting: restingStatus, transient: transientStatus } = useMemo(
    () =>
      splitStatus({
        state,
        remoteSessions,
        dbcPaths,
        count,
        firstIndex,
        framesPerSecond,
        bufferSeconds,
        scratchBytes,
        memBytes,
      }),
    [
      state,
      remoteSessions,
      dbcPaths,
      count,
      firstIndex,
      framesPerSecond,
      bufferSeconds,
      scratchBytes,
      memBytes,
    ],
  );
  // Transient status notices (errors, completions, remote connect/error
  // summaries) flash in the header for a few seconds and mirror to the
  // system log, then the bar reverts to the resting residency line — a
  // notice is never lost (the log keeps it) but the label settles back
  // to the disk-spill readout (ADR 0002 DS-8). Keyed by level+text so an
  // unchanged notice logs once; a new/different one re-fires.
  const emitStatusToLog = useCallback((t: TransientStatus) => {
    void invoke("gui_emit_system_log", {
      level: t.level,
      source: "status",
      message: t.text,
    }).catch(() => {
      /* best effort - the bar still reverts on its own */
    });
  }, []);
  // How long a transient notice stays frozen in the header before the
  // bar reverts to the resting residency line (ADR 0002 DS-8). The
  // notice is mirrored to the system log so it outlives the flash,
  // which is why lengthening or shortening it loses nothing.
  const status = useTransientStatus(
    restingStatus,
    transientStatus,
    emitStatusToLog,
    useSetting("notice_dwell_ms"),
  );

  const traceData: TraceData = useMemo(() => {
    diagCount("memo.traceData"); // DIAG
    return {
      count,
      firstIndex,
      // The truncation marker exists only once eviction has truncated the
      // oldest history (`firstIndex > 0`); otherwise there's nothing to mark.
      truncationTsNs: firstIndex > 0 ? firstIndexTsNs : null,
      sessionStartSeconds,
      epoch: traceEpoch,
      fetchRange,
      liveTail,
    };
  }, [count, firstIndex, firstIndexTsNs, sessionStartSeconds, traceEpoch, fetchRange, liveTail]);

  const elementRegistryValue: ElementRegistry = useMemo(
    () => ({
      entries: (diagCount("memo.elementRegistryValue"), registry), // DIAG

      get: (id) => registry.find((e) => e.element.id === id),
      create,
      ensure,
      updateTrace,
      update: updateElement,
      remove: removeElement,
    }),
    [registry, create, ensure, updateTrace, updateElement, removeElement],
  );

  const remoteConnected = Array.from(remoteSessions.values()).some(
    (s) => s.kind === "running" || s.kind === "connecting",
  );
  // Strictly "a session is up", for the perf-capture connect-retry loop —
  // unlike `remoteConnected` above, a merely "connecting" session doesn't
  // count, since that's exactly the state a retry must not mistake for
  // success.
  remoteConnectedRef.current = Array.from(remoteSessions.values()).some(
    (s) => s.kind === "running",
  );
  const connectedAddresses = useMemo(
    () =>
      Array.from(remoteSessions.entries())
        .filter(([, s]) => s.kind === "running")
        .map(([addr]) => addr),
    [remoteSessions],
  );
  // A bus is "connected" when its interface binding resolves to one
  // of the running session addresses. The transmit panel gates
  // send / start on this.
  const connectedBusIds = useMemo(() => {
    const set = new Set<string>();
    for (const b of interfaceBindings) {
      const resolved = resolveServer(b.server, sidecarAddress);
      if (resolved && connectedAddresses.includes(resolved)) {
        set.add(b.bus_id);
      }
    }
    return Array.from(set);
  }, [interfaceBindings, sidecarAddress, connectedAddresses]);

  // Buses whose live hardware config (snapshot taken at connect) no
  // longer matches the edited project. Only buses with an active
  // session contribute — there's nothing to be "pending against" for
  // a bus that isn't connected. Reconnect applies the change.
  const busesWithPendingHwConfig = useMemo(() => {
    const dirty: string[] = [];
    const connected = new Set(connectedBusIds);
    for (const bus of buses) {
      if (!connected.has(bus.id)) continue;
      const snapshot = busConfigInFlight.get(bus.id);
      if (!snapshot) continue;
      const speed = bus.speed_bps ?? null;
      const fd = bus.fd ?? null;
      const dataSpeed = bus.fd_data_speed_bps ?? null;
      if (
        snapshot.speed_bps !== speed ||
        snapshot.fd !== fd ||
        snapshot.fd_data_speed_bps !== dataSpeed
      ) {
        dirty.push(bus.id);
      }
    }
    return dirty;
  }, [buses, busConfigInFlight, connectedBusIds]);

  const blfPath =
    state.kind === "loading" || state.kind === "running" || state.kind === "done"
      ? state.result.blf_path
      : null;

  const projectContextValue: ProjectContextValue = useMemo(
    () => ({
      projectPath: (diagCount("memo.projectContextValue"), projectPath), // DIAG

      dirty,
      dbcPaths,
      dbcBuses,
      buses,
      interfaceBindings,
      connectedAddresses,
      remoteConnected,
      connectedBusIds,
      blfPath,
      onNewProject: handleNewProject,
      onOpenProject: handleOpenProject,
      onSaveProject: handleSaveProject,
      onSaveProjectAs: handleSaveProjectAs,
      onAddDbc: handleAddDbc,
      onRemoveDbc: handleRemoveDbc,
      onReloadDbc: handleReloadDbc,
      onSetDbcBuses: handleSetDbcBuses,
      onAddBus: handleAddBus,
      onRemoveBus: handleRemoveBus,
      onUpdateBus: handleUpdateBus,
      busesWithPendingHwConfig,
      onAddBinding: handleAddBinding,
      onRemoveBinding: handleRemoveBinding,
      onConnect: handleConnect,
      onDisconnect: handleDisconnect,
      localVirtualBuses,
      onAddVirtualBus: handleAddVirtualBus,
      onRemoveVirtualBus: handleRemoveVirtualBus,
      onUpdateVirtualBus: handleUpdateVirtualBus,
      signalColors,
      onSetSignalColor: handleSetSignalColor,
    }),
    [
      projectPath,
      dirty,
      dbcPaths,
      dbcBuses,
      buses,
      interfaceBindings,
      connectedAddresses,
      remoteConnected,
      connectedBusIds,
      blfPath,
      handleNewProject,
      handleOpenProject,
      handleSaveProject,
      handleSaveProjectAs,
      handleAddDbc,
      handleRemoveDbc,
      handleReloadDbc,
      handleSetDbcBuses,
      handleAddBus,
      handleRemoveBus,
      handleUpdateBus,
      busesWithPendingHwConfig,
      handleAddBinding,
      handleRemoveBinding,
      handleConnect,
      handleDisconnect,
      localVirtualBuses,
      handleAddVirtualBus,
      handleRemoveVirtualBus,
      handleUpdateVirtualBus,
      signalColors,
      handleSetSignalColor,
    ],
  );

  // Command-backed toolbar (ADR 0037): an ordered list of command ids —
  // every button dispatches through `runCommand`, so a click gets the same
  // recent-tracking and context gate as the palette and keyboard. The few
  // buttons that carry view-extras (the Connect/Disconnect toggle, the
  // disabled-while-empty Clear/Save, the Recent-BLFs dropdown, the unread
  // badge) stay bespoke, keyed by a sentinel and interleaved in order.
  type ToolbarItem =
    | "sep"
    | "connection"
    | "recentBlfs"
    | "systemMessages"
    | { id: string; label: string; disabled?: boolean };
  const toolbarItems: ToolbarItem[] = [
    { id: "project.open", label: "Open project…" },
    { id: "project.save", label: "Save project" },
    "sep",
    { id: "blf.open", label: "Open BLF…" },
    "recentBlfs",
    { id: "dbc.add", label: "Add DBC…" },
    "sep",
    "connection",
    "sep",
    { id: "capture.clear", label: "Clear", disabled: count === 0 },
    { id: "capture.save", label: "Save capture…", disabled: count === 0 },
    "sep",
    { id: "panel.add.trace", label: "Add trace" },
    { id: "panel.add.plot", label: "Add plot panel" },
    { id: "panel.add.signals", label: "Add signal view" },
    { id: "panel.add.transmit", label: "Add transmit panel" },
    { id: "panel.add.rbs", label: "Add RBS panel" },
    { id: "panel.add.colormap", label: "Add color map" },
    { id: "panel.add.generator", label: "Add generator" },
    { id: "panel.show.dbc", label: "DBC panel" },
    { id: "panel.show.projectGraph", label: "Graph panel" },
    { id: "panel.show.events", label: "Events panel" },
    { id: "panel.show.project", label: "Project panel" },
    "systemMessages",
  ];
  const renderToolbarItem = (item: ToolbarItem, i: number) => {
    if (item === "sep") {
      return <span key={`sep-${i}`} className="toolbar-separator" aria-hidden="true" />;
    }
    if (item === "recentBlfs") {
      if (recentBlfs.length === 0) return null;
      return (
        <details key="recent-blfs" className="recent-blfs">
          <summary
            role="button"
            aria-label={`Recent BLFs (${recentBlfs.length})`}
            title="Recent BLFs"
          >
            Recent
          </summary>
          <ul role="menu" className="recent-blfs-menu">
            {recentBlfs.map((p) => (
              <li key={p} role="menuitem">
                <button
                  onClick={(e) => {
                    // Close the <details> panel; React state drives the rest.
                    const el = (e.currentTarget as HTMLElement).closest("details");
                    if (el instanceof HTMLDetailsElement) el.open = false;
                    void handleOpenLog(p);
                  }}
                  title={p}
                >
                  {p}
                </button>
              </li>
            ))}
          </ul>
        </details>
      );
    }
    if (item === "connection") {
      return remoteConnected ? (
        <button key="connection" onClick={() => runCommand("connection.disconnect")}>
          Disconnect
        </button>
      ) : (
        <button
          key="connection"
          onClick={() => runCommand("connection.connect")}
          disabled={interfaceBindings.length === 0}
          title={
            interfaceBindings.length === 0
              ? "Add interface bindings in the project panel first"
              : undefined
          }
        >
          Connect
        </button>
      );
    }
    if (item === "systemMessages") {
      const unread = systemLog.unread;
      return (
        <button
          key="system-messages"
          onClick={() => runCommand("panel.show.systemMessages")}
          className="system-messages-button"
          aria-label={unread > 0 ? `System messages (${unread} unread)` : "System messages"}
        >
          System messages
          {unread > 0 && (
            <span className="system-messages-badge" aria-hidden="true">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      );
    }
    return (
      <button key={item.id} onClick={() => runCommand(item.id)} disabled={item.disabled}>
        {item.label}
      </button>
    );
  };

  return (
    <main className="app">
      <header>
        <div className="toolbar">{toolbarItems.map(renderToolbarItem)}</div>
        <div
          className="status"
          title="buffered frames · frame rate · elapsed capture · resident memory (app + WebView) · disk-spill cache on disk"
        >
          {status}
        </div>
      </header>
      <ProjectContext.Provider value={projectContextValue}>
        <SignalCatalogProvider>
          <ElementRegistryContext.Provider value={elementRegistryValue}>
            <SignalGeneratorProvider>
            <SystemLogContext.Provider value={systemLogValue}>
              <NotesContext.Provider value={notesValue}>
                <TraceDataProvider value={traceData}>
                  <KeybindingsContext.Provider value={commands.keybindings}>
                  <PanelCommandsContext.Provider value={commands.panelCommands}>
                    {/* dockview drags tabs with the HTML5 drag-and-drop API, which
                        Tauri's OS-level drag-drop handler breaks on WebView2 — hence
                        `dragDropEnabled: false` in tauri.conf.json. The GUI takes
                        files via the dialog plugin, not by drop, so nothing is lost. */}
                    {/* `defaultTabComponent`: dockview-core's built-in tab
                        closes only via its close button; the React default
                        tab (same DOM, same class names) adds close on
                        middle-click. The `mousedown` capture listener above
                        keeps the browser's middle-button autoscroll from
                        eating the press. */}
                    <DockviewReact
                      className="dock-area"
                      theme={dockTheme}
                      components={DOCK_COMPONENTS}
                      defaultTabComponent={DockviewDefaultTab}
                      onReady={handleDockReady}
                    />
                  </PanelCommandsContext.Provider>
                  </KeybindingsContext.Provider>
                </TraceDataProvider>
              </NotesContext.Provider>
            </SystemLogContext.Provider>
            </SignalGeneratorProvider>
          </ElementRegistryContext.Provider>
        </SignalCatalogProvider>
      </ProjectContext.Provider>
      {commands.palettes}
      {pendingClose && <CloseConfirmModal onChoice={pendingClose.resolve} />}
      {confirmingClearColors && (
        <ClearColorsConfirmModal
          onChoice={(confirmed) => {
            setConfirmingClearColors(false);
            if (confirmed) handleClearProjectColors();
          }}
        />
      )}
      {pendingBlf && (
        <BlfChannelMapModal
          blfPath={pendingBlf.blfPath}
          scan={pendingBlf.scan}
          buses={buses}
          initial={savedBlfChannelMap(
            hostState().blf_channel_maps,
            pendingBlf.blfPath,
            pendingBlf.scan.channels.length,
            new Set(buses.map((b) => b.id)),
          )}
          onConfirm={handleBlfMapConfirm}
          onCancel={() => setPendingBlf(null)}
        />
      )}
      {splashVisible && <SplashOverlay />}
    </main>
  );
}


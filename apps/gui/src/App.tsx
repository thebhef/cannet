import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { DockviewDefaultTab, DockviewReact, themeAbyss, themeLight } from "dockview";
import type { DockviewApi, DockviewReadyEvent } from "dockview";

import type {
  BlfScanResult,
  Bus,
  DbcInfo,
  DbcRef,
  ImportMdfResult,
  InterfaceBinding,
  InterfaceRecord,
  LoadProgress,
  LocalVirtualBusDef,
  LogFinished,
  MdfScanResult,
  OpenLogResult,
  Project,
  ProjectElement,
  ProjectElementKind,
  RbsDirtyRecord,
  RebuildProgress,
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
import { RbsSignalsPanel } from "./RbsSignalsPanel";
import { ChangedOnDiskNotice } from "./ChangedOnDiskNotice";
import { LoadProgressChip } from "./LoadProgressChip";
import { ColorMapPanel } from "./ColorMapPanel";
import { GeneratorPanel } from "./GeneratorPanel";
import { SystemMessagesPanel } from "./SystemMessagesPanel";
import { DatabasePanel } from "./DatabasePanel";
import { ViewSignalsPanel } from "./ViewSignalsPanel";
import { SettingsPanel } from "./SettingsPanel";
import { AboutPanel } from "./AboutPanel";
import { EventsPanel } from "./EventsPanel";
import { BusHealthPanel } from "./BusHealthPanel";
import { busHealthConcerns, busHealthRows, useBusHealth } from "./busHealth";
import { SystemLogContext, type SystemLogContextValue } from "./systemLogContext";
import {
  EMPTY_SYSTEM_LOG_MIRROR,
  type SystemLogMirror,
  clearSystemLogMirror,
  markSystemLogRead,
  mergeSystemMessage,
  reconcileSnapshot,
} from "./systemLog";
import {
  capturePath,
  splitStatus,
  statusMetrics,
  statusMetricsTooltip,
  type LogState,
  type RemoteStatus,
  type TransientStatus,
} from "./statusLine";
import { useTransientStatus } from "./useTransientStatus";
import { hostSettings, useSetting } from "./hostSettings";
import { NotesContext, type NotesContextValue } from "./notesContext";
import type { Note } from "./notes";
import { sortNotesChronologically } from "./notes";
import { ShortcutsPanel } from "./ShortcutsPanel";
import { KeybindingsContext } from "./keybindingsContext";
import { recordRecentCapture, forgetRecentCapture } from "./recentCaptures";
import { recordRecentProject, forgetRecentProject } from "./recentProjects";
import {
  DEFAULT_SAVE_CAPTURE_NAME,
  SAVE_CAPTURE_FILTERS,
  saveFormatFor,
} from "./saveFormat";
import { IMPORT_TRACE_FILTERS, importFormatFor } from "./importFormat";
import {
  hostState,
  hydrateState,
  setRecentCaptures as persistRecentCaptures,
  setRecentProjects as persistRecentProjects,
  setLastProject as persistLastProject,
  setLayout as persistLayout,
  setBlfChannelMaps as persistBlfChannelMaps,
} from "./hostState";
import { recordBlfChannelMap, savedBlfChannelMap } from "./blfChannelMap";
import type { SystemMessage } from "./types";
import { TraceDataProvider, type TraceData } from "./traceData";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { SignalCatalogProvider } from "./signalCatalogContext";
import { suppressDbcChanges, useDbcGeneration } from "./dbcChanged";
import { useViewSignalsAttentionCount } from "./viewSignalsAttention";
import { SignalGeneratorProvider } from "./signalGeneratorContext";
import { CloseConfirmModal, type CloseChoice } from "./CloseConfirmModal";
import { ServersPanel } from "./ServersPanel";
import { ServerTrustDialogs } from "./ServerTrustDialog";
import { raiseServerTrust } from "./serverTrust";
import { ClearColorsConfirmModal } from "./ClearColorsConfirmModal";
import { useThemeName } from "./theme";
import { SplashOverlay, useSplashVisible } from "./SplashOverlay";
import {
  BlfChannelMapModal,
  type ImportContents,
  type ImportRange,
} from "./BlfChannelMapModal";
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
  stopTrace,
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
  RBS_SIGNALS_PANEL_COMPONENT,
  SETTINGS_PANEL_COMPONENT,
  ABOUT_PANEL_COMPONENT,
  EVENTS_PANEL_COMPONENT,
  BUS_HEALTH_PANEL_COMPONENT,
  SERVERS_PANEL_COMPONENT,
  SHORTCUTS_PANEL_COMPONENT,
  SIGNALS_PANEL_COMPONENT,
  SYSTEM_MESSAGES_PANEL_COMPONENT,
  TRACE_PANEL_COMPONENT,
  TRANSMIT_PANEL_COMPONENT,
  VIEW_SIGNALS_PANEL_COMPONENT,
  elementPanelComponent,
  elementPanelTitle,
  normalizeSingletonTitles,
  panelsForElementId,
  showRbsSignalsPanel,
  stripMaximizedNode,
  validateLayout,
} from "./dockLayout";
import { StatusBar, type StatusBarChip } from "./StatusBar";
import { Toolbar } from "./Toolbar";
import { summarizeConnection, unboundBusError, useConnectionStates } from "./connectionStates";
import { useRbsAttentionCount } from "./rbsAttention";
import {
  EMPTY_FOCUS_HISTORY,
  initLayoutHistory,
  recordFocus,
  recordLayout,
  type FocusHistory,
  type LayoutHistory,
} from "./viewHistory";
import {
  EMPTY_UNDO_ORDER,
  amendElements,
  initElementHistory,
  recordElements,
  recordStep,
  redoElements,
  restoreElements,
  syncElements,
  undoElements,
  type ElementCreate,
  type ElementHistory,
  type UndoOrder,
} from "./elementHistory";
import { UndoGestureContext, type UndoGesture } from "./undoGesture";
import { EMPTY_LINK_HISTORY, type LinkHistory, type LinkStep } from "./eventLinkHistory";
import { useEventLinkUndo } from "./useEventLinkUndo";
import { PanelCommandsContext } from "./panelCommands";
import { useCommands } from "./useCommands";
import {
  beginDiagCapture,
  diagCount,
  diagGauge,
  endDiagCapture,
  setDiagEnabled,
  startDiagReporter,
} from "./diag"; // DIAG
import {
  INTERACT_WARMUP_MS,
  parseInteractScript,
  startPerfInteraction,
} from "./perfInteract";
import type { PerfInteraction } from "./perfInteract";

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
  rbsRunOnStart: boolean;
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

/// How often the rebuild chip asks the host whether the discarded signal
/// caches have caught up. Only runs while the chip is up, and the answer
/// is a couple of map lookups, so a second is generous — the chip is
/// there for a minutes-long wait, not a millisecond one.
const REBUILD_POLL_MS = 1000;

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
  [RBS_SIGNALS_PANEL_COMPONENT]: RbsSignalsPanel,
  [COLORMAP_PANEL_COMPONENT]: ColorMapPanel,
  [GENERATOR_PANEL_COMPONENT]: GeneratorPanel,
  [PROJECT_GRAPH_PANEL_COMPONENT]: ProjectGraphPanel,
  [SYSTEM_MESSAGES_PANEL_COMPONENT]: SystemMessagesPanel,
  [DBC_PANEL_COMPONENT]: DatabasePanel,
  [VIEW_SIGNALS_PANEL_COMPONENT]: ViewSignalsPanel,
  [SETTINGS_PANEL_COMPONENT]: SettingsPanel,
  [ABOUT_PANEL_COMPONENT]: AboutPanel,
  [EVENTS_PANEL_COMPONENT]: EventsPanel,
  [BUS_HEALTH_PANEL_COMPONENT]: BusHealthPanel,
  [SHORTCUTS_PANEL_COMPONENT]: ShortcutsPanel,
  [SERVERS_PANEL_COMPONENT]: ServersPanel,
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
  // DIAG. The reporter is unconditional — it carries the host's
  // UI-liveness heartbeat — but the diagnostic machinery it feeds is
  // armed only when the launch asked for it (`--diag`, implied by the
  // perf-capture flags; see `diag::diag_enabled_from_args`).
  useEffect(() => {
    const stop = startDiagReporter();
    let cancelled = false;
    void invoke<boolean>("diag_enabled")
      .then((on) => {
        if (!cancelled && on) setDiagEnabled(true);
      })
      .catch(() => {
        /* no host (tests, dev preview) — stay off */
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);
  const [count, setCount] = useState(0);
  // Windowed-ring low-water mark from `trace-grew` (ADR 0002 DS-8): the
  // chronological window clamps its start up to this so truncated rows below
  // the floor aren't rendered as blank placeholders. `0` until eviction.
  const [firstIndex, setFirstIndex] = useState(0);
  // Absolute ns of the oldest retained frame from `trace-grew` — where the
  // derived truncation marker sits (ADR 0035). `null` until a tick carries it.
  const [firstIndexTsNs, setFirstIndexTsNs] = useState<number | null>(null);
  // The restore discarded the signal pyramids a prior session persisted
  // (ADR 0047), so every plotted signal is decoded again from frame zero
  // — minutes on a large capture, and silent until now. The host says so
  // (`restore_scratch_capture`'s own answer); the frontend never infers
  // it from how slow a plot feels.
  const [rebuildingCaches, setRebuildingCaches] = useState(false);
  // The rebuild's own progress, polled alongside the still-rebuilding
  // fact. `null` until the first poll answers.
  const [rebuildProgress, setRebuildProgress] = useState<RebuildProgress | null>(null);
  const [framesPerSecond, setFramesPerSecond] = useState(0);
  // `null`, never zero: a loaded file has no wire and a bus with no
  // known bitrate has nothing to divide by, and the bar leaves the
  // metric out rather than reporting an idle wire that does not exist.
  const [busLoadPercent, setBusLoadPercent] = useState<number | null>(null);
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
  // Mirror of the load state for the `log-finished` listener, which is
  // registered once and would otherwise close over the kind it saw at
  // mount. The event fires for a live session's pump as well as a
  // file's, and only the file's ends a capture.
  const stateKindRef = useRef(state.kind);
  stateKindRef.current = state.kind;
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
  // Path of a project file the host says changed on disk while applying
  // it was not safe (ADR 0053 §1). Non-null renders the notice in the
  // header; the notice's Reload is the only thing that applies it.
  const [projectChangedOnDisk, setProjectChangedOnDisk] = useState<string | null>(null);
  // A notice refers to something, and goes when that something is gone
  // (the contract `ChangedOnDiskNotice` carries). For the project that
  // is four moments — the file is re-opened, reloaded, saved over, or
  // closed — and they are wired here because the state that raises the
  // notice is frontend state. The RBS panel's equivalent is host state
  // and so cannot go stale at all.
  const clearProjectDiskNotice = useCallback(() => setProjectChangedOnDisk(null), []);
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
  // The notes as of this render, for the callbacks that must read them
  // without re-binding on every note change — recording a link step has
  // to know which side already holds the reference.
  const notesRef = useRef<Note[]>(notes);
  notesRef.current = notes;
  // Recent captures (the N most-recently-imported BLF/MDF paths,
  // persisted host-side per ADR 0032). Offered in the Import-trace
  // flow; format routing at open time is by extension (`importFormat.ts`).
  const [recentCaptures, setRecentCaptures] = useState<string[]>(() => hostState().recent_blfs);
  const rememberRecentCapture = useCallback((path: string) => {
    setRecentCaptures((current) => {
      const next = recordRecentCapture(current, path);
      persistRecentCaptures(next);
      return next;
    });
  }, []);
  const dropRecentCapture = useCallback((path: string) => {
    setRecentCaptures((current) => {
      const next = forgetRecentCapture(current, path);
      persistRecentCaptures(next);
      return next;
    });
  }, []);
  // Recent projects (the N project files most recently opened or
  // saved-as). User-scope state (ADR 0042 §3), unlike the captures
  // above: it is how you get back to a project you are *not* in, so it
  // follows the person and a project switch leaves it alone — which is
  // why `rehydrateProjectState` below re-seeds the captures and not
  // this.
  const [recentProjects, setRecentProjects] = useState<string[]>(
    () => hostState().recent_projects,
  );
  const rememberRecentProject = useCallback((path: string) => {
    setRecentProjects((current) => {
      const next = recordRecentProject(current, path);
      persistRecentProjects(next);
      return next;
    });
  }, []);
  const dropRecentProject = useCallback((path: string) => {
    setRecentProjects((current) => {
      const next = forgetRecentProject(current, path);
      persistRecentProjects(next);
      return next;
    });
  }, []);
  // Re-read the host state after the session has moved to another
  // project directory, and re-seed the view state hydrated from it.
  // The project-scoped half of that state (ADR 0042 §3) is a different
  // file's now, and the recents list above is a *window* onto one of
  // its values — left alone it would keep showing the project we left
  // and, on the next import, write that merged list into the project we
  // just moved to.
  const rehydrateProjectState = useCallback(async () => {
    await hydrateState();
    setRecentCaptures(hostState().recent_blfs);
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
  // View navigation history + layout undo/redo (ADR 0050; pure state
  // in `viewHistory.ts`). `applyingLayoutRef` marks a
  // programmatic `fromJSON` so the layout-change echo it fires isn't
  // recorded as an undo step. `layoutHistoryRef` stays `null` until
  // the initial restore/seed settles.
  const focusHistoryRef = useRef<FocusHistory>(EMPTY_FOCUS_HISTORY);
  const layoutHistoryRef = useRef<LayoutHistory | null>(null);
  const applyingLayoutRef = useRef(false);
  // Element undo/redo (`elementHistory.ts`), the second stack: the
  // user's edits to the elements themselves, masked to ADR 0050's
  // allowlist. `undoOrderRef` interleaves it with the layout stack so
  // one chord reverses the most recent change whichever stack it lives
  // on. `pendingElementEditRef` is armed by the user-edit registry
  // callers (`updateElement` / `removeElement`) and read by the effect
  // that takes the snapshot — it is what separates an edit from the
  // registry churn (element creation, project open, session
  // re-anchoring) that must not become a step. `applyingElementsRef`
  // marks a restore in progress, so undo can't undo itself.
  const elementHistoryRef = useRef<ElementHistory>(initElementHistory([]));
  // Event links (`eventLinkHistory.ts`), the third stack. Steps rather
  // than snapshots — a link's inverse is another link — but ordered
  // against the other two by the same log, so one chord always reverses
  // the most recent change whichever stack it lives on.
  const linkHistoryRef = useRef<LinkHistory>(EMPTY_LINK_HISTORY);
  const undoOrderRef = useRef<UndoOrder>(EMPTY_UNDO_ORDER);
  const pendingElementEditRef = useRef(false);
  const applyingElementsRef = useRef(false);
  // The open undo *transaction* (`undoGesture.ts`), if any: the id both
  // stacks tag their steps with while one user gesture is in flight, and
  // whether that gesture has already taken its element step (later
  // writes amend it instead of piling up). `closing` marks a gesture
  // whose last write hasn't landed yet — the registry effect that lands
  // it is what finally closes the gesture.
  const gestureRef = useRef<{
    id: number;
    stepTaken: boolean;
    closing: boolean;
    /// Elements this gesture created — part of its step, so undoing it
    /// takes them away again. Every other element that appears is churn
    /// the history grafts in instead.
    created: string[];
  } | null>(null);
  const gestureCounterRef = useRef(0);
  // Detaches the open gesture's safety close (see `beginGesture`).
  const gestureSafetyCloseRef = useRef<(() => void) | null>(null);
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
  // Mirrors `remoteConnected` for the project-disk-watch listener, which
  // is registered once and must read the *current* session state rather
  // than the one captured when it subscribed. Broader than
  // `remoteConnectedRef` above: a session still connecting counts, since
  // re-rooting would drop that too.
  const sessionUpRef = useRef(false);

  // --- element registry ops ---
  // Latest bus list, mirrored into a ref so element creation can
  // pre-fill a transmit's `sinks` without taking `buses` as a
  // dependency of every `create` / `ensure` call site (those refs
  // change on every bus add/rename, which would invalidate panel
  // memoisation).
  const busesRef = useRef<readonly Bus[]>([]);
  busesRef.current = buses;

  // --- undo transactions (`undoGesture.ts`) ---
  // One user gesture is one undo step, however many writes it takes and
  // whichever stacks they land on: while a gesture is open, every step
  // either stack records joins its entry in the interleaved order log,
  // and every element write after the first amends that step rather than
  // making another.
  // Close whatever gesture is open, and disarm its safety close. The one
  // place the open gesture is dropped, so the listener below can never
  // outlive it.
  const clearGesture = useCallback(() => {
    gestureRef.current = null;
    gestureSafetyCloseRef.current?.();
    gestureSafetyCloseRef.current = null;
  }, []);
  const beginGesture = useCallback(() => {
    gestureCounterRef.current += 1;
    gestureSafetyCloseRef.current?.();
    gestureRef.current = {
      id: gestureCounterRef.current,
      stepTaken: false,
      closing: false,
      created: [],
    };
    // A pointer gesture is normally closed by the event that ends it,
    // but that event can go missing: a pointer released outside the
    // window delivers no `mouseup` at all. The next press is therefore
    // also a close — whatever interaction it starts, it is not this one,
    // and an edit it makes must be a step of its own.
    //
    // Capture phase, so it runs before the handler that would open the
    // *next* gesture; a listener added during this press's own dispatch
    // has already missed that press's capture phase, so a gesture can
    // never close itself.
    const onPress = () => clearGesture();
    document.addEventListener("pointerdown", onPress, true);
    gestureSafetyCloseRef.current = () =>
      document.removeEventListener("pointerdown", onPress, true);
  }, [clearGesture]);
  // Closing waits on a write that is armed but hasn't landed yet — a
  // drag's last persist arrives a render after the mouse comes up — so
  // the effect that lands it is what finally closes the gesture. With
  // nothing in flight the gesture ends here, and the next write is a
  // step of its own.
  const endGesture = useCallback(() => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (pendingElementEditRef.current) gesture.closing = true;
    else clearGesture();
  }, [clearGesture]);
  const undoGesture = useMemo<UndoGesture>(
    () => ({
      begin: beginGesture,
      end: endGesture,
      transact: (write) => {
        beginGesture();
        try {
          write();
        } finally {
          endGesture();
        }
      },
    }),
    [beginGesture, endGesture],
  );

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
        // Path picked in the panel. Run is host session state, off
        // until the panel's toggle turns it on (ADR 0028) — nothing
        // the project carries can transmit unasked.
        return { kind, id, name, path: null };
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
    // An element created *inside a gesture* is part of that gesture's
    // undo step — inserting a filter upstream creates one, and undoing
    // the insert has to take it away again. A bare `create` (a fresh
    // panel's element, a healed one) stays churn the present just
    // follows, so adding a panel remains a single layout step.
    if (gestureRef.current) {
      gestureRef.current.created.push(id);
      pendingElementEditRef.current = true;
    }
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
        // Arm the undo capture on the same "did anything change?" test,
        // for the same reason it can't happen inside the updater. The
        // snapshot itself is taken by the effect below, once the change
        // has landed — so several writes in one gesture (a filter
        // insert) capture once, from a base that is really there.
        // Excluded while a restore is replaying its own patches.
        if (!applyingElementsRef.current) pendingElementEditRef.current = true;
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
      // One gesture across both stacks: the element leaves the registry
      // and its panel closes, and a single chord brings both back.
      beginGesture();
      try {
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
        if (removed) pendingElementEditRef.current = true;
        setRegistry((prev) => prev.filter((e) => e.element.id !== id));
        const api = dockApiRef.current;
        // An RBS element can carry a second panel over the same
        // elementId (its signals grid) — `panelsForElementId`, not a
        // single `.find`, so removing the element closes every panel
        // referencing it rather than leaking the second one.
        const panels = panelsForElementId(api?.panels ?? [], id);
        if (api) for (const panel of panels) api.removePanel(panel);
      } finally {
        endGesture();
      }
    },
    [registry, beginGesture, endGesture],
  );
  // Latest registry, mirrored into a ref so the add-panel handlers
  // can compute the new element's default name (= the tab title)
  // without taking `registry` as a dependency.
  const registryRef = useRef<readonly RegistryEntry[]>([]);
  registryRef.current = registry;

  // Feed the element undo stack. Every registry change lands here; the
  // armed flag says whether it was a user edit (a step) or churn the
  // present just has to keep up with. Taking the snapshot *after* the
  // change means the step's base is the state that was really there,
  // and that a gesture making several writes in one batch is one step.
  useEffect(() => {
    const elements = registry.map((e) => e.element);
    const before = elementHistoryRef.current;
    const gesture = gestureRef.current;
    if (!pendingElementEditRef.current) {
      elementHistoryRef.current = syncElements(before, elements);
    } else {
      pendingElementEditRef.current = false;
      if (gesture?.stepTaken) {
        // A gesture that has already taken its step folds the rest of
        // its writes into it — a drag persists on every mouse move and
        // still costs one undo.
        elementHistoryRef.current = amendElements(before, elements);
      } else {
        const after = recordElements(
          before,
          elements,
          gesture ? new Set(gesture.created) : undefined,
        );
        elementHistoryRef.current = after;
        // `past` is only re-allocated when a step was actually pushed —
        // a masked-equal or config-seeding write keeps the same array.
        if (after.past !== before.past) {
          if (gesture) gesture.stepTaken = true;
          undoOrderRef.current = recordStep(undoOrderRef.current, "element", gesture?.id);
        }
      }
    }
    // The write a closing gesture was waiting on has landed.
    if (gesture?.closing) clearGesture();
  }, [registry, clearGesture]);

  // Put back the elements a restore re-creates, and drop the ones it
  // undoes into existence, in one registry write. A re-created element
  // is a *fresh* element of its kind with the snapshot's allowlisted
  // fields laid over it: nothing ADR 0050 excludes comes back (a
  // restored RBS is stopped and pathless, a restored transmit carries no
  // messages) and no host side effect is re-run — the panel's own
  // ensure / reconcile paths take it from there exactly as they would a
  // brand-new element. Removals here are registry-only for the same
  // reason: the panel half of the gesture is the layout stack's.
  const restoreElementSet = useCallback(
    (creates: readonly ElementCreate[], removes: readonly string[]) => {
      setRegistry((prev) => {
        let next = prev.filter((e) => !removes.includes(e.element.id));
        for (const { element, index } of creates) {
          const { id, kind, name, ...fields } = element;
          const label =
            typeof name === "string" ? name : defaultElementName(kind, next.map((e) => e.element));
          const fresh = { ...buildFreshElement(kind, id, label), ...fields } as ProjectElement;
          next = [
            ...next.slice(0, index),
            { element: fresh, trace: newElementTrace() },
            ...next.slice(index),
          ];
        }
        return next;
      });
    },
    [],
  );

  // Undo / redo one element step: step the stack, then move the registry
  // back to the snapshot — patching the allowlisted fields of the
  // elements it shares, re-creating the ones it has that the registry
  // lost, and dropping the ones the step brought into existence. The
  // patches carry no writer token, so every mounted panel on a changed
  // element resyncs from it. Returns whether anything was actually
  // restored; a step that turns out to be a no-op is consumed and the
  // caller moves on to the next one.
  const applyElementHistory = useCallback((dir: "undo" | "redo"): boolean => {
    const history = elementHistoryRef.current;
    const r = dir === "undo" ? undoElements(history) : redoElements(history);
    if (!r) return false;
    elementHistoryRef.current = r.history;
    const plan = restoreElements(
      r.snapshot,
      registryRef.current.map((e) => e.element),
    );
    applyingElementsRef.current = true;
    try {
      for (const { id, patch } of plan.patches) updateElement(id, patch);
      if (plan.creates.length > 0 || plan.removes.length > 0) {
        restoreElementSet(plan.creates, plan.removes);
      }
    } finally {
      applyingElementsRef.current = false;
    }
    return plan.patches.length + plan.creates.length + plan.removes.length > 0;
  }, [updateElement, restoreElementSet]);

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

  // The host's DBC-change carrier (ADR 0053), read here and nowhere
  // else in this file: a change to the loaded set re-decodes the
  // capture, so the model every window and plot fetches against is not
  // the one they fetched. This is the *only* route for a change the
  // frontend did not initiate — a file edited on disk, a capture's
  // embedded databases — and it costs one re-anchor however many
  // announcements the host made getting here.
  const dbcGeneration = useDbcGeneration();
  const seenDbcGenerationRef = useRef(dbcGeneration);
  useEffect(() => {
    if (seenDbcGenerationRef.current === dbcGeneration) return;
    seenDbcGenerationRef.current = dbcGeneration;
    invalidateCache();
  }, [dbcGeneration, invalidateCache]);

  // The signal mapping chip's live count: read here, independently of
  // whether the view-signals panel is mounted, so the badge stays live
  // with the panel closed.
  const viewSignalsAttentionCount = useViewSignalsAttentionCount();
  // The host's per-bus connection map, which the connection chip
  // aggregates. The host owns it; this only subscribes.
  const connStates = useConnectionStates();

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
          bus_load_percent,
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
          diagGauge(`fps.${b.bus_id}`, b.frames_per_second); // DIAG
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
        // Taken as reported: the host says "no session" with `null`, and
        // zero is a real origin — a log with no stated start time
        // anchors there (ADR 0024). Reading zero as "no origin" left the
        // plot falling back to its own window's first frame, so anything
        // to the left of it rendered at a negative time and the trace
        // table and the plot disagreed about the same instant.
        setSessionStartSeconds(session_start_seconds);
        setFramesPerSecond(frames_per_second);
        setBusLoadPercent(bus_load_percent);
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
      listen<LoadProgress>("load-progress", (event) => {
        setLoadProgress(event.payload);
      }),
    );

    unlistens.push(
      listen<LogFinished>("log-finished", (event) => {
        // Whatever the load did, it is over: the next one starts from no
        // report rather than inheriting this one's last fraction.
        setLoadProgress(null);
        if (event.payload.status === "ok") {
          // A cancelled pump ends through the identical clean-exit path
          // a natural EOF does (`cancel_import`'s cooperative flag just
          // makes `run_pump` stop early), and lands here on purpose: a
          // cancelled import keeps the frames it already appended and
          // reads as done at the count it stopped at — the user asked
          // it to stop, not to throw away what it had.
          const { total, count } = event.payload;
          // A file import that reached its end is a capture nothing more
          // will be appended to, so every trace element freezes there
          // rather than staying *running* over a buffer that has stopped
          // growing — a running element keeps each plot area's
          // self-paced re-sample loop alive for a picture that cannot
          // change (ADR 0024). Frozen at the event's own count, not at
          // the last `trace-grew` tick's: the sampler runs on a timer and
          // is up to a tick behind the pump, and an `end` below the true
          // length is what `reanchorToSession` would then make permanent.
          // A live session's pump exiting lands here too, and must not
          // freeze anything — hence the same load-state gate the
          // transition below uses.
          if (stateKindRef.current === "loading" || stateKindRef.current === "running") {
            setCount(count);
            setRegistry((reg) => reg.map((e) => ({ ...e, trace: stopTrace(e.trace, count) })));
          }
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

  // Both formats import through a channel → bus mapping step. The
  // outer pending state holds the picked path + its scan (channel
  // census, metadata, markers) while the modal is open; clicking
  // "Open" in the modal commits and the host pump starts. Kept as two
  // pending states (rather than one union) because the result types
  // and mapping-confirm commands genuinely differ per format.
  const [pendingBlf, setPendingBlf] = useState<{
    blfPath: string;
    scan: BlfScanResult;
  } | null>(null);
  const [pendingMdf, setPendingMdf] = useState<{
    mdfPath: string;
    scan: MdfScanResult;
  } | null>(null);
  // The path whose census is walking right now — the status line's
  // only sign of life between picking a file and the dialog opening.
  const [scanningBlfPath, setScanningBlfPath] = useState<string | null>(null);
  const [scanningMdfPath, setScanningMdfPath] = useState<string | null>(null);
  // The most recent `load-progress` report, or `null` while the phase in
  // flight has not reported one yet (and between loads). View-local by
  // construction: the numbers are the host's, this only remembers the
  // last pair it was told.
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>(null);

  // Pick → census → mapping dialog is one gesture, and only one of it
  // runs at a time: a second launch while the census walks would walk
  // its own and hand back its own dialog behind the first. The
  // pick-and-scan stretch is a ref because the guard has to close
  // synchronously, on the call, before any render; the dialog-is-up
  // stretch is the pending state itself, which cannot go stale.
  const traceOpenInFlight = useRef(false);

  // "Import trace…": one file-open dialog for both formats,
  // routed by the picked path's extension (`importFormatFor`) to the
  // format's own scan command — the host still never sniffs the file,
  // it just receives an explicit command choice made here. `presetPath`
  // is how the Recent-captures list and a failed-save retry skip the
  // dialog.
  const handleImportTrace = useCallback(
    async (presetPath?: string) => {
      // Cancelling is its own control now (`handleCancelLoad`), so a
      // launch while a load is in flight is just a launch too early:
      // ignore it rather than giving the button a second meaning the
      // user has to guess at.
      if (state.kind === "loading") return;
      if (traceOpenInFlight.current || pendingBlf !== null || pendingMdf !== null) return;
      traceOpenInFlight.current = true;
      try {
        const selected =
          typeof presetPath === "string" && presetPath.length > 0
            ? presetPath
            : await open({ multiple: false, filters: IMPORT_TRACE_FILTERS });
        if (typeof selected !== "string") return;

        // The census walks the whole file, which is seconds on a large
        // capture and all of it before the mapping dialog exists. Say
        // so, or the pick lands on an app that looks like it did
        // nothing.
        if (importFormatFor(selected) === "mdf") {
          setScanningMdfPath(selected);
          setLoadProgress(null);
          try {
            const scan = await invoke<MdfScanResult | null>("scan_mdf_channels", {
              mdfPath: selected,
            });
            // `null` is a cancelled census: it walked part of the file
            // and produced nothing, so there is no dialog to open and
            // nothing to undo. Drop the gesture and go back to idle.
            if (scan !== null) setPendingMdf({ mdfPath: selected, scan });
          } catch (err) {
            setState({ kind: "error", message: String(err) });
            // If we tried to open a recent file and it failed (path
            // moved, file deleted), drop it from the recents list so
            // it doesn't keep being offered.
            if (presetPath) dropRecentCapture(presetPath);
          } finally {
            setScanningMdfPath(null);
            setLoadProgress(null);
          }
          return;
        }

        setScanningBlfPath(selected);
        setLoadProgress(null);
        try {
          const scan = await invoke<BlfScanResult | null>("scan_blf_channels", {
            blfPath: selected,
          });
          // See the MDF branch: `null` is a cancelled census.
          if (scan !== null) setPendingBlf({ blfPath: selected, scan });
        } catch (err) {
          setState({ kind: "error", message: String(err) });
          if (presetPath) dropRecentCapture(presetPath);
        } finally {
          setScanningBlfPath(null);
          setLoadProgress(null);
        }
      } finally {
        traceOpenInFlight.current = false;
      }
    },
    [state.kind, dropRecentCapture, pendingBlf, pendingMdf],
  );

  // Stop the load in flight, whichever phase it is in. One host command
  // covers both (`cancel_import`): the phases are sequential, and the
  // host holds one cancel flag for whichever is running.
  //
  // The two ends differ in what they leave behind. A cancelled census
  // has produced nothing — its command resolves with `null` and
  // `handleImportTrace` drops the gesture. A cancelled pump keeps what
  // it already appended: it ends through the same clean-exit path a
  // natural EOF takes and the `log-finished` listener presents it as a
  // capture finished at the count the cancel stopped at.
  const handleCancelLoad = useCallback(async () => {
    try {
      await invoke("cancel_import");
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, []);

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
            dropRecentCapture(blfPath);
          },
        }))
      ) {
        return;
      }
      try {
        // A skipped channel is left out entirely: the host drops the
        // frames of any channel the mapping does not name, so "(skip)"
        // and "never mentioned" are the same instruction.
        const channelBusMapping = scan.channels
          .filter((ch) => choices[ch])
          .map((ch) => ({ channel: ch, busId: choices[ch] }));
        // Loading *before* the command, not on its resolution: the pump
        // thread the command spawns can finish — and emit its
        // `log-finished` — before the resolution is processed on a small
        // file, and the listener drops the event unless the state is
        // already `loading`. A `loading` set afterwards would then never
        // be cleared: that event was the only way out, and the host's
        // cancel flag is already gone. The result is just the path
        // echoed back, so nothing in it is worth waiting for.
        setState({ kind: "loading", result: { blf_path: blfPath } });
        await invoke<OpenLogResult>("open_log", {
          blfPath,
          channelBusMapping,
          startNs: range.startNs,
          endNs: range.endNs,
          // The census counted these frames a moment ago; handing the
          // count back is what makes the pump's progress determinate,
          // and is cheaper than any way of finding it again.
          totalFrames: scan.frame_count,
        });
        // Record on a successful open. Failures don't
        // promote a path — `handleImportTrace` drops it on the
        // recents-launch path.
        rememberRecentCapture(blfPath);
      } catch (err) {
        setState({ kind: "error", message: String(err) });
        dropRecentCapture(blfPath);
      }
    },
    [pendingBlf, resetSession, rememberRecentCapture, dropRecentCapture],
  );

  // Confirm the MDF channel mapping and actually start the pump.
  // Mirrors `handleBlfMapConfirm` exactly, modulo the command names and
  // result shape; the channel→bus mapping persistence (`blf_channel_maps`)
  // is keyed by path + channel count alone, so it needs no MDF-specific
  // counterpart and is reused as is.
  const handleMdfMapConfirm = useCallback(
    async (choices: Record<number, string>, range: ImportRange, contents: ImportContents) => {
      if (!pendingMdf) return;
      const { mdfPath, scan } = pendingMdf;
      setPendingMdf(null);
      persistBlfChannelMaps(recordBlfChannelMap(hostState().blf_channel_maps, mdfPath, choices));
      if (
        !(await resetSession({
          onError: (err) => {
            setState({ kind: "error", message: String(err) });
            dropRecentCapture(mdfPath);
          },
        }))
      ) {
        return;
      }
      try {
        // A skipped channel is left out entirely: the host drops the
        // frames of any channel the mapping does not name, so "(skip)"
        // and "never mentioned" are the same instruction.
        const channelBusMapping = scan.channels
          .filter((ch) => choices[ch])
          .map((ch) => ({ channel: ch, busId: choices[ch] }));
        // See `handleBlfMapConfirm`: `loading` must be set before the
        // command, or a pump that finishes first — a messages-less
        // import emits `log-finished` the moment its thread starts —
        // leaves the state stuck at `loading` forever.
        setState({ kind: "loading", result: { mdf_path: mdfPath } });
        await invoke<ImportMdfResult>("import_mdf", {
          mdfPath,
          channelBusMapping,
          startNs: range.startNs,
          endNs: range.endNs,
          importSignals: contents.signals,
          importMessages: contents.messages,
          // See `handleBlfMapConfirm`: the census's own count.
          totalFrames: scan.frame_count,
        });
        rememberRecentCapture(mdfPath);
      } catch (err) {
        setState({ kind: "error", message: String(err) });
        dropRecentCapture(mdfPath);
      }
    },
    [pendingMdf, resetSession, rememberRecentCapture, dropRecentCapture],
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
      // One set change, spread over `clear_dbcs` + an add and a re-scope
      // per database — each of which the host announces (ADR 0053 §2).
      // Held here so the frontend takes a single re-anchor at the end
      // rather than one per host call, which is the refresh storm this
      // path is on record for.
      const release = suppressDbcChanges();
      try {
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
      } finally {
        release();
      }
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

  /// The rebuild chip's offramp: drop the restored capture rather than
  /// wait out the re-decode. It is the same session clear Clear runs —
  /// the host wipes the raw store, the pyramids (abandoning a rebuild in
  /// flight with them, ADR 0048), the notes and the verification runtime
  /// — so there is one deletion path, not a second one that could leave
  /// a half-deleted scratch. What survives is the project: its file, its
  /// DBCs, the layout, the server/trust configuration. None of that is
  /// capture-scoped.
  const handleDiscardRestoredCapture = useCallback(async () => {
    // Down immediately: the click is the answer, and the host stops
    // announcing a rebuild that no longer has anything to rebuild.
    setRebuildingCaches(false);
    setRebuildProgress(null);
    await resetSession({
      onError: (err) => setState({ kind: "error", message: String(err) }),
      resetOnClearError: true,
    });
    // The restored capture's eviction mark goes with it — an empty
    // session has no dropped history, so no truncation marker (ADR 0035).
    setFirstIndex(0);
    setFirstIndexTsNs(null);
  }, [resetSession]);

  // The chip's end signal is the host's completeness token, aggregated
  // over the caches (ADR 0049): ask once a second whether the rebuild is
  // still owed, and only while the chip is up — an ordinary session
  // issues no poll at all. A poll rather than an event because the
  // answer is "where the decode cursors have reached", which no single
  // moment in the host corresponds to.
  useEffect(() => {
    if (!rebuildingCaches) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void invoke<RebuildProgress>("signal_pyramids_rebuilding")
        .then((progress) => {
          if (stopped) return;
          setRebuildProgress(progress);
          if (!progress.rebuilding) setRebuildingCaches(false);
        })
        .catch(() => {});
    }, REBUILD_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [rebuildingCaches]);

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
  /// Counts connect presses, so a repeated refusal carries a fresh
  /// `seq` and stays loud (see `TransientStatus.seq`).
  const connectAttemptRef = useRef(0);
  const handleConnect = useCallback(async () => {
    // A refusal is loud on *every* press: `seq` makes an identical
    // repeat re-flash the label and re-log, where an unchanged notice
    // would silently change nothing.
    const refuse = (message: string) => {
      connectAttemptRef.current += 1;
      setState({ kind: "error", message, seq: connectAttemptRef.current });
    };
    // Refuse loudly rather than silently subscribing to nothing: a
    // project with no buses, or with any bus that carries no
    // interface binding, names what's missing.
    const unboundError = unboundBusError(buses, interfaceBindings);
    if (unboundError !== null) {
      refuse(unboundError);
      return;
    }
    if (
      interfaceBindings.some(isLocalBinding) &&
      sidecarAddress === null
    ) {
      refuse(
        "Local sidecar isn't ready yet — wait for the Connection panel's Local row to go green, then Connect.",
      );
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
      refuse("No reachable servers — check the Connection panel.");
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
        // The user asked for this connection, so a trust question that
        // blocked it is one they are waiting on — the case a modal is
        // for. `raiseServerTrust` asks the host whether there is one:
        // a connection that failed for any other reason raises nothing.
        await raiseServerTrust(address);
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
    elementHistoryRef.current = initElementHistory([]);
    undoOrderRef.current = EMPTY_UNDO_ORDER;
    linkHistoryRef.current = EMPTY_LINK_HISTORY;
    clearGesture();
    focusHistoryRef.current = api.activePanel
      ? recordFocus(EMPTY_FOCUS_HISTORY, api.activePanel.id)
      : EMPTY_FOCUS_HISTORY;
  }, [create, clearGesture]);

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
  // The one place the session records which project file it is working
  // in: the last-project pointer and the recent-projects MRU are the
  // same fact at two depths, so they are written together rather than
  // at each of the four call sites. `null` — a New project, which has
  // no file yet — clears the pointer and adds nothing to the list.
  const rememberProject = useCallback(
    (path: string | null) => {
      setProjectPath(path);
      persistLastProject(path);
      if (path !== null) rememberRecentProject(path);
    },
    [rememberRecentProject],
  );

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
      // An opened project's elements are a fresh starting point too —
      // the undo history must not step back into the project that was
      // open before. (The effect above re-reads the present from the
      // registry once this render lands.)
      elementHistoryRef.current = initElementHistory([]);
      undoOrderRef.current = EMPTY_UNDO_ORDER;
      linkHistoryRef.current = EMPTY_LINK_HISTORY;
      clearGesture();
      const api = dockApiRef.current;
      const layout = validateLayout(project.layout);
      if (api && layout) {
        // An opened project replaces what was open wholesale; its
        // layout is a fresh baseline, not an undoable step from the
        // previous one — apply under the guard and restart both view
        // histories (same as `seedDefaultLayout`).
        applyingLayoutRef.current = true;
        try {
          api.fromJSON(normalizeSingletonTitles(layout));
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
            session_start_seconds: number | null;
            pyramids_rebuilding?: boolean;
          }>("restore_scratch_capture");
          if (restored.count <= 0) return;
          setRebuildingCaches(restored.pyramids_rebuilding === true);
          invalidateCache();
          setCount(restored.count);
          setFirstIndex(restored.first_index);
          setFirstIndexTsNs(restored.first_index_ts_ns);
          setSessionStartSeconds(restored.session_start_seconds);
          setRegistry((reg) => reg.map((e) => ({ ...e, trace: restoredTrace(restored.count) })));
        } catch {
          /* no scratch capture to restore */
        }
      })();
    },
    [loadDbcSet, invalidateCache, clearGesture],
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
    void (async () => {
      // An unsaved project is a project of its own (ADR 0042 §1/§7), in
      // the directory cannet auto-locates for it — so hand the session
      // back to the host and re-read the project-scoped state before
      // anything below writes any. In between, the host has moved but
      // the cached state is still the previous project's, and every
      // write flushes the whole struct: a `set_state` issued in that
      // window would deposit the project we just left into the one we
      // just moved to.
      await invoke("close_project").catch((err) => {
        console.error("close_project failed", err);
      });
      await rehydrateProjectState();
      seedDefaultLayout();
      rememberProject(null);
      // Nothing is open for a notice to refer to, and its Reload would
      // re-open the project the user has just closed.
      clearProjectDiskNotice();
      void loadDbcSet([], {});
      setDbcBuses({});
      // A project always has at least one bus — matching the id/name
      // scheme the project panel's own Add bus control uses.
      setBuses([{ id: "b1", name: "Bus 1" }]);
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
    })();
  }, [
    clearProjectDiskNotice,seedDefaultLayout, rememberProject, loadDbcSet, resetSession, rehydrateProjectState]);

  // Open the project at `path`. The one open path — the file picker, and
  // the disk watch's reload, both end here (ADR 0053 §1: a reload is the
  // existing open path, not a merge).
  const openProjectAt = useCallback(
    async (path: string) => {
      try {
        const project = await invoke<Project>("open_project", { path });
        // Opening a project re-roots the host onto that project's own
        // directory (ADR 0042 §1), so the project-scoped half of the host
        // state — the layout, its recent BLFs, its channel maps — is a
        // different file's now. Re-read before anything writes the previous
        // project's values into it.
        await rehydrateProjectState();
        void applyProject(project, path);
        rememberProject(path);
        setDirty(false);
        // Whatever a notice was pointing at, this project is what is
        // open now — including the case where *this* open is the
        // notice's own Reload.
        clearProjectDiskNotice();
      } catch (err) {
        setState({ kind: "error", message: String(err) });
        // The project was moved, renamed or deleted — stop offering it.
        // Nothing prunes the list ahead of time (`recentProjects.ts`):
        // an entry only leaves when opening it actually fails.
        dropRecentProject(path);
      }
    },
    [
      applyProject,
      clearProjectDiskNotice,
      dropRecentProject,
      rememberProject,
      rehydrateProjectState,
    ],
  );

  const handleOpenProject = useCallback(async () => {
    const selected = await open({
      multiple: false,
      // `.cannet_prj` is the convention; `.json` (the same content)
      // stays accepted for projects saved before the extension.
      filters: [{ name: "cannet project", extensions: ["cannet_prj", "json"] }],
    });
    if (typeof selected !== "string") return;
    await openProjectAt(selected);
  }, [openProjectAt]);

  // The open project file changed on disk. The host watches it and
  // announces; it applies nothing, because the two facts that decide
  // whether applying is safe live here (ADR 0053 §1) — whether the
  // in-memory project is dirty, and whether a session is up. Applying is
  // `openProjectAt`, which re-roots the session and drops the
  // connection, so:
  //
  // - clean *and* nothing connected → apply silently; there is nothing
  //   of the user's to lose and no interruption worth raising.
  // - otherwise → notify. Mid-capture is a precondition, not a weight:
  //   a clean project reloaded under a running capture still ends it.
  //
  // Read through refs so the listener registers once and still sees the
  // current state, rather than the state it subscribed with.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen<string>("project-changed", (event) => {
      const path = typeof event.payload === "string" ? event.payload : projectPathRef.current;
      if (!path) return;
      if (!dirtyRef.current && !sessionUpRef.current) void openProjectAt(path);
      else setProjectChangedOnDisk(path);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openProjectAt]);

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
        if (promote) await rehydrateProjectState();
        rememberProject(path);
        setDirty(false);
        // The file now holds what the session holds, so a pending
        // "changed on disk" no longer describes anything.
        clearProjectDiskNotice();
        return true;
      } catch (err) {
        setState({ kind: "error", message: String(err) });
        return false;
      }
    },
    [clearProjectDiskNotice, gatherProject, rememberProject, rehydrateProjectState],
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

  // Save Capture: write the session buffer to a capture file.
  // System Messages handle the user-visible success / failure
  // feedback; this just routes through the host command.
  //
  // One gesture, two formats: the dialog's filter list offers Vector BLF
  // and ASAM MDF, and the chosen filter travels to the host as an
  // explicit `format` (see `saveFormat.ts` for why the mapping lives on
  // this side). BLF carries frames and notes; MDF also carries the
  // capture's file-backed signals and the project's DBCs.
  //
  // The project's ordered `buses` list IS the channel order in either
  // format (see CLAUDE.md § File formats). Frames get re-channeled by
  // the host so that bus index N → channel N; on reload the channel map
  // modal seeds matching pairs.
  const handleSaveCapture = useCallback(async () => {
    if (count === 0) return;
    const path = await save({
      defaultPath: DEFAULT_SAVE_CAPTURE_NAME,
      filters: SAVE_CAPTURE_FILTERS,
    });
    if (typeof path !== "string" || path.length === 0) return;
    const format = saveFormatFor(path);
    try {
      await invoke("save_capture", {
        path,
        format,
        buses: buses.map((b) => b.id),
      });
      // A newly-saved capture is a reasonable Recent-captures candidate
      // (the user just produced this file; re-opening it is the
      // archetypal "what did I just save?" gesture) — either format.
      rememberRecentCapture(path);
    } catch {
      // Failure surfaces in the System Messages panel via the
      // host's `capture`-tagged error log; nothing more to do here.
    }
  }, [buses, count, rememberRecentCapture]);

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
    let interaction: PerfInteraction | null = null;
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
            interaction = startPerfInteraction(
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
          // The tally rides with the report: a run whose script found
          // none of its targets must be visible in the data, not just
          // structurally identical to a good one.
          await endDiagCapture(automation.out ?? undefined, interaction?.tally());
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
        interaction?.stop();
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
      interaction?.stop();
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
  //
  // Each path goes through `add_dbc`, which swaps it in place and so
  // keeps its bus assignment and priority position — deliberately *not*
  // through `loadDbcSet`, whose `clear_dbcs` would make every re-read
  // look to the host like a first load and hide that it is reloading
  // definitions something may be transmitting from (ADR 0053 §1).
  const handleReloadDbc = useCallback(async () => {
    if (dbcPaths.length === 0) return;
    // One set change spread over a call per database, as `loadDbcSet`
    // does it: a single re-anchor at the end rather than one per call.
    const release = suppressDbcChanges();
    try {
      let list: string[] = [...dbcPaths];
      const errors: string[] = [];
      for (const path of dbcPaths) {
        try {
          list = (await invoke<DbcInfo[]>("add_dbc", { path })).map((d) => d.dbc_path);
        } catch (err) {
          errors.push(`${path}: ${String(err)}`);
          try {
            list = (await invoke<DbcInfo[]>("remove_dbc", { path })).map((d) => d.dbc_path);
          } catch {
            /* the host kept it; the error above is what the user sees */
          }
        }
      }
      setDbcPaths(list);
      invalidateCache();
      if (errors.length > 0) setState({ kind: "error", message: `DBC: ${errors.join("; ")}` });
    } finally {
      release();
    }
  }, [dbcPaths, invalidateCache]);

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
  // path appears / changes, unload when the element goes away. Owned
  // here (not by the panel) so an element's config is on the host even
  // when its panel isn't in the layout. Run is not reconciled — it is
  // host session state with no project copy to push — with one
  // exception: an unattended measurement launch asks for the
  // simulation outright (`--rbs-run-on-start`, ADR 0031), because a
  // project file cannot carry that any more and a report of an idle
  // bus measures nothing.
  const rbsHostStateRef = useRef<Map<string, { path: string | null }>>(new Map());
  const rbsRunOnStartRef = useRef(false);
  rbsRunOnStartRef.current = automation?.rbsRunOnStart === true;
  // Per-element op queue: the reconciler fires across renders (a
  // layout-restored panel ensures a pathless element moments before
  // the opened project replaces it with the saved path), and the
  // rbs_* commands run concurrently on the async pool — unserialized,
  // an early rbs_init could land after the project's rbs_load.
  // Chaining per element keeps host ops in dispatch order.
  const rbsOpsRef = useRef<Map<string, Promise<unknown>>>(new Map());
  /// Chained onto an element's load / init so the measurement launch's
  /// arming lands after the config the host is about to schedule from.
  /// A normal launch adds nothing.
  const armRbs = useCallback(
    (id: string) => () =>
      rbsRunOnStartRef.current
        ? invoke("rbs_set_run", { elementId: id, run: true })
        : Promise.resolve(),
    [],
  );
  const queueRbsOp = useCallback((id: string, op: () => Promise<unknown>) => {
    const prev = rbsOpsRef.current.get(id) ?? Promise.resolve();
    const next = prev.then(op).catch(() => {});
    rbsOpsRef.current.set(id, next);
  }, []);
  useEffect(() => {
    const current = new Map<string, { path: string | null }>();
    for (const e of registry) {
      if (e.element.kind === "rbs") {
        current.set(e.element.id, { path: e.element.path });
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
        queueRbsOp(id, () => invoke("rbs_load", { elementId: id, path }).then(armRbs(id)));
      } else if (now.path == null && !prev) {
        // A fresh element needs no file: the host seeds an in-memory
        // config from the project's current buses (saving is explicit).
        queueRbsOp(id, () => invoke("rbs_init", { elementId: id }).then(armRbs(id)));
      }
    }
    rbsHostStateRef.current = current;
  }, [registry, queueRbsOp]);
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
      const title = elementPanelTitle(panel.id, elementLabel(entry.element));
      if (panel.title !== title) {
        diagCount("dockview.setTitle"); // DIAG
        panel.api.setTitle(title);
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
  const addNoteRemote = useCallback((note: Note) => {
    // The whole note goes over as one struct: every field the caller
    // left off is `#[serde(default)]` host-side, so an event with no
    // color or no subjects costs nothing to send.
    void invoke("add_note", { note }).catch(() => {
      /* best effort — error surfaces in System Messages */
    });
  }, []);
  const renameNoteRemote = useCallback((id: string, label: string) => {
    void invoke("rename_note", { id, label }).catch(() => { /* best effort */ });
  }, []);
  const recolorNoteRemote = useCallback((id: string, color: string | null) => {
    void invoke("recolor_note", { id, color }).catch(() => { /* best effort */ });
  }, []);
  const describeNoteRemote = useCallback((id: string, description: string | null) => {
    void invoke("describe_note", { id, description }).catch(() => { /* best effort */ });
  }, []);
  const retagNoteRemote = useCallback((id: string, tag: string | null) => {
    void invoke("retag_note", { id, tag }).catch(() => { /* best effort */ });
  }, []);
  const removeNoteRemote = useCallback((id: string) => {
    void invoke("remove_note", { id }).catch(() => { /* best effort */ });
  }, []);
  // Event links are the third undo stack (ADR 0050) — steps rather than
  // snapshots, ordered against the other two by the shared log.
  const dispatchLink = useCallback((step: LinkStep) => {
    if (step.kind === "subjects") {
      void invoke("set_note_subjects", { id: step.eventId, subjects: step.after }).catch(() => {
        /* best effort */
      });
      return;
    }
    const cmd = step.linked ? "link_events" : "unlink_events";
    void invoke(cmd, { a: step.stores, b: step.other }).catch(() => { /* best effort */ });
  }, []);
  const gestureId = useCallback(() => gestureRef.current?.id, []);
  const {
    linkEvents: linkEventsRemote,
    unlinkEvents: unlinkEventsRemote,
    setNoteSubjects: setNoteSubjectsRemote,
    applyEventLinkHistory,
  } = useEventLinkUndo({
    notesRef,
    linkHistoryRef,
    undoOrderRef,
    gestureId,
    dispatch: dispatchLink,
  });
  const notesValue: NotesContextValue = useMemo(
    () => ({
      notes,
      addNote: addNoteRemote,
      renameNote: renameNoteRemote,
      recolorNote: recolorNoteRemote,
      describeNote: describeNoteRemote,
      retagNote: retagNoteRemote,
      removeNote: removeNoteRemote,
      linkEvents: linkEventsRemote,
      unlinkEvents: unlinkEventsRemote,
      setNoteSubjects: setNoteSubjectsRemote,
    }),
    [
      notes,
      addNoteRemote,
      renameNoteRemote,
      recolorNoteRemote,
      describeNoteRemote,
      retagNoteRemote,
      removeNoteRemote,
      linkEventsRemote,
      unlinkEventsRemote,
      setNoteSubjectsRemote,
    ],
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
    "project.new": handleNewProject,
    "trace.import": () => void handleImportTrace(),
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
    // Both outcomes — what was added, or why it couldn't be — are
    // logged by the host, so they arrive in the System Messages panel
    // with nothing for the view to hold.
    "server.addToPath": () => {
      void invoke<string>("add_server_to_path").catch(() => {});
    },
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
    elementHistoryRef,
    undoOrderRef,
    applyElementHistory,
    linkHistoryRef,
    applyEventLinkHistory,
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
    recentCaptures,
    openRecentCapture: (path: string) => void handleImportTrace(path),
    recentProjects,
    openRecentProject: (path: string) => void openProjectAt(path),
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
          api.fromJSON(normalizeSingletonTitles(saved));
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
          const before = layoutHistoryRef.current;
          const after = recordLayout(before, JSON.stringify(json));
          layoutHistoryRef.current = after;
          // Only a structural change pushes a step; the interleaving
          // log follows the same test (`past` re-allocated = pushed).
          if (after.past !== before.past) {
            undoOrderRef.current = recordStep(
              undoOrderRef.current,
              "layout",
              gestureRef.current?.id,
            );
          }
        }
      });
      // The restore/seed above is the baseline the first undo steps
      // back toward. (`seedDefaultLayout` set this itself; a restored
      // saved layout hasn't yet.)
      layoutHistoryRef.current = initLayoutHistory(JSON.stringify(api.toJSON()));
      undoOrderRef.current = EMPTY_UNDO_ORDER;
      linkHistoryRef.current = EMPTY_LINK_HISTORY;
      clearGesture();

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
            // The host may have moved onto a directory other than the
            // one it resolved before the WebView existed — automation's
            // `--project` names its own — so the project-scoped state
            // hydrated at load is re-read here too.
            await rehydrateProjectState();
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
            dropRecentProject(projectToOpen);
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
    [
      seedDefaultLayout,
      applyProject,
      rememberProject,
      dropRecentProject,
      clearGesture,
      rehydrateProjectState,
    ],
  );

  const { resting: restingStatus, transient: transientStatus } = useMemo(
    () =>
      splitStatus({
        state,
        remoteSessions,
        count,
        scanningBlfPath,
        scanningMdfPath,
      }),
    [state, remoteSessions, count, scanningBlfPath, scanningMdfPath],
  );
  // The numbers the header shows, as discrete metrics rather than a
  // sentence. Every figure is the host's: the rate, the elapsed span,
  // the two residency figures and the bus load all arrive on
  // `trace-grew`, and the frame count is the store's.
  const metrics = useMemo(
    () =>
      statusMetrics({
        count,
        firstIndex,
        framesPerSecond,
        busLoadPercent,
        bufferSeconds,
        scratchBytes,
        memBytes,
      }),
    [
      count,
      firstIndex,
      framesPerSecond,
      busLoadPercent,
      bufferSeconds,
      scratchBytes,
      memBytes,
    ],
  );
  const metricsTooltip = useMemo(() => statusMetricsTooltip(metrics), [metrics]);
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
  sessionUpRef.current = remoteConnected;
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
      ? capturePath(state.result)
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
      localVirtualBuses,
      handleAddVirtualBus,
      handleRemoveVirtualBus,
      handleUpdateVirtualBus,
      signalColors,
      handleSetSignalColor,
    ],
  );

  // The capture whose census is walking right now, in whichever format
  // — one trace-open at a time, so at most one of the two is set.
  const scanningTracePath = scanningBlfPath ?? scanningMdfPath;
  // The capture actually loading right now — past the census, past the
  // mapping dialog, the pump running until its own `log-finished`. This
  // is `state.kind === "loading"`'s whole lifetime: it must not end
  // when data starts reaching the plot panel, only when the import
  // genuinely finishes. Unlike the census, this phase is click-to-cancel
  // rather than merely disabled.
  const importingTracePath = state.kind === "loading" ? capturePath(state.result) : null;

  // The connection chip's state: the host's per-bus map, folded over
  // the project buses that carry a binding. The chip both reports the
  // aggregate and is the control, so nothing says "connected" from two
  // places.
  const connectionSummary = useMemo(
    () =>
      summarizeConnection(
        buses
          .filter((b) => interfaceBindings.some((binding) => binding.bus_id === b.id))
          .map((b) => ({ id: b.id, name: b.name })),
        connStates,
        remoteConnected,
      ),
    [buses, interfaceBindings, connStates, remoteConnected],
  );
  // The status bar's bus-health launcher. It stays neutral while every
  // reporting controller is error-active and tints with a count when one
  // is not; pressing it opens the panel, which is where "which bus" is
  // answered (ADR 0055). The interface display names the panel's adapter
  // column needs are not wanted here, so the rows are built without
  // them — the launcher names buses, not adapters.
  const busHealth = useBusHealth();
  const busHealthProps = useMemo(() => {
    const rows = busHealthRows({
      buses,
      bindings: interfaceBindings,
      interfaces: [],
      connStates,
      health: busHealth,
    });
    return {
      concerns: busHealthConcerns(rows),
      onOpen: () => runCommand("panel.show.busHealth"),
    };
  }, [buses, interfaceBindings, connStates, busHealth, runCommand]);
  // Every RBS configuration the project has open — what the RBS mapping
  // chip counts problems across, and (when there is exactly one) where
  // pressing it goes.
  const rbsElements = useMemo(
    () => registry.filter((e) => e.element.kind === "rbs"),
    [registry],
  );
  const rbsElementIds = useMemo(() => rbsElements.map((e) => e.element.id), [rbsElements]);
  const rbsAttentionCount = useRbsAttentionCount(rbsElementIds);
  // Pinned left to right: System messages, Signal mapping, RBS mapping.
  // They are pushed into the overflow menu from the right, so the last
  // one standing is the one that reports faults.
  const statusChips: StatusBarChip[] = [
    {
      id: "system-messages",
      label: "System messages",
      badge: systemLog.unread,
      title: "Everything the host and the app have logged this session.",
      onPress: () => runCommand("panel.show.systemMessages"),
    },
    {
      id: "signal-mapping",
      label: "Signal mapping",
      badge: viewSignalsAttentionCount,
      title: "The signals the open views reference, and which of them need attention.",
      onPress: () => runCommand("panel.show.viewSignals"),
    },
    {
      id: "rbs-mapping",
      label: "RBS mapping",
      badge: rbsAttentionCount,
      // Reporting combines across configurations; editing does not. With
      // one config there is no ambiguity about where an edit belongs, so
      // the chip opens that config's own grid. With several there is,
      // and the view that lists every config's problems together —
      // naming which config each belongs to — is not built yet, so the
      // chip reports without pretending to navigate.
      title:
        rbsElements.length === 0
          ? "No RBS configuration in this project."
          : rbsElements.length === 1
            ? "RBS signal mapping notes and warnings. Opens the RBS signals grid."
            : `RBS signal mapping notes and warnings across ${rbsElements.length} configurations. Open one from its own RBS panel — a combined view is not built yet.`,
      disabled: rbsElements.length !== 1,
      onPress: () => {
        const api = dockApiRef.current;
        const entry = rbsElements[0];
        if (api === null || entry === undefined) return;
        showRbsSignalsPanel(api, entry.element.id, elementLabel(entry.element));
      },
    },
  ];
  // Whatever is in flight, and the response to it. The bar is a readout
  // that also carries the way out of what it reports.
  const statusNotices = (
    <>
      {/* The load in flight: how far it has got, and the way out of
              it. Spans the census and the pump — it must not drop out
              just because data has started reaching the plot panel —
              and the status text alongside it names the file. The bar
              is determinate once the host has reported a fraction, and
              the indeterminate chip until then: a bar pinned at zero
              would claim a measurement nobody has made yet. */}
          {(scanningTracePath !== null || importingTracePath !== null) && (
            <span className="trace-load">
              <LoadProgressChip progress={loadProgress} />
              <button
                type="button"
                className="trace-load-cancel"
                title="Stop loading this capture. The frames loaded so far are kept as the capture."
                onClick={() => void handleCancelLoad()}
              >
                Cancel
              </button>
            </span>
          )}
          {/* The restore threw the persisted pyramids away and every
              plotted signal is being decoded again (ADR 0047) — minutes
              on a large capture, and until now completely silent, which
              read as the app being broken. Same chip the load uses, and
              determinate for the same reason: every pyramid re-decodes
              the same store, so the host can say how far along they all
              are. Beside it the offramp, for the user who would rather
              have the capture gone than wait for it. */}
          {rebuildingCaches && (
            <span className="cache-rebuild">
              <LoadProgressChip
                progress={
                  rebuildProgress === null
                    ? null
                    : {
                        phase: "cache_rebuild",
                        decoded: rebuildProgress.decoded,
                        total: rebuildProgress.total,
                      }
                }
              />
              Rebuilding signal caches…
              <button
                type="button"
                className="cache-rebuild-discard"
                title="Drop the restored capture instead of waiting for its signal caches to rebuild. The project, its DBCs and the layout are kept."
                onClick={() => void handleDiscardRestoredCapture()}
              >
                Discard
              </button>
            </span>
          )}
          {/* The project file changed on disk while applying it would
              have cost the user something — unsaved changes, or a
              session a re-root would drop (ADR 0053 §1). The RBS panel
              raises the same notice for its own file; the shared
              component is where the shape and the going-away rule
              live. */}
          {projectChangedOnDisk !== null && (
            <ChangedOnDiskNotice
              statement="Project changed on disk"
              action={{
                label: "Reload",
                title:
                  "Discard the in-memory project and re-open the file from disk. Unsaved changes are lost, and any open session is dropped (the reload re-roots the session).",
                onClick: () => {
                  const path = projectChangedOnDisk;
                  setProjectChangedOnDisk(null);
                  void openProjectAt(path);
                },
              }}
              dismiss={{
                label: "Dismiss the project-changed notice",
                title:
                  "Keep working with the project as it is in memory. Saving will overwrite the file's new contents.",
                onClick: () => setProjectChangedOnDisk(null),
              }}
            />
          )}
    </>
  );

  return (
    <main className="app">
      <header>
        {/* Command-backed (ADR 0037): every chip dispatches through
            `runCommand`, so a click gets the same recent-tracking and
            context gate as the palette and the keyboard. Re-opening a
            recent capture is the one thing that is not a command — the
            path is its argument. */}
        <Toolbar
          onRun={runCommand}
          captureEmpty={count === 0}
          importing={scanningTracePath !== null || importingTracePath !== null}
          recentCaptures={recentCaptures}
          onOpenRecent={(path) => void handleImportTrace(path)}
          recentProjects={recentProjects}
          onOpenRecentProject={(path) => void openProjectAt(path)}
        />
        <StatusBar
          connection={connectionSummary}
          onConnectionPress={() =>
            runCommand(
              connectionSummary.action === "disconnect"
                ? "connection.disconnect"
                : "connection.connect",
            )
          }
          busHealth={busHealthProps}
          notices={statusNotices}
          statusText={status}
          metrics={metrics}
          metricsTooltip={metricsTooltip}
          chips={statusChips}
        />
      </header>
      <ProjectContext.Provider value={projectContextValue}>
        <SignalCatalogProvider>
          <ElementRegistryContext.Provider value={elementRegistryValue}>
            <UndoGestureContext.Provider value={undoGesture}>
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
            </UndoGestureContext.Provider>
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
      {pendingMdf && (
        <BlfChannelMapModal
          blfPath={pendingMdf.mdfPath}
          scan={pendingMdf.scan}
          buses={buses}
          initial={savedBlfChannelMap(
            hostState().blf_channel_maps,
            pendingMdf.mdfPath,
            pendingMdf.scan.channels.length,
            new Set(buses.map((b) => b.id)),
          )}
          onConfirm={handleMdfMapConfirm}
          onCancel={() => setPendingMdf(null)}
          format="MDF"
          decodedMessageGroups={pendingMdf.scan.decoded_message_groups}
          signalCount={pendingMdf.scan.signal_count}
        />
      )}
      <ServerTrustDialogs />
      {splashVisible && <SplashOverlay />}
    </main>
  );
}


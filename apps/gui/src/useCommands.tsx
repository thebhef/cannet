import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { AddPanelOptions, DockviewApi } from "dockview";

import type { ProjectElement } from "./types";
import type { RegistryEntry } from "./projectElements";
import type { Note } from "./notes";
import { GOTO_EVENT, gotoEventItems, parseTimeInTrace, timeInTraceTargetNs } from "./gotoEvent";
import { parseVisibleRangeInput } from "./plotVisibleRange";
import { elementViewEntries } from "./gotoViews";
import { elementLabel } from "./elementLabel";
import { basename } from "./windowTitle";
import type { KeybindingsController } from "./keybindingsContext";
import { hostSettings, subscribeSettings, updateSettings } from "./hostSettings";
import { setRecentCommands as persistRecentCommands, hostState } from "./hostState";
import {
  ABOUT_PANEL_COMPONENT,
  ABOUT_PANEL_ID,
  DBC_PANEL_COMPONENT,
  DBC_PANEL_ID,
  EVENTS_PANEL_COMPONENT,
  BUS_HEALTH_PANEL_COMPONENT,
  EVENTS_PANEL_ID,
  BUS_HEALTH_PANEL_ID,
  PROJECT_GRAPH_PANEL_COMPONENT,
  PROJECT_GRAPH_PANEL_ID,
  PROJECT_PANEL_COMPONENT,
  PROJECT_PANEL_ID,
  SERVERS_PANEL_ID,
  SETTINGS_PANEL_COMPONENT,
  SETTINGS_PANEL_ID,
  SHORTCUTS_PANEL_COMPONENT,
  SHORTCUTS_PANEL_ID,
  SYSTEM_MESSAGES_PANEL_COMPONENT,
  SYSTEM_MESSAGES_PANEL_ID,
  VIEW_SIGNALS_PANEL_COMPONENT,
  VIEW_SIGNALS_PANEL_ID,
  elementPanelComponent,
  isTabMiddlePress,
  panelKindForFocus,
  showServersPanel as showServersPanelIn,
  validateLayout,
} from "./dockLayout";
import {
  COMMANDS,
  commandsAvailableIn,
  parseBindings,
  resolveBindings,
  reviewBindings,
  type BindingSpec,
  type CommandContext,
} from "./commands";
import {
  dispatchStroke,
  formatChord,
  isEditableTarget,
  isGridviewContentTarget,
  isGridviewTarget,
  isMacPlatform,
  type KeyStroke,
} from "./keybindings";
import {
  navigateFocus,
  redoLayout,
  undoLayout,
  type FocusHistory,
  type LayoutHistory,
} from "./viewHistory";
import type { LinkHistory } from "./eventLinkHistory";
import type { PanelEditHistory } from "./panelEditHistory";
import {
  popRedo,
  popUndo,
  type ElementHistory,
  type UndoOrder,
  type UndoStack,
} from "./elementHistory";
import { PaletteModal, PalettePrompt, type PaletteItem } from "./PaletteModal";
import {
  recordRecentCommand,
  sortRecentFirst,
} from "./recentCommands";
import { createPanelCommandRegistry } from "./panelCommands";

/// The active dockview panel, tracked by `App`'s `onDidActivePanelChange`
/// (dockview lifecycle) and read here to route panel-local commands.
export type ActivePanel = { id: string; elementId: string | null } | null;

export interface UseCommandsOptions {
  // Dockview + layout-history lifecycle refs. Owned by `App` (its layout
  // seed / restore / undo-record all touch them); the command subsystem
  // reads and drives them for view navigation and layout undo/redo.
  dockApiRef: RefObject<DockviewApi | null>;
  focusHistoryRef: MutableRefObject<FocusHistory>;
  layoutHistoryRef: MutableRefObject<LayoutHistory | null>;
  applyingLayoutRef: MutableRefObject<boolean>;
  // The element half of undo/redo, and the log that interleaves it with
  // the layout half. The stack and its restore live in `App` (they
  // write the registry); read here to decide which stack a chord steps.
  elementHistoryRef: MutableRefObject<ElementHistory>;
  undoOrderRef: MutableRefObject<UndoOrder>;
  /// Step the element stack and write the snapshot back. Returns
  /// whether it changed anything (see `App`).
  applyElementHistory: (dir: "undo" | "redo") => boolean;
  /// The event-link stack, read the same way — whether a chord has a
  /// link step to take, and how to take it.
  linkHistoryRef: MutableRefObject<LinkHistory>;
  applyEventLinkHistory: (dir: "undo" | "redo") => boolean;
  /// The Signal/RBS panel-edit stack (task 129), read the same way.
  panelEditHistoryRef: MutableRefObject<PanelEditHistory>;
  applyPanelEditHistory: (dir: "undo" | "redo") => boolean;
  // Reactive model reads.
  registry: readonly RegistryEntry[];
  activePanel: ActivePanel;
  projectPath: string | null;
  hasMaximizedView: boolean;
  // Timeline-event palette inputs.
  notes: Note[];
  firstIndex: number;
  firstIndexTsNs: number | null;
  sessionStartSeconds: number | null;
  // Apply a model-owned display name (ADR 0019) to an element — the
  // same registry mutation the project panel's inline rename performs,
  // passed in because the registry context is provided *below* `App`.
  renameElement: (id: string, name: string) => void;
  // The app-domain command implementations (project / BLF / DBC /
  // connection / capture / panel.add / saveAll / exit).
  // Merged with the framework/view/palette commands owned here.
  appCommands: Record<string, () => void>;
  // The Recent-captures list — the exact same MRU `App`'s toolbar
  // button reads, so the palette can't drift from it. Each entry gets
  // its own "Open recent: <name>" palette command.
  recentCaptures: readonly string[];
  // Open a recent path through the app's single import entry point
  // (`handleImportTrace`), the same call the toolbar dropdown's click
  // handler makes — same census/guard/cancel flow either way.
  openRecentCapture: (path: string) => void;
  // The Recent-projects list — the same user-scope MRU (ADR 0042 §3)
  // the toolbar's Projects chip reads. Each entry gets its own
  // "Open recent project: <name>" palette command.
  recentProjects: readonly string[];
  // Open a recent project through the app's single project-open path
  // (`openProjectAt`), the same call the toolbar menu makes.
  openRecentProject: (path: string) => void;
}

/// A command's second stage (ADR 0037): the one piece of text the
/// command still needs, collected in the palette rather than by sending
/// the user to another view. Set by a command handler through
/// `promptForText`; the palette clears it on submit or cancel.
interface CommandPrompt {
  /// What is being asked for, shown above the field and used as its
  /// accessible name.
  label: string;
  /// The value the field opens with, pre-selected.
  initial: string;
  /// Gate the submit: a non-null return is shown as an inline error and
  /// keeps the prompt open instead of calling `submit`.
  validate?: (value: string) => string | null;
  submit: (value: string) => void;
}

export interface UseCommandsResult {
  /// Run a command by id (recent-tracked, same path as palette + keys).
  runCommand: (id: string) => void;
  /// The keybinding controller for `KeybindingsContext`.
  keybindings: KeybindingsController;
  /// The panel-local command registry for `PanelCommandsContext`.
  panelCommands: ReturnType<typeof createPanelCommandRegistry>;
  /// The command / go-to-view / go-to-event palette modals.
  palettes: ReactNode;
}

/// Identity of a persisted binding list, for "has this changed?" — the
/// settings cache hands out a fresh array on every read, so reference
/// equality would report a change on every unrelated settings write.
function bindingsKey(bindings: BindingSpec[] | null): string {
  return JSON.stringify(bindings);
}

/// Warn on the system log about every binding the sanitiser refuses, so a
/// hand-edited `settings.json` naming a command that doesn't exist doesn't
/// just quietly lose that shortcut. Deduped by binding set: the same
/// refusal isn't re-reported when some unrelated setting is written.
let lastReportedBindings: string | null = null;
function reportRejectedBindings(bindings: BindingSpec[] | null): void {
  const key = bindingsKey(bindings);
  if (key === lastReportedBindings) return;
  lastReportedBindings = key;
  if (bindings == null) return;
  for (const { binding, reason } of reviewBindings(bindings, COMMANDS).rejected) {
    void invoke("gui_emit_system_log", {
      level: "warn",
      source: "keybindings",
      message: `ignoring keybinding "${binding.chord}" → ${binding.commandId}: ${reason}`,
    }).catch(() => {
      /* best effort - the binding is dropped either way */
    });
  }
}

/// The command + hotkey + palette subsystem (ADR 0018), extracted from
/// `App` as the provider `commands.ts` was always meant to delegate to.
///
/// Owns: the effective-binding resolution + persistence, the global
/// keydown dispatcher, the command registry (app-domain commands merged
/// with the framework/view/palette commands), the singleton view-show
/// helpers, the command context, and the three palette modals. `App`
/// keeps the dockview layout lifecycle and the app-domain command
/// implementations, passing the latter in as {@link UseCommandsOptions.appCommands}.
export function useCommands(options: UseCommandsOptions): UseCommandsResult {
  const {
    dockApiRef,
    focusHistoryRef,
    layoutHistoryRef,
    applyingLayoutRef,
    elementHistoryRef,
    undoOrderRef,
    applyElementHistory,
    linkHistoryRef,
    applyEventLinkHistory,
    panelEditHistoryRef,
    applyPanelEditHistory,
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
    openRecentCapture,
    recentProjects,
    openRecentProject,
  } = options;

  const focusedPanelKind = useMemo(() => {
    if (!activePanel) return null;
    const elementKind = activePanel.elementId
      ? registry.find((e) => e.element.id === activePanel.elementId)?.element.kind ?? null
      : null;
    return panelKindForFocus(activePanel.id, elementKind);
  }, [activePanel, registry]);

  // Which palette is open: command palette (Mod+Shift+P), go-to-view
  // (Mod+P), or go-to-event.
  const [openPalette, setOpenPalette] = useState<"commands" | "goto" | "gotoEvent" | null>(
    null,
  );
  // User keybinding customisation (ADR 0018): `null` = the built-in
  // defaults are in effect. Read synchronously from the settings cache
  // (hydrated before first render) and persisted on each edit from the
  // shortcuts panel; the effect below follows later changes.
  const [userBindings, setUserBindings] = useState<BindingSpec[] | null>(
    () => hostSettings().keybindings,
  );
  // The last few commands run (MRU, capped — see recentCommands.ts); the
  // command palette floats them to the top, VS Code-style.
  const [recentCommands, setRecentCommands] = useState<string[]>(
    () => hostState().recent_commands,
  );
  // Panel-local command implementations (plot fit / follow-live).
  const [panelCommands] = useState(createPanelCommandRegistry);
  // What a command's second stage is asking for, if one is open — the
  // palette renders a text field for it instead of a list.
  const [prompt, setPrompt] = useState<CommandPrompt | null>(null);

  // --- singleton view-show helpers ---
  // Show-or-focus a singleton panel keyed by its fixed id: bring it
  // forward if it's already open, otherwise add it.
  const showSingletonPanel = useCallback(
    (panel: AddPanelOptions) => {
      const api = dockApiRef.current;
      if (!api) return;
      const existing = api.panels.find((p) => p.id === panel.id);
      if (existing) {
        existing.api.setActive();
        return;
      }
      api.addPanel(panel);
    },
    [dockApiRef],
  );
  const showProjectPanel = useCallback(
    () =>
      showSingletonPanel({
        id: PROJECT_PANEL_ID,
        component: PROJECT_PANEL_COMPONENT,
        title: "Project",
        position: { direction: "left" },
      }),
    [showSingletonPanel],
  );
  const showProjectGraphPanel = useCallback(
    () =>
      showSingletonPanel({
        id: PROJECT_GRAPH_PANEL_ID,
        component: PROJECT_GRAPH_PANEL_COMPONENT,
        title: "Graph",
      }),
    [showSingletonPanel],
  );
  const showSystemMessagesPanel = useCallback(
    () =>
      showSingletonPanel({
        id: SYSTEM_MESSAGES_PANEL_ID,
        component: SYSTEM_MESSAGES_PANEL_COMPONENT,
        title: "System messages",
      }),
    [showSingletonPanel],
  );
  const showDbcPanel = useCallback(
    () =>
      showSingletonPanel({
        id: DBC_PANEL_ID,
        component: DBC_PANEL_COMPONENT,
        title: "Database",
      }),
    [showSingletonPanel],
  );
  const showViewSignalsPanel = useCallback(
    () =>
      showSingletonPanel({
        id: VIEW_SIGNALS_PANEL_ID,
        component: VIEW_SIGNALS_PANEL_COMPONENT,
        title: "View signals",
      }),
    [showSingletonPanel],
  );
  const showSettingsPanel = useCallback(
    () =>
      showSingletonPanel({
        id: SETTINGS_PANEL_ID,
        component: SETTINGS_PANEL_COMPONENT,
        title: "Settings",
      }),
    [showSingletonPanel],
  );
  const showAboutPanel = useCallback(
    () =>
      showSingletonPanel({
        id: ABOUT_PANEL_ID,
        component: ABOUT_PANEL_COMPONENT,
        title: "About",
      }),
    [showSingletonPanel],
  );
  const showShortcutsPanel = useCallback(
    () =>
      showSingletonPanel({
        id: SHORTCUTS_PANEL_ID,
        component: SHORTCUTS_PANEL_COMPONENT,
        title: "Keyboard shortcuts",
      }),
    [showSingletonPanel],
  );
  const showEventsPanel = useCallback(
    () =>
      showSingletonPanel({
        id: EVENTS_PANEL_ID,
        component: EVENTS_PANEL_COMPONENT,
        title: "Events",
      }),
    [showSingletonPanel],
  );
  const showBusHealthPanel = useCallback(
    () =>
      showSingletonPanel({
        id: BUS_HEALTH_PANEL_ID,
        component: BUS_HEALTH_PANEL_COMPONENT,
        title: "Bus health",
      }),
    [showSingletonPanel],
  );
  // Not `showSingletonPanel`: the bus row's "Manage servers…" opens the
  // same panel from outside this hook, and both go through one helper.
  const showServersPanel = useCallback(() => {
    const api = dockApiRef.current;
    if (api) showServersPanelIn(api);
  }, [dockApiRef]);

  // --- command handlers + key dispatch (ADR 0018) ---
  const activePanelRef = useRef(activePanel);
  activePanelRef.current = activePanel;
  // Element-backed panels register under their element id; a singleton
  // panel (DBC, …) has none, so it falls back to its fixed dockview
  // panel id — the same id `usePanelCommands` is called with for that
  // singleton. Safe for element-backed panels too: `elementId` is
  // always set whenever a command's context targets one of their
  // kinds, so the fallback is only ever exercised for singletons.
  const runFocusedPanelCommand = useCallback(
    (commandId: string, arg?: string) => {
      const active = activePanelRef.current;
      if (!active) return;
      panelCommands.invoke(active.elementId ?? active.id, commandId, arg);
    },
    [panelCommands],
  );
  // View navigation: walk the focus history (skipping panels closed
  // since), browser back/forward style. The `setActive` echo lands in
  // `recordFocus` as a no-op, so the jump doesn't re-record itself.
  const navigateViewHistory = useCallback(
    (dir: -1 | 1) => {
      const api = dockApiRef.current;
      if (!api) return;
      const r = navigateFocus(focusHistoryRef.current, dir, (id) => api.getPanel(id) != null);
      if (!r) return;
      focusHistoryRef.current = r.history;
      api.getPanel(r.panelId)?.api.setActive();
    },
    [dockApiRef, focusHistoryRef],
  );
  // Layout undo/redo: swap the whole serialized layout back in. The
  // applying guard keeps the resulting layout-change echo from being
  // recorded as a fresh step. Returns whether it applied one.
  const applyLayoutHistory = useCallback(
    (dir: "undo" | "redo"): boolean => {
      const api = dockApiRef.current;
      const history = layoutHistoryRef.current;
      if (!api || !history) return false;
      const r = dir === "undo" ? undoLayout(history) : redoLayout(history);
      if (!r) return false;
      const layout = validateLayout(JSON.parse(r.layout));
      if (!layout) return false;
      applyingLayoutRef.current = true;
      try {
        api.fromJSON(layout);
      } catch {
        return false; // snapshot won't load — leave the history untouched
      } finally {
        applyingLayoutRef.current = false;
      }
      layoutHistoryRef.current = r.history;
      return true;
    },
    [dockApiRef, layoutHistoryRef, applyingLayoutRef],
  );
  // One timeline over two stacks: the interleaving log names the stacks
  // each *gesture* stepped, so a chord always reverses the most recent
  // change — a panel move, a change made inside a panel, or a gesture
  // that did both (removing an element takes its panel with it) — as one
  // step. A gesture that turns out to restore nothing is consumed and
  // the chord moves on to the next one, rather than looking like a dead
  // key.
  //
  // Within a gesture the element half goes first: both halves are
  // dispatched from the same event, so React commits them together, and
  // a panel the layout half remounts then reads an element the element
  // half has already put back.
  const applyViewHistory = useCallback(
    (dir: "undo" | "redo") => {
      const canStep = (stack: UndoStack): boolean => {
        const history =
          stack === "layout"
            ? layoutHistoryRef.current
            : stack === "events"
              ? linkHistoryRef.current
              : stack === "edits"
                ? panelEditHistoryRef.current
                : elementHistoryRef.current;
        if (!history) return false;
        return (dir === "undo" ? history.past : history.future).length > 0;
      };
      // Bounded by the log: every iteration consumes one of its entries.
      const budget = undoOrderRef.current.past.length + undoOrderRef.current.future.length;
      for (let steps = budget; steps > 0; steps--) {
        const r =
          dir === "undo"
            ? popUndo(undoOrderRef.current, canStep)
            : popRedo(undoOrderRef.current, canStep);
        if (!r) return;
        undoOrderRef.current = r.order;
        let applied = false;
        if (r.stacks.includes("element")) applied = applyElementHistory(dir);
        if (r.stacks.includes("events")) applied = applyEventLinkHistory(dir) || applied;
        if (r.stacks.includes("edits")) applied = applyPanelEditHistory(dir) || applied;
        if (r.stacks.includes("layout")) applied = applyLayoutHistory(dir) || applied;
        if (applied) return;
      }
    },
    [
      layoutHistoryRef,
      elementHistoryRef,
      linkHistoryRef,
      panelEditHistoryRef,
      undoOrderRef,
      applyLayoutHistory,
      applyElementHistory,
      applyEventLinkHistory,
      applyPanelEditHistory,
    ],
  );
  const cycleTabInGroup = useCallback(
    (dir: -1 | 1) => {
      const group = dockApiRef.current?.activeGroup;
      if (!group || group.panels.length < 2) return;
      const active = group.activePanel;
      const idx = active ? group.panels.indexOf(active) : -1;
      const next = group.panels[(idx + dir + group.panels.length) % group.panels.length];
      next.api.setActive();
    },
    [dockApiRef],
  );
  // Full-screen toggle over dockview's maximized-group. Runtime-only
  // view state: the persisted layouts strip it (`stripMaximizedNode`).
  const toggleFullscreenView = useCallback(() => {
    const api = dockApiRef.current;
    if (!api) return;
    if (api.hasMaximizedGroup()) {
      api.exitMaximizedGroup();
    } else if (api.activePanel) {
      api.maximizeGroup(api.activePanel);
    }
  }, [dockApiRef]);

  // Recent-captures palette commands: one per MRU entry, id-keyed by
  // path so a run of one is stable across re-renders. Built straight
  // off `recentCaptures` — the same list
  // the toolbar's Recent-captures button reads — so there's no second
  // source for the palette to drift from.
  const recentCaptureCommands = useMemo(
    () =>
      recentCaptures.map((path) => ({
        id: `recent.open:${path}`,
        path,
        label: `Open recent: ${basename(path)}`,
      })),
    [recentCaptures],
  );

  // Recent-projects palette commands: the same shape, over the
  // user-scope project MRU the toolbar's Projects chip reads.
  const recentProjectCommands = useMemo(
    () =>
      recentProjects.map((path) => ({
        id: `recentProject.open:${path}`,
        path,
        label: `Open recent project: ${basename(path)}`,
      })),
    [recentProjects],
  );

  // The command registry: the app-domain commands passed in merged with
  // the framework/view/palette commands owned here. Rebuilt every render
  // (cheap) and read through a ref so the once-registered keydown
  // listener and the palette always see current closures.
  const commandHandlersRef = useRef<Record<string, () => void>>({});
  commandHandlersRef.current = {
    ...appCommands,
    // Each opens through the exact path the toolbar dropdown's click
    // handler uses (`openRecentCapture`, i.e. `App`'s
    // `handleImportTrace`) — same census/guard/cancel flow either way.
    ...Object.fromEntries(
      recentCaptureCommands.map((c) => [c.id, () => openRecentCapture(c.path)]),
    ),
    ...Object.fromEntries(
      recentProjectCommands.map((c) => [c.id, () => openRecentProject(c.path)]),
    ),
    "panel.show.project": showProjectPanel,
    "panel.show.systemMessages": showSystemMessagesPanel,
    "panel.show.projectGraph": showProjectGraphPanel,
    "panel.show.dbc": showDbcPanel,
    "panel.show.viewSignals": showViewSignalsPanel,
    "panel.show.settings": showSettingsPanel,
    "panel.show.about": showAboutPanel,
    "panel.show.events": showEventsPanel,
    "panel.show.busHealth": showBusHealthPanel,
    "panel.show.shortcuts": showShortcutsPanel,
    "panel.show.servers": showServersPanel,
    // Rename in place: the palette stays open and becomes a text field
    // seeded with the focused panel's name, so the user never leaves
    // the view they are renaming. The name is the model-owned one
    // (ADR 0019) — committing writes it through the element registry,
    // the same mutation the project panel's inline rename performs.
    "panel.rename": () => {
      const elementId = activePanelRef.current?.elementId;
      if (!elementId) return;
      const element = registry.find((e) => e.element.id === elementId)?.element;
      if (!element) return;
      const current = elementLabel(element);
      setPrompt({
        label: `Rename “${current}”`,
        initial: current,
        submit: (value) => {
          // An empty box reverts rather than clearing the name — every
          // element has one, and a nameless panel falls back to a
          // generated label.
          const next = value.trim();
          if (next && next !== current) renameElement(elementId, next);
        },
      });
    },
    "palette.show": () => setOpenPalette("commands"),
    "goto.view": () => setOpenPalette("goto"),
    "goto.event": () => setOpenPalette("gotoEvent"),
    // Prompt for a time (seconds since session start, non-negative — a
    // negative value is a validation error, not a pre-session seek) and
    // broadcast it on the same cross-panel goto bus the events view and
    // the go-to-event palette use (ADR 0035), so the trace scrolls and
    // every plot re-centres exactly as for a named event.
    "goto.timeInTrace": () => {
      setPrompt({
        label: "Go to time (seconds since start)",
        initial: "",
        validate: (value) => {
          const parsed = parseTimeInTrace(value);
          return parsed.ok ? null : parsed.error;
        },
        submit: (value) => {
          const parsed = parseTimeInTrace(value);
          if (!parsed.ok) return; // the validator already blocked this
          void emit(GOTO_EVENT, timeInTraceTargetNs(sessionStartSeconds, parsed.seconds));
        },
      });
    },
    "plot.fitXAxis": () => runFocusedPanelCommand("plot.fitXAxis"),
    "plot.followLive.enable": () => runFocusedPanelCommand("plot.followLive.enable"),
    "panel.find": () => runFocusedPanelCommand("panel.find"),
    // Prompt for a range ("min max" / "min,max" / "min..max") or a bare
    // width, and hand the raw text to the focused plot's own handler —
    // it alone knows the current window needed to resolve a width into
    // concrete bounds (`plotVisibleRange.ts`).
    "plot.setVisibleRange": () => {
      setPrompt({
        label: "Set visible range (min max, or a width)",
        initial: "",
        validate: (value) => {
          const parsed = parseVisibleRangeInput(value);
          return parsed.ok ? null : parsed.error;
        },
        submit: (value) => runFocusedPanelCommand("plot.setVisibleRange", value),
      });
    },
    "view.back": () => navigateViewHistory(-1),
    "view.forward": () => navigateViewHistory(1),
    // Close the focused panel only — the chord (`Mod+W`) must never
    // fall through to the webview's close-the-window default; the
    // dispatcher's preventDefault sees to that, and an accidental
    // close is undoable (`view.undo`).
    "view.close": () => dockApiRef.current?.activePanel?.api.close(),
    "tab.next": () => cycleTabInGroup(1),
    "tab.previous": () => cycleTabInGroup(-1),
    "view.undo": () => applyViewHistory("undo"),
    "view.redo": () => applyViewHistory("redo"),
    "view.fullscreen": toggleFullscreenView,
    "view.exitFullscreen": () => dockApiRef.current?.exitMaximizedGroup(),
  };
  const runCommand = useCallback((id: string) => {
    const handler = commandHandlersRef.current[id];
    if (!handler) return;
    // The palette-opening commands aren't worth resurfacing at the
    // top of the palette they open; everything else is remembered.
    if (id !== "palette.show" && id !== "goto.view") {
      setRecentCommands((current) => {
        const next = recordRecentCommand(current, id);
        persistRecentCommands(next);
        return next;
      });
    }
    handler();
  }, []);

  const commandContext: CommandContext = useMemo(
    () => ({ focusedPanelKind, hasProjectOpen: projectPath !== null, hasMaximizedView }),
    [focusedPanelKind, projectPath, hasMaximizedView],
  );
  const commandContextRef = useRef(commandContext);
  commandContextRef.current = commandContext;

  // Effective bindings (ADR 0018): the user's customisation overlaid on the
  // defaults, sanitised. The dispatcher and the palette hints read these,
  // not a compile-time constant, so a shortcuts-panel edit takes effect
  // immediately. Parsed once per change; read through a ref so the
  // once-registered keydown listener always sees the latest.
  const effectiveBindings = useMemo(() => resolveBindings(userBindings), [userBindings]);
  const parsedBindings = useMemo(() => parseBindings(effectiveBindings), [effectiveBindings]);
  const parsedBindingsRef = useRef(parsedBindings);
  parsedBindingsRef.current = parsedBindings;

  // Follow the settings cache: another consumer's write — or a re-hydrate
  // after the file was hand-edited — takes effect without a restart.
  // Anything the sanitiser refuses is reported on the system log: a
  // hand-edited `settings.json` naming a command that doesn't exist used to
  // just lose that shortcut, with nothing anywhere saying why.
  useEffect(() => {
    let applied = bindingsKey(hostSettings().keybindings);
    reportRejectedBindings(hostSettings().keybindings);
    return subscribeSettings((s) => {
      const key = bindingsKey(s.keybindings);
      if (key === applied) return;
      applied = key;
      setUserBindings(s.keybindings);
      reportRejectedBindings(s.keybindings);
    });
  }, []);

  // Persist a keybinding change through the shared cache, which merges it
  // over a fresh read of the file so a concurrent settings edit isn't
  // clobbered. `null` resets to the built-in defaults. The host is
  // authoritative; a failed write is logged host-side.
  const persistUserBindings = useCallback((next: readonly BindingSpec[] | null) => {
    const value = next == null ? null : [...next];
    setUserBindings(value);
    void updateSettings({ keybindings: value }).catch(() => {
      /* host logs the failure; the in-memory value still holds */
    });
  }, []);

  const keybindings: KeybindingsController = useMemo(
    () => ({ user: userBindings, effective: effectiveBindings, setUser: persistUserBindings }),
    [userBindings, effectiveBindings, persistUserBindings],
  );

  // The global keydown dispatcher: resolve binding → check context →
  // run, or silently no-op. Registered once, on the capture phase so
  // a focused panel's own handlers can't shadow the global chords;
  // plain-key bindings are suppressed while typing, and the keys a
  // gridview consumes are suppressed while focus is inside one
  // (ADR 0044) — see `dispatchStroke`. Sequence prefixes expire after
  // a beat.
  useEffect(() => {
    const isMac = isMacPlatform();
    let pending: KeyStroke[] = [];
    let timer: number | undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Control" || e.key === "Meta" || e.key === "Shift" || e.key === "Alt") {
        return;
      }
      const available = new Set(
        commandsAvailableIn(COMMANDS, commandContextRef.current).map((c) => c.id),
      );
      const result = dispatchStroke(
        pending,
        { key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey },
        parsedBindingsRef.current.filter((b) => available.has(b.commandId)),
        {
          isMac,
          inEditable: isEditableTarget(e.target),
          inGridview: isGridviewTarget(e.target),
          inGridviewContent: isGridviewContentTarget(e.target),
        },
      );
      pending = result.pending;
      window.clearTimeout(timer);
      if (result.pending.length > 0) {
        timer = window.setTimeout(() => {
          pending = [];
        }, 1500);
      }
      if (result.handled) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (result.commandId) runCommand(result.commandId);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.clearTimeout(timer);
    };
  }, [runCommand]);

  // Middle-clicking a tab closes the view (dockview default-tab
  // behaviour on pointer-up), but the browser's middle-button
  // autoscroll is `mousedown`'s default action and engages first —
  // cancel the default for tab presses only, on the capture phase.
  // `preventDefault` doesn't touch dockview's own pointer handlers.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (isTabMiddlePress(e.button, e.target)) e.preventDefault();
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, []);

  // Palette items. Commands: everything available in the current
  // context, hinted with the key binding (or category). Go-to-view:
  // every view — open or not — by its model-owned display name
  // (`gotoViews` below), so a closed element view is still reachable.
  const commandPaletteItems: PaletteItem[] = useMemo(() => {
    if (openPalette !== "commands") return [];
    const isMac = isMacPlatform();
    const items = commandsAvailableIn(COMMANDS, commandContext).map((c) => {
      const binding = parsedBindings.find((b) => b.commandId === c.id);
      return {
        id: c.id,
        label: c.label,
        hint: binding ? formatChord(binding.chord, isMac) : c.category,
        keywords: c.keywords,
      };
    });
    // One entry per recent capture, findable by a fragment of its full
    // path — not just the filename the label shows — via `keywords`
    // (the same fold-into-fuzzy-match field a
    // renamed command or view uses to stay reachable by an old name).
    // An empty recents list contributes none.
    const recents = recentCaptureCommands.map((c) => ({
      id: c.id,
      label: c.label,
      hint: "Recent",
      keywords: c.path,
    }));
    const recentProjectItems = recentProjectCommands.map((c) => ({
      id: c.id,
      label: c.label,
      hint: "Recent",
      keywords: c.path,
    }));
    // Recently-used first (the fzf ranking takes over once the user
    // types — this orders only the unfiltered list).
    return sortRecentFirst([...items, ...recents, ...recentProjectItems], recentCommands);
  }, [
    openPalette,
    commandContext,
    recentCommands,
    parsedBindings,
    recentCaptureCommands,
    recentProjectCommands,
  ]);
  // Open-or-focus the dockview panel for a project element — the reopen
  // path go-to-view uses for a closed element view (mirrors ProjectPanel's
  // open). A filter has no panel of its own, so surface the graph instead.
  const openElementView = useCallback(
    (element: ProjectElement) => {
      const api = dockApiRef.current;
      if (!api) return;
      const component = elementPanelComponent(element.kind);
      if (component === null) {
        showProjectGraphPanel();
        return;
      }
      const id = `${component}-${element.id}`;
      const existing = api.getPanel(id);
      if (existing) {
        existing.api.setActive();
        return;
      }
      api.addPanel({
        id,
        component,
        title: elementLabel(element),
        params:
          element.kind === "trace"
            ? { elementId: element.id, mode: "by-id" }
            : { elementId: element.id },
      });
    },
    [dockApiRef, showProjectGraphPanel],
  );
  // Every reachable view for go-to-view (Ctrl+P): each project element that
  // has a panel, plus every singleton. Open panels are focused, closed ones
  // are opened on pick — the palette must reach a view you closed (e.g. a
  // color map), not just the ones currently on screen. Labels are the
  // model-owned element names (ADR 0019), same as the tabs.
  const gotoViews = useMemo(() => {
    const views: { id: string; label: string; keywords?: string; open: () => void }[] = [];
    for (const entry of registry) {
      // Element views keyed exactly as `gotoViews`'s openers expect
      // (`elementViewEntries` filters out panel-less kinds like `filter`).
      const [view] = elementViewEntries([entry.element]);
      if (view) views.push({ ...view, open: () => openElementView(entry.element) });
    }
    // `keywords` are folded into the palette's fuzzy-match text without
    // being displayed — a view renamed since the user learned it stays
    // findable by the old name, exactly as a renamed *command* does.
    const singleton = (id: string, label: string, open: () => void, keywords?: string) =>
      views.push({ id, label, keywords, open });
    singleton(PROJECT_PANEL_ID, "Project", showProjectPanel);
    singleton(PROJECT_GRAPH_PANEL_ID, "Graph", showProjectGraphPanel);
    // It was the "DBC panel" before it grew every other signal-defining
    // format (ADR 0052).
    singleton(DBC_PANEL_ID, "Database", showDbcPanel, "DBC panel");
    singleton(VIEW_SIGNALS_PANEL_ID, "View signals", showViewSignalsPanel, "signal mapping");
    singleton(SYSTEM_MESSAGES_PANEL_ID, "System messages", showSystemMessagesPanel);
    singleton(SETTINGS_PANEL_ID, "Settings", showSettingsPanel);
    singleton(ABOUT_PANEL_ID, "About", showAboutPanel);
    singleton(EVENTS_PANEL_ID, "Events", showEventsPanel);
    singleton(BUS_HEALTH_PANEL_ID, "Bus health", showBusHealthPanel, "bus load error frames");
    singleton(SHORTCUTS_PANEL_ID, "Keyboard shortcuts", showShortcutsPanel);
    singleton(SERVERS_PANEL_ID, "Servers", showServersPanel);
    return views;
  }, [
    registry,
    openElementView,
    showProjectPanel,
    showProjectGraphPanel,
    showDbcPanel,
    showViewSignalsPanel,
    showSystemMessagesPanel,
    showSettingsPanel,
    showAboutPanel,
    showEventsPanel,
    showBusHealthPanel,
    showShortcutsPanel,
    showServersPanel,
  ]);
  const gotoPaletteItems: PaletteItem[] = useMemo(() => {
    if (openPalette !== "goto") return [];
    return gotoViews.map((v) => ({ id: v.id, label: v.label, keywords: v.keywords }));
  }, [openPalette, gotoViews]);
  // Go-to-event palette: every timeline event by label, hinted with its
  // time relative to the session start. Selecting one broadcasts the same
  // cross-panel jump the events view's per-row goto button emits (ADR 0035),
  // so no events panel need be open.
  const gotoEventPaletteItems: PaletteItem[] = useMemo(() => {
    if (openPalette !== "gotoEvent") return [];
    const truncationTsNs = firstIndex > 0 ? firstIndexTsNs : null;
    return gotoEventItems(notes, truncationTsNs, sessionStartSeconds);
  }, [openPalette, notes, firstIndex, firstIndexTsNs, sessionStartSeconds]);
  const openViewById = useCallback(
    (id: string) => {
      gotoViews.find((v) => v.id === id)?.open();
    },
    [gotoViews],
  );

  const palettes = (
    <>
      {openPalette === "commands" && (
        <PaletteModal
          placeholder="Run a command…"
          items={commandPaletteItems}
          onPick={(item) => {
            setOpenPalette(null);
            runCommand(item.id);
          }}
          onClose={() => setOpenPalette(null)}
        />
      )}
      {openPalette === "goto" && (
        <PaletteModal
          placeholder="Go to view…"
          items={gotoPaletteItems}
          onPick={(item) => {
            setOpenPalette(null);
            openViewById(item.id);
          }}
          onClose={() => setOpenPalette(null)}
        />
      )}
      {openPalette === "gotoEvent" && (
        <PaletteModal
          placeholder="Go to event…"
          items={gotoEventPaletteItems}
          onPick={(item) => {
            setOpenPalette(null);
            // `item.id` is the event's absolute ns; broadcast the same
            // cross-panel jump the events view's goto button emits (ADR 0035).
            void emit(GOTO_EVENT, Number(item.id));
          }}
          onClose={() => setOpenPalette(null)}
        />
      )}
      {prompt && (
        <PalettePrompt
          label={prompt.label}
          initialValue={prompt.initial}
          validate={prompt.validate}
          onSubmit={(value) => {
            setPrompt(null);
            prompt.submit(value);
          }}
          onClose={() => setPrompt(null)}
        />
      )}
    </>
  );

  return { runCommand, keybindings, panelCommands, palettes };
}

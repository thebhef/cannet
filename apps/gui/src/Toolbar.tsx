/// The application toolbar: **commands, and only commands** (ADR 0037,
/// ADR 0055).
///
/// Every control here is a {@link ChipButton} — the shared chip
/// silhouette — so the toolbar, the status bar under it and the panel
/// bars below all read as one species of control. What a chip does is
/// a command id dispatched through {@link ToolbarProps.onRun}, so a
/// click gets the same recent-tracking and context gate as the palette
/// and the keyboard. Nothing here reaches past the command layer except
/// the two menus, which are view-local open/closed state.
///
/// Things about the shape, each of them a decision rather than a style:
///
/// - **The bar is a rendering of the command registry, not a second
///   declaration of it** (ADR 0055 §4). What sits here is a command id,
///   an icon and an order; the words come from that command's own
///   `bar` entry in `commands.ts`, beside its palette label. A chip
///   that spelled its own label is how the Database rename (ADR 0052)
///   reached every surface except this one — the two strings still
///   differ, but a rename now has both under one hand.
/// - **The words are short and the tooltip is long.** A chip's label is
///   a Title Case word or two beside an icon; the full phrase ("Open
///   project…") is the sentence-case tooltip. Where an icon is
///   unambiguous on its own — the panel launchers — the chip is the
///   icon and the tooltip is the whole of its words. The Database
///   launcher is the exception and keeps its word, because the name is
///   what it exists to settle: the view is "Database" everywhere a
///   user meets it (ADR 0052), and a bar that said "DBC" was the last
///   place still saying otherwise.
/// - **Showing the Database view is a command; opening a database file
///   is not one of the bar's.** Adding a file to the project is
///   project membership, and it is offered where the project's
///   databases are listed — the project panel — rather than from a
///   second place up here. The palette keeps both: it is the whole
///   command list, and the bar a curated rendering of it.
/// - **The seven "Add X" commands are one menu.** They differ only in
///   which panel they open, and seven near-identical phrases across the
///   bar is where the eye stops reading.
/// - **Save is a split chip, and the split never swallows the press.**
///   Save and its disclosure are two chips inside one
///   {@link ChipSegment}: pressing Save saves, and only the `▾` beside
///   it opens the menu that offers Save As. A disclosure that hijacked
///   the primary press would make the commonest action in the bar the
///   slowest one, so `Toolbar.dom.test.tsx` pins that pressing Save
///   dispatches `project.save` and opens nothing.
/// - **The toolbar carries nothing that reports a condition.** The
///   connection control, System Messages, Signal Mapping and RBS
///   Mapping all live in the status bar, where the condition already
///   is; a duplicate launcher up here would report the same thing from
///   two places. `Toolbar.dom.test.tsx` holds that.

import { useState } from "react";

import { ChipButton } from "./ChipButton";
import { ChipSegment } from "./ChipSegment";
import { COMMANDS } from "./commands";
import { useDismissableMenu } from "./useDismissableMenu";
import type { IconName } from "./Icon";

/// The words each command is drawn with here, taken from the registry
/// rather than restated — see the module doc. A `label` of `undefined`
/// is the icon-only form, named by its title; the title falls back to
/// the command's palette label where the bar wants the same phrase.
const BAR_WORDS = new Map(
  COMMANDS.filter((c) => c.bar !== undefined).map(
    (c) => [c.id, { label: c.bar?.label, title: c.bar?.title ?? c.label }] as const,
  ),
);

/// One chip: the command it dispatches, the icon beside its words, and
/// whatever its current state adds. The words themselves are the
/// command's, not the chip's.
interface ToolbarChip {
  command: string;
  icon: IconName;
  /// Overrides the command's bar tooltip while the chip's own state
  /// changes what it should say — the import chip mid-load is the only
  /// case, and the sentence is about *this* press rather than about the
  /// command.
  title?: string;
  disabled?: boolean;
  /// The chip's own command is running. Pulses the hairline rather than
  /// greying out, so "working" does not read as "unavailable".
  busy?: boolean;
}

/// The separators, the split Save chip and the three menus, interleaved
/// with the chips in bar order.
type ToolbarItem = ToolbarChip | "sep" | "save" | "recentProjects" | "recent" | "add";

/// The panels the Add menu opens, in the order they are listed.
const ADD_PANEL_CHIPS: readonly { command: string; icon: IconName }[] = [
  { command: "panel.add.trace", icon: "rows" },
  { command: "panel.add.plot", icon: "chart" },
  { command: "panel.add.signals", icon: "signals" },
  { command: "panel.add.transmit", icon: "send" },
  { command: "panel.add.rbs", icon: "loop" },
  { command: "panel.add.colormap", icon: "palette" },
  { command: "panel.add.generator", icon: "wave" },
];

export interface ToolbarProps {
  /// Dispatches a command id. Every chip goes through this and nothing
  /// else.
  onRun: (commandId: string) => void;
  /// The projects opened most recently, most recent first — user-scope
  /// state (ADR 0042 §3), so it is the same list whichever project is
  /// open. Empty means the Projects chip is not drawn at all.
  recentProjects: readonly string[];
  /// Re-open one of them. Not a command — the path is the argument.
  onOpenRecentProject: (path: string) => void;
  /// Nothing has been captured, so there is nothing to clear or save.
  captureEmpty: boolean;
  /// A capture is being scanned or imported right now. Starting a
  /// second one is refused, and the chip that started this one says so.
  importing: boolean;
  /// The captures this project has opened before, most recent first.
  /// Empty means the Recent chip is not drawn at all.
  recentCaptures: readonly string[];
  /// Re-open one of them. Not a command — the path is the argument.
  onOpenRecent: (path: string) => void;
}

export function Toolbar({
  onRun,
  captureEmpty,
  importing,
  recentCaptures,
  onOpenRecent,
  recentProjects,
  onOpenRecentProject,
}: ToolbarProps) {
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useDismissableMenu<HTMLDivElement>(addOpen, () => setAddOpen(false));
  const [recentOpen, setRecentOpen] = useState(false);
  const recentRef = useDismissableMenu<HTMLDivElement>(recentOpen, () => setRecentOpen(false));
  const [projectsOpen, setProjectsOpen] = useState(false);
  const projectsRef = useDismissableMenu<HTMLDivElement>(projectsOpen, () =>
    setProjectsOpen(false),
  );
  const [saveOpen, setSaveOpen] = useState(false);
  const saveRef = useDismissableMenu<HTMLDivElement>(saveOpen, () => setSaveOpen(false));

  const items: ToolbarItem[] = [
    { command: "project.new", icon: "plus" },
    { command: "project.open", icon: "folder" },
    "recentProjects",
    "save",
    "sep",
    // A load running is the one thing the user is waiting on, so the
    // chip that started it says so rather than sitting there looking
    // idle — which is what got clicked through repeatedly. It says so
    // on the hairline: stopping the load is the status bar's own Cancel
    // button, not a second meaning on the launcher.
    {
      command: "trace.import",
      icon: "import",
      title: importing
        ? "Loading a capture. Stop it with Cancel in the status bar below."
        : undefined,
      disabled: importing,
      busy: importing,
    },
    "recent",
    "sep",
    { command: "capture.clear", icon: "clear", disabled: captureEmpty },
    { command: "capture.save", icon: "save", disabled: captureEmpty },
    "sep",
    "add",
    "sep",
    { command: "panel.show.dbc", icon: "db" },
    { command: "panel.show.projectGraph", icon: "graph" },
    { command: "panel.show.events", icon: "flag" },
    { command: "panel.show.project", icon: "tree" },
  ];

  const renderItem = (item: ToolbarItem, i: number) => {
    if (item === "sep") {
      return <span key={`sep-${i}`} className="toolbar-separator" aria-hidden="true" />;
    }
    if (item === "save") {
      // The split chip: one hairline around two chips, and a menu
      // hanging off the second. The primary press is Save's own and
      // reaches nothing else — see the module doc.
      return (
        <div key="save" className="chip-menu" ref={saveRef}>
          <ChipSegment label="Save" className="save-split">
            <ChipButton
              icon="save"
              label={BAR_WORDS.get("project.save")?.label}
              title={BAR_WORDS.get("project.save")?.title}
              onPress={() => onRun("project.save")}
            />
            <ChipButton
              label={"▾"}
              ariaLabel="More save actions"
              title="More save actions"
              menuOpen={saveOpen}
              onPress={() => setSaveOpen((v) => !v)}
            />
          </ChipSegment>
          {saveOpen && (
            <ul role="menu" className="chip-menu-list save-split-menu">
              <li role="menuitem">
                <ChipButton
                  icon="save"
                  label={BAR_WORDS.get("project.saveAs")?.label}
                  title={BAR_WORDS.get("project.saveAs")?.title}
                  onPress={() => {
                    setSaveOpen(false);
                    onRun("project.saveAs");
                  }}
                />
              </li>
            </ul>
          )}
        </div>
      );
    }
    if (item === "recentProjects") {
      // Nothing opened yet on this machine: a menu with nothing in it
      // is worse than no menu.
      if (recentProjects.length === 0) return null;
      return (
        <div key="recentProjects" className="chip-menu recent-projects" ref={projectsRef}>
          <ChipButton
            icon="clock"
            label="Projects"
            ariaLabel={`Recent projects (${recentProjects.length})`}
            title="Recent projects"
            menuOpen={projectsOpen}
            onPress={() => setProjectsOpen((v) => !v)}
          />
          {projectsOpen && (
            <ul role="menu" className="chip-menu-list recent-projects-menu">
              {recentProjects.map((path) => (
                <li key={path} role="menuitem">
                  <ChipButton
                    label={path}
                    title={path}
                    onPress={() => {
                      setProjectsOpen(false);
                      onOpenRecentProject(path);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    if (item === "add") {
      return (
        <div key="add" className="chip-menu" ref={addRef}>
          <ChipButton
            icon="plus"
            label={"Add ▾"}
            ariaLabel="Add a panel"
            title="Add a panel"
            menuOpen={addOpen}
            onPress={() => setAddOpen((v) => !v)}
          />
          {addOpen && (
            <ul role="menu" className="chip-menu-list">
              {ADD_PANEL_CHIPS.map((chip) => (
                <li key={chip.command} role="menuitem">
                  <ChipButton
                    icon={chip.icon}
                    label={BAR_WORDS.get(chip.command)?.label}
                    onPress={() => {
                      setAddOpen(false);
                      onRun(chip.command);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    if (item === "recent") {
      // Nothing opened yet in this project: a menu with nothing in it
      // is worse than no menu.
      if (recentCaptures.length === 0) return null;
      return (
        <div key="recent" className="chip-menu recent-captures" ref={recentRef}>
          <ChipButton
            icon="clock"
            label="Recent"
            ariaLabel={`Recent captures (${recentCaptures.length})`}
            title="Recent captures"
            menuOpen={recentOpen}
            onPress={() => setRecentOpen((v) => !v)}
          />
          {recentOpen && (
            <ul role="menu" className="chip-menu-list recent-captures-menu">
              {recentCaptures.map((path) => (
                <li key={path} role="menuitem">
                  <ChipButton
                    label={path}
                    title={path}
                    onPress={() => {
                      setRecentOpen(false);
                      onOpenRecent(path);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    const words = BAR_WORDS.get(item.command);
    return (
      <ChipButton
        key={item.command}
        icon={item.icon}
        label={words?.label}
        title={item.title ?? words?.title}
        disabled={item.disabled}
        busy={item.busy}
        onPress={() => onRun(item.command)}
      />
    );
  };

  return <div className="toolbar">{items.map(renderItem)}</div>;
}

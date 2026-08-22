/// The plot panel's toolbar: **every plot command, on one row that
/// never wraps** (ADR 0026, ADR 0055).
///
/// It is the chip language applied to the busiest bar in the app.
/// Three things about its shape are decisions rather than styling:
///
/// - **Cursor placement is a segment, not a dropdown.** Which cursor a
///   click places is a mode that goes on and off constantly while a
///   plot is being read; a dropdown spends two clicks on it and hides
///   the answer behind a shut list. Three icon chips under one hairline
///   show the mode and change it in one press — and pressing the one
///   that is on turns it off, which is how "off" stays reachable
///   without a fourth position that does nothing.
/// - **The solo control is one unbreakable unit.** Its field, its
///   paging and its clear are one control wearing three hats, so the
///   fit planner's cluster contract carries them together, and they sit
///   left, where the bar gives way last.
/// - **The performance read-out is off.** It is a diagnostic, and a row
///   of numbers that changes width every tick sits badly beside
///   controls that must not move. It lives behind the bar's own
///   right-click menu, beside the other diagnostics.
///
/// The bar is stateless: the panel owns every value here and gets a
/// callback for every press, which is what lets a test drive the whole
/// bar with spies.

import type { ComponentProps, MouseEvent, MutableRefObject, ReactNode } from "react";

import { ChipButton } from "./ChipButton";
import { ChipSegment } from "./ChipSegment";
import { Icon, type IconName } from "./Icon";
import { TraceControls } from "./TraceControls";
import type { CursorMode } from "./plotPanelConfig";
import type { ShowPointsMode } from "./plotPoints";

/// Where a menu was asked for, in viewport coordinates.
export interface MenuAnchor {
  x: number;
  y: number;
}

/// The solo control's half of the bar. Every value is the panel's; the
/// bar only draws them.
export interface PlotToolbarSolo {
  pattern: string;
  /// The pattern does not parse. The field says so, and the paging
  /// stays away.
  invalid: boolean;
  /// How many pages the matches make. Zero means there is nothing to
  /// step through, and the steppers say so by being disabled.
  pages: number;
  /// What solo has on show, already worded by the panel.
  positionLabel: string;
  /// There is a match list to open. Without one, neither the position
  /// chip nor a right-click opens anything.
  hasMatches: boolean;
  /// So `panel.find` can put the caret in the box.
  inputRef: MutableRefObject<HTMLInputElement | null>;
  onPattern: (pattern: string) => void;
  /// Step the page by one, forwards or back.
  onStep: (delta: 1 | -1) => void;
  onClear: () => void;
  onOpenMatches: (at: MenuAnchor) => void;
}

export interface PlotToolbarProps {
  /// The shared run controls, passed straight through.
  traceControls: ComponentProps<typeof TraceControls>;
  onAddArea: () => void;
  onFitX: () => void;
  onFitY: () => void;
  followLive: boolean;
  onFollowLive: (on: boolean) => void;
  showPoints: ShowPointsMode;
  onShowPoints: (mode: ShowPointsMode) => void;
  solo: PlotToolbarSolo;
  cursorMode: CursorMode;
  onCursorMode: (mode: CursorMode) => void;
  onClearCursors: () => void;
  /// The performance read-out as one line, or `null` while it is
  /// hidden — which it is unless the bar's right-click menu turned it
  /// on.
  perfText: string | null;
  /// Right-click anywhere on the bar that is not a control with a menu
  /// of its own.
  onOpenMenu: (at: MenuAnchor) => void;
}

/// The three cursor placement modes, in bar order. Each is its own
/// chip; the one that is on is pressed, and pressing it again is how
/// the mode goes back to `off`.
const CURSOR_MODES: readonly {
  mode: Exclude<CursorMode, "off">;
  icon: IconName;
  name: string;
  title: string;
}[] = [
  {
    mode: "x",
    icon: "cursor-x",
    name: "X Cursors",
    title: "x cursors — vertical A / B lines placed on click",
  },
  {
    mode: "y",
    icon: "cursor-y",
    name: "Y Cursors",
    title: "y cursors — horizontal H1 / H2 lines placed on click",
  },
  { mode: "note", icon: "note", name: "Notes", title: "notes — click places a timeline note" },
];

/// The points setting cycles rather than dropping down: three states
/// nobody hunts for, and a dropdown spends two clicks and a popup on
/// them. The chip says which one it is in.
const POINTS_CYCLE: readonly { mode: ShowPointsMode; label: string }[] = [
  { mode: "auto", label: "Points: Auto" },
  { mode: "off", label: "Points: Off" },
  { mode: "on", label: "Points: On" },
];

const POINTS_TITLE =
  "draw sample points on every series: auto = let uPlot decide based on sample density; off = never draw points; on = always draw points";

const SOLO_TITLE =
  "solo: show only the series whose bus/ecu/message/signal path matches this regex — the same dialect an area's pattern filter speaks (case-sensitive, partial, so a bare name matches too). Everything else is masked out of the view — no series' own hide state is changed, and clearing the box (or Escape) brings the full view back. Right-click for the match list, and tick any subset of it to show exactly those.";

/// The whole of what the read-out's numbers mean, in the order it
/// prints them.
export const PERF_TITLE =
  "update rate · worst recent resample (host slice + decode in parens) · device pixel ratio · frames in trace window · cached plot points (biggest area)";

/// One thing on the bar. `cluster` ties it to its neighbours so the fit
/// planner cannot separate them; `sep` asks for a divider in front of
/// it, as the head of a group.
export interface PlotBarItem {
  key: string;
  cluster?: string;
  sep?: boolean;
  node: ReactNode;
}

/// Everything on the bar, left to right, as the fit planner needs to
/// see it: one list, with the solo cluster's three parts tied together.
/// Split out from the render so a test can read the bar's *order and
/// clustering* without going through a layout that jsdom cannot do.
export function plotToolbarItems({
  traceControls,
  onAddArea,
  onFitX,
  onFitY,
  followLive,
  onFollowLive,
  showPoints,
  onShowPoints,
  solo,
  cursorMode,
  onCursorMode,
  onClearCursors,
  perfText,
}: Omit<PlotToolbarProps, "onOpenMenu">): PlotBarItem[] {
  const points = POINTS_CYCLE.find((p) => p.mode === showPoints) ?? POINTS_CYCLE[0];
  const nextPoints = POINTS_CYCLE[(POINTS_CYCLE.indexOf(points) + 1) % POINTS_CYCLE.length].mode;

  // The control's own menu, not the bar's — the event is stopped either
  // way, so a right-click aimed at solo never opens the unrelated panel
  // menu behind it.
  const onSoloContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!solo.hasMatches) return;
    solo.onOpenMatches({ x: e.clientX, y: e.clientY });
  };

  const items: PlotBarItem[] = [
    { key: "run", node: <TraceControls {...traceControls} /> },
    {
      key: "fit-x",
      sep: true,
      node: (
        <ChipButton
          icon="fit-x"
          ariaLabel="Fit Data"
          title="fit x axis to the data"
          onPress={onFitX}
        />
      ),
    },
    {
      key: "fit-y",
      node: (
        <ChipButton
          icon="fit-y"
          ariaLabel="Fit Y"
          title="fit each area's y-axis to its currently visible data — useful after zooming in"
          onPress={onFitY}
        />
      ),
    },
    {
      key: "solo:field",
      cluster: "solo",
      sep: true,
      node: (
        <span className="plot-solo chip-field" title={SOLO_TITLE} onContextMenu={onSoloContextMenu}>
          <Icon name="search" />
          <input
            ref={solo.inputRef}
            className="plot-solo-input"
            aria-label="solo pattern"
            aria-invalid={solo.invalid || undefined}
            placeholder="solo regex"
            value={solo.pattern}
            onChange={(e) => solo.onPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                solo.onClear();
              }
            }}
          />
          {solo.invalid && <span className="plot-solo-error">bad regex</span>}
        </span>
      ),
    },
  ];

  if (solo.pattern !== "" && !solo.invalid) {
    items.push({
      key: "solo:paging",
      cluster: "solo",
      node: (
        <ChipSegment label="Solo Paging" className="plot-solo-paging">
          <ChipButton
            label="‹"
            ariaLabel="previous solo match"
            title="previous page (PgUp) — the cycle runs all → page 1 → … → page N → all"
            // Nothing to step through: a pattern that captures nothing
            // filters flat, and one that matches nothing has no pages
            // either. Disabled rather than silently inert.
            disabled={solo.pages === 0}
            onPress={() => solo.onStep(-1)}
          />
          <ChipButton
            className={`plot-solo-pos${solo.positionLabel === "no matches" ? " plot-solo-pos-empty" : ""}`}
            label={solo.positionLabel}
            ariaLabel="solo position"
            title="what solo has on show — the whole matched set, a page of groups, or the subset you ticked — and how many of the matches that is; click for the match list"
            // The same list the control's own right-click opens:
            // left-click is the more discoverable gesture for "show me
            // what matched", so it opens it too.
            disabled={!solo.hasMatches}
            onPress={(e) => solo.onOpenMatches({ x: e.clientX, y: e.clientY })}
          />
          <ChipButton
            label="›"
            ariaLabel="next solo match"
            title="next page (PgDn) — the cycle runs all → page 1 → … → page N → all"
            disabled={solo.pages === 0}
            onPress={() => solo.onStep(1)}
          />
        </ChipSegment>
      ),
    });
  }
  if (solo.pattern !== "") {
    items.push({
      key: "solo:clear",
      cluster: "solo",
      node: (
        <ChipButton
          icon="x"
          ariaLabel="clear solo"
          title="clear solo — every series goes back to its own visibility"
          onPress={solo.onClear}
        />
      ),
    });
  }

  items.push(
    {
      key: "add-area",
      node: (
        <ChipButton
          icon="plus"
          label="Area"
          ariaLabel="Add Plot Area"
          title="add plot area"
          onPress={onAddArea}
        />
      ),
    },
    {
      key: "follow",
      node: (
        <ChipButton
          label="Follow"
          ariaLabel="Follow Live"
          title="follow the live edge"
          pressed={followLive}
          onPress={() => onFollowLive(!followLive)}
        />
      ),
    },
    {
      key: "points",
      node: (
        <ChipButton
          className="plot-points-chip"
          label={points.label}
          ariaLabel="Show Points"
          title={POINTS_TITLE}
          onPress={() => onShowPoints(nextPoints)}
        />
      ),
    },
    {
      key: "cursor-mode",
      sep: true,
      node: (
        <ChipSegment
          label="Cursor Mode"
          title="cursor placement mode — press the one that is on for off"
        >
          {CURSOR_MODES.map((m) => (
            <ChipButton
              key={m.mode}
              icon={m.icon}
              ariaLabel={m.name}
              title={m.title}
              pressed={cursorMode === m.mode}
              // Pressing the mode that is already on turns it off —
              // there is no fourth "off" position, and there does not
              // need to be.
              onPress={() => onCursorMode(cursorMode === m.mode ? "off" : m.mode)}
            />
          ))}
        </ChipSegment>
      ),
    },
    {
      key: "clear-cursors",
      node: (
        <ChipButton
          icon="cursors"
          ariaLabel="Clear Cursors"
          title="remove all placed cursors"
          onPress={onClearCursors}
        />
      ),
    },
  );

  if (perfText !== null) {
    items.push({
      key: "perf",
      sep: true,
      // A read-out, not a command: it wears the chip's silhouette so it
      // sits level with the row, but it is not a button and does not
      // pretend to be pressable.
      node: (
        <span className="status-chip chip-button plot-perf" title={PERF_TITLE}>
          <span className="status-chip-label">{perfText}</span>
        </span>
      ),
    });
  }

  return items;
}

export function PlotToolbar(props: PlotToolbarProps) {
  const items = plotToolbarItems(props);
  return (
    <div
      className="plot-panel-toolbar"
      onContextMenu={(e) => {
        // Right-click the *toolbar* to open the panel menu. Deliberately
        // not bound to the whole panel: right-click + drag over a plot
        // area is uPlot's zoom gesture, and a plain right-click places
        // cursor B — a panel-wide handler stole both.
        e.preventDefault();
        props.onOpenMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {items.map((item, i) => (
        <PlotBarSlot key={item.key} item={item} first={i === 0} />
      ))}
    </div>
  );
}

/// One item on the bar, with the divider that introduces its group. The
/// divider is the item's own, so a group that is not on the bar takes
/// its separator with it rather than leaving a rule in mid-air.
function PlotBarSlot({ item, first }: { item: PlotBarItem; first: boolean }) {
  return (
    <>
      {item.sep && !first && <span className="plot-toolbar-sep" aria-hidden="true" />}
      {item.node}
    </>
  );
}

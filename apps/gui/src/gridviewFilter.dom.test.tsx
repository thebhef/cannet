// @vitest-environment jsdom
//
// The filter slot's React half (ADR 0044): the shared search box, the
// debounce that keeps a burst of keystrokes to one re-filter, and the
// settle-time seed that folds a match's ancestors into the panel's own
// expansion set once, so a deep match is visible without the user
// unfolding the path to it — without ever overriding a collapse the
// user makes afterwards.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";

import {
  GridviewFilterBox,
  type GridviewFilterEntry,
  useGridviewFilter,
} from "./gridviewFilter";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ENTRIES: GridviewFilterEntry[] = [
  { id: "sig:speed", ancestors: ["bus", "msg:brake"], haystack: "VehicleSpeed km/h" },
  { id: "sig:temp", ancestors: ["bus", "msg:engine"], haystack: "CoolantTemp degC" },
];

function Harness({
  onEntries,
  onSettledCall,
  rebuildKey = 0,
}: {
  onEntries?: () => void;
  /// Called every time the seed actually fires — separate from
  /// `onEntries`, which counts matcher builds (a different thing: an
  /// entries rebuild forces a fresh matcher even when the seed itself
  /// stays quiet).
  onSettledCall?: () => void;
  /// Bumped by a caller that wants a fresh `buildEntries` identity
  /// without changing anything else — standing in for a panel whose
  /// `buildEntries` depends on host state that refreshes on its own
  /// timer (RBS's `view`, rebuilt by its 500 ms value poll) rather than
  /// on the settled query.
  rebuildKey?: number;
}) {
  const buildEntries = useCallback(() => {
    onEntries?.();
    return ENTRIES;
  }, [onEntries, rebuildKey]);
  // Stands in for a panel's own expansion set — the thing the shared
  // slot writes into, the chevron writes into, and nothing else.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["bus"]));
  const onMatchesSettled = useCallback(
    (ids: ReadonlySet<string>) => {
      onSettledCall?.();
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
      });
    },
    [onSettledCall],
  );
  const filter = useGridviewFilter(buildEntries, "", onMatchesSettled);
  const collapse = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  return (
    <div>
      <GridviewFilterBox
        filter={filter}
        className="test-filter"
        ariaLabel="filter rows"
        matchCountClassName="test-match-count"
      />
      <button onClick={() => collapse("msg:engine")}>collapse msg:engine</button>
      <span data-testid="query">{filter.query}</span>
      <span data-testid="matches">{[...filter.matchSet].join(",")}</span>
      <span data-testid="expanded">{[...expanded].sort().join(",")}</span>
    </div>
  );
}

describe("the gridview filter slot", () => {
  it("re-filters once the box settles, not once per keystroke", () => {
    vi.useFakeTimers();
    const onEntries = vi.fn();
    render(<Harness onEntries={onEntries} />);
    const box = screen.getByLabelText("filter rows");
    for (const q of ["V", "Ve", "Veh", "Vehi"]) {
      fireEvent.change(box, { target: { value: q } });
    }
    // The box shows every keystroke; the query behind it has not moved.
    expect(box).toHaveValue("Vehi");
    expect(screen.getByTestId("query")).toHaveTextContent("");
    expect(onEntries).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId("query")).toHaveTextContent("Vehi");
    expect(screen.getByTestId("matches")).toHaveTextContent("sig:speed");
    // One index build for the whole burst.
    expect(onEntries).toHaveBeenCalledTimes(1);
  });

  it("leaves expansion alone while idle — nothing to settle, nothing written", () => {
    vi.useFakeTimers();
    render(<Harness />);
    expect(screen.getByTestId("expanded")).toHaveTextContent("bus");
  });

  it("writes a settled match's ancestors into the panel's own expansion set once, and a later collapse sticks", () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("filter rows"), {
      target: { value: "CoolantTemp" },
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // The settle-time seed: msg:engine is now an ordinary member of the
    // expansion set, not a live merge recomputed on every read.
    expect(screen.getByTestId("expanded")).toHaveTextContent("bus,msg:engine");
    // The query is still active, but a plain collapse (what the chevron
    // does) removes it and nothing re-adds it — no standing override.
    fireEvent.click(screen.getByText("collapse msg:engine"));
    expect(screen.getByTestId("expanded")).toHaveTextContent("bus");
    expect(screen.getByTestId("query")).toHaveTextContent("CoolantTemp");
  });

  it("does not re-fire the seed when entries rebuild but the settled matches don't change", () => {
    // RBS's `buildFilterEntries` depends on `view`, which its 500 ms
    // value poll replaces with a fresh object on an unchanged tree —
    // so `ancestorsOfMatches` gets a new identity with the same
    // contents on every poll while a query sits settled. Keying the
    // seed on identity alone re-fired it every time, reopening
    // anything the user had just collapsed.
    vi.useFakeTimers();
    const onSettledCall = vi.fn();
    const { rerender } = render(<Harness onSettledCall={onSettledCall} rebuildKey={0} />);
    fireEvent.change(screen.getByLabelText("filter rows"), {
      target: { value: "CoolantTemp" },
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onSettledCall).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("expanded")).toHaveTextContent("bus,msg:engine");
    // Collapse the seeded ancestor, as the chevron would.
    fireEvent.click(screen.getByText("collapse msg:engine"));
    expect(screen.getByTestId("expanded")).toHaveTextContent("bus");
    // Same query, but a fresh `buildEntries` identity — the poll firing
    // with nothing changed.
    rerender(<Harness onSettledCall={onSettledCall} rebuildKey={1} />);
    expect(onSettledCall).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("expanded")).toHaveTextContent("bus");
  });

  it("clearing the query touches expansion not at all", () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("filter rows"), {
      target: { value: "CoolantTemp" },
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId("expanded")).toHaveTextContent("bus,msg:engine");
    fireEvent.change(screen.getByLabelText("filter rows"), { target: { value: "" } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId("query")).toHaveTextContent("");
    // Nothing added, nothing removed — the tree is exactly as the user
    // left it (msg:engine included, since nobody collapsed it).
    expect(screen.getByTestId("expanded")).toHaveTextContent("bus,msg:engine");
  });

  it("shows a live match count only while the filter is active", () => {
    vi.useFakeTimers();
    render(<Harness />);
    expect(document.querySelector(".test-match-count")).toBeNull();
    fireEvent.change(screen.getByLabelText("filter rows"), {
      target: { value: "e" },
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(document.querySelector(".test-match-count")).toHaveTextContent(/match/);
  });
});

// @vitest-environment jsdom
//
// The filter slot's React half (ADR 0044): the shared search box, the
// debounce that keeps a burst of keystrokes to one re-filter, and the
// ancestors-are-expanded rule that makes a deep match visible without
// the user unfolding the path to it.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useCallback } from "react";

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

function Harness({ onEntries }: { onEntries?: () => void }) {
  const buildEntries = useCallback(() => {
    onEntries?.();
    return ENTRIES;
  }, [onEntries]);
  const filter = useGridviewFilter(buildEntries);
  const effective = filter.effectiveExpanded(new Set(["bus"]));
  return (
    <div>
      <GridviewFilterBox
        filter={filter}
        className="test-filter"
        ariaLabel="filter rows"
        matchCountClassName="test-match-count"
      />
      <span data-testid="query">{filter.query}</span>
      <span data-testid="matches">{[...filter.matchSet].join(",")}</span>
      <span data-testid="expanded">{[...effective].sort().join(",")}</span>
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

  it("treats a match's ancestors as expanded, and leaves expansion alone when idle", () => {
    vi.useFakeTimers();
    render(<Harness />);
    // Idle: the panel's own expansion set, untouched.
    expect(screen.getByTestId("expanded")).toHaveTextContent("bus");
    fireEvent.change(screen.getByLabelText("filter rows"), {
      target: { value: "CoolantTemp" },
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
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

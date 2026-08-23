// @vitest-environment jsdom
//
// What an event row gives up when its subjects do not fit. jsdom does no
// layout, so the widths are supplied the way `useToolbarFit.dom.test.tsx`
// supplies them: what is under test is the row's *policy* — it never
// wraps, never grows, and never hides a subject without saying how many —
// not the measurement, which only a browser can prove.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { EventSubjectChips } from "./EventSubjectChips";
import type { SubjectChip } from "./eventSubjects";

const layout: Record<string, number> = {};

function sizeOf(el: HTMLElement): number {
  const key = el.dataset.toolbarFit;
  if (key !== undefined) return layout[key] ?? 0;
  if (el.classList.contains("event-subject-chips")) return layout.bar ?? 0;
  return 0;
}

let resizeCallbacks: (() => void)[] = [];

class ControllableResizeObserver {
  constructor(private readonly cb: () => void) {
    resizeCallbacks.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    resizeCallbacks = resizeCallbacks.filter((c) => c !== this.cb);
  }
}

function resizeTo(width: number): void {
  layout.bar = width;
  act(() => {
    for (const cb of resizeCallbacks) cb();
  });
}

beforeEach(() => {
  for (const key of Object.keys(layout)) delete layout[key];
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
  for (const prop of ["offsetWidth", "clientWidth"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return sizeOf(this);
      },
    });
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const prop of ["offsetWidth", "clientWidth"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value: 0 });
  }
});

function chip(n: number): SubjectChip {
  return {
    key: `signal:s:1A2:Sig${n}`,
    kind: "signal",
    label: `Sig${n}`,
    title: `signal s:1A2 BMS_Status.Sig${n}`,
    resolved: true,
  };
}

const CHIPS = [chip(1), chip(2), chip(3), chip(4)];

function labels(): string[] {
  return Array.from(document.querySelectorAll(".event-subject-chip-label")).map(
    (el) => el.textContent ?? "",
  );
}

function renderChips(onExpand = () => {}, expanded = false) {
  return render(<EventSubjectChips chips={CHIPS} expanded={expanded} onExpand={onExpand} />);
}

describe("EventSubjectChips", () => {
  it("draws every chip when the row has the room", () => {
    for (const c of CHIPS) layout[c.key] = 60;
    layout.bar = 1000;
    renderChips();
    expect(labels()).toEqual(["Sig1", "Sig2", "Sig3", "Sig4"]);
    expect(document.querySelector(".event-subject-more")).toBeNull();
  });

  it("collapses what does not fit into a … carrying the count", () => {
    for (const c of CHIPS) layout[c.key] = 60;
    layout.overflow = 40;
    layout.bar = 1000;
    renderChips();
    // 2 chips (120) + the … (40) is the widest arrangement under 180.
    resizeTo(180);
    expect(labels()).toEqual(["Sig1", "Sig2"]);
    expect(screen.getByLabelText("show 2 more subjects")).toHaveTextContent("… +2");
  });

  it("puts them back when the row is given the room again", () => {
    for (const c of CHIPS) layout[c.key] = 60;
    layout.overflow = 40;
    layout.bar = 1000;
    renderChips();
    resizeTo(180);
    expect(labels()).toHaveLength(2);
    resizeTo(1000);
    expect(labels()).toHaveLength(4);
    expect(document.querySelector(".event-subject-more")).toBeNull();
  });

  it("keeps the … even when a single chip is all that overflows", () => {
    // The alternative — dropping the last chip silently — would leave a
    // row that says nothing about what it is not showing.
    for (const c of CHIPS) layout[c.key] = 60;
    layout.overflow = 40;
    layout.bar = 1000;
    renderChips();
    resizeTo(220);
    expect(labels()).toEqual(["Sig1", "Sig2", "Sig3"]);
    expect(screen.getByLabelText("show 1 more subject")).toBeInTheDocument();
  });

  it("discloses the row rather than dropping a menu — the scroll area would clip one", () => {
    for (const c of CHIPS) layout[c.key] = 60;
    layout.overflow = 40;
    layout.bar = 1000;
    const onExpand = vi.fn();
    renderChips(onExpand);
    resizeTo(180);
    const more = screen.getByLabelText("show 2 more subjects");
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(onExpand).toHaveBeenCalledTimes(1);
    // Nothing is drawn inside the row itself: the chips are in the body.
    expect(document.querySelector(".event-subject-chips ul")).toBeNull();
  });

  it("does not take the row's click on its way past", () => {
    // The row's own click puts the grid's cursor on it; pressing … must
    // not do that as well.
    for (const c of CHIPS) layout[c.key] = 60;
    layout.overflow = 40;
    layout.bar = 1000;
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <EventSubjectChips chips={CHIPS} expanded={false} onExpand={() => {}} />
      </div>,
    );
    resizeTo(180);
    fireEvent.click(screen.getByLabelText("show 2 more subjects"));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("reports the row's disclosed state, since pressing it is what opens it", () => {
    for (const c of CHIPS) layout[c.key] = 60;
    layout.overflow = 40;
    layout.bar = 1000;
    renderChips(() => {}, true);
    resizeTo(180);
    expect(screen.getByLabelText("show 2 more subjects")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

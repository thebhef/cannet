/// Driving the application toolbar from a test.
///
/// The toolbar's controls are chips: a short label beside an icon, or
/// an icon alone. Neither is a phrase a test can match on the way the
/// old full-sentence buttons could, so a chip is found by its
/// **accessible name** — the label, or the tooltip where there is no
/// label. That is also what a screen reader announces, so a test that
/// cannot find a control is a control a user cannot find either.
///
/// The seven panel-adding commands live behind the Add menu, which this
/// opens on the way past.

import { fireEvent } from "@testing-library/react";
import { flushSync } from "react-dom";

/// The chip on the bar with this accessible name — "Open", "Import",
/// "Database panel". Throws rather than returning null: a test that has
/// lost a control should say so where it happened.
export function toolbarChip(name: string): HTMLButtonElement {
  // Every button on the bar itself, however deeply the chip sits — a
  // split chip nests one inside a segment inside a menu wrapper — but
  // not the entries inside an open menu, which are reached by the
  // helpers below.
  const chips = Array.from(document.querySelectorAll<HTMLButtonElement>(".toolbar button")).filter(
    (el) => el.closest(".chip-menu-list") === null,
  );
  const chip = chips.find((c) => c.getAttribute("aria-label") === name);
  if (!chip) {
    const had = chips.map((c) => c.getAttribute("aria-label")).join(", ");
    throw new Error(`no toolbar chip named "${name}" — the bar has: ${had}`);
  }
  return chip;
}

/// The Add menu's entry for a panel kind — "Plot Panel", "Color Map".
/// Opens the menu if it is not already open, so the caller can click
/// the entry it gets back.
export function addPanelChip(label: string): HTMLButtonElement {
  if (document.querySelector(".toolbar .chip-menu-list") === null) {
    // Flushed on the spot: callers reach for the entry in the same
    // statement they open the menu in, usually already inside an
    // `act(...)` that would otherwise hold the render back.
    flushSync(() => {
      fireEvent.click(toolbarChip("Add a panel"));
    });
  }
  const entries = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".toolbar .chip-menu-list .chip-button"),
  );
  const entry = entries.find((e) => e.textContent === label);
  if (!entry) {
    const had = entries.map((e) => e.textContent).join(", ");
    throw new Error(`no Add-menu entry "${label}" — the menu has: ${had}`);
  }
  return entry;
}

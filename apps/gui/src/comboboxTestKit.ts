// Test-only helpers for driving the shared Combobox (Combobox.tsx)
// the way suites used to drive a native `<select>` with
// `fireEvent.change`. Imported by *.dom.test.tsx files only.

import { fireEvent, waitFor } from "@testing-library/react";

/// Open `trigger` (the combobox's closed-state button) if it isn't
/// open already.
export function openCombobox(trigger: HTMLElement): void {
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
}

/// The dropdown option element carrying submitted value `value`, or
/// undefined. The dropdown must be open.
function findOption(value: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (el) => el.dataset.value === value,
  );
}

/// Open `trigger` and click the option whose *submitted value* is
/// `value` — the combobox equivalent of
/// `fireEvent.change(select, { target: { value } })`. Waits for the
/// option to appear, so an async-loaded catalog is fine.
export async function pickCombobox(trigger: HTMLElement, value: string): Promise<void> {
  openCombobox(trigger);
  const option = await waitFor(() => {
    const found = findOption(value);
    if (!found) throw new Error(`combobox option ${JSON.stringify(value)} not present`);
    return found;
  });
  fireEvent.click(option);
}

/// The submitted value the combobox currently carries — the
/// equivalent of reading `select.value`.
export function comboboxValue(trigger: HTMLElement): string {
  return (trigger as HTMLButtonElement).value;
}

/// Labels of the options the open dropdown currently lists, in order.
export function comboboxOptionLabels(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map(
    (el) => el.textContent ?? "",
  );
}

// The `unit-customizations` custom setting renderer (ADR 0034): what
// this project's DBC unit strings mean.
//
// A DBC's unit field is free text, so the host recognises the common
// spellings ("V", "mV", "degC", "rpm", …) built in and this setting
// holds only what the user changed. It is the one workspace-scoped
// setting — it interprets *this project's* databases and travels with
// them (ADR 0042 §3) — so the panel shows the project's own rows.

import type { SettingDescriptor } from "./settingDescriptors";

/// The dict as the host serialises it: DBC unit string → unit id.
function rowsOf(value: unknown): [string, string][] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([a], [b]) => a.localeCompare(b));
}

export function UnitCustomizations({
  value,
  onCommit,
}: {
  descriptor: SettingDescriptor;
  value: unknown;
  onCommit: (value: unknown) => void;
}) {
  const rows = rowsOf(value);
  if (rows.length === 0) {
    return (
      <p className="setting-custom unit-customizations-empty">
        This project adds nothing: every unit string is read with the built-in
        recognitions.
      </p>
    );
  }
  const remove = (key: string) =>
    onCommit(Object.fromEntries(rows.filter(([k]) => k !== key)));
  return (
    <div className="unit-customizations">
      {rows.map(([spelling, unit]) => (
        <div className="unit-customization-row" key={spelling}>
          <code className="unit-customization-spelling">{spelling}</code>
          <span aria-hidden="true">→</span>
          <span className="unit-customization-unit">{unit}</span>
          <button
            type="button"
            aria-label={`Remove the customization for ${spelling}`}
            onClick={() => remove(spelling)}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

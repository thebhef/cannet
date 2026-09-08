// The `unit-customizations` custom setting renderer (ADR 0034): what
// this project's DBC unit strings mean.
//
// A DBC's unit field is free text, so the host recognises the common
// spellings ("V", "mV", "degC", "rpm", …) built in and this setting
// holds only what the user changed.
//
// It renders **two** settings, one per scope, because the mappings live
// at both: `unit_customizations` is workspace-scoped — it interprets
// *this project's* databases and travels with them (ADR 0042 §3) — and
// `unit_customizations_user` is the same map promoted to every project
// the person opens. The host joins them, and **the project wins** where
// both map one string. The renderer is key-agnostic: it edits whichever
// dict its descriptor names.
//
// A customization is a DBC unit string mapped onto a unit the host's
// library carries, so the add path is that pair: the spelling as the
// database writes it, and a unit picked from the library the host
// serves. It is a settings row and nothing more — the value it commits
// is the whole dict, which the panel writes through `updateSettings`
// like every other setting.

import { useState } from "react";

import { Combobox } from "./Combobox";
import { unitOptions, useUnitLibrary } from "./unitLibrary";
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
  const units = useUnitLibrary();
  const [spelling, setSpelling] = useState("");
  const [unit, setUnit] = useState("");
  const rows = rowsOf(value);
  const write = (next: [string, string][]) => onCommit(Object.fromEntries(next));
  const add = () => {
    // Trimmed: a DBC's padding is not part of what the user typed, and
    // the host consults a customization on the raw string *and* its
    // trimmed form either way.
    write([...rows.filter(([k]) => k !== spelling.trim()), [spelling.trim(), unit]]);
    setSpelling("");
    setUnit("");
  };
  return (
    <div className="setting-custom unit-customizations">
      {rows.length === 0 ? (
        <p className="unit-customizations-empty">
          This project adds nothing: every unit string is read with the built-in
          recognitions.
        </p>
      ) : (
        rows.map(([raw, id]) => {
          const known = units.find((u) => u.id === id);
          return (
            <div className="unit-customization-row" key={raw}>
              <code className="unit-customization-spelling">{raw}</code>
              <span aria-hidden="true">→</span>
              <span
                className="unit-customization-unit"
                // A hand-edit, or an id a later build dropped: the host
                // recognises nothing for it, so the row shows the file's
                // own word rather than inventing one.
                title={known ? undefined : "no unit in the library carries this id"}
              >
                {known ? `${known.display} (${id})` : id}
              </span>
              <button
                type="button"
                aria-label={`Remove the customization for ${raw}`}
                onClick={() => write(rows.filter(([k]) => k !== raw))}
              >
                Remove
              </button>
            </div>
          );
        })
      )}
      <div className="unit-customization-add">
        <input
          type="text"
          aria-label="Unit string as the database spells it"
          placeholder="e.g. mAmp"
          value={spelling}
          onChange={(e) => setSpelling(e.target.value)}
        />
        <span aria-hidden="true">→</span>
        <Combobox
          options={unitOptions(units, (u) => u.id)}
          value={unit}
          ariaLabel="Library unit"
          placeholder="choose a unit…"
          title="the unit from the host's library that this spelling means"
          proseLabels
          onChange={setUnit}
        />
        <button
          type="button"
          disabled={spelling.trim() === "" || unit === ""}
          onClick={add}
        >
          Add
        </button>
      </div>
    </div>
  );
}

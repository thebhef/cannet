// The `unit-customizations` custom setting renderer (ADR 0034): the
// **Settings → Units** section — what this project's DBC unit strings
// mean.
//
// One row per unit: the library's full base-unit set, plus any unit the
// user or project config names, each carrying the strings that read as
// it. Which row a string lands on is the host's answer and nothing else
// (`list_unit_mappings` over `units::recognize`, ADR 0025) — so the table
// cannot disagree with what the app actually does, and a spelling both
// scopes map appears once, on the reading that wins.
//
// **Two scopes, one table.** The mappings live at both:
// `unit_customizations` is workspace-scoped — it interprets *this
// project's* databases and travels with them (ADR 0042 §3) — and
// `unit_customizations_user` is the same map promoted to every project
// the person opens; the host joins them and **the project wins**. The
// per-row checkboxes are where that choice is made, which is why the
// user-scope key has no row of its own: a second row would be a second
// editor of one fact.
//
// The descriptor's own key (the project dict) is edited through the
// panel's `onCommit`, so the row keeps the panel's optimistic value and
// its reset-to-default; the user dict has no row and so is written
// directly through `updateSettings`.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { subscribeSettings, updateSettings, useSetting } from "./hostSettings";
import type { SettingDescriptor } from "./settingDescriptors";
import type { UnitId } from "./types";

/// One string that reads as a unit, and where that reading comes from.
interface UnitMapping {
  spelling: string;
  /// `builtIn` ships with the app and persists nowhere; the other two
  /// are the scopes the row's checkboxes govern.
  source: "builtIn" | "project" | "user";
}

/// One row, as `list_unit_mappings` serves it.
interface UnitMappingRow {
  unit: UnitId;
  /// The stored id a customization writes to name this unit. `null` for
  /// a unit nothing can be mapped *to*.
  id: string | null;
  display: string;
  dimensionLabel: string;
  mappings: UnitMapping[];
}

/// The dict as the host serialises it: DBC unit string → unit id.
function dictOf(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function UnitCustomizations({
  value,
  onCommit,
}: {
  descriptor: SettingDescriptor;
  value: unknown;
  onCommit: (value: unknown) => void;
}) {
  const project = dictOf(value);
  const user = useSetting("unit_customizations_user");
  const [rows, setRows] = useState<UnitMappingRow[]>([]);
  const [filter, setFilter] = useState("");

  // The host reads both dicts from its own settings cache, so the table
  // is re-asked once a write has **landed** there — which is what the
  // settings store publishes, and the only moment the host's answer can
  // have changed. Keying the fetch on the dict this component was
  // handed would ask too early and then not at all: a commit arrives
  // here as a new value the instant it is made (the panel sets it
  // optimistically), while `updateSettings` is still a read-modify-write
  // round-trip away from the host — so the table would re-read the old
  // mappings and never see the value settle to what it already showed.
  // A publish also covers a re-hydrate after a hand-edit.
  const [settled, setSettled] = useState(0);
  useEffect(() => subscribeSettings(() => setSettled((n) => n + 1)), []);
  useEffect(() => {
    let live = true;
    void invoke<UnitMappingRow[] | null>("list_unit_mappings")
      .then((r) => {
        if (live) setRows(r ?? []);
      })
      .catch(() => {
        /* no host: the section renders empty rather than throwing */
      });
    return () => {
      live = false;
    };
  }, [settled]);

  /// The spellings this row persists — the ones a scope checkbox moves.
  /// A built-in match is not one: it ships with the app and is not
  /// stored anywhere, so a row that only has those has nothing to
  /// promote or demote.
  const customOf = useCallback(
    (row: UnitMappingRow) =>
      row.mappings.filter((m) => m.source !== "builtIn").map((m) => m.spelling),
    [],
  );

  /// Put this row's custom mappings into a scope, or take them out.
  ///
  /// Promoting copies rather than moves: a project's own reading of its
  /// databases is more specific than a habit carried between projects,
  /// so it stays in force where it already was, and the host's join
  /// (project over user) is what settles a string both scopes hold.
  const setScope = (row: UnitMappingRow, scope: "project" | "user", on: boolean) => {
    const spellings = customOf(row);
    if (spellings.length === 0 || row.id == null) return;
    const dict = scope === "project" ? project : user;
    const next = { ...dict };
    for (const spelling of spellings) {
      if (on) next[spelling] = row.id;
      else delete next[spelling];
    }
    if (scope === "project") onCommit(next);
    else void updateSettings({ unit_customizations_user: next });
  };

  /// A spelling assigned to this row, typed into it. It lands in the
  /// **project** dict: a mapping is made because of the databases in
  /// front of the user, and the user checkbox is how it is promoted
  /// afterwards.
  const addSpelling = (row: UnitMappingRow, raw: string) => {
    const spelling = raw.trim();
    // Trimmed: a DBC's padding is not part of what the user typed, and
    // the host consults a customization on the raw string *and* its
    // trimmed form either way.
    if (spelling === "" || row.id == null) return;
    onCommit({ ...project, [spelling]: row.id });
  };

  const removeSpelling = (spelling: string, source: UnitMapping["source"]) => {
    if (source === "project") {
      const next = { ...project };
      delete next[spelling];
      onCommit(next);
      return;
    }
    const next = { ...user };
    delete next[spelling];
    void updateSettings({ unit_customizations_user: next });
  };

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? rows.filter(
        (r) =>
          r.display.toLowerCase().includes(needle) ||
          r.unit.base.includes(needle) ||
          r.dimensionLabel.includes(needle) ||
          r.mappings.some((m) => m.spelling.toLowerCase().includes(needle)),
      )
    : rows;

  return (
    <div className="setting-custom unit-customizations">
      <input
        type="search"
        className="unit-customizations-filter"
        aria-label="Filter units"
        placeholder="Filter units"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <table className="unit-customizations-table">
        <thead>
          <tr>
            <th scope="col">unit</th>
            <th scope="col">dimension</th>
            <th scope="col">matched strings</th>
            <th scope="col">project</th>
            <th scope="col">user</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <UnitRow
              key={`${row.unit.base}/${row.unit.prefix ?? ""}`}
              row={row}
              custom={customOf(row)}
              onAdd={(spelling) => addSpelling(row, spelling)}
              onRemove={removeSpelling}
              onScope={(scope, on) => setScope(row, scope, on)}
            />
          ))}
        </tbody>
      </table>
      {shown.length === 0 && (
        <p className="unit-customizations-empty">
          {rows.length === 0
            ? "The unit library has not loaded."
            : "No unit matches that filter."}
        </p>
      )}
    </div>
  );
}

function UnitRow({
  row,
  custom,
  onAdd,
  onRemove,
  onScope,
}: {
  row: UnitMappingRow;
  /// The spellings this row persists — what a scope checkbox moves.
  custom: readonly string[];
  onAdd: (spelling: string) => void;
  onRemove: (spelling: string, source: UnitMapping["source"]) => void;
  onScope: (scope: "project" | "user", on: boolean) => void;
}) {
  const [typed, setTyped] = useState("");
  const inScope = (scope: "project" | "user") =>
    row.mappings.some((m) => m.source === scope);
  // Nothing to promote or demote until the row persists something: a
  // built-in match ships with the app and is stored nowhere.
  const disabled = custom.length === 0;
  return (
    <tr>
      <td className="unit-customization-unit">{row.display}</td>
      <td className="unit-customization-dimension">{row.dimensionLabel}</td>
      <td>
        {row.mappings.map((m) => (
          <span
            key={m.spelling}
            className={`unit-customization-spelling ${m.source}`}
            title={
              m.source === "builtIn"
                ? "recognised without an entry — nothing to persist"
                : `mapped in your ${m.source} settings`
            }
          >
            {m.spelling}
            {m.source !== "builtIn" && (
              <button
                type="button"
                aria-label={`Remove the mapping for ${m.spelling}`}
                onClick={() => onRemove(m.spelling, m.source)}
              >
                ×
              </button>
            )}
          </span>
        ))}
        <input
          type="text"
          className="unit-customization-add"
          aria-label={`Map a unit string to ${row.display}`}
          placeholder="add a spelling"
          disabled={row.id == null}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            onAdd(typed);
            setTyped("");
          }}
          onBlur={() => {
            if (typed.trim() === "") return;
            onAdd(typed);
            setTyped("");
          }}
        />
      </td>
      <td className="unit-customization-scope">
        <input
          type="checkbox"
          aria-label={`Keep ${row.display} mappings in this project`}
          title="persist this row's own mappings in the project's settings — they travel with its databases"
          disabled={disabled}
          checked={inScope("project")}
          onChange={(e) => onScope("project", e.target.checked)}
        />
      </td>
      <td className="unit-customization-scope">
        <input
          type="checkbox"
          aria-label={`Keep ${row.display} mappings in every project`}
          title="persist this row's own mappings in your user settings — every project you open sees them; the project wins where both map one string"
          disabled={disabled}
          checked={inScope("user")}
          onChange={(e) => onScope("user", e.target.checked)}
        />
      </td>
    </tr>
  );
}

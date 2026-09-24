import { useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { SETTINGS_PANEL_ID } from "./dockLayout";
import { usePanelCommands } from "./panelCommands";
import { SettingsShownContext } from "./settingsShown";
import { SettingControl } from "./settingControls";
import { useScrollRestore } from "./useScrollRestore";
import {
  DEVELOPER_GROUP,
  EMPTY_SCHEMA,
  countsByGroup,
  formatSettingValue,
  primaryGroupIdOf,
  isDefaultValue,
  loadSettingDescriptors,
  loadSettingsOverrides,
  settingGroups,
  settingsMatcher,
  visibleSettings,
  type SettingDescriptor,
  type SettingsSchema,
  type SurfaceId,
} from "./settingDescriptors";
import {
  hostSettings,
  hydrateSettings,
  subscribeSettings,
  updateSettings,
  type Settings,
} from "./hostSettings";

/// How long the search box settles before the list re-filters — the same
/// rule and the same number the Database panel's tree filter uses, so a burst
/// of keystrokes costs one match instead of one per character.
const FILTER_DEBOUNCE_MS = 150;

/**
 * Settings panel — a descriptor-driven editor over the host's
 * `settings.json` (ADR 0034).
 *
 * The panel is **generated**, not hand-written: the host serves a
 * descriptor per setting (`get_setting_descriptors`) carrying its label,
 * help text, control shape, tags, scope, and default, and every row here
 * is rendered from that. Adding a setting is a host-side table entry;
 * nothing in this file names one.
 *
 * Search is `fzf` over label, key, help text, and tags. The tree groups
 * by the descriptor's surface tag, except that `developer`-tagged
 * settings collect into their own group — and are hidden entirely until
 * `show_developer_settings` is on. **Nothing announces what is hidden**:
 * no banner, no count, no "some results are hidden". The toggle that
 * reveals them is an ordinary setting, one search away.
 *
 * Values come from the shared `hostSettings` cache — the panel
 * re-hydrates on mount (picking up a hand-edit made since boot), follows
 * changes any other consumer makes, and writes through `updateSettings`,
 * which merges each edit over a fresh read. A singleton panel (one
 * instance, fixed dockview id), opened from the command palette.
 *
 * **Nothing here is owned, and nothing here polls.** Every value on the
 * view is a read of the host — the settings file, the open project's
 * overrides, the project registry — and each can move while the user is
 * looking at another panel. A cache size comes from a directory walk,
 * far too expensive to put on a timer (ADR 0002 DS-8), so the view
 * re-reads at the one moment that is both cheap and exactly when it
 * matters: coming back on screen.
 */
export function SettingsPanel({ api }: IDockviewPanelProps) {
  const [settings, setSettings] = useState<Settings>(hostSettings);
  const [schema, setSchema] = useState<SettingsSchema>(EMPTY_SCHEMA);
  /// Keys the open project's `.cannet/settings.json` declares, so an
  /// overridden value is visible as one instead of looking like a
  /// personal preference (ADR 0042 §3).
  const [overrides, setOverrides] = useState<readonly string[]>([]);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<SurfaceId | null>(null);

  /// The search box, so `panel.find` (Mod+F, ADR 0018) can focus and
  /// select it. Registered under the panel's fixed dockview id — the
  /// Settings panel is a singleton with no element id of its own
  /// (`runFocusedPanelCommand` in `useCommands.tsx` falls back to it).
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  usePanelCommands(SETTINGS_PANEL_ID, {
    "panel.find": () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    },
  });

  /// How many times this view has been on screen, counting its first
  /// render. Every increment is a re-read; the count is published so the
  /// project caches list — reached only through the custom-renderer
  /// table, which passes a renderer nothing — hears about it too.
  const [shownCount, setShownCount] = useState(1);
  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => {
      if (e.isVisible) setShownCount((n) => n + 1);
    });
    return () => d.dispose();
  }, [api]);

  // The descriptor table is generated at build time and the settings
  // subscription is standing, so both are mount-only.
  useEffect(() => {
    const unsubscribe = subscribeSettings(setSettings);
    let live = true;
    void loadSettingDescriptors().then((s) => {
      if (live) setSchema(s);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  // The file may have been hand-edited, and another project — with its
  // own overrides — may have been opened, since this view was last on
  // screen. Coming back is exactly when to find out.
  useEffect(() => {
    let live = true;
    void hydrateSettings();
    void loadSettingsOverrides().then((o) => {
      if (live) setOverrides(o);
    });
    return () => {
      live = false;
    };
  }, [shownCount]);

  /// Where the user had scrolled to. dockview's default renderer removes
  /// a hidden panel's element from the document, and a box with no
  /// layout keeps no scroll offset, so the view puts its own back
  /// (`useScrollRestore`, shared with the two inner row spaces). View
  /// state, held in a ref: it drives no render.
  const listRef = useRef<HTMLDivElement | null>(null);
  const onListScroll = useScrollRestore(listRef, shownCount);

  // Debounced, so typing re-renders the input and nothing else.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  // Searching drops any group selection, so a query searches everything.
  // Filtering a search *within* a group hides matches outside it, and
  // the panel then looks like it found nothing when it found plenty.
  // The tree returns to "All settings" so the state is visible rather
  // than merely ignored, and clearing the query does not restore the
  // old group — search took over, and this is where it left you.
  useEffect(() => {
    if (typed.trim() !== "") setGroup(null);
  }, [typed]);

  const match = useMemo(() => settingsMatcher(schema), [schema]);
  const showDeveloper = settings.show_developer_settings;
  const groups = useMemo(
    () => settingGroups(schema, showDeveloper),
    [schema, showDeveloper],
  );
  // A selection that no longer exists — Developer, after the toggle went
  // off — falls back to "All settings" rather than showing nothing.
  const selected = groups.some((g) => g.id === group) ? group : null;

  const matched = useMemo(() => match(query), [match, query]);
  const inScope = useMemo(
    () => visibleSettings(matched, showDeveloper, null),
    [matched, showDeveloper],
  );
  const shown = useMemo(
    () => visibleSettings(inScope, showDeveloper, selected),
    [inScope, showDeveloper, selected],
  );
  const counts = useMemo(() => countsByGroup(inScope), [inScope]);
  // The denominator counts only what the user can see, so the footer
  // never hints at a hidden setting.
  const total = useMemo(
    () => visibleSettings(schema.settings, showDeveloper, null).length,
    [schema, showDeveloper],
  );

  const values = settings as unknown as Record<string, unknown>;
  const commit = (key: string, value: unknown) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    void updateSettings({ [key]: value } as Partial<Settings>).catch(() => {
      /* host logs the failure; the in-memory value still holds */
    });
  };

  const rows = (list: readonly SettingDescriptor[]) =>
    list.map((descriptor) => (
      <SettingRow
        key={descriptor.key}
        descriptor={descriptor}
        surfaceLabel={surfaceLabelOf(schema, descriptor)}
        value={values[descriptor.key]}
        overridden={overrides.includes(descriptor.key)}
        onCommit={(value) => commit(descriptor.key, value)}
      />
    ));

  // Bound to a name rather than returned inline, so the provider below
  // wraps it without re-indenting the whole view.
  const body = (
    <div className="settings-view">
      <div className="settings-header">
        <input
          ref={searchInputRef}
          type="search"
          className="settings-search"
          placeholder="Search settings"
          aria-label="Search settings"
          autoComplete="off"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>
      <div className="settings-body">
        <div className="settings-tree" role="tree" aria-label="Setting groups">
          <button
            type="button"
            role="treeitem"
            aria-selected={selected === null}
            className={`settings-tree-row${selected === null ? " selected" : ""}`}
            onClick={() => setGroup(null)}
          >
            <span className="settings-tree-label">All settings</span>
            <span className="settings-tree-count">{inScope.length}</span>
          </button>
          {groups.map((g) => {
            const count = counts.get(g.id) ?? 0;
            // A group with nothing in it is noise, and worse than noise
            // when it implies the user has missed something. This also
            // covers a group emptied only because its developer rows are
            // hidden — which must look identical to one that has no
            // settings at all, or the tree would announce what is hidden.
            if (count === 0) return null;
            return (
              <button
                type="button"
                key={g.id}
                role="treeitem"
                aria-selected={selected === g.id}
                className={`settings-tree-row${selected === g.id ? " selected" : ""}${
                  g.id === DEVELOPER_GROUP ? " developer" : ""
                }`}
                onClick={() => setGroup(g.id)}
              >
                <span className="settings-tree-label">{g.label}</span>
                <span className="settings-tree-count">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="settings-list" ref={listRef} onScroll={onListScroll}>
          {shown.length === 0 && (
            <p className="settings-empty">
              {query === "" ? "No settings." : `No settings match “${query}”.`}
            </p>
          )}
          {/* A query ranks globally, so grouping it would fight the
              ranking; an unfiltered list is grouped. */}
          {query === ""
            ? groups.map((g) => {
                const inGroup = shown.filter((d) => primaryGroupIdOf(d) === g.id);
                if (inGroup.length === 0) return null;
                return (
                  <section key={g.id}>
                    <h3 className="settings-group-head">{g.label}</h3>
                    {rows(inGroup)}
                  </section>
                );
              })
            : rows(shown)}
        </div>
      </div>
      <div className="settings-footer">
        <span>
          {shown.length} of {total} settings
        </span>
        <span className="settings-footer-hint">
          Backed by <code>settings.json</code> — hand-editable
        </span>
      </div>
    </div>
  );

  // Published to what the view renders: the project caches list is
  // reached through the custom-renderer table, which passes a renderer
  // nothing about the panel hosting it.
  return (
    <SettingsShownContext.Provider value={shownCount}>{body}</SettingsShownContext.Provider>
  );
}

/// The label of a setting's first surface, for the chip a developer row
/// shows in place of the group it is no longer filed under.
function surfaceLabelOf(schema: SettingsSchema, descriptor: SettingDescriptor): string {
  const id = descriptor.surfaces[0];
  return schema.surfaces.find((s) => s.id === id)?.label ?? (id ?? "");
}

function SettingRow({
  descriptor,
  surfaceLabel,
  value,
  overridden,
  onCommit,
}: {
  descriptor: SettingDescriptor;
  surfaceLabel: string;
  value: unknown;
  overridden: boolean;
  onCommit: (value: unknown) => void;
}) {
  const isDefault = isDefaultValue(descriptor, value);
  const custom = descriptor.control.type === "custom";
  // A view row is not a field of `settings.json`, so it shows no key —
  // the panel teaches the file, and pointing at a key nothing stores
  // would teach the wrong thing.
  const field = descriptor.backing !== "view";
  return (
    <div
      className={`setting${overridden ? " overridden" : isDefault ? "" : " modified"}`}
    >
      <div className="setting-top">
        <span className="setting-label">{descriptor.label}</span>
        {field && <code className="setting-key">{descriptor.key}</code>}
        <span className="setting-chips">
          {descriptor.kind === "developer" ? (
            <>
              <span className="setting-chip">{surfaceLabel}</span>
              <span className="setting-chip developer">developer</span>
            </>
          ) : (
            <span className="setting-chip">{descriptor.kind}</span>
          )}
          {descriptor.scope === "user-overridable" && (
            <span className="setting-chip scope">project-overridable</span>
          )}
        </span>
      </div>
      {/* A self-describing setting carries no help text, and then the
          paragraph is not rendered at all — an empty one still takes its
          margin, which reads as a missing description rather than a
          setting whose label says everything. */}
      {descriptor.help !== "" && <p className="setting-desc">{descriptor.help}</p>}
      <div className="setting-ctl">
        <SettingControl descriptor={descriptor} value={value} onCommit={onCommit} />
      </div>
      <div className="setting-meta">
        {overridden && (
          <span className="setting-from">
            Set by this project — the value lives in its{" "}
            <code>.cannet/settings.json</code>
          </span>
        )}
        {!overridden && !isDefault && !custom && (
          <span className="setting-from">
            Modified — the default is {formatSettingValue(descriptor, descriptor.default)}
          </span>
        )}
        {!isDefault && !custom && (
          <button
            type="button"
            className="setting-reset"
            onClick={() => onCommit(descriptor.default)}
          >
            Reset to default
          </button>
        )}
      </div>
    </div>
  );
}

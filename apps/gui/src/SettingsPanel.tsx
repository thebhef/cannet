import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import {
  hostSettings,
  hydrateSettings,
  loadSettingsBounds,
  subscribeSettings,
  updateSettings,
  type Settings,
  type SettingsBounds,
} from "./hostSettings";

const BYTES_PER_MB = 1024 * 1024;

/**
 * Settings panel — a flat, hand-rolled editor over the host's
 * `settings.json` (ADR 0034). User intent only (the disk-spill scratch
 * cap and clear-on-exit), distinct from the machine state in `hostState`.
 * The file is the durable contract; this panel is a view over the shared
 * `hostSettings` cache — it re-hydrates on mount (picking up a hand-edit
 * made since boot), follows changes any other consumer makes, and writes
 * through `updateSettings`, which merges each edit over a fresh read.
 * Field limits come from the host (`loadSettingsBounds`) rather than being
 * restated here, and the host is the one that enforces them — this panel
 * displays whatever the host says it stored. A singleton panel (one
 * instance, fixed dockview id), opened from the command palette.
 */
export function SettingsPanel(_props: IDockviewPanelProps) {
  const [settings, setSettings] = useState<Settings>(hostSettings);
  const [bounds, setBounds] = useState<SettingsBounds | null>(null);
  // In-progress text for the cap box. `null` = show the stored value. The
  // box can't be written through on every keystroke: the host refuses a
  // below-minimum cap, so "500" typed one digit at a time would be refused
  // (and the box reset) before the last digit arrived.
  const [capDraft, setCapDraft] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeSettings(setSettings);
    // The file may have been hand-edited since boot; a panel opening is
    // exactly when to find out.
    void hydrateSettings();
    let live = true;
    void loadSettingsBounds()
      .then((b) => {
        if (live) setBounds(b);
      })
      .catch(() => {
        /* no host: render without the limit rather than inventing one */
      });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  // Persist an edit: show it immediately, then write through the shared
  // cache, which merges the patch over a fresh read of the file — not over
  // this panel's snapshot — so a concurrent write (the shortcuts panel
  // persisting a keybinding) isn't clobbered. The host is authoritative and
  // answers with what it stored, which is what every consumer then sees.
  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    void updateSettings(patch).catch(() => {
      /* host logs the failure; the in-memory value still holds */
    });
  };

  const minCapMb = bounds == null ? undefined : Math.ceil(bounds.minScratchCapBytes / BYTES_PER_MB);
  const storedCapMb =
    settings.scratch_cap_bytes == null
      ? ""
      : String(Math.round(settings.scratch_cap_bytes / BYTES_PER_MB));

  // Commit the typed cap on blur / Enter. Blank = unbounded; anything
  // unparseable reverts to the stored value. A too-small number is *sent* —
  // the host is the one that judges it, and reports the refusal.
  const commitCap = () => {
    if (capDraft == null) return;
    const trimmed = capDraft.trim();
    setCapDraft(null);
    if (trimmed === "") {
      update({ scratch_cap_bytes: null });
      return;
    }
    const mb = Number(trimmed);
    if (!Number.isFinite(mb) || mb < 0) return;
    update({ scratch_cap_bytes: Math.round(mb * BYTES_PER_MB) });
  };

  return (
    <div className="settings-panel">
      <fieldset className="settings-group">
        <legend>Disk-spill Cache</legend>
        <label className="settings-field">
          <span className="settings-label">Cache size cap (MB)</span>
          <input
            type="number"
            min={minCapMb}
            step={64}
            placeholder="unbounded"
            value={capDraft ?? storedCapMb}
            onChange={(e) => setCapDraft(e.target.value)}
            onBlur={commitCap}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitCap();
            }}
          />
          <span className="settings-desc">
            Drop the oldest history once the on-disk cache exceeds this.
            {minCapMb != null && (
              <> Minimum {minCapMb} MB — below that, pre-allocated segments
              dominate and the cap can't be honored, so a smaller value is
              refused.</>
            )}{" "}
            Blank = unbounded.
          </span>
        </label>
        <label className="settings-field settings-field-checkbox">
          <input
            type="checkbox"
            checked={settings.clear_scratch_on_exit}
            onChange={(e) => update({ clear_scratch_on_exit: e.target.checked })}
          />
          <span className="settings-label">Clear cache on exit</span>
          <span className="settings-desc">
            Wipe the disk-spill cache when the app closes cleanly, instead of
            reloading the prior session on the next launch.
          </span>
        </label>
      </fieldset>
    </div>
  );
}

import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";

import {
  defaultSettings,
  loadSettings,
  saveSettings,
  type Settings,
} from "./hostSettings";

const BYTES_PER_MB = 1024 * 1024;

/// Minimum effective scratch cap in MB (ADR 0002 DS-8). A smaller cap can't
/// be honored — the pre-allocated segment families (one payload + one filter
/// segment alone are ~12 MiB) dominate the budget and the retained window
/// thrashes a segment at a time. The host clamps authoritatively; the UI
/// mirrors the floor so the displayed value matches what's enforced. Keep in
/// sync with `settings::MIN_SCRATCH_CAP_BYTES`.
const MIN_CAP_MB = 100;

/**
 * Settings panel — a flat, hand-rolled editor over the host's
 * `settings.json` (ADR 0034). User intent only (the disk-spill scratch
 * cap and clear-on-exit), distinct from the machine state in `hostState`.
 * The file is the durable contract; this panel loads it on mount and
 * writes the whole struct back on each edit. A singleton panel (one
 * instance, fixed dockview id), opened from the command palette. Also
 * hosts the read-only About section (build version).
 */
export function SettingsPanel(_props: IDockviewPanelProps) {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState("");

  // The host stamps the binary with `git describe` at build time; the
  // About section is where an alpha build is identified (the native
  // title bar carries only the project name).
  useEffect(() => {
    let live = true;
    invoke<string>("app_version")
      .then((v) => live && setVersion(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void loadSettings().then((s) => {
      if (live) {
        setSettings(s);
        setLoaded(true);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  // Persist the whole struct on each edit; the host is authoritative.
  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void saveSettings(next).catch(() => {
        /* host logs the failure; the in-memory value still holds */
      });
      return next;
    });
  };

  const capMb =
    settings.scratch_cap_bytes == null
      ? ""
      : // Mirror the host's floor: a stored sub-floor value (e.g. a
        // hand-edited settings.json) is enforced at the floor, so show it.
        String(Math.max(MIN_CAP_MB, Math.round(settings.scratch_cap_bytes / BYTES_PER_MB)));

  const onCapChange = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      update({ scratch_cap_bytes: null });
      return;
    }
    const mb = Number(trimmed);
    if (!Number.isFinite(mb) || mb < 0) return; // ignore non-numeric / negative
    // Mirror the host's cap floor (ADR 0002 DS-8) so the box never shows a
    // value smaller than what's actually enforced.
    update({ scratch_cap_bytes: Math.round(Math.max(mb, MIN_CAP_MB) * BYTES_PER_MB) });
  };

  return (
    <div className="settings-panel">
      <fieldset className="settings-group" disabled={!loaded}>
        <legend>Disk-spill Cache</legend>
        <label className="settings-field">
          <span className="settings-label">Cache size cap (MB)</span>
          <input
            type="number"
            min={MIN_CAP_MB}
            step={64}
            placeholder="unbounded"
            value={capMb}
            onChange={(e) => onCapChange(e.target.value)}
          />
          <span className="settings-desc">
            Drop the oldest history once the on-disk cache exceeds this.
            Minimum {MIN_CAP_MB} MB — below that, pre-allocated segments
            dominate and the cap can't be honored. Blank = unbounded.
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
      <fieldset className="settings-group">
        <legend>About</legend>
        <div className="settings-field">
          <span className="settings-label">Version</span>
          <span className="settings-desc">{version || "unknown"}</span>
        </div>
      </fieldset>
    </div>
  );
}

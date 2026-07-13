import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";

/**
 * About panel — a read-only singleton (one instance, fixed dockview id),
 * opened from the command palette. Shows the build version and the
 * bundled third-party license texts.
 *
 * The license block is the runtime "prominent notice" surface for the
 * redistributed frozen-sidecar dependencies (LGPL-3.0 §4a–c); the host
 * `include_str!`'s the committed `THIRD-PARTY-LICENSES` and hands it over
 * verbatim through `third_party_licenses` (ADR 0036).
 */
export function AboutPanel(_props: IDockviewPanelProps) {
  const [version, setVersion] = useState("");
  const [licenses, setLicenses] = useState("");

  // The host stamps the binary with `git describe` at build time; the
  // About section is where an alpha build is identified (the native
  // title bar carries only the project name).
  useEffect(() => {
    let live = true;
    invoke<string>("app_version")
      .then((v) => live && setVersion(v))
      .catch(() => {});
    invoke<string>("third_party_licenses")
      .then((t) => live && setLicenses(t))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="settings-panel">
      <fieldset className="settings-group">
        <legend>About</legend>
        <div className="settings-field">
          <span className="settings-label">Version</span>
          <span className="settings-desc">{version || "unknown"}</span>
        </div>
      </fieldset>
      <fieldset className="settings-group">
        <legend>Third-party licenses</legend>
        <div className="settings-desc">
          Notices for the dependencies bundled with the sidecar
          (python-can, grpcio, protobuf, uptime, CPython).
        </div>
        <pre className="about-licenses">{licenses || "loading…"}</pre>
      </fieldset>
    </div>
  );
}

import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";

type DependencyLicense = {
  name: string;
  version: string;
  spdx: string;
  origin: string;
  licenseText: string;
};

type ComponentLicenses = {
  component: string;
  dependencies: DependencyLicense[];
};

/**
 * About panel — a read-only singleton (one instance, fixed dockview id),
 * opened from the command palette. Shows the build version and the
 * bundled third-party license texts.
 *
 * The license block is the runtime "prominent notice" surface for the
 * redistributed frozen-sidecar dependencies (LGPL-3.0 §4a–c); the host
 * serves the build-generated, bundled `licenses.json` manifest through
 * `third_party_licenses` (ADR 0036). A developer `cargo run` has no
 * bundled manifest, so the section is empty there.
 */
export function AboutPanel(_props: IDockviewPanelProps) {
  const [version, setVersion] = useState("");
  const [components, setComponents] = useState<ComponentLicenses[]>([]);

  // The host stamps the binary with `git describe` at build time; the
  // About section is where an alpha build is identified (the native
  // title bar carries only the project name).
  useEffect(() => {
    let live = true;
    invoke<string>("app_version")
      .then((v) => live && setVersion(v))
      .catch(() => {});
    invoke<ComponentLicenses[]>("third_party_licenses")
      .then((c) => live && setComponents(c))
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
        {components.length === 0 ? (
          <div className="settings-desc">
            Bundled attribution is generated in packaged builds.
          </div>
        ) : (
          components.map((component) => (
            <details key={component.component} className="about-license-group">
              <summary>
                {component.component} ({component.dependencies.length})
              </summary>
              {component.dependencies.map((dep) => (
                <details key={dep.name} className="about-license-dep">
                  <summary>
                    {dep.name} {dep.version} · {dep.spdx} · {dep.origin}
                  </summary>
                  <pre className="about-licenses">{dep.licenseText}</pre>
                </details>
              ))}
            </details>
          ))
        )}
      </fieldset>
    </div>
  );
}

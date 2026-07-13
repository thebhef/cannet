//! Runtime third-party license attribution for the About view.
//!
//! This is the LGPL-3.0 §4a-c runtime "prominent notice" surface for the
//! redistributed frozen-sidecar dependencies. The attribution manifest is
//! **generated at build time** from the frozen deps' own dist-info license
//! files, **bundled as a Tauri resource** (`licenses.json`), and read here
//! at runtime — no license text is committed to the repo (ADR 0036).
//!
//! Because the manifest is a bundle resource, a developer build launched
//! with `cargo run` (no packaged resources) shows nothing; the attribution
//! surface is populated only in packaged builds.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// One attribution component (e.g. the python-can sidecar) and the
/// dependencies it redistributes.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentLicenses {
    pub component: String,
    pub dependencies: Vec<DependencyLicense>,
}

/// A single redistributed dependency and its verbatim license text.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyLicense {
    pub name: String,
    pub version: String,
    pub spdx: String,
    pub origin: String,
    pub license_text: String,
}

/// Wrapper matching the bundled `licenses.json` top-level shape.
#[derive(Deserialize)]
struct Manifest {
    components: Vec<ComponentLicenses>,
}

/// Parse the bundled manifest, returning its components. Returns an empty
/// vec on any parse error — attribution is best-effort at runtime and must
/// never fail the About view.
fn parse_manifest(json: &str) -> Vec<ComponentLicenses> {
    serde_json::from_str::<Manifest>(json)
        .map(|m| m.components)
        .unwrap_or_default()
}

/// Serve the bundled third-party license manifest to the About view.
///
/// Resolves `licenses.json` in Tauri's resource directory and returns the
/// parsed components. Returns an empty vec when the resource dir can't be
/// resolved or the file is absent — the developer `cargo run` flow has no
/// bundled manifest and simply shows nothing (ADR 0036).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn third_party_licenses(app: AppHandle) -> Vec<ComponentLicenses> {
    let Ok(dir) = app.path().resource_dir() else {
        return Vec::new();
    };
    match std::fs::read_to_string(dir.join("licenses.json")) {
        Ok(json) => parse_manifest(&json),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The `resource_dir()` path in `third_party_licenses` is eyeball-
    // verified: unit tests have no `AppHandle`, so only `parse_manifest`
    // (the pure part) is exercised here.

    #[test]
    fn parse_manifest_reads_valid_json() {
        let json = r#"{
          "components": [
            { "component": "python-can sidecar",
              "dependencies": [
                { "name": "uptime", "version": "3.0.1",
                  "spdx": "BSD-2-Clause", "origin": "python",
                  "licenseText": "BSD TEXT" }
              ] }
          ]
        }"#;
        let components = parse_manifest(json);
        assert_eq!(components.len(), 1);
        assert_eq!(components[0].component, "python-can sidecar");
        assert_eq!(components[0].dependencies.len(), 1);
        let dep = &components[0].dependencies[0];
        assert_eq!(dep.name, "uptime");
        assert_eq!(dep.spdx, "BSD-2-Clause");
        assert_eq!(dep.license_text, "BSD TEXT");
    }

    #[test]
    fn parse_manifest_returns_empty_on_garbage() {
        assert!(parse_manifest("not json at all").is_empty());
        assert!(parse_manifest("").is_empty());
    }
}

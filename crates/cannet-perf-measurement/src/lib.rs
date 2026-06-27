//! Agent-runnable performance / integration harness for cannet.
//!
//! The harness drives a reproducible CAN workload — the `examples/ev-demo`
//! project (an EV model: powertrain and battery buses with a
//! BMS, dual traction inverters, and thermal / DC-DC / OBC ECUs) — through
//! the host model and emits machine-readable metrics that a baseline can be
//! diffed against. It stands in for the GUI frontend: it owns a real
//! [`cannet_gui_lib::trace_store::TraceStore`], pumps frames into it, and
//! runs the same filtered-scan query load the trace view issues, so a
//! regression in ingest throughput under view contention shows up as a
//! failing number rather than a human noticing lag.
//!
//! Three source modes exercise progressively more of the stack:
//! 1. **in-process** — a synthetic generator appends straight into the
//!    `TraceStore` (no sidecar, no wire, fully deterministic);
//! 2. **virtual bus** — frames travel the real gRPC wire through an
//!    in-process [`cannet_core::SharedBus`] driven by `cannet-client`;
//! 3. **full stack** — the python-can sidecar transmits the RBS schedule
//!    onto real PEAK hardware and the harness reads it back.
//!
//! This module loads and validates the example artifacts; the per-mode
//! workloads build on the [`LoadedExample`] it returns.

use std::path::{Path, PathBuf};

use cannet_dbc::Database;
use cannet_gui_lib::{parse_message_key, Project, RbsFile, PROJECT_SCHEMA_VERSION};

pub mod check;
pub mod filter_bench;
pub mod frontend;
pub mod runner;
pub mod sidecar;
pub mod tracebuffer;
pub mod grpc;
pub mod hardware_peak;
pub mod workload;

/// A DBC loaded from the example, with its resolved on-disk path.
pub struct LoadedDbc {
    pub path: PathBuf,
    pub db: Database,
}

/// The parsed `examples/ev-demo` project: the project document, its RBS
/// simulation, and every DBC it references — each validated against the
/// real parser the GUI uses.
pub struct LoadedExample {
    pub dir: PathBuf,
    pub project: Project,
    pub rbs: RbsFile,
    pub dbcs: Vec<LoadedDbc>,
}

/// Default example directory, resolved relative to this crate's manifest
/// so the harness finds the workload regardless of the current working
/// directory.
#[must_use]
pub fn default_example_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/ev-demo")
}

/// Directory holding the dated, git-stamped performance baselines.
#[must_use]
pub fn default_measurements_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/performance-measurements")
}

/// Filename for a fresh measurement: `<YYYY-MM-DD>-<short-hash>[-dirty].json`,
/// the date local and the hash from `git` (`nogit` if unavailable). The
/// `-dirty` marker flags a measurement taken against an uncommitted tree.
#[must_use]
pub fn measurement_filename() -> String {
    let date = chrono::Local::now().format("%Y-%m-%d");
    let hash = git_output(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "nogit".into());
    let dirty = match git_output(&["status", "--porcelain"]) {
        Some(s) if !s.is_empty() => "-dirty",
        _ => "",
    };
    format!("{date}-{hash}{dirty}.json")
}

/// The canonical committed baseline `check` compares against by default.
/// Dated measurement snapshots (`measurement_filename`) sit beside it for
/// archival; promoting one to the reference is a deliberate copy to this
/// path, not a "newest file wins" guess.
#[must_use]
pub fn default_baseline_path() -> PathBuf {
    default_measurements_dir().join("baseline.json")
}

fn git_output(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(env!("CARGO_MANIFEST_DIR"))
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Load and parse the example project at `dir`: the `.cannet_prj`
/// project (schema-checked), the `.cannet_rbs` simulation, and each referenced
/// DBC (paths resolved relative to `dir`). Every parse goes through the
/// production parser, so a malformed artifact fails here.
///
/// # Errors
/// Returns a human-readable message if any file is missing, unreadable,
/// fails to parse, or carries an unsupported schema version.
pub fn load_example(dir: &Path) -> Result<LoadedExample, String> {
    let project_path = dir.join("ev-demo.cannet_prj");
    let project_text = std::fs::read_to_string(&project_path)
        .map_err(|e| format!("reading {}: {e}", project_path.display()))?;
    let project: Project = serde_json::from_str(&project_text)
        .map_err(|e| format!("parsing {}: {e}", project_path.display()))?;
    if project.schema_version != PROJECT_SCHEMA_VERSION {
        return Err(format!(
            "{}: schema version {}; this build expects {PROJECT_SCHEMA_VERSION}",
            project_path.display(),
            project.schema_version
        ));
    }

    let rbs_path = dir.join("ev-demo.cannet_rbs");
    let rbs_text = std::fs::read_to_string(&rbs_path)
        .map_err(|e| format!("reading {}: {e}", rbs_path.display()))?;
    let rbs = RbsFile::parse(&rbs_text).map_err(|e| format!("{}: {e}", rbs_path.display()))?;

    let mut dbcs = Vec::with_capacity(project.dbcs.len());
    for dbc_ref in &project.dbcs {
        let path = dir.join(&dbc_ref.path);
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("reading {}: {e}", path.display()))?;
        let db = Database::parse(&text).map_err(|e| format!("{}: {e:?}", path.display()))?;
        dbcs.push(LoadedDbc { path, db });
    }

    Ok(LoadedExample {
        dir: dir.to_path_buf(),
        project,
        rbs,
        dbcs,
    })
}

impl LoadedExample {
    /// Cross-check the RBS overrides against the DBCs: every overridden
    /// message must exist in some loaded DBC, and every overridden signal
    /// must exist in that message. Catches hand-authoring drift (a typo'd
    /// id or renamed signal) that each file would pass on its own.
    ///
    /// # Errors
    /// Returns the list of mismatches, one per line, if any are found.
    pub fn check_rbs_against_dbcs(&self) -> Result<(), String> {
        use std::collections::{HashMap, HashSet};

        // (id, extended) -> set of signal names, unioned across DBCs.
        let mut signals: HashMap<(u32, bool), HashSet<&str>> = HashMap::new();
        for loaded in &self.dbcs {
            for (id, ext, sig) in loaded.db.signal_names() {
                signals.entry((id, ext)).or_default().insert(sig);
            }
        }

        let mut problems = Vec::new();
        for (bus_name, bus) in &self.rbs.buses {
            for (ecu_name, ecu) in &bus.ecus {
                for (msg_key, msg) in &ecu.messages {
                    let (id, ext) = match parse_message_key(msg_key) {
                        Ok(parts) => parts,
                        Err(e) => {
                            problems.push(format!("{bus_name}/{ecu_name}: bad key {msg_key}: {e}"));
                            continue;
                        }
                    };
                    let Some(known) = signals.get(&(id, ext)) else {
                        problems.push(format!(
                            "{bus_name}/{ecu_name}/{msg_key}: id 0x{id:X} (ext={ext}) not in any DBC"
                        ));
                        continue;
                    };
                    for sig in msg.signals.keys() {
                        if !known.contains(sig.as_str()) {
                            problems.push(format!(
                                "{bus_name}/{ecu_name}/{msg_key}: signal {sig:?} not in message"
                            ));
                        }
                    }
                }
            }
        }

        if problems.is_empty() {
            Ok(())
        } else {
            Err(problems.join("\n"))
        }
    }
}

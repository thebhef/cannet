//! The per-setting descriptor: the one place a setting's label, help
//! text, control shape, and tags are written down (ADR 0034).
//!
//! [`crate::settings`] owns the *values*; this module owns everything a
//! view needs to render them. It is deliberately host-side, so the
//! descriptor table and the `Settings` struct sit next to each other and
//! a test can prove they name the same keys — which is ADR 0034's "the
//! file lists every knob" promise, mechanically checked. The frontend
//! generates its controls from what [`get_setting_descriptors`] serves;
//! nothing about a setting is hand-written per setting over there.
//!
//! **Nothing here is a second copy of something that already exists.** A
//! descriptor declares only what is genuinely new — the label, the help,
//! the control shape, and the two tag axes. Its scope is read from
//! [`crate::settings::SCOPES`] and its default from
//! [`Settings::default`] when the table is served, so neither can drift
//! from the thing it describes.
//!
//! **Two tag axes, both closed enums.** [`Surface`] says which part of
//! the app a setting governs and drives the default grouping; [`Kind`]
//! says what sort of decision it is. A closed enum rather than free
//! strings because a typo'd tag would silently misfile — or, for
//! [`Kind::Developer`], silently hide — a setting, and the taxonomy is
//! small enough that adding to it is a deliberate act.

use serde::Serialize;

use crate::persisted_json::{scope_of, Scope};
use crate::settings::{Settings, MIN_SCRATCH_CAP_BYTES, SCOPES};

/// Which part of the app a setting governs — the tag axis the settings
/// tree groups by. A setting may govern more than one surface.
///
/// [`Surface::ALL`] is the tree order; it is also what proves every
/// variant is reachable from the view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Surface {
    General,
    Plot,
    Trace,
    Signals,
    ById,
    Dbc,
    Transmit,
    Connection,
    Logging,
    Storage,
}

impl Surface {
    /// Every surface, in the order the settings tree lists them, with
    /// the label the tree shows. Served alongside the descriptors so the
    /// frontend renders the taxonomy rather than restating it.
    const ALL: &'static [(Self, &'static str)] = &[
        (Self::General, "General"),
        (Self::Plot, "Plot"),
        (Self::Trace, "Trace"),
        (Self::Signals, "Signals"),
        (Self::ById, "By-ID"),
        (Self::Dbc, "DBC"),
        (Self::Transmit, "Transmit"),
        (Self::Connection, "Connection"),
        (Self::Logging, "Logging"),
        (Self::Storage, "Storage"),
    ];
}

/// What sort of decision a setting is. Exactly one per setting — the
/// field is a single value, not a list, so "exactly one kind tag" is a
/// property of the type rather than something a test has to police.
///
/// The taxonomy is deliberately complete ahead of the settings that will
/// carry it: it has to be settled *before* the store grows, or every
/// field added in the meantime needs a tag retrofitted. So a variant no
/// setting uses yet is the intended state, not dead code — hence the
/// `allow` rather than a shorter enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub(crate) enum Kind {
    /// The initial value of something the user can also change per view.
    Default,
    /// App-wide policy with no per-view equivalent.
    Behaviour,
    /// A machine-load or internal-cadence knob, exposed so that every
    /// knob lives in `settings.json` rather than because tuning it is
    /// expected. **Hidden in the settings view unless the user opts in**
    /// via `show_developer_settings`.
    Developer,
}

/// The control a setting's row renders. The view generates the widget
/// from this — there is no per-setting UI code — and the one escape
/// hatch is [`Control::Custom`], which names a renderer the view
/// dispatches through a single table.
///
/// A setting is therefore either a generated control or one named
/// renderer. There is no third case.
///
/// Like [`Kind`], this is a vocabulary rather than a set of call sites:
/// the view renders every variant (`settingControls.dom.test.tsx` covers
/// them), and a variant no setting uses yet is what makes adding that
/// setting a one-line change rather than a framework change. Rust cannot
/// see a use that lives on the other side of a serialized contract,
/// hence the `allow`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
#[allow(dead_code)]
pub(crate) enum Control {
    /// Checkbox over a `bool`.
    Bool,
    /// Select over a fixed set of strings.
    Enum { options: &'static [&'static str] },
    /// Whole-number input. `scale` converts between the stored value and
    /// the displayed one — stored = displayed × `scale` — so a byte
    /// count can be edited in MB without the file's units changing.
    /// `min` is in *stored* units, and is the same constant the host
    /// enforces on ingress. `unset`, when present, is the placeholder
    /// shown for an empty box and marks blank as a legal value (the
    /// field is `Option`al on the host).
    Int {
        unit: Option<&'static str>,
        scale: u64,
        min: Option<u64>,
        unset: Option<&'static str>,
    },
    /// Fractional-number input.
    Number {
        unit: Option<&'static str>,
        min: Option<f64>,
    },
    /// Free-text input.
    Text { placeholder: Option<&'static str> },
    /// Not a labelled input: the view dispatches `renderer` through its
    /// one custom-renderer table.
    Custom { renderer: &'static str },
}

/// One setting's descriptor, as written in [`DESCRIPTORS`]. The scope
/// and the default are *not* here — they are joined in from the places
/// that already own them when the table is served.
struct Spec {
    /// The `settings.json` field name. The view shows it, so the panel
    /// teaches the file (ADR 0034).
    key: &'static str,
    label: &'static str,
    /// One or two sentences: what it does, and what going wrong looks
    /// like. Searched, so a user who cannot name a setting can still
    /// find it.
    help: &'static str,
    surfaces: &'static [Surface],
    kind: Kind,
    control: Control,
}

/// Every setting `settings.json` carries, in tree order within each
/// surface. `descriptors_and_settings_name_the_same_keys` is what keeps
/// this table and [`Settings`] from drifting apart.
const DESCRIPTORS: &[Spec] = &[
    Spec {
        key: "show_developer_settings",
        label: "Show developer settings",
        help: "Reveal machine-load and internal-cadence knobs in the settings \
               view. They are hidden by default because they exist so that every \
               knob lives in settings.json, not because tuning them is expected.",
        surfaces: &[Surface::General],
        kind: Kind::Behaviour,
        control: Control::Bool,
    },
    Spec {
        key: "keybindings",
        label: "Keyboard shortcuts",
        help: "Your keybinding customisation. Edited in the Keyboard Shortcuts \
               panel, which is its only editor; it is listed here because it is a \
               field of settings.json like any other. Absent means the built-in \
               default bindings.",
        surfaces: &[Surface::General],
        kind: Kind::Behaviour,
        control: Control::Custom {
            renderer: "keybindings",
        },
    },
    Spec {
        key: "scratch_cap_bytes",
        label: "Cache size cap",
        help: "Drop the oldest history once this project's on-disk cache exceeds \
               this. Below the minimum the pre-allocated segments dominate and the \
               cap cannot be honoured, so a smaller value is refused. Blank is \
               unbounded.",
        surfaces: &[Surface::Storage],
        kind: Kind::Behaviour,
        control: Control::Int {
            unit: Some("MB"),
            scale: 1024 * 1024,
            min: Some(MIN_SCRATCH_CAP_BYTES),
            unset: Some("unbounded"),
        },
    },
    Spec {
        key: "clear_scratch_on_exit",
        label: "Discard session on exit",
        help: "Wipe this project's on-disk cache on a clean close, instead of \
               reloading the prior session on the next launch.",
        surfaces: &[Surface::Storage],
        kind: Kind::Behaviour,
        control: Control::Bool,
    },
];

/// One surface, as served: the tag value and the label the tree shows.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct SurfaceInfo {
    id: Surface,
    label: &'static str,
}

/// One setting's descriptor as served to the view: [`Spec`] with the
/// scope and default value joined in from the code that owns them.
#[derive(Debug, Clone, Serialize)]
pub struct SettingDescriptor {
    key: &'static str,
    label: &'static str,
    help: &'static str,
    surfaces: &'static [Surface],
    kind: Kind,
    control: Control,
    /// From [`crate::settings::SCOPES`] — where a write of this key
    /// lands, and therefore whether a project may override it. `None`
    /// only if the key declares no scope, which
    /// `every_settings_key_declares_a_scope` already rules out.
    scope: Option<Scope>,
    /// From [`Settings::default`], so "differs from its default" is
    /// answerable in the view without the default being written twice.
    default: serde_json::Value,
}

/// The taxonomy and the descriptors, in one answer — a view needs both
/// to render, and they are one static fact.
#[derive(Debug, Clone, Serialize)]
pub struct SettingsSchema {
    surfaces: Vec<SurfaceInfo>,
    settings: Vec<SettingDescriptor>,
}

/// Build the served schema: the surface taxonomy, plus every descriptor
/// with its scope and default joined in.
fn schema() -> SettingsSchema {
    let defaults = serde_json::to_value(Settings::default()).unwrap_or(serde_json::Value::Null);
    SettingsSchema {
        surfaces: Surface::ALL
            .iter()
            .map(|(id, label)| SurfaceInfo { id: *id, label })
            .collect(),
        settings: DESCRIPTORS
            .iter()
            .map(|s| SettingDescriptor {
                key: s.key,
                label: s.label,
                help: s.help,
                surfaces: s.surfaces,
                kind: s.kind,
                control: s.control,
                scope: scope_of(SCOPES, s.key),
                default: defaults
                    .get(s.key)
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            })
            .collect(),
    }
}

/// The settings taxonomy and every setting's descriptor. The view
/// renders from this instead of carrying its own copy of the schema.
#[tauri::command]
#[must_use]
pub fn get_setting_descriptors() -> SettingsSchema {
    schema()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn served() -> SettingsSchema {
        schema()
    }

    #[test]
    fn every_setting_has_at_least_one_surface_tag() {
        // Exactly-one-kind is a property of the type (`kind` is one
        // value, not a list); at-least-one-surface is not, so it is
        // policed here. A setting with no surface would be reachable
        // only by search.
        for s in DESCRIPTORS {
            assert!(
                !s.surfaces.is_empty(),
                "setting `{}` declares no surface tag",
                s.key
            );
        }
    }

    #[test]
    fn descriptors_and_settings_name_the_same_keys() {
        // ADR 0034's "the file lists every knob", mechanically checked:
        // a field added to `Settings` without a descriptor fails here,
        // and so does a descriptor for a field that no longer exists.
        let serde_json::Value::Object(fields) = serde_json::to_value(Settings::default()).unwrap()
        else {
            panic!("settings must serialize to a JSON object");
        };
        for key in fields.keys() {
            assert!(
                DESCRIPTORS.iter().any(|s| s.key == key),
                "settings key `{key}` has no descriptor"
            );
        }
        for s in DESCRIPTORS {
            assert!(
                fields.contains_key(s.key),
                "descriptor names a stale key `{}`",
                s.key
            );
        }
    }

    #[test]
    fn every_descriptor_carries_the_scope_the_store_declares() {
        // The descriptor reads `settings::SCOPES` rather than keeping a
        // second copy, so a served scope that disagreed with the write
        // routing would be a bug in this join, not a drifted duplicate.
        for d in &served().settings {
            assert_eq!(
                d.scope,
                scope_of(SCOPES, d.key),
                "descriptor for `{}` lost its scope",
                d.key
            );
            assert!(d.scope.is_some(), "`{}` declares no scope", d.key);
        }
    }

    #[test]
    fn every_descriptor_carries_the_default_the_struct_defines() {
        // The other join: the view answers "differs from its default"
        // from this, so it must be the struct's default and not a
        // transcription of it.
        let defaults = serde_json::to_value(Settings::default()).unwrap();
        for d in &served().settings {
            assert_eq!(
                Some(&d.default),
                defaults.get(d.key),
                "descriptor for `{}` carries a stale default",
                d.key
            );
        }
    }

    #[test]
    fn the_published_cap_minimum_is_the_one_validate_enforces() {
        // The frontend renders the descriptor's `min` rather than its
        // own copy of the limit, so the published bound and the enforced
        // one must be the same number.
        let cap = DESCRIPTORS
            .iter()
            .find(|s| s.key == "scratch_cap_bytes")
            .expect("the cap has a descriptor");
        let Control::Int { min, .. } = cap.control else {
            panic!("the cap is a whole-number control");
        };
        assert_eq!(min, Some(crate::settings::MIN_SCRATCH_CAP_BYTES));
    }

    #[test]
    fn the_developer_toggle_is_an_ordinary_setting() {
        // It reveals the developer knobs, so it must not itself be one
        // — a toggle you can only see once you've flipped it is
        // unreachable.
        let toggle = DESCRIPTORS
            .iter()
            .find(|s| s.key == "show_developer_settings")
            .expect("the toggle has a descriptor");
        assert_ne!(toggle.kind, Kind::Developer);
    }

    #[test]
    fn the_served_taxonomy_lists_every_surface_in_tree_order() {
        let schema = served();
        assert_eq!(schema.surfaces.len(), Surface::ALL.len());
        assert_eq!(schema.surfaces[0].id, Surface::General);
        for d in &schema.settings {
            for surface in d.surfaces {
                assert!(
                    schema.surfaces.iter().any(|s| s.id == *surface),
                    "`{}` is tagged with a surface the taxonomy omits",
                    d.key
                );
            }
        }
    }
}

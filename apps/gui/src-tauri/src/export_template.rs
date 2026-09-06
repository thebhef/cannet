//! Name/folder template resolution shared by log export and project
//! loggers: both offer an editable template with a live-resolved
//! preview, and both resolve the same four tokens the same way.
//!
//! - `{project}` — the slugified project display name.
//! - `{logger}` — the slugified logger name; an error outside a
//!   logger's own template.
//! - `{start}` — the capture's wall-clock start. On an unanchored
//!   capture (ADR 0024 — a live session with no session origin yet, or
//!   one replayed from a log with no start time) there is no wall clock
//!   to name, so `{start}` resolves as `{now}` instead; [`Resolved`]
//!   carries that fact so a preview can say so.
//! - `{now}` — the instant resolution runs. Injected by the caller
//!   ([`resolve`]'s `now` parameter) rather than read from the system
//!   clock here, so a logger can resolve `{now}` as the moment logging
//!   started rather than the moment the panel happens to repaint.
//!
//! A bare `{start}` / `{now}` resolves as ISO 8601 in *basic* form with
//! a timezone offset (`20260905T091502-0600`) — extended ISO's colons
//! cannot appear in a Windows file name. `{start:<fmt>}` / `{now:<fmt>}`
//! pass `<fmt>` straight through to `chrono`'s strftime formatter: no
//! subset, so anything chrono accepts is accepted here, and anything it
//! doesn't is rejected with a message naming the format string.
//!
//! Folder text resolves through the same token syntax
//! ([`resolve_folder`]); the one folder-specific rule is that a
//! relative result is rooted at the project directory when the project
//! has one the user chose ([`TemplateContext::project_dir`]), and
//! rejected otherwise.

use std::path::{Path, PathBuf};

use chrono::format::{Item, StrftimeItems};
use chrono::{DateTime, Local, TimeZone, Utc};
use tauri::Manager;

/// Everything a template needs to resolve, independent of the wall
/// clock (which [`resolve`] takes separately, so a logger can inject
/// "when logging started" instead of "now").
pub(crate) struct TemplateContext<'a> {
    /// The project's display name, before slugifying. Every project has
    /// one, including an auto-located one — the caller supplies it
    /// rather than this module deriving it, since what a project is
    /// called is a fact this module has no reason to know twice.
    pub project: &'a str,
    /// The logger's name, when resolving inside a logger's own
    /// template. `{logger}` is an error when this is `None`.
    pub logger: Option<&'a str>,
    /// The capture's wall-clock start, Unix-epoch seconds — `None` for
    /// an unanchored capture (ADR 0024), in which case `{start}`
    /// resolves as `{now}`.
    pub start_seconds: Option<f64>,
    /// The project directory to root a relative folder template
    /// against. `None` when the project has no directory the user
    /// chose (an auto-located project), which makes a relative folder
    /// an error rather than silently landing inside cannet's own cache
    /// space.
    pub project_dir: Option<&'a Path>,
}

/// A template resolved to text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Resolved {
    pub text: String,
    /// Whether a `{start}` (or `{start:<fmt>}`) token in this template
    /// fell back to resolving as `{now}` because the capture is
    /// unanchored — what lets a preview add the "no wall-clock anchor"
    /// note without re-deriving it.
    pub start_resolved_as_now: bool,
}

/// Lowercase, with every run of non-alphanumeric characters collapsed
/// to a single `-` and no leading/trailing `-`. Empty input (or input
/// that is entirely non-alphanumeric) yields `"project"` rather than an
/// empty path segment.
pub(crate) fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut at_boundary = true;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            at_boundary = false;
        } else if !at_boundary {
            out.push('-');
            at_boundary = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "project".to_string()
    } else {
        out
    }
}

/// `secs` (Unix-epoch seconds, fractional) as a local date-time. Out of
/// chrono's representable range falls back to the epoch rather than
/// failing: a template preview has no better answer to give for a
/// pathological input, and this is a display convenience, not a
/// timestamp anything is recorded under.
fn local_from_epoch_seconds(secs: f64) -> DateTime<Local> {
    let whole = secs.floor();
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let nanos = ((secs - whole) * 1_000_000_000.0)
        .round()
        .clamp(0.0, 999_999_999.0) as u32;
    #[allow(clippy::cast_possible_truncation)]
    let whole_secs = whole as i64;
    Utc.timestamp_opt(whole_secs, nanos)
        .single()
        .unwrap_or_else(|| {
            Utc.timestamp_opt(0, 0)
                .single()
                .expect("epoch is representable")
        })
        .with_timezone(&Local)
}

/// `dt` formatted per `fmt`, or the bare ISO-8601-basic form
/// (`20260905T091502-0600`) when `fmt` is `None`. `%z` is chrono's
/// `+HHMM` offset with no colon, which is exactly the basic form's
/// offset — no separate implementation needed for the bare case.
const BARE_FORMAT: &str = "%Y%m%dT%H%M%S%z";

fn format_datetime(dt: DateTime<Local>, fmt: Option<&str>) -> Result<String, String> {
    let Some(fmt) = fmt else {
        return Ok(dt.format(BARE_FORMAT).to_string());
    };
    if fmt.is_empty() {
        return Err("a time format after \":\" must not be empty".to_string());
    }
    // `StrftimeItems` parses lazily and reports an invalid specifier as
    // `Item::Error` rather than an `Err` from `new` — checked up front
    // so the format call below can't hit chrono's `to_string` panic on
    // a bad specifier.
    if StrftimeItems::new(fmt).any(|item| matches!(item, Item::Error)) {
        return Err(format!(
            "\"{fmt}\" is not a strftime format chrono understands"
        ));
    }
    Ok(dt.format_with_items(StrftimeItems::new(fmt)).to_string())
}

/// One `{token}` or `{token:fmt}` resolved to text.
fn resolve_token(
    token: &str,
    fmt: Option<&str>,
    ctx: &TemplateContext,
    now: DateTime<Local>,
    start_resolved_as_now: &mut bool,
) -> Result<String, String> {
    match token {
        "project" => Ok(slugify(ctx.project)),
        "logger" => match ctx.logger {
            Some(name) => Ok(slugify(name)),
            None => Err("{logger} can only be used in a logger's own template".to_string()),
        },
        "start" | "now" => {
            let dt = if token == "now" {
                now
            } else if let Some(secs) = ctx.start_seconds {
                local_from_epoch_seconds(secs)
            } else {
                *start_resolved_as_now = true;
                now
            };
            format_datetime(dt, fmt)
        }
        other => Err(format!(
            "\"{{{other}}}\" is not a token this template understands \
             — use {{project}}, {{logger}}, {{start}}, or {{now}}"
        )),
    }
}

/// Resolve every `{token}` / `{token:fmt}` in `template` against `ctx`.
/// Text outside `{...}` passes through unchanged; an unterminated `{`
/// (no matching `}`) is left as literal text rather than an error,
/// since there is nothing to interpret it as.
pub(crate) fn resolve(
    template: &str,
    ctx: &TemplateContext,
    now: DateTime<Local>,
) -> Result<Resolved, String> {
    let mut out = String::new();
    let mut start_resolved_as_now = false;
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find('}') else {
            out.push_str(&rest[open..]);
            rest = "";
            break;
        };
        let inner = &after_open[..close];
        let (token, fmt) = match inner.split_once(':') {
            Some((t, f)) => (t, Some(f)),
            None => (inner, None),
        };
        out.push_str(&resolve_token(
            token,
            fmt,
            ctx,
            now,
            &mut start_resolved_as_now,
        )?);
        rest = &after_open[close + 1..];
    }
    out.push_str(rest);
    Ok(Resolved {
        text: out,
        start_resolved_as_now,
    })
}

/// Resolve a folder template: same token syntax as [`resolve`], plus
/// one folder-specific rule — a relative result is rooted at
/// [`TemplateContext::project_dir`], and rejected when the project has
/// none (an auto-located project, not one the user pointed cannet at).
pub(crate) fn resolve_folder(
    template: &str,
    ctx: &TemplateContext,
    now: DateTime<Local>,
) -> Result<Resolved, String> {
    let resolved = resolve(template.trim(), ctx, now)?;
    let path = Path::new(&resolved.text);
    if path.is_absolute() {
        return Ok(resolved);
    }
    match ctx.project_dir {
        Some(dir) => {
            let rooted: PathBuf = dir.join(path);
            Ok(Resolved {
                text: rooted.to_string_lossy().into_owned(),
                start_resolved_as_now: resolved.start_resolved_as_now,
            })
        }
        None => Err(
            "a relative folder needs the project open in project-directory mode \
             — use an absolute path, or save the project to a directory first"
                .to_string(),
        ),
    }
}

/// What a live preview shows: either the resolved text — with whether
/// `{start}` fell back to `{now}` — or the polished message an invalid
/// template produced. Never both.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplatePreview {
    pub resolved: Option<String>,
    pub error: Option<String>,
    pub start_resolved_as_now: bool,
}

impl From<Result<Resolved, String>> for TemplatePreview {
    fn from(result: Result<Resolved, String>) -> Self {
        match result {
            Ok(r) => Self {
                resolved: Some(r.text),
                error: None,
                start_resolved_as_now: r.start_resolved_as_now,
            },
            Err(e) => Self {
                resolved: None,
                error: Some(e),
                start_resolved_as_now: false,
            },
        }
    }
}

/// Tauri command — resolve one name or folder template for a live
/// preview. The same call the export dialog and a logger panel both
/// make (`is_folder` distinguishes a folder field, which roots a
/// relative result at the project directory, from a bare name).
///
/// `project_dir` comes from the session's active project directory
/// (`crate::project_dir::ActiveProjectDir`), `None` when it is
/// auto-located rather than one the user chose.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn preview_export_template(
    app: tauri::AppHandle,
    template: String,
    project: String,
    logger: Option<String>,
    start_seconds: Option<f64>,
    is_folder: bool,
) -> TemplatePreview {
    let active = app.state::<crate::project_dir::ActiveProjectDir>().get();
    let project_dir = (!active.is_auto_located()).then(|| active.root().to_path_buf());
    let ctx = TemplateContext {
        project: &project,
        logger: logger.as_deref(),
        start_seconds,
        project_dir: project_dir.as_deref(),
    };
    let now = Local::now();
    if is_folder {
        resolve_folder(&template, &ctx, now)
    } else {
        resolve(&template, &ctx, now)
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(
        project: &'a str,
        logger: Option<&'a str>,
        start_seconds: Option<f64>,
    ) -> TemplateContext<'a> {
        TemplateContext {
            project,
            logger,
            start_seconds,
            project_dir: None,
        }
    }

    /// 2026-09-05 09:15:02 local, matching the prototype's `START`
    /// constant and its documented ISO-basic rendering.
    fn fixed_now() -> DateTime<Local> {
        Local
            .with_ymd_and_hms(2026, 9, 5, 9, 15, 2)
            .single()
            .unwrap()
    }

    /// `dt` as `TemplateContext::start_seconds` wants it. Test-only
    /// convenience: real callers get this value from the frontend, not
    /// from converting a `DateTime` back the other way.
    #[allow(clippy::cast_precision_loss)]
    fn epoch_seconds(dt: DateTime<Local>) -> f64 {
        dt.timestamp() as f64
    }

    #[test]
    fn slugify_lowercases_and_collapses_separators() {
        assert_eq!(slugify("EV Zonal"), "ev-zonal");
        assert_eq!(slugify("  Multi   Space--Name  "), "multi-space-name");
        assert_eq!(slugify("bench_1"), "bench-1");
    }

    #[test]
    fn slugify_of_nothing_alphanumeric_falls_back_to_project() {
        assert_eq!(slugify(""), "project");
        assert_eq!(slugify("!!!"), "project");
    }

    #[test]
    fn plain_text_with_no_tokens_passes_through() {
        let r = resolve("capture.log", &ctx("p", None, None), fixed_now()).unwrap();
        assert_eq!(r.text, "capture.log");
        assert!(!r.start_resolved_as_now);
    }

    #[test]
    fn project_token_resolves_to_the_slugified_name() {
        let r = resolve("{project}", &ctx("EV Zonal", None, None), fixed_now()).unwrap();
        assert_eq!(r.text, "ev-zonal");
    }

    #[test]
    fn logger_token_resolves_to_the_slugified_logger_name() {
        let r = resolve("{logger}", &ctx("p", Some("Front ECU"), None), fixed_now()).unwrap();
        assert_eq!(r.text, "front-ecu");
    }

    #[test]
    fn logger_token_outside_a_logger_is_an_error() {
        let err = resolve("{logger}", &ctx("p", None, None), fixed_now()).unwrap_err();
        assert!(err.contains("logger"), "{err}");
    }

    #[test]
    fn a_bare_start_token_on_an_anchored_capture_is_iso_basic_with_offset() {
        let start = Local
            .with_ymd_and_hms(2026, 9, 5, 9, 15, 2)
            .single()
            .unwrap();
        let expected = start.format("%Y%m%dT%H%M%S%z").to_string();
        let r = resolve(
            "{start}",
            &ctx("p", None, Some(epoch_seconds(start))),
            fixed_now(),
        )
        .unwrap();
        assert_eq!(r.text, expected);
        assert!(!r.start_resolved_as_now);
    }

    #[test]
    fn a_bare_now_token_is_iso_basic_with_offset() {
        let now = fixed_now();
        let r = resolve("{now}", &ctx("p", None, None), now).unwrap();
        assert_eq!(r.text, now.format("%Y%m%dT%H%M%S%z").to_string());
    }

    #[test]
    fn an_unanchored_capture_resolves_start_as_now_and_says_so() {
        let now = fixed_now();
        let r = resolve("{start}", &ctx("p", None, None), now).unwrap();
        assert_eq!(r.text, now.format("%Y%m%dT%H%M%S%z").to_string());
        assert!(r.start_resolved_as_now);
    }

    #[test]
    fn now_never_reports_the_unanchored_fallback_flag() {
        // Only `{start}` can fall back; `{now}` always names the real
        // instant, anchored or not.
        let r = resolve("{now}", &ctx("p", None, None), fixed_now()).unwrap();
        assert!(!r.start_resolved_as_now);
    }

    #[test]
    fn an_explicit_format_passes_straight_through_to_chrono() {
        let start = Local
            .with_ymd_and_hms(2026, 9, 5, 9, 15, 2)
            .single()
            .unwrap();
        let r = resolve(
            "{start:%Y%m%d-%H%M%S}",
            &ctx("p", None, Some(epoch_seconds(start))),
            fixed_now(),
        )
        .unwrap();
        assert_eq!(r.text, "20260905-091502");
    }

    #[test]
    fn chronos_full_strftime_is_available_not_just_a_subset() {
        // `%A` (full weekday name) is outside the old JS-prototype
        // subset (%Y %y %m %d %H %M %S %z %Z %%) but is ordinary chrono
        // strftime, and ruling 23 says the format passes straight
        // through with no subset.
        let now = fixed_now();
        let r = resolve("{now:%A}", &ctx("p", None, None), now).unwrap();
        assert_eq!(r.text, now.format("%A").to_string());
    }

    #[test]
    fn an_unknown_strftime_specifier_is_a_polished_error() {
        let err = resolve("{now:%Q}", &ctx("p", None, None), fixed_now()).unwrap_err();
        assert!(err.contains("%Q"), "{err}");
    }

    #[test]
    fn an_empty_explicit_format_is_an_error() {
        let err = resolve("{now:}", &ctx("p", None, None), fixed_now()).unwrap_err();
        assert!(err.contains("empty"), "{err}");
    }

    #[test]
    fn an_unknown_token_is_a_polished_error() {
        let err = resolve("{banana}", &ctx("p", None, None), fixed_now()).unwrap_err();
        assert!(err.contains("banana"), "{err}");
    }

    #[test]
    fn several_tokens_and_literal_text_combine_in_one_template() {
        let start = Local
            .with_ymd_and_hms(2026, 9, 5, 9, 15, 2)
            .single()
            .unwrap();
        let r = resolve(
            "{project}-{start:%Y%m%d}-run",
            &ctx("Bench Rig", None, Some(epoch_seconds(start))),
            fixed_now(),
        )
        .unwrap();
        assert_eq!(r.text, "bench-rig-20260905-run");
    }

    #[test]
    fn an_unterminated_brace_is_left_as_literal_text() {
        let r = resolve("capture-{oops", &ctx("p", None, None), fixed_now()).unwrap();
        assert_eq!(r.text, "capture-{oops");
    }

    #[test]
    fn the_default_name_template_resolves_with_no_error() {
        let start = Local
            .with_ymd_and_hms(2026, 9, 5, 9, 15, 2)
            .single()
            .unwrap();
        let r = resolve(
            crate::export_state::DEFAULT_NAME_TEMPLATE,
            &ctx("EV Zonal", None, Some(epoch_seconds(start))),
            fixed_now(),
        )
        .unwrap();
        assert_eq!(
            r.text,
            format!("ev-zonal-{}", start.format("%Y%m%dT%H%M%S%z"))
        );
    }

    // ---------- folder rooting ----------

    #[test]
    fn an_absolute_folder_is_returned_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let template = tmp.path().to_string_lossy().into_owned();
        let r = resolve_folder(&template, &ctx("p", None, None), fixed_now()).unwrap();
        assert_eq!(Path::new(&r.text), tmp.path());
    }

    #[test]
    fn a_relative_folder_is_rooted_at_the_project_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let mut ctx = ctx("p", None, None);
        ctx.project_dir = Some(tmp.path());
        let r = resolve_folder("logs", &ctx, fixed_now()).unwrap();
        assert_eq!(Path::new(&r.text), tmp.path().join("logs"));
    }

    #[test]
    fn a_relative_folder_with_no_project_directory_is_an_error() {
        let err = resolve_folder("logs", &ctx("p", None, None), fixed_now()).unwrap_err();
        assert!(err.contains("project-directory mode"), "{err}");
    }

    #[test]
    fn tokens_resolve_inside_a_folder_template_too() {
        let tmp = tempfile::tempdir().unwrap();
        let mut ctx = ctx("Bench Rig", Some("Front ECU"), None);
        ctx.project_dir = Some(tmp.path());
        let r = resolve_folder("logs/{project}/{logger}", &ctx, fixed_now()).unwrap();
        assert_eq!(
            Path::new(&r.text),
            tmp.path().join("logs/bench-rig/front-ecu")
        );
    }

    #[test]
    fn an_error_inside_a_folder_template_is_reported_as_such() {
        let err = resolve_folder("{logger}", &ctx("p", None, None), fixed_now()).unwrap_err();
        assert!(err.contains("logger"), "{err}");
    }

    // ---------- preview wire shape ----------

    #[test]
    fn a_successful_preview_carries_no_error() {
        let preview: TemplatePreview =
            resolve("{project}", &ctx("p", None, None), fixed_now()).into();
        assert_eq!(preview.resolved.as_deref(), Some("p"));
        assert!(preview.error.is_none());
    }

    #[test]
    fn a_failed_preview_carries_no_resolved_text() {
        let preview: TemplatePreview =
            resolve("{banana}", &ctx("p", None, None), fixed_now()).into();
        assert!(preview.resolved.is_none());
        assert!(preview.error.is_some());
        assert!(!preview.start_resolved_as_now);
    }
}

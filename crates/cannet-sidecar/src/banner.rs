//! The sidecar's stdout banner and stderr log format, parsed.
//!
//! Pure line parsing: no process handling, no I/O. See the crate root
//! for the banner grammar itself.

/// Severity of a line the sidecar produced, as this crate classifies
/// it. A host maps these onto whatever log surface it has — the GUI's
/// System Messages levels, `tracing` levels, stderr.
///
/// The ladder is deliberately the same four levels every host already
/// speaks, so the mapping is a rename and never a judgement call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    /// The sidecar talking about itself: version, interface
    /// enumeration, exit codes.
    Debug,
    /// What a user reads to answer "is local capture available":
    /// `listening`, `shutdown`, and where the detailed log went.
    Info,
    Warn,
    Error,
}

/// Pull the `<addr>` out of a `sidecar\tlistening\t<addr>` banner line.
/// `None` for any other input. Pure; testable without spawning.
pub fn parse_listening_address(line: &str) -> Option<&str> {
    line.strip_prefix("sidecar\tlistening\t")
}

/// Parse one stderr line from the sidecar against the Python logger
/// format configured by `logging.basicConfig` in `__main__.py`:
/// `"%(asctime)s %(levelname)s %(name)s %(message)s"`. Returns the
/// embedded severity (mapped onto our 4-level [`LogLevel`]) so a
/// run-of-the-mill `INFO` line isn't surfaced as a warning, and the
/// timestamp is stripped from the displayed text (a host log usually
/// stamps its own time).
///
/// Anything that doesn't look like that format — a raw traceback
/// frame, an unbuffered `print`, a third-party library writing
/// directly to stderr — falls through as `Warn` with the line
/// unchanged. Warn is the safest default: it lands at the usual
/// default filter level so the user actually sees it, without
/// pretending to know its real severity.
pub fn classify_stderr_line(line: &str) -> (LogLevel, String) {
    // asctime = "YYYY-MM-DD HH:MM:SS,mmm" → two whitespace-separated
    // tokens. `splitn(5, …)` then peels: date, time, levelname, name,
    // message-rest.
    let mut parts = line.splitn(5, ' ');
    let _date = parts.next();
    let _time = parts.next();
    let level_token = parts.next();
    let name = parts.next();
    let message = parts.next();
    let (Some(level_token), Some(name), Some(message)) = (level_token, name, message) else {
        return (LogLevel::Warn, line.to_string());
    };
    let level = match level_token {
        // Python: DEBUG / INFO / WARNING / ERROR / CRITICAL — plus the
        // `WARN` alias some loggers emit. The sidecar's own INFO is our
        // Debug (it is reporting on itself; nobody asked for it), and
        // CRITICAL collapses to Error.
        "DEBUG" | "INFO" => LogLevel::Debug,
        "WARNING" | "WARN" => LogLevel::Warn,
        "ERROR" | "CRITICAL" => LogLevel::Error,
        // Token doesn't look like a Python level — bail out so a
        // traceback frame like `  File "x.py", line 42, in foo`
        // isn't mis-classified.
        _ => return (LogLevel::Warn, line.to_string()),
    };
    (level, format!("{name} {message}"))
}

/// Parse one tab-separated banner line from the sidecar's stdout into
/// a level + message. Anything we don't recognise falls through as a
/// plain debug-level message so a stray `print` still reaches the
/// host's log.
pub fn classify_stdout_line(line: &str) -> (LogLevel, String) {
    let parts: Vec<&str> = line.split('\t').collect();
    match parts.as_slice() {
        ["sidecar", "version", v] => (LogLevel::Debug, format!("sidecar version {v}")),
        ["sidecar", "interfaces", n] => (LogLevel::Debug, format!("discovered {n} interface(s)")),
        // Coming up and going down is the pair a user reads to see whether
        // local capture is available; the rest of the banner is the
        // sidecar reporting on itself.
        ["sidecar", "listening", addr] => (LogLevel::Info, format!("listening on {addr}")),
        // Where the sidecar's own always-debug rolling log went. Info,
        // like `listening`: it is the answer to "what do I attach to
        // the bug report", so it has to be readable at the usual
        // default filter.
        ["sidecar", "logfile", path] => (LogLevel::Info, format!("detailed log: {path}")),
        ["sidecar", "shutdown", reason] => (LogLevel::Info, format!("shutting down ({reason})")),
        ["sidecar", "exit", code] => (LogLevel::Debug, format!("exit code {code}")),
        // Top-level Python failure surfaced by `__main__.py`'s
        // last-chance handler. The matching multi-line traceback
        // follows on stderr (one `LogLevel::Warn` line per frame).
        ["sidecar", "error", msg] => (LogLevel::Error, format!("sidecar fatal: {msg}")),
        ["interface", id, display, kind] => (
            LogLevel::Debug,
            format!("interface {id} ({display}) [{kind}]"),
        ),
        _ => (LogLevel::Debug, line.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_stdout_recognises_banner_lines() {
        // The sidecar's own status is Debug; only "listening" / "shutdown"
        // — is local capture available or not — rate as Info.
        assert!(matches!(
            classify_stdout_line("sidecar\tversion\t0.1.0"),
            (LogLevel::Debug, _)
        ));
        assert!(matches!(
            classify_stdout_line("sidecar\tlistening\t127.0.0.1:50061"),
            (LogLevel::Info, _)
        ));
        let (_lvl, msg) = classify_stdout_line("sidecar\tinterfaces\t0");
        assert!(msg.contains('0'));
        let (_lvl, msg) = classify_stdout_line("sidecar\tlistening\t127.0.0.1:50061");
        assert!(msg.contains("127.0.0.1:50061"));
        let (_lvl, msg) = classify_stdout_line(
            "interface\tvector:VN1630A(SN:12345, ch:0)\tVector VN1630A ch0\tfd",
        );
        assert!(msg.contains("vector:VN1630A(SN:12345, ch:0)"));
        assert!(msg.contains("[fd]"));
    }

    #[test]
    fn classify_stdout_passes_through_unknown_lines() {
        let (lvl, msg) = classify_stdout_line("a stray print from the sidecar");
        assert!(matches!(lvl, LogLevel::Debug));
        assert_eq!(msg, "a stray print from the sidecar");
    }

    #[test]
    fn classify_stderr_reads_python_levelname() {
        // The Python sidecar's basicConfig format is
        // "%(asctime)s %(levelname)s %(name)s %(message)s".
        let (lvl, msg) = classify_stderr_line(
            "2026-05-25 16:05:43,487 INFO cannet_python_can.server ListInterfaces -> 2 channels",
        );
        assert!(
            matches!(lvl, LogLevel::Debug),
            "the sidecar's INFO is our Debug, and must not be warned"
        );
        assert_eq!(
            msg, "cannet_python_can.server ListInterfaces -> 2 channels",
            "timestamp should be stripped; name + message retained"
        );

        let (lvl, _) = classify_stderr_line(
            "2026-05-25 16:05:43,487 WARNING cannet_python_can.server rx pump for X failed",
        );
        assert!(matches!(lvl, LogLevel::Warn));

        let (lvl, _) = classify_stderr_line(
            "2026-05-25 16:05:43,487 ERROR cannet_python_can sidecar fatal error",
        );
        assert!(matches!(lvl, LogLevel::Error));

        let (lvl, _) =
            classify_stderr_line("2026-05-25 16:05:43,487 CRITICAL cannet_python_can boom");
        assert!(matches!(lvl, LogLevel::Error));

        let (lvl, _) =
            classify_stderr_line("2026-05-25 16:05:43,487 DEBUG cannet_python_can chatty");
        assert!(matches!(lvl, LogLevel::Debug));
    }

    #[test]
    fn classify_stderr_falls_back_to_warn_on_unrecognised_lines() {
        // Traceback frame — no levelname token at position 2.
        let (lvl, msg) = classify_stderr_line("  File \"server.py\", line 42, in <module>");
        assert!(matches!(lvl, LogLevel::Warn));
        assert_eq!(msg, "  File \"server.py\", line 42, in <module>");

        // Looks roughly right but the level token isn't a real level.
        let (lvl, msg) =
            classify_stderr_line("2026-05-25 16:05:43,487 BANANAS cannet_python_can not a level");
        assert!(matches!(lvl, LogLevel::Warn));
        assert!(msg.contains("BANANAS"));
    }

    #[test]
    fn classify_stdout_promotes_error_banner_to_error_level() {
        let (lvl, msg) =
            classify_stdout_line("sidecar\terror\tVersionError: protobuf gencode/runtime mismatch");
        assert!(matches!(lvl, LogLevel::Error));
        assert!(
            msg.contains("VersionError"),
            "expected exception text preserved, got {msg}"
        );
        assert!(
            msg.starts_with("sidecar fatal:"),
            "expected `sidecar fatal:` prefix, got {msg}"
        );
    }

    #[test]
    fn the_logfile_banner_line_is_readable_at_the_default_filter() {
        // Debug-level would hide it behind the usual default filter,
        // which defeats the point: this line is how a user finds the
        // file to attach to a bug report.
        let (lvl, msg) =
            classify_stdout_line("sidecar\tlogfile\t/home/u/.local/share/cannet/logs/s.log");
        assert!(matches!(lvl, LogLevel::Info));
        assert!(
            msg.contains("/home/u/.local/share/cannet/logs/s.log"),
            "the path must survive verbatim, got {msg}"
        );
    }

    #[test]
    fn parse_listening_address_strips_the_banner_prefix() {
        assert_eq!(
            parse_listening_address("sidecar\tlistening\t127.0.0.1:43891"),
            Some("127.0.0.1:43891"),
        );
        assert_eq!(
            parse_listening_address("sidecar\tlistening\t[::1]:43891"),
            Some("[::1]:43891"),
        );
    }

    #[test]
    fn parse_listening_address_ignores_other_banner_lines() {
        assert_eq!(parse_listening_address("sidecar\tversion\t0.1.0"), None);
        assert_eq!(
            parse_listening_address("interface\tvector:ch0\tVector ch0\tfd"),
            None,
        );
        assert_eq!(parse_listening_address(""), None);
    }
}

//! How the host reaches one server, and what it does when the attempt
//! is refused —
//! [ADR 0041](../../../../docs/adr/0041-remote-connection-security.md)'s
//! client half, as a state machine the host owns.
//!
//! The frontend renders; it never decides. Every question this module
//! can ask reaches the `WebView` as a [`TrustPrompt`] keyed by server
//! address, and every answer comes back as a write to the trust store
//! ([`crate::server_trust`]) — so what the user accepted survives the
//! window, and no connection decision lives in view state.
//!
//! ## The four paths
//!
//! - **Local** (loopback, `localhost`, the in-process virtual bus):
//!   plaintext, unconditionally. The server itself lets these run
//!   unprotected, and this is the path the GUI's own sidecar takes.
//! - **Pinned**: TLS verified against the stored fingerprint, with the
//!   stored token on every RPC. A mismatch is refused and asked about;
//!   there is no retry and no fallback to plaintext, ever.
//! - **Trust on first use**: nothing stored, so the connection is a
//!   [`Attempt::Probe`] — it reaches the server's certificate, refuses
//!   it, and hands the fingerprint to the dialog. No RPC is made and no
//!   credential is sent, because the handshake never completes.
//! - **Explicitly unprotected**: a probe that never reached a
//!   certificate means the endpoint is not speaking TLS (a server run
//!   `--insecure`) or is not there. There is no silent fallback: the
//!   host asks, and only a stored answer lets a later attempt go out in
//!   the clear.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::Mutex;

use cannet_client::tls::CertPin;
use cannet_client::{ConnectConfig, ConnectionError};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::server_trust::TrustEntry;

/// Tauri event emitted whenever the set of pending trust questions
/// changes. Payload is the whole map, address → [`TrustPrompt`]
/// (bounded by the number of servers a project names, so there is no
/// diff format).
pub const SERVER_PROMPTS_CHANGED_EVENT: &str = "server-prompts-changed";

/// How the next attempt against a server is made.
#[derive(Clone, PartialEq, Eq)]
pub enum Attempt {
    /// Plaintext HTTP/2, no credential.
    Plaintext,
    /// TLS pinned to `fingerprint`, presenting `token` when one is
    /// stored.
    Pinned {
        fingerprint: String,
        token: Option<String>,
    },
    /// A trust-on-first-use probe. Always fails; the point is what it
    /// saw on the way.
    Probe,
}

/// Redacts the token, which the derived impl printed in full. An
/// `&Attempt` travels into the failure-reporting helpers that sit
/// beside the `sys_warn!` / `sys_error!` calls writing `cannet.log` —
/// the file a bug report attaches — so a `{attempt:?}` added there
/// while troubleshooting must not be a credential leak. The
/// fingerprint is public material and stays legible; the same split
/// [`crate::server_trust::TrustEntry`] makes.
impl std::fmt::Debug for Attempt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Plaintext => f.write_str("Plaintext"),
            Self::Probe => f.write_str("Probe"),
            Self::Pinned { fingerprint, token } => f
                .debug_struct("Pinned")
                .field("fingerprint", fingerprint)
                .field("token", &token.as_ref().map(|_| "<redacted>"))
                .finish(),
        }
    }
}

impl Attempt {
    /// The `cannet-client` configuration this attempt dials with.
    ///
    /// A stored fingerprint that no longer parses is a hard error
    /// rather than a downgrade to a probe: the file has been edited
    /// into a state the host cannot honour, and quietly asking the user
    /// to re-accept an identity would hide that.
    pub fn config(&self, address: &str) -> Result<ConnectConfig, String> {
        match self {
            Attempt::Plaintext => Ok(ConnectConfig::plaintext(address)),
            Attempt::Probe => Ok(ConnectConfig::unpinned(address)),
            Attempt::Pinned { fingerprint, token } => {
                let pin = CertPin::parse(fingerprint).map_err(|e| {
                    format!("the fingerprint stored for {address} is unusable ({e}); forget the server to accept it again")
                })?;
                Ok(match token {
                    Some(token) => ConnectConfig::pinned_with_token(address, pin, token),
                    None => ConnectConfig::pinned(address, pin),
                })
            }
        }
    }
}

/// Decide how to reach `address` given what the host has stored for it.
///
/// The order is the security posture: a local address is plaintext
/// whatever else is stored, a pinned server is *always* dialled pinned
/// (S7 — there is no configuration in which a pin degrades to
/// plaintext), and only a server with nothing pinned can use a stored
/// "connect without protection" choice.
#[must_use]
pub fn plan(address: &str, trust: &TrustEntry) -> Attempt {
    if is_local(address) {
        return Attempt::Plaintext;
    }
    if let Some(fingerprint) = &trust.fingerprint {
        return Attempt::Pinned {
            fingerprint: fingerprint.clone(),
            token: trust.token.clone(),
        };
    }
    if trust.insecure {
        return Attempt::Plaintext;
    }
    Attempt::Probe
}

/// Whether reaching `address` still needs an answer from the user: the
/// next attempt would be a [`Attempt::Probe`], refused at the
/// certificate, with the question raised from there.
///
/// Exactly [`plan`]'s answer, so no other surface has to re-derive
/// which addresses are reached without asking — a pin, an accepted
/// unprotected choice, and the loopback path all carry a connection
/// through, and only the first two are visible in the trust store.
#[must_use]
pub fn needs_trust(address: &str, trust: &TrustEntry) -> bool {
    matches!(plan(address, trust), Attempt::Probe)
}

/// Which of `addresses` cannot be reached without asking the user
/// first. Connection Management flags the buses bound to them, rather
/// than letting a project opened on a machine that has not accepted the
/// server fail silently at connect time.
///
/// The host answers because the rules are the host's: a trust store it
/// owns, plus address rules ([`is_local`]) that must not be guessed at
/// in the `WebView`.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn addresses_needing_trust(app: AppHandle, addresses: Vec<String>) -> Vec<String> {
    addresses
        .into_iter()
        .filter(|address| needs_trust(address, &crate::server_trust::trust_for(&app, address)))
        .collect()
}

/// Plan and build the connection configuration for `address` in one
/// step — what a call site with a single attempt and no retry loop
/// needs. Failures still go through [`classify`] at the call site.
pub(crate) fn config_for(app: &AppHandle, address: &str) -> Result<ConnectConfig, String> {
    plan(address, &crate::server_trust::trust_for(app, address)).config(address)
}

/// A question only the user can answer, as the dialog receives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TrustPrompt {
    /// First contact with this server. `observed` is the `SHA256:`
    /// string the server printed at startup, for the user to compare;
    /// accepting it pins the identity and stores the token they paste.
    AcceptIdentity { observed: String },
    /// The server presented a different certificate than the one
    /// pinned. Refused — re-accepting is an explicit act that
    /// overwrites the pin.
    IdentityChanged { expected: String, observed: String },
    /// The server refused the credential. The token is wrong, stale, or
    /// missing.
    TokenRefused,
    /// A protected connection never reached a certificate: the endpoint
    /// is not speaking TLS, or is not answering at all. `detail` is the
    /// transport error, so the dialog can distinguish "run it with
    /// `--tls`" from "it is not there" without the host guessing.
    NoProtection { detail: String },
}

/// What the host does with a refused attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Put a question to the user and stop. Terminal for a retry loop:
    /// the same attempt will fail the same way until something the user
    /// decides changes (S13).
    Ask(TrustPrompt),
    /// Terminal, with nothing to ask — a configuration error the user
    /// has to go and fix.
    Fatal(String),
    /// Nothing about the failure says it will keep failing; a retry
    /// loop should back off and try again.
    Retry(String),
}

/// Classify the error an [`Attempt`] failed with.
///
/// The two credential failures — a certificate that isn't the pinned
/// one, and a token the server refused — are never retried. They do not
/// become correct by asking again, and a loop that hammers one is both
/// useless and noisy.
#[must_use]
pub fn classify(attempt: &Attempt, error: &ConnectionError) -> Outcome {
    match error {
        ConnectionError::PinMismatch {
            expected: None,
            observed,
        } => Outcome::Ask(TrustPrompt::AcceptIdentity {
            observed: observed.clone(),
        }),
        ConnectionError::PinMismatch {
            expected: Some(expected),
            observed,
        } => Outcome::Ask(TrustPrompt::IdentityChanged {
            expected: expected.clone(),
            observed: observed.clone(),
        }),
        ConnectionError::Unauthenticated => Outcome::Ask(TrustPrompt::TokenRefused),
        // A probe that got a transport error never saw a certificate,
        // so either the endpoint is plaintext or it is not there. Both
        // are the user's call, and neither is something to fall back
        // from silently.
        ConnectionError::Connect(detail) if matches!(attempt, Attempt::Probe) => {
            Outcome::Ask(TrustPrompt::NoProtection {
                detail: detail.clone(),
            })
        }
        ConnectionError::InsecureScheme { .. } | ConnectionError::InvalidToken => {
            Outcome::Fatal(error.to_string())
        }
        other => Outcome::Retry(other.to_string()),
    }
}

/// Whether `address` is one of the connections that stay plaintext
/// unconditionally: the in-process virtual bus (ADR 0021), and a
/// loopback server — the GUI's own sidecar and any `--bind 127.0.0.1`
/// proxy, which the server itself lets run unprotected.
///
/// An IPv4-mapped IPv6 address (`::ffff:127.0.0.1`) is canonicalised
/// before the test, so the loopback check cannot be side-stepped by
/// spelling the address differently. Anything that is not an IP literal
/// — a DNS name other than `localhost` — is *not* local: the host
/// cannot tell where it resolves, and guessing in the permissive
/// direction is the one mistake that costs protection.
#[must_use]
pub fn is_local(address: &str) -> bool {
    if address.starts_with(crate::project::LOCAL_VBUS_URL_SCHEME) {
        return true;
    }
    let authority = match address.split_once("://") {
        Some((_, rest)) => rest,
        None => address,
    };
    let host = host_of(authority);
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_loopback(),
        Ok(IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.is_loopback(),
            None => v6.is_loopback(),
        },
        Err(_) => false,
    }
}

/// The host part of `authority`, handling the bracketed IPv6 form.
fn host_of(authority: &str) -> &str {
    if let Some(rest) = authority.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest);
    }
    match authority.rsplit_once(':') {
        Some((host, _)) => host,
        None => authority,
    }
}

/// Tauri-managed singleton holding the pending questions, address →
/// prompt. Bounded by the number of servers a project names.
#[derive(Default)]
pub struct ServerPrompts {
    inner: Mutex<BTreeMap<String, TrustPrompt>>,
}

impl ServerPrompts {
    /// Current snapshot.
    pub fn snapshot(&self) -> BTreeMap<String, TrustPrompt> {
        self.lock().clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, TrustPrompt>> {
        self.inner.lock().expect("server prompts mutex poisoned")
    }
}

/// Record `prompt` against `address` and push the new map at the
/// frontend if it moved. The one write path, so "the host is waiting on
/// the user" and "the user was asked" cannot drift apart.
pub(crate) fn ask(app: &AppHandle, address: &str, prompt: TrustPrompt) {
    let Some(prompts) = app.try_state::<ServerPrompts>() else {
        return;
    };
    let changed = {
        let mut guard = prompts.lock();
        if guard.get(address) == Some(&prompt) {
            false
        } else {
            guard.insert(address.to_string(), prompt);
            true
        }
    };
    if changed {
        emit(app, &prompts);
    }
}

/// Drop any pending question for `address` — the connection succeeded,
/// or the user answered.
pub(crate) fn resolved(app: &AppHandle, address: &str) {
    let Some(prompts) = app.try_state::<ServerPrompts>() else {
        return;
    };
    let changed = prompts.lock().remove(address).is_some();
    if changed {
        emit(app, &prompts);
    }
}

fn emit(app: &AppHandle, prompts: &ServerPrompts) {
    let _ = app.emit(SERVER_PROMPTS_CHANGED_EVENT, prompts.snapshot());
    // A pending question is also a fact about the server's row — a
    // refused certificate is what the changed-identity badge is made
    // of — so the merged list moves with it.
    crate::server_list::changed(app);
}

/// Initial-state read for a frontend that just mounted; the event
/// carries every subsequent change.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_server_prompts(
    prompts: tauri::State<'_, ServerPrompts>,
) -> BTreeMap<String, TrustPrompt> {
    prompts.snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_attempts_debug_output_never_carries_the_token() {
        // `&Attempt` is handed to `report_failure` and `ask_or_report`,
        // which sit directly beside the `sys_warn!` / `sys_error!` calls
        // that write `cannet.log` — the file a bug report attaches. A
        // `{attempt:?}` added there while troubleshooting would be a
        // one-line credential leak, so the type refuses to render one.
        let attempt = Attempt::Pinned {
            fingerprint: "SHA256:qF3".into(),
            token: Some("the-bearer-token-value".into()),
        };
        let rendered = format!("{attempt:?}");
        assert!(
            !rendered.contains("the-bearer-token-value"),
            "the token must not be printable: {rendered}"
        );
        assert!(rendered.contains("SHA256:qF3"), "{rendered}");
        assert!(rendered.contains("redacted"), "{rendered}");
        // An attempt with no token says so rather than saying nothing.
        let none = Attempt::Pinned {
            fingerprint: "SHA256:qF3".into(),
            token: None,
        };
        assert!(!format!("{none:?}").contains("redacted"));
    }

    fn pinned(fingerprint: &str, token: Option<&str>) -> TrustEntry {
        TrustEntry {
            fingerprint: Some(fingerprint.into()),
            token: token.map(Into::into),
            insecure: false,
        }
    }

    #[test]
    fn loopback_in_every_spelling_takes_the_plaintext_path() {
        for address in [
            "127.0.0.1:50051",
            "127.0.0.5:50051",
            "http://127.0.0.1:50051",
            "localhost:50051",
            "LOCALHOST:50051",
            "[::1]:50051",
            "[::ffff:127.0.0.1]:50051",
            "local-vbus://bus0",
        ] {
            assert!(is_local(address), "{address}");
            assert_eq!(
                plan(address, &TrustEntry::default()),
                Attempt::Plaintext,
                "{address} is the untouched local fast path",
            );
        }
    }

    #[test]
    fn a_routable_address_is_never_assumed_local() {
        for address in [
            "192.168.1.10:50051",
            "bench.example.com:50051",
            "0.0.0.0:50051",
            "[2001:db8::1]:50051",
            "[::ffff:192.168.1.10]:50051",
        ] {
            assert!(!is_local(address), "{address}");
        }
    }

    #[test]
    fn a_routable_address_with_nothing_stored_is_a_first_use_probe() {
        assert_eq!(plan("bench:50051", &TrustEntry::default()), Attempt::Probe,);
    }

    #[test]
    fn needs_trust_is_exactly_the_probe_case() {
        // What a bus row is flagged by. A loopback proxy is never asked
        // about, so a project bound to one must not be told to go and
        // trust it — the question would never come.
        assert!(needs_trust("bench:50051", &TrustEntry::default()));
        assert!(!needs_trust("127.0.0.1:50051", &TrustEntry::default()));
        assert!(!needs_trust("localhost:50051", &TrustEntry::default()));
        assert!(!needs_trust("bench:50051", &pinned("SHA256:aaa", None)));
        assert!(!needs_trust(
            "bench:50051",
            &TrustEntry {
                insecure: true,
                ..TrustEntry::default()
            }
        ));
        // A stored token alone still stops at the certificate.
        assert!(needs_trust(
            "bench:50051",
            &TrustEntry {
                token: Some("tok".into()),
                ..TrustEntry::default()
            }
        ));
    }

    #[test]
    fn a_pinned_server_is_dialled_pinned_with_its_token() {
        assert_eq!(
            plan("bench:50051", &pinned("SHA256:aaa", Some("tok"))),
            Attempt::Pinned {
                fingerprint: "SHA256:aaa".into(),
                token: Some("tok".into()),
            },
        );
    }

    #[test]
    fn a_pin_beats_a_stored_insecure_choice() {
        // S7: there is no configuration in which a pinned server is
        // reached over an unencrypted channel. Even a store that somehow
        // holds both answers resolves to the protected one.
        let mut trust = pinned("SHA256:aaa", Some("tok"));
        trust.insecure = true;
        assert!(matches!(
            plan("bench:50051", &trust),
            Attempt::Pinned { .. }
        ));
    }

    #[test]
    fn only_an_explicit_stored_choice_reaches_a_routable_server_in_the_clear() {
        let trust = TrustEntry {
            insecure: true,
            ..TrustEntry::default()
        };
        assert_eq!(plan("bench:50051", &trust), Attempt::Plaintext);
    }

    #[test]
    fn a_first_contact_asks_the_user_to_accept_what_the_server_presented() {
        let outcome = classify(
            &Attempt::Probe,
            &ConnectionError::PinMismatch {
                expected: None,
                observed: "SHA256:bbb".into(),
            },
        );
        assert_eq!(
            outcome,
            Outcome::Ask(TrustPrompt::AcceptIdentity {
                observed: "SHA256:bbb".into(),
            }),
        );
    }

    #[test]
    fn a_changed_identity_is_asked_about_with_both_fingerprints_and_never_retried() {
        let outcome = classify(
            &Attempt::Pinned {
                fingerprint: "SHA256:aaa".into(),
                token: None,
            },
            &ConnectionError::PinMismatch {
                expected: Some("SHA256:aaa".into()),
                observed: "SHA256:bbb".into(),
            },
        );
        assert_eq!(
            outcome,
            Outcome::Ask(TrustPrompt::IdentityChanged {
                expected: "SHA256:aaa".into(),
                observed: "SHA256:bbb".into(),
            }),
            "the dialog shows what was pinned beside what arrived",
        );
    }

    #[test]
    fn a_refused_credential_is_asked_about_and_never_retried() {
        // S13's other half: a wrong token does not become right by
        // asking again once a second, forever.
        for attempt in [
            Attempt::Pinned {
                fingerprint: "SHA256:aaa".into(),
                token: Some("stale".into()),
            },
            Attempt::Plaintext,
        ] {
            assert_eq!(
                classify(&attempt, &ConnectionError::Unauthenticated),
                Outcome::Ask(TrustPrompt::TokenRefused),
            );
        }
    }

    #[test]
    fn a_probe_that_never_saw_a_certificate_asks_before_anything_goes_out_in_the_clear() {
        let outcome = classify(
            &Attempt::Probe,
            &ConnectionError::Connect("transport error".into()),
        );
        assert_eq!(
            outcome,
            Outcome::Ask(TrustPrompt::NoProtection {
                detail: "transport error".into(),
            }),
            "no automatic downgrade — the user is asked",
        );
    }

    #[test]
    fn a_pinned_server_that_is_simply_down_keeps_retrying() {
        // The distinction that keeps a configured server reconnecting:
        // the same transport error means "ask" only on a probe, because
        // only there is "maybe it is plaintext" a live possibility.
        let outcome = classify(
            &Attempt::Pinned {
                fingerprint: "SHA256:aaa".into(),
                token: None,
            },
            &ConnectionError::Connect("connection refused".into()),
        );
        assert!(matches!(outcome, Outcome::Retry(_)), "{outcome:?}");
    }

    #[test]
    fn an_unreachable_plaintext_server_keeps_retrying_exactly_as_before() {
        let outcome = classify(
            &Attempt::Plaintext,
            &ConnectionError::Connect("connection refused".into()),
        );
        assert!(matches!(outcome, Outcome::Retry(_)), "{outcome:?}");
    }

    #[test]
    fn a_configuration_error_is_terminal_with_no_question_to_ask() {
        for error in [
            ConnectionError::InsecureScheme {
                address: "http://bench:50051".into(),
            },
            ConnectionError::InvalidToken,
        ] {
            assert!(
                matches!(classify(&Attempt::Probe, &error), Outcome::Fatal(_)),
                "{error}",
            );
        }
    }

    #[test]
    fn a_stored_fingerprint_that_does_not_parse_fails_rather_than_re_prompting() {
        let attempt = Attempt::Pinned {
            fingerprint: "not-a-fingerprint".into(),
            token: None,
        };
        let err = attempt.config("bench:50051").unwrap_err();
        assert!(err.contains("bench:50051"), "{err}");
        assert!(err.contains("forget"), "{err}");
    }

    #[test]
    fn the_prompt_wire_shape_is_a_tagged_union_the_frontend_can_switch_on() {
        let json = serde_json::to_value(TrustPrompt::IdentityChanged {
            expected: "SHA256:aaa".into(),
            observed: "SHA256:bbb".into(),
        })
        .unwrap();
        assert_eq!(json["kind"], "identityChanged");
        assert_eq!(json["expected"], "SHA256:aaa");
        assert_eq!(json["observed"], "SHA256:bbb");

        let json = serde_json::to_value(TrustPrompt::TokenRefused).unwrap();
        assert_eq!(json["kind"], "tokenRefused");

        let json = serde_json::to_value(TrustPrompt::AcceptIdentity {
            observed: "SHA256:bbb".into(),
        })
        .unwrap();
        assert_eq!(json["kind"], "acceptIdentity");
        assert_eq!(json["observed"], "SHA256:bbb");
    }
}

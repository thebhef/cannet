//! Bearer-token client authentication (ADR 0041).
//!
//! One shared secret guards the endpoint: whoever can read the console
//! the server was launched from is authorized to use its buses. A
//! generated token is a 5-word passphrase drawn from the embedded EFF
//! large wordlist — `word-word-word-word-word`, lowercase,
//! hyphen-separated — chosen over the previous 256-bit base64url blob
//! because that blob was "ridiculously long and difficult to
//! transcribe across machines" (owner feedback). Clients
//! present it as an RFC 6750 `authorization: Bearer <token>` gRPC
//! metadata entry; generation is the only thing that changed —
//! `--token` / `CANNET_TOKEN` still accept any string the operator
//! hands them, and the wire, trust store and constant-time compare
//! treat every token as an opaque string regardless of its shape.
//!
//! Like the certificate, the generated token is persisted in the
//! server's per-user data directory so it survives a restart — a client
//! that stored it does not have to be reconfigured every launch.
//! Rotation is deleting that file.
//!
//! The value is a credential, so it appears in exactly one place: the
//! startup banner the operator reads. It never reaches a log record, a
//! `Status` message, or an error string.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use subtle::ConstantTimeEq as _;

use crate::identity::write_private;

/// File name of the persisted token inside the identity directory.
const TOKEN_FILE: &str = "access-token";

/// The embedded EFF large wordlist: 7776 tab-separated
/// `dice-index<TAB>word` lines, committed verbatim from EFF's own
/// distribution. See `assets/eff_large_wordlist.LICENSE` for
/// provenance (CC BY 3.0, Electronic Frontier Foundation). Public
/// data, not a crate dependency — no new dependency to pull in.
const WORDLIST_RAW: &str = include_str!("../assets/eff_large_wordlist.txt");

/// Words per generated passphrase. `PASSPHRASE_WORDS *
/// log2(wordlist().len())` is the entropy math cited on
/// [`AccessToken::generate`].
const PASSPHRASE_WORDS: usize = 5;

/// The embedded wordlist, parsed once: each line is
/// `dice-index<TAB>word`, and only the word half is kept.
fn wordlist() -> &'static [&'static str] {
    static WORDS: OnceLock<Vec<&'static str>> = OnceLock::new();
    WORDS
        .get_or_init(|| {
            WORDLIST_RAW
                .lines()
                .filter_map(|line| line.split('\t').nth(1))
                .collect()
        })
        .as_slice()
}

/// Draw an index uniformly from `0..bound` off `rng`, by rejecting
/// draws that would otherwise land unevenly.
///
/// `bound` (7776 for the wordlist) does not evenly divide 65536, the
/// range of a `u16`: naively reducing a random `u16` mod `bound` would
/// make the low `65536 % bound` indices very slightly more likely than
/// the rest. Rejection sampling removes that skew instead of
/// tolerating it: draw two bytes, and if the value falls in the
/// trailing partial range, throw it away and draw again. `bound` up to
/// `u16::MAX as usize + 1` is supported; the wordlist's 7776 is nowhere
/// near that ceiling, so rejection is rare in practice.
fn uniform_index(rng: &dyn ring::rand::SecureRandom, bound: usize) -> Result<usize, TokenError> {
    assert!(bound > 0, "uniform_index: bound must be positive");
    // `usize::from` (never a truncating cast) keeps every value here
    // lossless; the widest quantity, `draw_space`, is 65536.
    let draw_space = usize::from(u16::MAX) + 1;
    assert!(
        bound <= draw_space,
        "uniform_index: bound must fit a u16 draw"
    );
    // Largest multiple of `bound` that fits in a u16 draw; a draw at or
    // past it is the biased remainder and gets rejected.
    let limit = (draw_space / bound) * bound;
    loop {
        let mut buf = [0u8; 2];
        rng.fill(&mut buf).map_err(|_| TokenError::Generate)?;
        let raw = usize::from(u16::from_be_bytes(buf));
        if raw < limit {
            return Ok(raw % bound);
        }
    }
}

/// Draw [`PASSPHRASE_WORDS`] words from the embedded wordlist, each
/// chosen uniformly and independently (repeats across the five slots
/// are allowed, exactly like independent dice rolls).
fn generate_words() -> Result<Vec<&'static str>, TokenError> {
    let rng = ring::rand::SystemRandom::new();
    let words = wordlist();
    (0..PASSPHRASE_WORDS)
        .map(|_| uniform_index(&rng, words.len()).map(|i| words[i]))
        .collect()
}

/// The shared secret a client presents to open any RPC.
///
/// Deliberately has no `Debug` and no `Display`: the only way to render
/// the value is [`AccessToken::as_str`], so it cannot end up in a log
/// record or an error message by accident.
#[derive(Clone)]
pub struct AccessToken(String);

impl AccessToken {
    /// Mint a fresh passphrase token from the OS CSPRNG:
    /// [`PASSPHRASE_WORDS`] words drawn uniformly (no modulo bias — see
    /// [`uniform_index`]) from the embedded EFF large wordlist,
    /// lowercase, joined with `-`.
    ///
    /// Entropy: 5 × log2(7776) ≈ 64.6 bits. That is far below the 256
    /// bits the previous base64url token carried, and that is fine:
    /// the token is stored in plaintext on disk either way (module
    /// docs above), so there was never an offline crack target to
    /// defend against — the only attack is guessing it live, one
    /// attempt at a time, through a TLS endpoint that a
    /// `Status::unauthenticated` reply and ordinary network latency
    /// already rate-limit. ~65 bits puts online brute force completely
    /// out of reach while being five words a person can read off one
    /// console and type into another — the transcription problem this
    /// format exists to solve (owner feedback).
    pub fn generate() -> Result<Self, TokenError> {
        Ok(Self(generate_words()?.join("-")))
    }

    /// Load the token persisted in `dir`, minting and persisting one
    /// when it isn't there yet.
    ///
    /// The file is created with owner-only permissions on Unix and
    /// renamed into place, exactly as the private key is.
    pub fn load_or_generate(dir: &Path) -> Result<Self, TokenError> {
        let path = dir.join(TOKEN_FILE);
        if path.is_file() {
            let value = fs::read_to_string(&path).map_err(|e| TokenError::io(&path, e))?;
            let value = value.trim();
            if value.is_empty() {
                return Err(TokenError::Empty(path));
            }
            return Ok(Self(value.to_string()));
        }
        fs::create_dir_all(dir).map_err(|e| TokenError::io(dir, e))?;
        let token = Self::generate()?;
        write_private(&path, token.0.as_bytes()).map_err(|e| TokenError::io(e.path, e.source))?;
        Ok(token)
    }

    /// Use `value` as this run's token, persisting nothing — the
    /// `--token` / `CANNET_TOKEN` path, where the operator already has
    /// the secret and wants the server to accept that one.
    ///
    /// Surrounding whitespace is trimmed, because a pasted value tends
    /// to carry some. An empty value is refused rather than accepted as
    /// a token nobody can guess: an empty secret matches an empty
    /// presentation, which is no authentication at all.
    pub fn from_value(value: &str) -> Result<Self, TokenError> {
        let value = value.trim();
        if value.is_empty() {
            return Err(TokenError::EmptyValue);
        }
        Ok(Self(value.to_string()))
    }

    /// The token as the operator sees it on the startup banner and as a
    /// client sends it.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether `presented` is this token, compared in constant time so
    /// a caller cannot learn the secret one character at a time from
    /// how long a rejection takes.
    ///
    /// The comparison is over the encoded ASCII, never over decoded
    /// bytes: base64 has non-canonical encodings that decode to the same
    /// value, and accepting those would widen the secret's surface.
    #[must_use]
    pub fn matches(&self, presented: &str) -> bool {
        self.0.as_bytes().ct_eq(presented.as_bytes()).into()
    }
}

/// The metadata entry a client presents its token in (RFC 6750).
const AUTHORIZATION: &str = "authorization";

/// A tonic interceptor that gates every RPC on `token`.
///
/// Mount it as a **server-wide layer** rather than per service, so that
/// adding a service cannot accidentally add an ungated one:
///
/// ```
/// # use cannet_server::auth::token_gate;
/// let gate = tonic::service::interceptor(token_gate(None));
/// let _server = tonic::transport::Server::builder().layer(gate);
/// ```
///
/// `None` leaves the endpoint ungated. That is not a convenience: the
/// token is bound to TLS (ADR 0041), because presenting a bearer token
/// over a plaintext channel hands it to anyone on the path. A server
/// that terminates no TLS therefore enforces no token, and its bind is
/// the one the startup guard refuses to put on the network.
// `tonic::Status` is a large error type, and it is also the only error
// type an interceptor is allowed to return. Boxing it here would just
// be unboxed again by tonic.
#[allow(clippy::result_large_err)]
pub fn token_gate(
    token: Option<AccessToken>,
) -> impl Fn(tonic::Request<()>) -> Result<tonic::Request<()>, tonic::Status> + Clone {
    move |request| match &token {
        Some(token) => authorize(request.metadata(), token).map(|()| request),
        None => Ok(request),
    }
}

/// Check one request's metadata for `token`.
///
/// Every failure — no `authorization` entry, a value that isn't ASCII,
/// a scheme other than `Bearer`, the wrong token — is the same
/// `unauthenticated` status with the same message. The presented value
/// is never echoed back and never logged: a rejected caller learns
/// only that it was rejected.
#[allow(clippy::result_large_err)] // As above: `Status` is the vocabulary here.
pub fn authorize(
    metadata: &tonic::metadata::MetadataMap,
    token: &AccessToken,
) -> Result<(), tonic::Status> {
    let header = metadata.get(AUTHORIZATION).ok_or_else(unauthenticated)?;
    // Metadata is bytes, and a value outside ASCII is a caller's
    // mistake (or probe), not a reason to panic.
    let value = header.to_str().map_err(|_| unauthenticated())?;
    let (scheme, presented) = value.split_once(' ').ok_or_else(unauthenticated)?;
    // RFC 7235: the scheme is case-insensitive, and RFC 6750 allows
    // more than one space before the credential.
    if !scheme.eq_ignore_ascii_case("Bearer") || !token.matches(presented.trim()) {
        return Err(unauthenticated());
    }
    Ok(())
}

fn unauthenticated() -> tonic::Status {
    tonic::Status::unauthenticated("a valid bearer token is required")
}

/// Why a token could not be established.
#[derive(Debug)]
pub enum TokenError {
    /// The token file could not be read or written.
    Io { path: PathBuf, source: io::Error },
    /// The OS CSPRNG refused to produce bytes.
    Generate,
    /// The persisted token file holds nothing. Deleting it mints a new
    /// token; an empty one is not silently replaced, because a client
    /// may be holding the value that used to be there.
    Empty(PathBuf),
    /// An operator-supplied token was blank.
    EmptyValue,
}

impl TokenError {
    fn io(path: impl Into<PathBuf>, source: io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

impl fmt::Display for TokenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "access token: {}: {source}", path.display()),
            Self::Generate => write!(f, "access token: the system random source failed"),
            Self::Empty(path) => write!(
                f,
                "access token: {} is empty; delete it to have a new token generated",
                path.display()
            ),
            Self::EmptyValue => write!(
                f,
                "access token: the token given is empty, which would authenticate everyone"
            ),
        }
    }
}

impl std::error::Error for TokenError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Generate | Self::Empty(_) | Self::EmptyValue => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wordlist_has_exactly_7776_unique_lowercase_entries() {
        let words = wordlist();
        assert_eq!(words.len(), 7776, "the EFF large wordlist is 7776 words");
        let unique: std::collections::HashSet<_> = words.iter().collect();
        assert_eq!(
            unique.len(),
            7776,
            "the embedded wordlist must carry no duplicate entries"
        );
        for word in words {
            assert!(!word.is_empty(), "a blank line parsed as a word");
            assert!(
                word.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "{word} is not lowercase ascii (a handful of EFF entries carry an \
                 internal hyphen, e.g. \"t-shirt\"; nothing else is expected)"
            );
        }
    }

    #[test]
    fn generate_words_draws_five_members_of_the_wordlist() {
        let words = generate_words().unwrap();
        assert_eq!(words.len(), PASSPHRASE_WORDS);
        let list = wordlist();
        for word in &words {
            assert!(
                list.contains(word),
                "{word} is not in the embedded wordlist"
            );
        }
    }

    #[test]
    fn a_generated_token_is_five_lowercase_words_hyphen_separated() {
        let token = AccessToken::generate().unwrap();
        let value = token.as_str();
        assert!(
            value.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
            "lowercase ascii and hyphens only: {value}"
        );
        assert!(!value.starts_with('-') && !value.ends_with('-'), "{value}");
        // Four separators join five words; a few EFF words carry an
        // internal hyphen too, so the total hyphen count can only be
        // *at least* four, not exactly four.
        assert!(
            value.matches('-').count() >= PASSPHRASE_WORDS - 1,
            "expected at least {} hyphens joining {} words: {value}",
            PASSPHRASE_WORDS - 1,
            PASSPHRASE_WORDS
        );
    }

    #[test]
    fn uniform_index_never_panics_and_stays_in_bounds() {
        // Boundary bounds: 1 (degenerate, always index 0), a power of
        // two that divides 65536 evenly (no rejection ever fires), and
        // 7776 (the real wordlist size, which does reject sometimes).
        let rng = ring::rand::SystemRandom::new();
        for bound in [1usize, 2, 7776, usize::from(u16::MAX) + 1] {
            for _ in 0..200 {
                let index = uniform_index(&rng, bound).unwrap();
                assert!(index < bound, "{index} not < {bound}");
            }
        }
    }

    #[test]
    fn two_generated_tokens_differ() {
        assert_ne!(
            AccessToken::generate().unwrap().as_str(),
            AccessToken::generate().unwrap().as_str()
        );
    }

    #[test]
    fn a_generated_token_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let first = AccessToken::load_or_generate(dir.path()).unwrap();
        assert!(dir.path().join(TOKEN_FILE).is_file());

        let second = AccessToken::load_or_generate(dir.path()).unwrap();
        assert_eq!(
            first.as_str(),
            second.as_str(),
            "a restart must reload the persisted token, not mint one a client has never seen"
        );
    }

    #[test]
    fn deleting_the_token_file_rotates_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let first = AccessToken::load_or_generate(dir.path()).unwrap();
        fs::remove_file(dir.path().join(TOKEN_FILE)).unwrap();
        let second = AccessToken::load_or_generate(dir.path()).unwrap();
        assert_ne!(first.as_str(), second.as_str());
    }

    #[test]
    fn a_generated_token_creates_the_directory_it_needs() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("does").join("not").join("exist");
        let token = AccessToken::load_or_generate(&nested).unwrap();
        assert_eq!(
            token.as_str(),
            AccessToken::load_or_generate(&nested).unwrap().as_str()
        );
    }

    #[test]
    fn an_operator_supplied_value_persists_nothing() {
        // `--token` / `CANNET_TOKEN`: the secret is the operator's, and
        // the server must not write it anywhere.
        let dir = tempfile::tempdir().unwrap();
        let token = AccessToken::from_value("  operator-chosen\n").unwrap();
        assert_eq!(
            token.as_str(),
            "operator-chosen",
            "a pasted value carries whitespace that is not part of the secret"
        );
        assert!(!dir.path().join(TOKEN_FILE).exists());
    }

    #[test]
    fn a_blank_operator_supplied_token_is_refused() {
        // An empty token would match an empty `Bearer ` presentation —
        // authentication that authenticates everyone.
        for blank in ["", "   ", "\n"] {
            let Err(err) = AccessToken::from_value(blank) else {
                panic!("{blank:?} must not become a usable token");
            };
            assert!(matches!(err, TokenError::EmptyValue), "{err}");
        }
    }

    #[test]
    fn a_persisted_token_ignores_surrounding_whitespace() {
        // Editors and `echo` add a trailing newline; that must not
        // become part of the secret.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE);
        fs::write(&path, "  abc123  \n").unwrap();
        assert_eq!(
            AccessToken::load_or_generate(dir.path()).unwrap().as_str(),
            "abc123"
        );
    }

    #[test]
    fn an_empty_token_file_is_an_error_rather_than_a_silent_new_token() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(TOKEN_FILE), "\n").unwrap();
        // `AccessToken` deliberately has no `Debug` (it holds a
        // credential), so unwrap the error by hand.
        let Err(err) = AccessToken::load_or_generate(dir.path()) else {
            panic!("an empty token file must not be treated as 'no token yet'");
        };
        assert!(matches!(err, TokenError::Empty(_)), "{err}");
    }

    #[test]
    fn matches_accepts_the_token_and_nothing_else() {
        let token = AccessToken::from_value("abcdef").unwrap();
        assert!(token.matches("abcdef"));
        assert!(!token.matches("abcdeg"));
        assert!(!token.matches("abcde"), "a prefix is not the token");
        assert!(!token.matches("abcdefg"), "nor is an extension of it");
        assert!(!token.matches(""));
        assert!(
            !token.matches("ABCDEF"),
            "and the compare is case-sensitive"
        );
    }

    /// A request carrying `value` as its `authorization` metadata.
    fn request_with_authorization(value: &str) -> tonic::Request<()> {
        let mut request = tonic::Request::new(());
        request
            .metadata_mut()
            .insert(AUTHORIZATION, value.parse().unwrap());
        request
    }

    fn token() -> AccessToken {
        AccessToken::from_value("t0k3n-abc_DEF").unwrap()
    }

    #[track_caller]
    fn assert_rejected(request: tonic::Request<()>, why: &str) {
        let gate = token_gate(Some(token()));
        let status = gate(request).err().unwrap_or_else(|| panic!("{why}"));
        assert_eq!(status.code(), tonic::Code::Unauthenticated, "{why}");
        assert_eq!(
            status.message(),
            "a valid bearer token is required",
            "every rejection says the same thing, so none of them is an oracle"
        );
    }

    #[test]
    fn the_right_token_passes_the_gate() {
        let gate = token_gate(Some(token()));
        gate(request_with_authorization("Bearer t0k3n-abc_DEF"))
            .expect("the token the server minted must be accepted");
    }

    #[test]
    fn the_bearer_scheme_is_case_insensitive() {
        // RFC 7235 makes the scheme case-insensitive, and real clients
        // spell it every way.
        let gate = token_gate(Some(token()));
        for spelling in ["Bearer", "bearer", "BEARER", "BeArEr"] {
            gate(request_with_authorization(&format!(
                "{spelling} t0k3n-abc_DEF"
            )))
            .unwrap_or_else(|_| panic!("`{spelling}` is the same scheme"));
        }
    }

    #[test]
    fn no_authorization_metadata_is_rejected() {
        assert_rejected(
            tonic::Request::new(()),
            "a request with no credential at all must not reach the service",
        );
    }

    #[test]
    fn the_wrong_token_is_rejected() {
        assert_rejected(
            request_with_authorization("Bearer t0k3n-abc_DEG"),
            "a near-miss is still a miss",
        );
        assert_rejected(
            request_with_authorization("Bearer t0k3n-abc_DE"),
            "a prefix of the token is not the token",
        );
        assert_rejected(
            request_with_authorization("Bearer "),
            "nor is the empty credential",
        );
    }

    #[test]
    fn another_scheme_is_rejected_even_carrying_the_right_token() {
        assert_rejected(
            request_with_authorization("Basic t0k3n-abc_DEF"),
            "the credential is a bearer token, not a password",
        );
        assert_rejected(
            request_with_authorization("t0k3n-abc_DEF"),
            "a bare value with no scheme is not RFC 6750",
        );
    }

    #[test]
    fn a_non_ascii_value_is_rejected_without_panicking() {
        // Metadata is bytes; `to_str` on 0x80..=0xFF fails, and that has
        // to be a rejection rather than an unwrap.
        let mut request = tonic::Request::new(());
        request.metadata_mut().insert(
            AUTHORIZATION,
            tonic::metadata::MetadataValue::try_from(&b"Bearer \xff\xfe"[..]).unwrap(),
        );
        assert_rejected(request, "a non-ASCII credential must be refused, not panic");
    }

    #[test]
    fn an_ungated_endpoint_passes_everything() {
        // `None` is the plaintext loopback server: no token is enforced
        // because a token must never ride an unencrypted channel.
        let gate = token_gate(None);
        gate(tonic::Request::new(())).expect("an ungated endpoint checks nothing");
        gate(request_with_authorization("Bearer whatever")).expect("not even a wrong one");
    }

    #[cfg(unix)]
    #[test]
    fn the_token_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir().unwrap();
        AccessToken::load_or_generate(dir.path()).unwrap();
        let mode = fs::metadata(dir.path().join(TOKEN_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "the token is a credential at rest, exactly like the private key"
        );
    }
}

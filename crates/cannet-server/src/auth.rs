//! Bearer-token client authentication (ADR 0041).
//!
//! One shared secret guards the endpoint: whoever can read the console
//! the server was launched from is authorized to use its buses. The
//! token is a 256-bit value from the OS CSPRNG, rendered as unpadded
//! base64url (RFC 4648 §5) so it is 43 characters of copy-pasteable
//! ASCII, and clients present it as an RFC 6750
//! `authorization: Bearer <token>` gRPC metadata entry.
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

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use subtle::ConstantTimeEq as _;

use crate::identity::write_private;

/// File name of the persisted token inside the identity directory.
const TOKEN_FILE: &str = "access-token";

/// Entropy behind a generated token: 256 bits, the standard opaque
/// API-key size.
const TOKEN_BYTES: usize = 32;

/// The shared secret a client presents to open any RPC.
///
/// Deliberately has no `Debug` and no `Display`: the only way to render
/// the value is [`AccessToken::as_str`], so it cannot end up in a log
/// record or an error message by accident.
#[derive(Clone)]
pub struct AccessToken(String);

impl AccessToken {
    /// Mint a fresh token from the OS CSPRNG.
    pub fn generate() -> Result<Self, TokenError> {
        let bytes: [u8; TOKEN_BYTES] = ring::rand::generate(&ring::rand::SystemRandom::new())
            .map_err(|_| TokenError::Generate)?
            .expose();
        Ok(Self(URL_SAFE_NO_PAD.encode(bytes)))
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
    #[must_use]
    pub fn from_value(value: String) -> Self {
        Self(value)
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
        }
    }
}

impl std::error::Error for TokenError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Generate | Self::Empty(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generated_token_is_43_characters_of_base64url() {
        let token = AccessToken::generate().unwrap();
        let value = token.as_str();
        assert_eq!(value.len(), 43, "256 bits, unpadded base64: {value}");
        assert!(!value.contains('='), "no padding: {value}");
        assert!(
            value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "base64url alphabet — no `+` or `/`, so the token survives a URL or a shell: {value}"
        );
        assert_eq!(
            URL_SAFE_NO_PAD.decode(value).unwrap().len(),
            TOKEN_BYTES,
            "the value has to decode back to the entropy that went in"
        );
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
        let token = AccessToken::from_value("operator-chosen".to_string());
        assert_eq!(token.as_str(), "operator-chosen");
        assert!(!dir.path().join(TOKEN_FILE).exists());
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
        let token = AccessToken::from_value("abcdef".to_string());
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

//! The server's TLS identity: a certificate/key pair and the
//! fingerprint operators compare out of band.
//!
//! Per ADR 0041 the server is its own certificate authority of one —
//! trust is established by pinning, not by a CA. On first run it
//! generates a keypair and a self-signed certificate and persists both
//! in its per-user data directory; every later run reloads the same
//! material, so the fingerprint a client pinned stays valid across
//! restarts. Operators who run a PKI supply their own material instead.
//!
//! Because trust rests on the fingerprint rather than on a chain, the
//! certificate carries a far-future expiry (rcgen's default) and
//! pinning clients ignore validity dates — an expired pinned
//! certificate is a non-event by construction.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine as _;

/// File name of the persisted certificate inside the identity
/// directory.
const CERT_FILE: &str = "server-cert.pem";
/// File name of the persisted private key inside the identity
/// directory.
const KEY_FILE: &str = "server-key.pem";

/// Subject alternative names on the generated certificate. Pinning
/// clients ignore the name, but a client that validates the chain
/// normally (and any tooling that inspects the certificate) expects the
/// local names to be present.
const GENERATED_SANS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// SHA-256 digest of an end-entity certificate's DER encoding — the
/// value a client pins and an operator eyeball-compares.
///
/// Stored as the raw 32 bytes; the display form is derived
/// ([`fmt::Display`]) and follows OpenSSH's host-key format: `SHA256:`
/// followed by unpadded **standard**-alphabet base64 (43 characters).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CertFingerprint([u8; 32]);

impl CertFingerprint {
    /// The fingerprint of the certificate whose DER encoding is `der`.
    #[must_use]
    pub fn from_cert_der(der: &[u8]) -> Self {
        let digest = ring::digest::digest(&ring::digest::SHA256, der);
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(digest.as_ref());
        Self(bytes)
    }

    /// The raw digest bytes, for constant-time comparison against a
    /// stored pin.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Display for CertFingerprint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SHA256:{}", STANDARD_NO_PAD.encode(self.0))
    }
}

/// A server certificate chain, its private key, and the fingerprint of
/// the end-entity certificate.
///
/// Both PEM blobs are held as loaded so they can be handed to tonic's
/// `Identity::from_pem` unchanged.
pub struct ServerIdentity {
    cert_pem: Vec<u8>,
    key_pem: Vec<u8>,
    fingerprint: CertFingerprint,
}

impl ServerIdentity {
    /// Load the identity persisted in `dir`, generating and persisting
    /// a fresh one when it isn't there yet.
    ///
    /// The private key is created with owner-only permissions on Unix.
    /// Both files are written to a temporary name and renamed into
    /// place, so a crash mid-write cannot leave a certificate without
    /// its key.
    pub fn load_or_generate(dir: &Path) -> Result<Self, IdentityError> {
        let cert_path = dir.join(CERT_FILE);
        let key_path = dir.join(KEY_FILE);
        if cert_path.is_file() && key_path.is_file() {
            return Self::from_files(&cert_path, &key_path);
        }
        fs::create_dir_all(dir).map_err(|e| IdentityError::io(dir, e))?;
        let generated = generate_self_signed()?;
        write_private(&key_path, generated.key_pem.as_bytes())?;
        write_public(&cert_path, generated.cert_pem.as_bytes())?;
        Self::from_pem(
            generated.cert_pem.into_bytes(),
            generated.key_pem.into_bytes(),
        )
    }

    /// Load operator-supplied material: a PEM certificate (or chain)
    /// and its PEM private key.
    pub fn from_files(cert_path: &Path, key_path: &Path) -> Result<Self, IdentityError> {
        let cert_pem = fs::read(cert_path).map_err(|e| IdentityError::io(cert_path, e))?;
        let key_pem = fs::read(key_path).map_err(|e| IdentityError::io(key_path, e))?;
        Self::from_pem(cert_pem, key_pem)
    }

    /// Build an identity from PEM blobs already in memory.
    ///
    /// The fingerprint covers the **first** certificate in `cert_pem` —
    /// the end-entity certificate a client sees at the head of the
    /// chain.
    pub fn from_pem(cert_pem: Vec<u8>, key_pem: Vec<u8>) -> Result<Self, IdentityError> {
        let der = first_certificate_der(&cert_pem)?;
        let fingerprint = CertFingerprint::from_cert_der(&der);
        Ok(Self {
            cert_pem,
            key_pem,
            fingerprint,
        })
    }

    /// The certificate chain, PEM-encoded.
    #[must_use]
    pub fn cert_pem(&self) -> &[u8] {
        &self.cert_pem
    }

    /// The private key, PEM-encoded.
    #[must_use]
    pub fn key_pem(&self) -> &[u8] {
        &self.key_pem
    }

    /// The end-entity certificate's fingerprint.
    #[must_use]
    pub fn fingerprint(&self) -> CertFingerprint {
        self.fingerprint
    }
}

/// The default per-user directory the generated identity is persisted
/// in: `<data-local-dir>/cannet-server`, i.e. `%LOCALAPPDATA%` on
/// Windows, `~/.local/share` on Linux, `~/Library/Application Support`
/// on macOS.
pub fn default_identity_dir() -> Result<PathBuf, IdentityError> {
    dirs::data_local_dir()
        .map(|dir| dir.join("cannet-server"))
        .ok_or(IdentityError::NoDataDir)
}

/// A freshly generated certificate and key, still PEM text.
struct Generated {
    cert_pem: String,
    key_pem: String,
}

fn generate_self_signed() -> Result<Generated, IdentityError> {
    let sans: Vec<String> = GENERATED_SANS.iter().map(|s| (*s).to_string()).collect();
    let key = rcgen::KeyPair::generate().map_err(IdentityError::Generate)?;
    let cert = rcgen::CertificateParams::new(sans)
        .map_err(IdentityError::Generate)?
        .self_signed(&key)
        .map_err(IdentityError::Generate)?;
    Ok(Generated {
        cert_pem: cert.pem(),
        key_pem: key.serialize_pem(),
    })
}

/// The DER bytes of the first `CERTIFICATE` block in `pem`.
fn first_certificate_der(pem: &[u8]) -> Result<Vec<u8>, IdentityError> {
    let mut reader = io::BufReader::new(pem);
    let first = rustls_pemfile::certs(&mut reader)
        .next()
        .ok_or(IdentityError::NoCertificate)?
        .map_err(|_| IdentityError::NoCertificate)?;
    Ok(first.to_vec())
}

/// Write `contents` to `path` via a temporary file in the same
/// directory, so readers never see a half-written file.
fn write_public(path: &Path, contents: &[u8]) -> Result<(), IdentityError> {
    let temp = temp_path(path);
    fs::write(&temp, contents).map_err(|e| IdentityError::io(&temp, e))?;
    fs::rename(&temp, path).map_err(|e| IdentityError::io(path, e))
}

/// Like [`write_public`], but the temporary file is *created* with
/// owner-only permissions on Unix — never widened after the fact, so
/// the key is unreadable to other users for its whole existence.
fn write_private(path: &Path, contents: &[u8]) -> Result<(), IdentityError> {
    use std::io::Write as _;

    let temp = temp_path(path);
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|e| IdentityError::io(&temp, e))?;
    file.write_all(contents)
        .map_err(|e| IdentityError::io(&temp, e))?;
    file.sync_all().map_err(|e| IdentityError::io(&temp, e))?;
    drop(file);
    fs::rename(&temp, path).map_err(|e| IdentityError::io(path, e))
}

fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    path.with_file_name(name)
}

/// Why a server identity could not be established.
#[derive(Debug)]
pub enum IdentityError {
    /// A file could not be read or written.
    Io { path: PathBuf, source: io::Error },
    /// Certificate generation failed.
    Generate(rcgen::Error),
    /// The certificate PEM held no `CERTIFICATE` block.
    NoCertificate,
    /// The platform reports no per-user data directory.
    NoDataDir,
}

impl IdentityError {
    fn io(path: impl Into<PathBuf>, source: io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "server identity: {}: {source}", path.display()),
            Self::Generate(e) => write!(f, "server identity: generating a certificate failed: {e}"),
            Self::NoCertificate => {
                write!(
                    f,
                    "server identity: the certificate PEM holds no certificate"
                )
            }
            Self::NoDataDir => write!(
                f,
                "server identity: no per-user data directory on this platform; \
                 pass --cert and --key"
            ),
        }
    }
}

impl std::error::Error for IdentityError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Generate(e) => Some(e),
            Self::NoCertificate | Self::NoDataDir => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fingerprint_is_openssh_formatted_standard_base64() {
        // Pinned against an independently computed digest: the display
        // form is `SHA256:` + unpadded *standard*-alphabet base64 (the
        // `+` and `/` below are exactly what distinguishes it from
        // base64url), 43 characters after the prefix.
        let fingerprint = CertFingerprint::from_cert_der(b"cannet certificate fixture");
        assert_eq!(
            fingerprint.to_string(),
            "SHA256:/9c5GMrPKEb+y88Cz/9IR6C9kgQbs5hYt4Qa3FSat9c"
        );
        let encoded = fingerprint.to_string();
        let encoded = encoded.strip_prefix("SHA256:").unwrap();
        assert_eq!(encoded.len(), 43, "unpadded base64 of 32 bytes");
        assert!(!encoded.contains('='), "no padding");
    }

    #[test]
    fn a_generated_identity_survives_a_restart_with_the_same_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let first = ServerIdentity::load_or_generate(dir.path()).unwrap();
        assert!(dir.path().join(CERT_FILE).is_file());
        assert!(dir.path().join(KEY_FILE).is_file());

        let second = ServerIdentity::load_or_generate(dir.path()).unwrap();
        assert_eq!(
            first.fingerprint(),
            second.fingerprint(),
            "a restart must reload the persisted identity, not mint a new one"
        );
        assert_eq!(first.cert_pem(), second.cert_pem());
        assert_eq!(first.key_pem(), second.key_pem());
    }

    #[test]
    fn a_generated_identity_creates_the_directory_it_needs() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("does").join("not").join("exist");
        let identity = ServerIdentity::load_or_generate(&nested).unwrap();
        assert!(nested.join(CERT_FILE).is_file());
        assert_eq!(
            identity.fingerprint(),
            ServerIdentity::load_or_generate(&nested)
                .unwrap()
                .fingerprint()
        );
    }

    #[test]
    fn the_fingerprint_covers_the_end_entity_certificate_of_a_chain() {
        // Two independent certificates concatenated stand in for a
        // chain: the fingerprint must be the leaf's — the first block —
        // because that is the certificate the client sees.
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        let leaf = ServerIdentity::load_or_generate(dir_a.path()).unwrap();
        let issuer = ServerIdentity::load_or_generate(dir_b.path()).unwrap();

        let mut chain = leaf.cert_pem().to_vec();
        chain.extend_from_slice(issuer.cert_pem());
        let chained = ServerIdentity::from_pem(chain, leaf.key_pem().to_vec()).unwrap();
        assert_eq!(chained.fingerprint(), leaf.fingerprint());
        assert_ne!(chained.fingerprint(), issuer.fingerprint());
    }

    #[test]
    fn operator_material_loads_from_explicit_paths() {
        let dir = tempfile::tempdir().unwrap();
        let generated = ServerIdentity::load_or_generate(dir.path()).unwrap();
        let loaded =
            ServerIdentity::from_files(&dir.path().join(CERT_FILE), &dir.path().join(KEY_FILE))
                .unwrap();
        assert_eq!(loaded.fingerprint(), generated.fingerprint());
    }

    #[test]
    fn a_pem_without_a_certificate_is_an_error() {
        // `ServerIdentity` deliberately has no `Debug` (it holds a
        // private key), so unwrap the error by hand.
        let Err(err) = ServerIdentity::from_pem(b"not a pem".to_vec(), b"neither".to_vec()) else {
            panic!("a PEM with no CERTIFICATE block cannot yield a fingerprint");
        };
        assert!(matches!(err, IdentityError::NoCertificate));
    }

    #[cfg(unix)]
    #[test]
    fn the_key_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir().unwrap();
        ServerIdentity::load_or_generate(dir.path()).unwrap();
        let mode = fs::metadata(dir.path().join(KEY_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "the private key must not be readable by other users"
        );
    }
}

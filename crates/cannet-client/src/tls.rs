//! Certificate-pinned TLS for the client half of ADR 0041.
//!
//! The server is its own certificate authority of one, so there is no
//! chain to validate and no name to match: trust is a 32-byte SHA-256
//! digest of the server's end-entity certificate that the user accepted
//! once and the client compares on every handshake. That is the SSH host
//! key model, and it has the same consequences — a re-issued certificate
//! is a new identity, and an expired one is a non-event.
//!
//! Two things about this module are load-bearing and easy to get wrong:
//!
//! - **Pinning replaces path validation, not signature verification.**
//!   [`PinVerifier`] short-circuits chain building, expiry and hostname
//!   checks, but the TLS handshake signature is still verified by the
//!   crypto provider. Skipping it would let anyone who has seen the
//!   server's (public) certificate replay it and impersonate the server
//!   without holding its private key.
//! - **The verifier fails closed.** A digest that does not match — or a
//!   configuration with nothing pinned yet — aborts the handshake before
//!   a single byte of application data, so no RPC and no bearer token
//!   ever reaches an unverified peer. What the peer presented is
//!   published to the caller through a side channel
//!   ([`PinObservation`]) so a trust-on-first-use prompt can show it;
//!   the connection itself stays refused.

use std::fmt;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine as _;
use hyper_util::rt::TokioIo;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use subtle::ConstantTimeEq as _;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tonic::transport::Uri;

/// The `SHA256:` prefix OpenSSH puts on a host-key fingerprint, and
/// which the server prints at startup.
const DISPLAY_PREFIX: &str = "SHA256:";

/// A pinned server certificate: the SHA-256 digest of its end-entity
/// DER encoding.
///
/// The display form is the one the server prints and the user compares —
/// `SHA256:` followed by unpadded **standard**-alphabet base64, 43
/// characters — and [`CertPin::parse`] reads that same form back, so a
/// pin can round-trip through a settings file or a dialog as text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CertPin([u8; 32]);

impl CertPin {
    /// The pin matching the certificate whose DER encoding is `der`.
    #[must_use]
    pub fn from_cert_der(der: &[u8]) -> Self {
        let digest = ring::digest::digest(&ring::digest::SHA256, der);
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(digest.as_ref());
        Self(bytes)
    }

    /// Read a pin back from its display form (`SHA256:` + unpadded
    /// standard base64). Anything else — a missing prefix, a bad
    /// alphabet, the wrong digest length — is [`PinParseError`].
    pub fn parse(text: &str) -> Result<Self, PinParseError> {
        let encoded = text.strip_prefix(DISPLAY_PREFIX).ok_or(PinParseError)?;
        let bytes = STANDARD_NO_PAD.decode(encoded).map_err(|_| PinParseError)?;
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| PinParseError)?;
        Ok(Self(bytes))
    }

    /// The raw digest bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Display for CertPin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{DISPLAY_PREFIX}{}", STANDARD_NO_PAD.encode(self.0))
    }
}

/// [`CertPin::parse`] was handed something that is not a fingerprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PinParseError;

impl fmt::Display for PinParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("not a `SHA256:` certificate fingerprint")
    }
}

impl std::error::Error for PinParseError {}

/// What a refused handshake saw — the side channel that feeds a
/// trust-on-first-use prompt.
///
/// The verifier publishes this instead of trusting the certificate, so
/// the decision to accept a new identity belongs to the user rather than
/// to any code path in this crate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PinObservation {
    /// The pin the connection was configured with, or `None` when
    /// nothing had been pinned yet — the discriminator between "this
    /// server is new" and "this server changed identity".
    pub expected: Option<CertPin>,
    /// The pin of the certificate the peer actually presented.
    pub observed: CertPin,
}

/// The slot a [`PinVerifier`] writes its [`PinObservation`] into.
///
/// A handshake failure surfaces as an opaque transport error several
/// layers above the verifier, with nothing certificate-shaped left in
/// it; this is how the dialer recovers what was seen.
pub type ObservedPin = Arc<Mutex<Option<PinObservation>>>;

/// A fail-closed [`ServerCertVerifier`] that trusts exactly one
/// certificate, identified by its fingerprint.
///
/// `expected` of `None` is a trust-on-first-use probe: every certificate
/// is refused, and the one that was offered is recorded for the prompt.
#[derive(Debug)]
struct PinVerifier {
    expected: Option<CertPin>,
    provider: Arc<rustls::crypto::CryptoProvider>,
    observed: ObservedPin,
}

impl PinVerifier {
    /// The failure every rejection uses. rustls has no "the pin did not
    /// match" variant, and inventing distinguishable ones would only
    /// tell the peer which part of the check it failed.
    fn refuse(&self, observed: CertPin) -> rustls::Error {
        if let Ok(mut slot) = self.observed.lock() {
            *slot = Some(PinObservation {
                expected: self.expected,
                observed,
            });
        }
        rustls::Error::InvalidCertificate(rustls::CertificateError::ApplicationVerificationFailure)
    }
}

impl ServerCertVerifier for PinVerifier {
    /// Pinning *replaces* path validation: intermediates, validity dates
    /// and the requested name are all deliberately ignored (ADR 0041 —
    /// the certificate is self-signed and long-lived by design). The
    /// digest of the leaf is the whole of the identity check.
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let observed = CertPin::from_cert_der(end_entity);
        let Some(expected) = self.expected else {
            return Err(self.refuse(observed));
        };
        if bool::from(expected.0.ct_eq(&observed.0)) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(self.refuse(observed))
        }
    }

    /// Delegated to the crypto provider, never asserted. The handshake
    /// signature is what proves the peer holds the private key for the
    /// certificate it presented; asserting it valid would make the pin
    /// meaningless, because certificates are public.
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    /// As [`Self::verify_tls12_signature`] — the provider's real
    /// verification, for the same reason.
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// A rustls client configuration that trusts `expected` and nothing
/// else, recording what it saw into `observed` when it refuses.
///
/// ALPN is set here because nothing else does it on this path: tonic
/// negotiates `h2` for the configurations it builds itself, and a
/// hand-supplied connector bypasses that — an h2 client that offers no
/// ALPN gets an HTTP/1.1 server back and fails later, confusingly.
pub(crate) fn pinned_client_config(
    expected: Option<CertPin>,
    observed: ObservedPin,
) -> ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        // Only fails when the provider supports no version at all,
        // which `ring` does not do.
        .expect("the ring provider supports TLS 1.2 and 1.3")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinVerifier {
            expected,
            provider,
            observed,
        }))
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec()];
    config
}

/// Errors a pinned dial can fail with before gRPC is involved.
type ConnectorError = Box<dyn std::error::Error + Send + Sync>;

/// Open one TLS connection to `uri`'s authority under `config`.
async fn connect_pinned(
    uri: Uri,
    config: Arc<ClientConfig>,
) -> Result<TokioIo<tokio_rustls::client::TlsStream<TcpStream>>, ConnectorError> {
    let host = uri.host().ok_or("the server address has no host")?;
    // `Uri` keeps the brackets on an IPv6 literal; neither the resolver
    // nor rustls wants them.
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let port = uri.port_u16().unwrap_or(443);
    let name = ServerName::try_from(host.to_string())?;
    let tcp = TcpStream::connect((host, port)).await?;
    // gRPC is request/response over many small frames; Nagle would add
    // a round trip to each. tonic sets this on the channels it builds.
    tcp.set_nodelay(true)?;
    let stream = TlsConnector::from(config).connect(name, tcp).await?;
    Ok(TokioIo::new(stream))
}

/// The connector type `Endpoint::connect_with_connector` is handed.
/// Boxed because tonic needs the response and future types named, and a
/// `service_fn` over an async block can name neither.
pub(crate) type PinnedConnector = tower::util::BoxCloneService<
    Uri,
    TokioIo<tokio_rustls::client::TlsStream<TcpStream>>,
    ConnectorError,
>;

/// A connector for `Endpoint::connect_with_connector` that terminates
/// TLS against a pinned certificate.
///
/// tonic 0.12's own `ClientTlsConfig` cannot carry a custom certificate
/// verifier, so a pinning client has to bring its own transport: a
/// `tower` service from URI to byte stream, dialled by tonic in place of
/// its built-in connector.
///
/// **The URI handed to this connector must be `http://`,** even though
/// the connection it opens is TLS. tonic wraps every connector in one of
/// its own that intercepts an `https://` URI and insists on terminating
/// TLS with *its* configuration — the one that cannot hold this
/// verifier. The scheme only reaches the wire as h2's `:scheme`
/// pseudo-header, which gRPC does not act on.
pub(crate) fn pinned_connector(
    expected: Option<CertPin>,
    observed: ObservedPin,
) -> PinnedConnector {
    let config = Arc::new(pinned_client_config(expected, observed));
    tower::util::BoxCloneService::new(tower::service_fn(move |uri: Uri| {
        connect_pinned(uri, config.clone())
    }))
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use cannet_core::BusConfig;
    use cannet_server::{install_crypto_provider, ServerIdentity, VirtualBusServerImpl};
    use cannet_wire::proto::{cannet_server_client::CannetServerClient, ListInterfacesRequest};
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;
    use tokio_stream::wrappers::TcpListenerStream;
    use tonic::transport::{Endpoint, Server};

    use super::*;

    /// A TLS-terminating virtual-bus endpoint presenting `identity`, on
    /// an ephemeral loopback port.
    async fn spawn_tls_server(identity: &ServerIdentity) -> (SocketAddr, JoinHandle<()>) {
        install_crypto_provider();
        let tls = identity.tls_config();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let stream = TcpListenerStream::new(listener);
        let service = VirtualBusServerImpl::new(BusConfig::classic_500k()).into_service();
        let handle = tokio::spawn(async move {
            let _ = Server::builder()
                .tls_config(tls)
                .unwrap()
                .add_service(service)
                .serve_with_incoming(stream)
                .await;
        });
        (addr, handle)
    }

    /// A freshly generated server identity, and the directory holding
    /// it (which must outlive the identity's use).
    fn generate_identity() -> (ServerIdentity, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let identity = ServerIdentity::load_or_generate(dir.path()).unwrap();
        (identity, dir)
    }

    /// Dial `addr` with `pin` pinned, reporting either the channel or
    /// what the verifier saw.
    async fn dial(
        addr: SocketAddr,
        pin: Option<CertPin>,
    ) -> Result<tonic::transport::Channel, Option<PinObservation>> {
        let observed: ObservedPin = Arc::new(Mutex::new(None));
        Endpoint::from_shared(format!("http://localhost:{}", addr.port()))
            .unwrap()
            .connect_with_connector(pinned_connector(pin, observed.clone()))
            .await
            .map_err(|_| *observed.lock().unwrap())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_pinned_client_completes_a_handshake_and_an_rpc() {
        // The spike: tonic's own `ClientTlsConfig` cannot carry a custom
        // verifier, so this proves a hand-supplied connector negotiates
        // h2 over TLS and carries a real RPC.
        let (identity, _dir) = generate_identity();
        let (addr, server) = spawn_tls_server(&identity).await;
        let pin = CertPin::parse(&identity.fingerprint().to_string()).unwrap();

        let channel = dial(addr, Some(pin))
            .await
            .expect("the server's own fingerprint must satisfy the pin");
        let interfaces = CannetServerClient::new(channel)
            .list_interfaces(ListInterfacesRequest {})
            .await
            .expect("ALPN must have negotiated h2, or the RPC never lands")
            .into_inner();
        assert_eq!(interfaces.interfaces.len(), 1);

        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_wrong_pin_refuses_the_handshake_and_reports_what_it_saw() {
        let (identity, _dir) = generate_identity();
        let (other, _other_dir) = generate_identity();
        let (addr, server) = spawn_tls_server(&identity).await;
        let wrong = CertPin::parse(&other.fingerprint().to_string()).unwrap();

        let Err(observation) = dial(addr, Some(wrong)).await else {
            panic!("a certificate that is not the pinned one must be refused");
        };
        let observation = observation.expect("the verifier must publish what it saw");
        assert_eq!(
            observation.expected,
            Some(wrong),
            "a mismatch is distinguishable from a first contact by carrying the pin it had"
        );
        assert_eq!(
            observation.observed.to_string(),
            identity.fingerprint().to_string(),
            "the fingerprint offered to the user must be the one the server presented"
        );

        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_unpinned_probe_refuses_the_handshake_and_reports_a_first_contact() {
        let (identity, _dir) = generate_identity();
        let (addr, server) = spawn_tls_server(&identity).await;

        let Err(observation) = dial(addr, None).await else {
            panic!("nothing is pinned, so nothing may be trusted");
        };
        let observation = observation.expect("the verifier must publish what it saw");
        assert_eq!(
            observation.expected, None,
            "`None` is what tells a dialog to say `new server` rather than `identity changed`"
        );
        assert_eq!(
            observation.observed.to_string(),
            identity.fingerprint().to_string()
        );

        server.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_certificate_presented_without_its_key_is_refused() {
        // The falsification test for the signature delegation. The
        // server presents certificate A — so the fingerprint the client
        // pinned matches exactly — but signs the handshake with an
        // unrelated key B. `with_single_cert` does not check that a
        // certificate and a key belong together, so this configuration
        // starts and serves.
        //
        // Nothing but real signature verification can reject it. A
        // verifier that asserted `HandshakeSignatureValid` would accept
        // this connection, and with it anyone who has ever seen the
        // server's (public) certificate.
        let (cert_a, _dir_a) = generate_identity();
        let (key_b, _dir_b) = generate_identity();
        let impostor =
            ServerIdentity::from_pem(cert_a.cert_pem().to_vec(), key_b.key_pem().to_vec()).unwrap();
        assert_eq!(
            impostor.fingerprint().to_string(),
            cert_a.fingerprint().to_string(),
            "the impostor presents the very certificate the client pinned"
        );
        let (addr, server) = spawn_tls_server(&impostor).await;
        let pin = CertPin::parse(&cert_a.fingerprint().to_string()).unwrap();

        let Err(observation) = dial(addr, Some(pin)).await else {
            panic!("a peer that cannot sign for the certificate it presents is not the server");
        };
        assert_eq!(
            observation, None,
            "the pin itself matched: the handshake died at the signature, not at the digest"
        );

        server.abort();
    }

    #[test]
    fn a_pin_displays_the_way_the_server_prints_it() {
        // The same fixture the server's fingerprint test pins, because
        // the two strings have to be comparable by eye and by `==`.
        let pin = CertPin::from_cert_der(b"cannet certificate fixture");
        assert_eq!(
            pin.to_string(),
            "SHA256:/9c5GMrPKEb+y88Cz/9IR6C9kgQbs5hYt4Qa3FSat9c"
        );
    }

    #[test]
    fn a_pin_round_trips_through_its_display_form() {
        // A stored pin is text in a settings file; it has to come back
        // as the same 32 bytes.
        let pin = CertPin::from_cert_der(b"cannet certificate fixture");
        assert_eq!(CertPin::parse(&pin.to_string()).unwrap(), pin);
    }

    #[test]
    fn a_pin_that_is_not_a_fingerprint_is_refused() {
        for text in [
            "",
            "/9c5GMrPKEb+y88Cz/9IR6C9kgQbs5hYt4Qa3FSat9c", // no prefix
            "SHA256:not base64!",
            "SHA256:c2hvcnQ", // right alphabet, wrong length
            "SHA1:/9c5GMrPKEb+y88Cz/9IR6C9kgQbs5hYt4Qa3FSat9c",
        ] {
            assert_eq!(
                CertPin::parse(text),
                Err(PinParseError),
                "{text:?} must not parse as a pin"
            );
        }
    }
}

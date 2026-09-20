//! `ServerInfo`: what this server is, answered before anything is asked
//! of it (ADR 0059).
//!
//! One unary RPC in the unversioned `cannet` package, served by every
//! mode this binary has. It states the protocol packages the server
//! serves — today exactly [`cannet_wire::PROTOCOL_PACKAGE`] — so a
//! client that speaks a different major is told so in a sentence
//! instead of discovering it as an `UNIMPLEMENTED` on its first real
//! call.
//!
//! **Unauthenticated**, and that is the point: ADR 0041's bearer token
//! gates every other RPC, and a client that cannot speak to this server
//! at all must not first be told its token is wrong. Nothing here is a
//! disclosure — the mDNS advertisement (ADR 0040) already puts the
//! instance name, the build version and the package list on the local
//! network. The proxy mode therefore gates its *service*, not its
//! endpoint; [`crate::auth::gated`] is the wrapper every other service
//! goes through.

use cannet_wire::info::cannet_info_server::{CannetInfo, CannetInfoServer};
use cannet_wire::info::{ServerInfoRequest, ServerInfoResponse};
use cannet_wire::PROTOCOL_PACKAGE;

/// The answer this server gives, fixed at startup.
///
/// The package list is not configurable: a server serves the packages
/// it implements, and this workspace implements one. A second major
/// would be a second service compiled in, and would add its own name
/// here at the same time.
#[derive(Debug, Clone)]
pub struct ServerInfoImpl {
    version: String,
    instance_name: String,
}

impl ServerInfoImpl {
    /// `version` is the build string — `git describe`, the same value
    /// `--version` prints and the mDNS `ver=` key carries.
    /// `instance_name` is `--name` / the machine's hostname, or empty
    /// for a mode that has no name (the `debug` servers, which do not
    /// advertise).
    #[must_use]
    pub fn new(version: impl Into<String>, instance_name: impl Into<String>) -> Self {
        Self {
            version: version.into(),
            instance_name: instance_name.into(),
        }
    }

    /// The tonic service, ready for `Server::add_service`.
    #[must_use]
    pub fn into_service(self) -> CannetInfoServer<Self> {
        CannetInfoServer::new(self)
    }

    /// The packages this build serves, in the form the TXT record and
    /// the RPC both publish. One source, so `proto=` and `ServerInfo`
    /// cannot disagree about what this server speaks.
    #[must_use]
    pub fn packages() -> Vec<String> {
        vec![PROTOCOL_PACKAGE.to_string()]
    }
}

#[tonic::async_trait]
impl CannetInfo for ServerInfoImpl {
    async fn server_info(
        &self,
        _request: tonic::Request<ServerInfoRequest>,
    ) -> Result<tonic::Response<ServerInfoResponse>, tonic::Status> {
        Ok(tonic::Response::new(ServerInfoResponse {
            packages: Self::packages(),
            version: self.version.clone(),
            instance_name: self.instance_name.clone(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_answer_names_the_package_this_build_speaks() {
        let info = ServerInfoImpl::new("v0.10.0-3-gabc1234", "bench");
        let answer = info
            .server_info(tonic::Request::new(ServerInfoRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(answer.packages, vec!["cannet.v1".to_string()]);
        assert_eq!(answer.version, "v0.10.0-3-gabc1234");
        assert_eq!(answer.instance_name, "bench");
    }

    #[test]
    fn the_txt_key_and_the_rpc_publish_the_same_list() {
        // `proto=` is advisory and `ServerInfo` is the gate, but a row
        // greyed out by one and accepted by the other would be a bug
        // nobody could explain. Both read this.
        assert_eq!(ServerInfoImpl::packages(), vec![PROTOCOL_PACKAGE]);
    }
}

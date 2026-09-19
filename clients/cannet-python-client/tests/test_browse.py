"""What one `_cannet._tcp` advertisement reduces to.

The browse itself binds a multicast socket, so it is not exercised
here: what is worth testing is the arithmetic around it, above all
which of the addresses an instance announces is the one to dial. A
responder answers on every interface it has, so a single server arrives
with its VM adapter, its link-local address and its loopback address
mixed in with the one that actually reaches it.
"""

from __future__ import annotations

import socket

from zeroconf import ServiceInfo

from cannet_python_client import browse


def info(
    name: str = "bench",
    addresses: list[str] | None = None,
    *,
    server: str = "bench.local.",
    properties: dict[str, str] | None = None,
    port: int = 50051,
) -> ServiceInfo:
    packed = [
        socket.inet_pton(socket.AF_INET6 if ":" in a else socket.AF_INET, a)
        for a in (addresses if addresses is not None else ["192.168.1.10"])
    ]
    return ServiceInfo(
        browse.SERVICE_TYPE,
        f"{name}.{browse.SERVICE_TYPE}",
        addresses=packed,
        port=port,
        server=server,
        properties=properties or {},
    )


def test_an_advertisement_becomes_a_row_the_connect_path_can_take_verbatim() -> None:
    server = browse.discovered(info(properties={"ver": "0.4.0"}))
    assert server == browse.DiscoveredServer(
        name="bench",
        address="192.168.1.10:50051",
        host="bench.local",
        version="0.4.0",
    )


def test_a_routable_address_outranks_the_loopback_one_the_server_also_announces() -> (
    None
):
    # Dialling a remote server's advertised `127.0.0.1` would silently
    # reach this machine instead.
    server = browse.discovered(info(addresses=["127.0.0.1", "192.168.1.10"]))
    assert server is not None
    assert server.address == "192.168.1.10:50051"


def test_ipv4_outranks_ipv6_and_ipv6_outranks_loopback() -> None:
    assert browse.dial_address(["2001:db8::1", "192.168.1.10"], 50051) == (
        "192.168.1.10:50051"
    )
    assert browse.dial_address(["::1", "2001:db8::1"], 50051) == "[2001:db8::1]:50051"
    assert browse.dial_address(["::1"], 50051) == "[::1]:50051"


def test_an_ipv6_link_local_address_is_not_dialable_at_all() -> None:
    # Unusable without the scope identifier, which does not survive into
    # a `host:port` string.
    assert browse.dial_address(["fe80::1"], 50051) is None
    assert browse.dial_address(["0.0.0.0"], 50051) is None


def test_an_instance_with_no_dialable_address_is_not_a_row() -> None:
    assert browse.discovered(info(addresses=["fe80::1"])) is None


def test_a_responder_that_published_no_host_name_has_none_to_show() -> None:
    server = browse.discovered(info(server=""))
    assert server is not None
    assert server.host is None
    assert server.version is None

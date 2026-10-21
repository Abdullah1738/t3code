#!/usr/bin/env python3
"""offbox-person-socks: the destination filter and the SOCKS5 relay, against local sockets only."""

import asyncio
import importlib.machinery
import importlib.util
import socket
import struct
import unittest
from pathlib import Path
from unittest import mock

SRC = Path(__file__).resolve().parent.parent / "bin" / "offbox-person-socks"
_loader = importlib.machinery.SourceFileLoader("offbox_person_socks", str(SRC))
_spec = importlib.util.spec_from_loader(_loader.name, _loader)
socks = importlib.util.module_from_spec(_spec)
_loader.exec_module(socks)


class BlockedTest(unittest.TestCase):
    def test_private_and_special_ranges_are_blocked(self):
        for a in ("127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1", "100.101.102.103",
                  "169.254.169.254", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fd7a:115c:a1e0::1",
                  "fe80::1%en0", "ff02::1", "::ffff:127.0.0.1", "::ffff:192.168.1.1"):
            self.assertTrue(socks.blocked(a), a)

    def test_public_addresses_pass(self):
        for a in ("1.1.1.1", "34.117.59.81", "2606:4700:4700::1111", "::ffff:8.8.8.8"):
            self.assertFalse(socks.blocked(a), a)


def socks_request(port: int, host: bytes, dport: int, atyp: int = 3) -> tuple[int, socket.socket]:
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    s.sendall(b"\x05\x01\x00")
    assert s.recv(2) == b"\x05\x00"
    addr = bytes([len(host)]) + host if atyp == 3 else host
    s.sendall(bytes([5, 1, 0, atyp]) + addr + struct.pack("!H", dport))
    rep = s.recv(10)
    return rep[1], s


class RelayTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.server = await asyncio.start_server(socks.handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def request(self, *a, **kw):
        return await asyncio.to_thread(socks_request, self.port, *a, **kw)

    async def test_loopback_by_name_and_address_is_refused(self):
        for host, atyp in ((b"localhost", 3), (socket.inet_aton("127.0.0.1"), 1), (b"10.0.0.1", 3),
                           (b"100.100.100.100", 3)):
            code, s = await self.request(host, 80, atyp)
            s.close()
            self.assertEqual(code, socks.NOT_ALLOWED, host)

    async def test_udp_associate_is_rejected(self):
        def udp():
            s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
            s.sendall(b"\x05\x01\x00")
            s.recv(2)
            s.sendall(b"\x05\x03\x00\x01" + socket.inet_aton("1.1.1.1") + struct.pack("!H", 53))
            code = s.recv(10)[1]
            s.close()
            return code
        self.assertEqual(await asyncio.to_thread(udp), socks.BAD_COMMAND)

    async def test_allowed_destination_is_relayed_both_ways(self):
        async def echo(r, w):
            w.write(b"echo:" + await r.read(5))
            await w.drain()
            w.close()
        upstream = await asyncio.start_server(echo, "127.0.0.1", 0)
        uport = upstream.sockets[0].getsockname()[1]

        def talk():
            code, s = socks_request(self.port, b"127.0.0.1", uport)
            s.sendall(b"hello")
            data = s.recv(100)
            s.close()
            return code, data
        # Loopback stands in for a public host here; the filter itself is covered above.
        with mock.patch.object(socks, "blocked", return_value=False):
            code, data = await asyncio.to_thread(talk)
        upstream.close()
        self.assertEqual(code, socks.OK)
        self.assertEqual(data, b"echo:hello")


if __name__ == "__main__":
    unittest.main()

"""Offline cancellation of preparation keepalive requests, including before response headers."""
import io
import socket
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, lease, runs
from offbox_lib.common import OffboxError
from test_capacity import Isolated


class RequestCancellationTests(Isolated):
    def test_partial_status_timeout_does_not_stop_keeper_renewal(self):
        peers = [socket.socketpair() for _ in range(2)]
        for pair in peers:
            for sock in pair:
                self.addCleanup(sock.close)
        peers[0][1].sendall(b'HTTP/1.1 20')
        body = b'{"sandbox":{"state":"running"}}'
        peers[1][1].sendall(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
        connections = iter(pair[0] for pair in peers)
        refreshed, stop = threading.Event(), threading.Event()
        errors = []
        scope = api.RequestScope(0.1)

        def connect(connection):
            connection.sock = next(connections)

        def renew(*args):
            refreshed.set()
            return True

        def keeper():
            with scope.active():
                try:
                    runs._ttl_keeper('box', stop)
                except BaseException as error:
                    errors.append(error)

        with patch.object(api, 'API', 'http://boat.invalid'), \
                patch.object(api, '_key', return_value='offline'), \
                patch.object(api.urllib.request, 'getproxies', return_value={}), \
                patch.object(api._HTTPConnection, 'connect', connect), \
                patch.object(lease, 'ensure_ttl', side_effect=renew), \
                patch.object(runs, 'TTL_RETRY_S', 0.01):
            worker = threading.Thread(target=keeper)
            worker.start()
            try:
                self.assertTrue(refreshed.wait(0.8), f'keeper stopped renewing: {errors}')
                self.assertTrue(worker.is_alive())
                self.assertEqual(errors, [])
            finally:
                stop.set()
                scope.cancel()
                worker.join(1)
            self.assertFalse(worker.is_alive())

    def test_request_deadline_and_cancel_wake_header_read(self):
        for cancel in (False, True):
            with self.subTest(cancel=cancel):
                reader, writer = socket.socketpair()
                self.addCleanup(reader.close)
                self.addCleanup(writer.close)
                sent, rescued = threading.Event(), threading.Event()
                scope = api.RequestScope(5 if cancel else 0.15)

                def connect(connection):
                    connection.sock = reader

                def reply():
                    writer.recv(8192)
                    writer.sendall(b'HTTP/1.1 200 OK\r\nContent-Len')
                    sent.set()
                    if cancel:
                        scope.cancel()

                def rescue():
                    rescued.set()
                    writer.close()

                responder = threading.Thread(target=reply)
                timer = threading.Timer(1.2, rescue)
                with patch.object(api, 'API', 'http://boat.invalid'), \
                        patch.object(api, '_key', return_value='offline'), \
                        patch.object(api.urllib.request, 'getproxies', return_value={}), \
                        patch.object(api._HTTPConnection, 'connect', connect), scope.active():
                    responder.start()
                    timer.start()
                    started = time.monotonic()
                    try:
                        with self.assertRaises(OffboxError):
                            api.get('box')
                        self.assertTrue(sent.is_set())
                        self.assertLess(time.monotonic() - started, 0.8)
                        self.assertFalse(rescued.is_set())
                    finally:
                        scope.cancel()
                        writer.close()
                        timer.cancel()
                        timer.join()
                        responder.join(1)
                    self.assertFalse(responder.is_alive())

    def test_cancelled_connect_cannot_send_a_late_patch(self):
        reader, writer = socket.socketpair()
        self.addCleanup(reader.close)
        self.addCleanup(writer.close)
        connected, release = threading.Event(), threading.Event()
        scope = api.RequestScope(5)
        errors = []

        def connect(connection):
            connected.set()
            if not release.wait(2):
                raise AssertionError('connection not released')
            connection.sock = reader

        def patch_ttl():
            with scope.active():
                try:
                    api.set_ttl('box', 1200)
                except OffboxError as error:
                    errors.append(error)

        with patch.object(api, 'API', 'http://boat.invalid'), \
                patch.object(api, '_key', return_value='offline'), \
                patch.object(api.urllib.request, 'getproxies', return_value={}), \
                patch.object(api._HTTPConnection, 'connect', connect):
            worker = threading.Thread(target=patch_ttl)
            worker.start()
            try:
                self.assertTrue(connected.wait(1))
                scope.cancel()
                release.set()
                worker.join(1)
                self.assertFalse(worker.is_alive())
                self.assertEqual(len(errors), 1)
                self.assertIn('cancelled', str(errors[0]))
                self.assertEqual(writer.recv(8192), b'', 'cancelled worker sent a late PATCH')
            finally:
                scope.cancel()
                release.set()
                worker.join(1)

    def test_request_timeout_does_not_cancel_future_refreshes_or_other_threads(self):
        scope = api.RequestScope(0.05)

        def expire(*args, **kwargs):
            self.assertTrue(api._REQUEST_SCOPE.get().stopped.wait(1))
            return io.BytesIO(b'{}')

        with patch.object(api, '_key', return_value='offline'), scope.active():
            with patch.object(api, '_open', side_effect=expire):
                with self.assertRaises(OffboxError):
                    api.get('box')
            self.assertFalse(scope.stopped.is_set())
            with patch.object(api, '_open', return_value=io.BytesIO(b'{"sandbox":{"state":"running"}}')):
                self.assertEqual(api.get('box'), {'state': 'running'})
        self.assertIsNone(api._REQUEST_SCOPE.get())


if __name__ == '__main__':
    unittest.main()

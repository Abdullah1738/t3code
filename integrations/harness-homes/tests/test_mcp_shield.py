"""mcp_shield.py: forwards to a healthy server, degrades instead of failing init."""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
SHIELD = PKG / "antigravity" / "mcp_shield.py"

FAKE_STDIO = textwrap.dedent("""
    import json, sys
    for line in sys.stdin:
        msg = json.loads(line)
        if "id" not in msg:
            continue
        if msg["method"] == "initialize":
            if len(sys.argv) > 1 and sys.argv[1] == "crash":
                sys.exit(4)
            result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "fake"}}
        elif msg["method"] == "tools/list":
            result = {"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}
        elif msg["method"] == "tools/call":
            if len(sys.argv) > 1 and sys.argv[1] == "die-on-call":
                sys.exit(5)
            result = {"content": [{"type": "text", "text": msg["params"]["arguments"]["text"]}]}
        else:
            result = {}
        print("log noise on stdout")
        print(json.dumps({"level": "info", "message": "structured log"}))
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}), flush=True)
""")

INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t"}}}
LIST = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
CALL = {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "echo", "arguments": {"text": "hi"}}}


def run_shield_raw(args, messages, env=None, timeout=30):
    tmp = tempfile.mkdtemp()
    data = "".join(json.dumps(m) + "\n" for m in messages)
    out = subprocess.run([sys.executable, str(SHIELD), *args], input=data, capture_output=True, text=True,
                         timeout=timeout, env={**os.environ, "MCP_SHIELD_LOG": os.path.join(tmp, "log"), **(env or {})})
    return [json.loads(line) for line in out.stdout.splitlines()]


def run_shield(args, messages, env=None, timeout=30):
    tmp = tempfile.mkdtemp()
    data = "".join(json.dumps(m) + "\n" for m in messages)
    out = subprocess.run([sys.executable, str(SHIELD), *args], input=data, capture_output=True, text=True,
                         timeout=timeout, env={**os.environ, "MCP_SHIELD_LOG": os.path.join(tmp, "log"), **(env or {})})
    replies = {}
    for line in out.stdout.splitlines():
        msg = json.loads(line)  # every stdout line must be JSON
        replies[msg.get("id")] = msg
    return replies


class StdioTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.server = self.tmp / "server.py"
        self.server.write_text(FAKE_STDIO)

    def test_forwards_a_healthy_server_and_drops_stdout_noise(self):
        lines = run_shield_raw(["--name", "fake", "--", sys.executable, str(self.server)], [INIT, LIST, CALL])
        # Review of 3e27b87ce3: JSON logs are not protocol messages and must not reach the client.
        self.assertTrue(all(m.get("jsonrpc") == "2.0" and "id" in m for m in lines), lines)
        r = run_shield(["--name", "fake", "--", sys.executable, str(self.server)], [INIT, LIST, CALL])
        self.assertEqual(r[1]["result"]["serverInfo"]["name"], "fake")
        self.assertEqual([t["name"] for t in r[2]["result"]["tools"]], ["echo"])
        self.assertEqual(r[3]["result"]["content"][0]["text"], "hi")

    def test_a_server_that_crashes_on_init_degrades(self):
        r = run_shield(["--name", "fake", "--", sys.executable, str(self.server), "crash"], [INIT, LIST, CALL])
        self.assertEqual(r[1]["result"]["serverInfo"]["name"], "fake-unavailable")
        self.assertIn("unavailable", r[1]["result"]["instructions"])
        self.assertEqual(r[2]["result"]["tools"], [])
        self.assertTrue(r[3]["result"]["isError"])

    def test_a_missing_binary_degrades(self):
        r = run_shield(["--name", "gone", "--", "/nonexistent/server"], [INIT, LIST])
        self.assertEqual(r[1]["result"]["serverInfo"]["name"], "gone-unavailable")
        self.assertEqual(r[2]["result"]["tools"], [])

    def test_a_server_that_dies_mid_call_answers_the_call(self):
        r = run_shield(["--name", "fake", "--", sys.executable, str(self.server), "die-on-call"], [INIT, LIST, CALL])
        self.assertEqual(len(r[2]["result"]["tools"]), 1)
        self.assertTrue(r[3]["result"]["isError"])

    def test_a_server_that_never_answers_init_times_out(self):
        hang = self.tmp / "hang.py"
        hang.write_text("import time\ntime.sleep(60)\n")
        r = run_shield(["--name", "slow", "--init-timeout", "1", "--", sys.executable, str(hang)], [INIT, LIST])
        self.assertEqual(r[1]["result"]["serverInfo"]["name"], "slow-unavailable")


class Handler(BaseHTTPRequestHandler):
    sessions = set()
    status = 200

    def log_message(self, *args):
        pass

    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.status != 200:
            self.send_response(self.status)
            self.end_headers()
            return
        if msg.get("method") == "initialize":
            Handler.sessions.add("s1")
            body = {"jsonrpc": "2.0", "id": msg["id"], "result": {"protocolVersion": "2025-06-18",
                                                                   "capabilities": {"tools": {}}, "serverInfo": {"name": "web"}}}
            self.send_response(200)
            self.send_header("Mcp-Session-Id", "s1")
            self.send_header("Content-Type", "application/json")
            data = json.dumps(body).encode()
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if "id" not in msg:
            self.send_response(202)
            self.end_headers()
            return
        assert self.headers.get("Mcp-Session-Id") == "s1"
        result = {"tools": [{"name": "web_tool", "inputSchema": {"type": "object"}}]} if msg["method"] == "tools/list" else {
            "content": [{"type": "text", "text": "web says hi"}]}
        event = f"event: message\ndata: {json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': result})}\n\n".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(event)))
        self.end_headers()
        self.wfile.write(event)


class HttpTests(unittest.TestCase):
    def serve(self, status=200):
        handler = type("H", (Handler,), {"status": status})
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}/mcp"

    def test_forwards_json_and_sse_replies_with_the_session(self):
        url = self.serve()
        initialized = {"jsonrpc": "2.0", "method": "notifications/initialized"}
        r = run_shield(["--name", "web", "--url", url], [INIT, initialized, LIST, CALL])
        self.assertEqual(r[1]["result"]["serverInfo"]["name"], "web")
        self.assertEqual(r[2]["result"]["tools"][0]["name"], "web_tool")
        self.assertEqual(r[3]["result"]["content"][0]["text"], "web says hi")

    def test_redirects_are_refused_and_never_carry_the_bearer(self):
        # Review of 3e27b87ce3: urllib forwarded Authorization across origins on redirect.
        seen = []

        class Catch(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                seen.append(self.headers.get("Authorization"))
                self.send_response(500)
                self.end_headers()

        catcher = ThreadingHTTPServer(("127.0.0.1", 0), Catch)
        threading.Thread(target=catcher.serve_forever, daemon=True).start()
        self.addCleanup(catcher.shutdown)
        elsewhere = f"http://127.0.0.1:{catcher.server_address[1]}/steal"

        class Redirect(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.send_response(307)
                self.send_header("Location", elsewhere)
                self.end_headers()

        origin = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        threading.Thread(target=origin.serve_forever, daemon=True).start()
        self.addCleanup(origin.shutdown)
        tmp = Path(tempfile.mkdtemp())
        fake_security = tmp / "security"
        fake_security.write_text("#!/bin/sh\necho test-bearer-value\n")
        fake_security.chmod(0o755)
        r = run_shield(["--name", "web", "--url", f"http://127.0.0.1:{origin.server_address[1]}/mcp",
                        "--bearer-keychain", "svc"], [INIT, LIST],
                       env={"MCP_SHIELD_SECURITY": str(fake_security)})
        self.assertEqual(r[1]["result"]["serverInfo"]["name"], "web-unavailable")
        self.assertEqual(seen, [])

    def test_heartbeats_cannot_hold_initialize_past_its_deadline(self):
        class Heartbeat(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                try:
                    for _ in range(100):
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        time.sleep(0.1)
                except OSError:
                    pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Heartbeat)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        started = time.monotonic()
        r = run_shield(["--name", "slow", "--url", f"http://127.0.0.1:{server.server_address[1]}/mcp",
                        "--init-timeout", "1"], [INIT, LIST])
        self.assertLess(time.monotonic() - started, 6)
        self.assertEqual(r[1]["result"]["serverInfo"]["name"], "slow-unavailable")

    def trickle_server(self, content_type, prefix):
        # Review of 5a93cd767e: bytes that never finish a buffer or a line kept resetting the
        # socket timeout, so reads blocked past the deadline.
        class Trickle(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", "100000")
                self.end_headers()
                try:
                    self.wfile.write(prefix)
                    self.wfile.flush()
                    for _ in range(200):
                        self.wfile.write(b"x")
                        self.wfile.flush()
                        time.sleep(0.05)
                except OSError:
                    pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Trickle)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}/mcp"

    def test_a_trickled_body_or_partial_sse_line_cannot_outlive_the_deadline(self):
        for content_type, prefix in (("application/json", b'{"jsonrpc":"2.0","id":1,"result":"'),
                                     ("text/event-stream", b"data: {")):
            with self.subTest(content_type=content_type):
                started = time.monotonic()
                r = run_shield(["--name", "slow", "--url", self.trickle_server(content_type, prefix),
                                "--init-timeout", "1"], [INIT, LIST])
                self.assertLess(time.monotonic() - started, 5)
                self.assertEqual(r[1]["result"]["serverInfo"]["name"], "slow-unavailable")
                self.assertEqual(r[2]["result"]["tools"], [])

    def test_slow_headers_cannot_pile_up_workers(self):
        # Review of 8ca5540d61: a server trickling an unfinished header kept open() blocked, so
        # the deadline had no socket to shut down and every timed-out call left a worker behind.
        import socket as socket_module
        sys.path.insert(0, str(SHIELD.parent))
        import mcp_shield
        listener = socket_module.create_server(("127.0.0.1", 0))
        self.addCleanup(listener.close)

        open_conns = []

        def trickle(conn):
            open_conns.append(conn)
            try:
                conn.recv(65536)
                conn.sendall(b"HTTP/1.1 200 OK\r\nX-Slow: ")
                for _ in range(400):
                    conn.sendall(b"x")
                    time.sleep(0.05)
            except OSError:
                pass
            finally:
                open_conns.remove(conn)
                conn.close()

        def accept():
            while True:
                try:
                    conn, _ = listener.accept()
                except OSError:
                    return
                threading.Thread(target=trickle, args=(conn,), daemon=True).start()

        threading.Thread(target=accept, daemon=True).start()
        upstream = mcp_shield.HttpUpstream("slowhdr", f"http://127.0.0.1:{listener.getsockname()[1]}/mcp", None, 0.3)
        for _ in range(8):
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                upstream.post(INIT, 0.3)
            self.assertLess(time.monotonic() - started, 2)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            left = [t for t in threading.enumerate() if t.name == "mcp-shield-post-slowhdr"]
            if not left and not open_conns:
                break
            time.sleep(0.05)
        self.assertEqual(left, [])
        self.assertEqual(open_conns, [])  # the server saw every timed-out connection close

    def test_a_late_worker_cannot_replace_a_newer_session(self):
        # Review of 8ca5540d61: a worker finishing after a re-initialize overwrote the new session.
        sys.path.insert(0, str(SHIELD.parent))
        import mcp_shield
        release = threading.Event()

        class Late(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                release.wait(5)
                data = json.dumps({"jsonrpc": "2.0", "id": msg.get("id"), "result": {}}).encode()
                self.send_response(200)
                self.send_header("Mcp-Session-Id", "stale")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Late)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_address[1]}/mcp"
        for abandoned in (False, True):
            with self.subTest(abandoned=abandoned):
                release.clear()
                upstream = mcp_shield.HttpUpstream("late", url, None, 5)
                upstream.session_id = "old"
                box = {}

                def call():
                    try:
                        box["value"] = upstream.post(LIST, 0.3 if abandoned else 5)
                    except TimeoutError:
                        box["timeout"] = True

                caller = threading.Thread(target=call)
                caller.start()
                time.sleep(0.5 if abandoned else 0.2)
                with upstream._lock:
                    upstream.session_id = "fresh"  # a re-initialize published a new session
                release.set()
                caller.join(5)
                time.sleep(0.3)
                self.assertEqual(upstream.session_id, "fresh")
                self.assertEqual("timeout" in box, abandoned)
        fresh = mcp_shield.HttpUpstream("late", url, None, 5)
        release.set()
        fresh.post(INIT, 5)
        self.assertEqual(fresh.session_id, "stale")  # an unchanged session still takes the reply's id

    def test_unauthorized_degrades(self):
        r = run_shield(["--name", "web", "--url", self.serve(401)], [INIT, LIST])
        self.assertIn("unauthorized", r[1]["result"]["instructions"])
        self.assertEqual(r[2]["result"]["tools"], [])

    def test_unreachable_degrades(self):
        r = run_shield(["--name", "dead", "--url", "http://127.0.0.1:9/mcp", "--init-timeout", "2"], [INIT, LIST])
        self.assertEqual(r[1]["result"]["serverInfo"]["name"], "dead-unavailable")

    def test_missing_keychain_token_degrades_without_contacting_the_server(self):
        r = run_shield(["--name", "bs", "--url", "http://127.0.0.1:9/mcp", "--bearer-keychain",
                        "harness-homes-test-no-such-item"], [INIT, LIST, CALL])
        self.assertIn("no API token in Keychain", r[1]["result"]["instructions"])
        self.assertTrue(r[3]["result"]["isError"])


if __name__ == "__main__":
    unittest.main()

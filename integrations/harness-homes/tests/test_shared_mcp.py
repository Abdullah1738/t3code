"""Shared endpoints, migration safety, and health probe behavior."""
import concurrent.futures
import json
import plistlib
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

PKG = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PKG / "shared"))
sys.path.insert(0, str(PKG))
import generate_homes as gh
import opencode
import check
import serve


class SharedMcpTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((PKG / "manifest.json").read_text())
        self.entries = opencode.remote_entries(self.manifest)

    def test_all_harnesses_keep_ids_and_use_remote_transports(self):
        servers = self.manifest["mcpServers"]
        claude = gh.claude_mcp(servers)
        for name, port in (("flighty", 18766), ("inbody", 18767)):
            url = f"http://127.0.0.1:{port}/mcp"
            self.assertEqual(claude[name], {"type": "http", "url": url, "timeout": 120000})
            self.assertEqual(self.entries[name], {"type": "remote", "url": url, "timeout": 120000})
            for harness in ("codex", "codex-cu"):
                cfg = gh.codex_config(self.manifest, "/tmp/harness-fixture", None, harness)
                self.assertEqual(cfg["mcp_servers"][name],
                                 {"url": url, "startup_timeout_sec": 30, "tool_timeout_sec": 120})
        self.assertEqual(claude["cua-driver"]["args"], ["mcp"])
        self.assertEqual(set(claude), {s["id"] for s in servers})
        for name in self.entries:
            self.assertEqual(gh.native_mcp_view(next(s for s in servers if s["id"] == name)),
                             {k: v for k, v in gh.opencode_mcp_view(self.entries[name]).items() if k != "enabled"})

    def test_jsonc_migration_preserves_unrelated_text_and_values(self):
        for old in ({"type": "local", "command": ["uv", "x"], "environment": {"KEY": "private"}},
                    {"type": "remote", "url": "http://old", "enabled": False}):
            with self.subTest(old=old):
                text = ('\ufeff{ // top comment\n "unrelated": [ {"mcp": {"flighty": "untouched"}}, 2 ],\n'
                        ' "mcp": {"flighty": ' + json.dumps(old) + ', /* keep */\n'
                        ' "other": {"command": ["a", "]", "{\\\""], "enabled": true},\n'
                        ' "inbody": {"type": "local", "command": ["inbody"],},},\n'
                        ' "literal": "// not a comment /* still a string */",}\n')
                result = opencode.patch(text, self.entries)
                self.assertTrue(result.startswith('\ufeff{ // top comment'))
                self.assertIn('/* keep */', result)
                self.assertIn('"other": {"command": ["a", "]", "{\\\""], "enabled": true}', result)
                parsed = gh.loads_jsonc(result)
                expected = gh.loads_jsonc(text)
                expected["mcp"].update(self.entries)
                if "enabled" in old:
                    expected["mcp"]["flighty"]["enabled"] = False
                self.assertEqual(parsed, expected)
                self.assertEqual(opencode.patch(result, self.entries), result)

    def test_migration_refuses_missing_malformed_or_duplicate_entries(self):
        for text in ('{}', '{"mcp":{}}', '{"mcp":{"flighty":null,"inbody":{}}}',
                     '{"mcp":{"flighty":{},"flighty":{},"inbody":{}}}',
                     '{"mcp":{"flighty":{},"inbody":{}}', '{"mcp":[]}'):
            with self.subTest(text=text), self.assertRaises((ValueError, gh.HomeError)):
                opencode.patch(text, self.entries)

    def test_repeated_migrations_preserve_original_rollback_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "opencode.jsonc"
            original = '{"mcp":{"flighty":{"command":["uv"]},"inbody":{"command":["inbody"]}}}'
            path.write_text(original)
            with mock.patch.object(gh, "load_manifest", return_value=self.manifest), \
                    mock.patch.object(gh, "opencode_config_path", return_value=str(path)):
                opencode.main()
                backup = Path(str(path) + ".before-shared-mcp")
                self.assertEqual(backup.read_text(), original)
                for formatting in (None, 2, 4):
                    with self.subTest(formatting=formatting):
                        migrated = gh.loads_jsonc(path.read_text())
                        migrated["unrelated"] = "preserve new edits"
                        path.write_text(json.dumps(migrated, indent=formatting))
                        opencode.main()
                        self.assertEqual(backup.read_text(), original)
                        self.assertEqual(gh.loads_jsonc(path.read_text())["unrelated"], "preserve new edits")

    def test_keychain_values_preserve_significant_whitespace(self):
        for output, expected in ((" value \n", " value "), ("abc\n\n", "abc"), ("\n", "")):
            with self.subTest(output=output), mock.patch.object(serve.subprocess, "run", return_value=mock.Mock(returncode=0, stdout=output)):
                self.assertEqual(serve.keychain_value("fixture"), expected)
        with mock.patch.object(serve.subprocess, "run", return_value=mock.Mock(returncode=1, stdout="ignored")):
            self.assertEqual(serve.keychain_value("fixture"), "")

    def test_launch_agents_reuse_existing_venvs_and_restart(self):
        for name, port in (("flighty", 18766), ("inbody", 18767)):
            label = f"com.ardud.shared-mcp-{name}"
            data = plistlib.loads((PKG / "launchd" / f"{label}.plist").read_bytes())
            self.assertEqual(data["Label"], label)
            self.assertTrue(data["KeepAlive"])
            self.assertTrue(data["RunAtLoad"])
            self.assertEqual(data["ProgramArguments"][-3:], [name, "--port", str(port)])
            self.assertIn("/.venv/bin/python", data["ProgramArguments"][0])
            self.assertTrue(data["StandardErrorPath"].startswith("/Users/ardud/Library/Logs/"))
        server = mock.Mock()
        self.assertIs(serve.configure(server, 12345), server)
        self.assertEqual(server.settings.host, "127.0.0.1")
        self.assertEqual(server.settings.port, 12345)
        self.assertIs(server.settings.stateless_http, True)
        self.assertIs(server.settings.json_response, True)

    def test_health_probe_uses_mcp_and_detects_wrong_server(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if "id" not in data:
                    self.send_response(202)
                    self.end_headers()
                    return
                result = {"serverInfo": {"name": "flighty"}} if data["method"] == "initialize" else {"tools": [{"name": "x"}]}
                body = json.dumps({"jsonrpc": "2.0", "id": data["id"], "result": result}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/mcp"
                with concurrent.futures.ThreadPoolExecutor(2) as pool:
                    self.assertEqual(list(pool.map(lambda _: check.probe(url, "flighty"), range(2))), [["x"], ["x"]])
                with self.assertRaisesRegex(RuntimeError, "wrong MCP server"):
                    check.probe(url, "inbody")
            finally:
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()

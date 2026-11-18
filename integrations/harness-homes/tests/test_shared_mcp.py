"""Shared endpoints, migration safety, and health probe behavior."""
import concurrent.futures
from contextlib import contextmanager
import json
import os
import plistlib
import subprocess
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
import runtime_paths


@contextmanager
def mcp_server(name="flighty", tool_result=None, rpc_error=None):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls.append(data)
            if "id" not in data:
                self.send_response(202)
                self.end_headers()
                return
            result = {"initialize": {"serverInfo": {"name": name}},
                      "tools/list": {"tools": [{"name": "search_airports"}]},
                      "tools/call": tool_result}[data["method"]]
            payload = {"error": rpc_error} if rpc_error and data["method"] == "tools/call" else {"result": result}
            body = json.dumps({"jsonrpc": "2.0", "id": data["id"], **payload}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}/mcp", calls
        finally:
            server.shutdown()
            thread.join()


class SharedMcpTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((PKG / "manifest.json").read_text())
        self.entries = opencode.remote_entries(self.manifest)

    def test_all_harnesses_keep_ids_and_use_remote_transports(self):
        servers = self.manifest["mcpServers"]
        claude = gh.claude_mcp(servers)
        env = gh.claude_settings_owned(self.manifest)["env"]
        self.assertEqual(env["MCP_TIMEOUT"], "15000")
        self.assertEqual(env["MCP_CONNECT_TIMEOUT_MS"], "15000")
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

    def test_repeated_migrations_keep_backup_and_identical_config_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "opencode.jsonc"
            original = '{"mcp":{"flighty":{"command":["uv"]},"inbody":{"command":["inbody"]}}}'
            path.write_text(original)
            with mock.patch.dict(os.environ, {'HOME': tmp, 'TOOLLOG_ROOT': tmp + '/logs',
                    'OPENCODE_RELOAD_INSTANCES': '[{"name":"HOME","url":"http://127.0.0.1:1"}]'}), \
                    mock.patch.object(gh, "load_manifest", return_value=self.manifest), \
                    mock.patch.object(gh, "opencode_config_path", return_value=str(path)):
                opencode.main([])
                backup, = (Path(tmp) / '.config/opencode/backups/harness-homes-shared-mcp').rglob('*.bak-*')
                self.assertEqual(backup.read_text(), original)
                before = path.stat()
                logs = {p: p.read_bytes() for p in (Path(tmp) / 'logs').rglob('*.ndjson')}
                opencode.main([])
                self.assertEqual((path.stat().st_ino, path.stat().st_mtime_ns), (before.st_ino, before.st_mtime_ns))
                self.assertEqual({p: p.read_bytes() for p in logs}, logs)
                for formatting in (None, 2, 4):
                    with self.subTest(formatting=formatting):
                        migrated = gh.loads_jsonc(path.read_text())
                        migrated["unrelated"] = "preserve new edits"
                        path.write_text(json.dumps(migrated, indent=formatting))
                        opencode.main([])
                        self.assertEqual(backup.read_text(), original)
                        self.assertEqual(gh.loads_jsonc(path.read_text())["unrelated"], "preserve new edits")

    def test_keychain_values_preserve_significant_whitespace(self):
        for output, expected in ((" value \n", " value "), ("abc\n\n", "abc"), ("\n", "")):
            with self.subTest(output=output), mock.patch.object(serve.subprocess, "run", return_value=mock.Mock(returncode=0, stdout=output)):
                self.assertEqual(serve.keychain_value("fixture"), expected)
        with mock.patch.object(serve.subprocess, "run", return_value=mock.Mock(returncode=1, stdout="ignored")):
            self.assertEqual(serve.keychain_value("fixture"), "")

    def test_launch_agents_use_dedicated_internal_python_runtimes(self):
        interpreters = {"flighty": "/Users/ardud/.local/share/shared-mcp-flighty/python/bin/python3.12",
                        "inbody": "/Users/ardud/.local/share/shared-mcp-inbody/python/bin/python"}
        for name, port in (("flighty", 18766), ("inbody", 18767)):
            label = f"com.ardud.shared-mcp-{name}"
            data = plistlib.loads((PKG / "launchd" / f"{label}.plist").read_bytes())
            self.assertEqual(data["Label"], label)
            self.assertTrue(data["KeepAlive"])
            self.assertTrue(data["RunAtLoad"])
            self.assertEqual(data["ProcessType"], "Standard")
            self.assertEqual(data["ProgramArguments"][-3:], [name, "--port", str(port)])
            self.assertEqual(data["ProgramArguments"][0], interpreters[name])
            self.assertTrue(data["StandardErrorPath"].startswith("/Users/ardud/Library/Logs/"))
        server = mock.Mock()
        self.assertIs(serve.configure(server, 12345), server)
        self.assertEqual(server.settings.host, "127.0.0.1")
        self.assertEqual(server.settings.port, 12345)
        self.assertIs(server.settings.stateless_http, True)
        self.assertIs(server.settings.json_response, True)

    def test_health_probe_uses_mcp_and_detects_wrong_server(self):
        with mcp_server(tool_result={"content": [{"type": "text", "text": "DXB Dubai International"}]}) as (url, calls):
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                self.assertEqual(list(pool.map(lambda _: check.probe(url, "flighty"), range(2))),
                                 [["search_airports"], ["search_airports"]])
            tool_calls = [call for call in calls if call["method"] == "tools/call"]
            self.assertEqual(len(tool_calls), 2)
            for call in tool_calls:
                self.assertEqual(call["params"], {"name": "search_airports", "arguments": {"query": "DXB"}})
            with self.assertRaisesRegex(RuntimeError, "wrong MCP server"):
                check.probe(url, "inbody")

    def test_health_cli_reports_tool_errors_and_database_access_hint(self):
        cases = [
            ({"isError": True, "content": [{"type": "text", "text": "Error executing tool search_airports: unable to open database file"}]}, None, False, True),
            ({"content": [{"type": "text", "text": "unable to open database file"}]}, None, False, True),
            ({"content": [{"type": "text", "text": "Error: bad query"}]}, None, False, False),
            ({"isError": True, "content": []}, None, False, False),
            (None, {"code": -32603, "message": "unable to open database file"}, False, True),
            ({"content": [{"type": "text", "text": "DXB Dubai International"}]}, None, True, False),
        ]
        for result, rpc_error, ok, hint in cases:
            with self.subTest(result=result, rpc_error=rpc_error), tempfile.TemporaryDirectory() as tmp, \
                    mcp_server(tool_result=result, rpc_error=rpc_error) as (url, calls):
                root = Path(tmp)
                shared = root / "shared"
                shared.mkdir()
                (root / "toollog.py").write_text((PKG / "toollog.py").read_text())
                (shared / "check.py").write_text((PKG / "shared/check.py").read_text())
                (shared / 'runtime_paths.py').write_text((PKG / 'shared/runtime_paths.py').read_text())
                plists = root / 'Library/LaunchAgents'
                plists.mkdir(parents=True)
                (plists / 'com.ardud.shared-mcp-flighty.plist').write_bytes(plistlib.dumps(
                    {'ProgramArguments': [sys.executable, str(shared / 'serve.py'), 'flighty']}))
                (shared / "opencode.py").write_text("SHARED_IDS = ('flighty', 'inbody')\n")
                (root / "generate_homes.py").write_text(
                    f"def load_manifest(): return {{'mcpServers': [{{'id': 'flighty', 'url': {url!r}}}]}}\n")
                process = subprocess.run([sys.executable, str(shared / "check.py")],
                                         env={**os.environ, "HOME": str(root)}, capture_output=True, text=True, timeout=10)
                self.assertEqual(process.returncode, 0 if ok else 1, process.stdout + process.stderr)
                self.assertIn("tools/call", [call["method"] for call in calls])
                self.assertEqual("Full Disk Access" in process.stderr, hint, process.stderr)
                if hint:
                    self.assertIn(f"FAIL flighty: cannot read the Flighty database; grant Full Disk Access to {root / '.local/share/shared-mcp-flighty/python/bin/python3.12'}", process.stderr)
                    self.assertIn("unable to open database file", process.stderr)

    def test_inbody_health_does_not_call_authenticated_tools(self):
        with mcp_server(name="inbody") as (url, calls):
            self.assertEqual(check.probe(url, "inbody"), ["search_airports"])
            self.assertEqual([call["method"] for call in calls],
                             ["initialize", "notifications/initialized", "tools/list"])

    def test_volume_guard_covers_arguments_symlinks_and_venv_base(self):
        cases = ('interpreter', 'script', 'interpreter-link', 'script-link', 'config-link', 'home', 'executable')
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                python = root / 'python/bin/python'
                python.parent.mkdir(parents=True)
                python.touch()
                script = root / 'serve.py'
                script.touch()
                args = [str(python), str(script), 'inbody']
                external = '/Volumes/ExternalSSD/fixture'
                if case in ('interpreter', 'script'):
                    args[0 if case == 'interpreter' else 1] = external
                elif case in ('interpreter-link', 'script-link', 'config-link'):
                    path = {'interpreter-link': python, 'script-link': script,
                            'config-link': python.parent.parent / 'pyvenv.cfg'}[case]
                    path.unlink(missing_ok=True)
                    path.symlink_to(external)
                else:
                    (python.parent.parent / 'pyvenv.cfg').write_text(f'{case} = {external}\n')
                plist = root / 'job.plist'
                plist.write_bytes(plistlib.dumps({'ProgramArguments': args}))
                with self.assertRaisesRegex(ValueError, '/Volumes/'):
                    runtime_paths.validate_plist(plist)
                plist.write_bytes(plistlib.dumps({'ProgramArguments': [sys.executable, 'serve.py', 'inbody']}))
                self.assertEqual(runtime_paths.validate_plist(plist, require_interpreter=True), Path(sys.executable))

    def test_inbody_runtime_guard_rejects_external_package_or_search_path(self):
        for path in ('/Volumes/ExternalSSD/pkg/server.py', '/Volumes/Elsewhere/lib/python3.14'):
            with self.subTest(path=path), mock.patch.object(runtime_paths.subprocess, 'run',
                    return_value=mock.Mock(stdout=json.dumps([sys.executable, path]))):
                with self.assertRaisesRegex(ValueError, '/Volumes/'):
                    runtime_paths.validate_inbody(sys.executable)

    def test_check_fails_before_http_for_external_runtime(self):
        with mock.patch.object(check.gh, 'load_manifest', return_value=self.manifest), \
                mock.patch.object(check, 'validate_plist', side_effect=ValueError('/Volumes/ external runtime')), \
                mock.patch.object(check, 'probe') as probe:
            self.assertEqual(check.main(), 1)
            probe.assert_not_called()

    def test_flighty_requires_exactly_one_site_packages_directory(self):
        for versions in ([], ["3.12", "3.13"]):
            with self.subTest(versions=versions), tempfile.TemporaryDirectory() as tmp:
                home = Path(tmp)
                for version in versions:
                    (home / f".local/share/flighty-mcp/.venv/lib/python{version}/site-packages").mkdir(parents=True)
                with mock.patch.object(serve.Path, "home", return_value=home), \
                        mock.patch.object(sys, "argv", ["serve.py", "flighty", "--port", "18766"]), \
                        mock.patch.object(serve.importlib, "import_module") as imported:
                    with self.assertRaisesRegex(SystemExit, f"flighty: expected exactly one venv site-packages directory.*found {len(versions)}"):
                        serve.main()
                    imported.assert_not_called()

    def test_flighty_adds_venv_packages_before_importing_main(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            source = home / ".local/share/flighty-mcp"
            site_dir = source / ".venv/lib/python3.12/site-packages"
            site_dir.mkdir(parents=True)
            dependency = home / "editable-package"
            dependency.mkdir()
            (site_dir / "editable.pth").write_text(str(dependency) + "\n")

            def imported(name):
                self.assertEqual(name, "main")
                self.assertEqual(sys.path[0], str(source))
                self.assertIn(str(site_dir), sys.path)
                self.assertIn(str(dependency), sys.path)
                return mock.Mock()

            with mock.patch.object(serve.Path, "home", return_value=home), \
                    mock.patch.object(sys, "argv", ["serve.py", "flighty", "--port", "18766"]), \
                    mock.patch.object(sys, "path", list(sys.path)), \
                    mock.patch.object(serve.importlib, "import_module", side_effect=imported), \
                    mock.patch.object(serve, "offload_sync_tools"), mock.patch.object(serve, "configure"):
                serve.main()


if __name__ == "__main__":
    unittest.main()

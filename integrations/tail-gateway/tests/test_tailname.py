"""Tests for tailname: route edits and the generated Caddyfile. Caddy itself is faked except in the
validate test, which runs the real binary when it's installed."""
import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "..", "bin")


def load_tailname(env):
    os.environ.update(env)
    loader = importlib.machinery.SourceFileLoader("tailname_mod", os.path.join(BIN, "tailname"))
    spec = importlib.util.spec_from_loader("tailname_mod", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class TailnameTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.conf = os.path.join(self.tmp, "conf")
        self.live = os.path.join(self.tmp, "live")
        os.makedirs(os.path.join(self.live, "ca"))
        fake = os.path.join(self.tmp, "caddy")
        with open(fake, "w") as f:
            f.write("#!/bin/sh\nexit 0\n")
        os.chmod(fake, 0o755)
        self.env = {"TAIL_GATEWAY_CONFIG": self.conf, "TAIL_GATEWAY_HOME": self.live, "CADDY_BIN": fake}
        self.t = load_tailname(self.env)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_cli(self, *args):
        env = dict(os.environ, **self.env)
        return subprocess.run([sys.executable, os.path.join(BIN, "tailname"), *args], env=env,
                              capture_output=True, text=True)

    def routes(self):
        with open(os.path.join(self.conf, "routes.json")) as f:
            return json.load(f)["routes"]

    def test_add_port_and_path_routes(self):
        r = self.run_cli("add", "builds", "8461", "--note", "OTA builds")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "https://builds.tail")
        r = self.run_cli("add", "builds.tail", "8462", "--path", "/crpko/")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "https://builds.tail/crpko/")
        self.assertEqual(self.routes(), [
            {"name": "builds", "path": "/crpko", "port": 8462},
            {"name": "builds", "port": 8461, "note": "OTA builds"},
        ])

    def test_add_replaces_same_name_and_path(self):
        self.run_cli("add", "x", "1000")
        self.run_cli("add", "x", "2000")
        self.assertEqual(self.routes(), [{"name": "x", "port": 2000}])

    def test_rejects_bad_names_ports_and_reserved(self):
        for args in (["add", "Bad_Name", "80"], ["add", "ok", "notaport"], ["add", "ok", "70000"],
                     ["add", "gateway", "80"], ["add", "ok", "80", "--path", "no-slash"]):
            r = self.run_cli(*args)
            self.assertEqual(r.returncode, 2, (args, r.stdout, r.stderr))
        self.assertFalse(os.path.exists(os.path.join(self.conf, "routes.json")))

    def test_invalid_config_leaves_routes_untouched(self):
        self.run_cli("add", "a", "1000")
        bad = os.path.join(self.tmp, "badcaddy")
        with open(bad, "w") as f:
            f.write("#!/bin/sh\necho nope >&2; exit 1\n")
        os.chmod(bad, 0o755)
        env = dict(os.environ, **dict(self.env, CADDY_BIN=bad))
        r = subprocess.run([sys.executable, os.path.join(BIN, "tailname"), "add", "b", "2000"], env=env,
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.routes(), [{"name": "a", "port": 1000}])

    def test_rejects_dot_segments_and_placeholder_dirs(self):
        self.assertEqual(self.run_cli("add", "a", "80", "--path", "/../x").returncode, 2)
        self.assertEqual(self.run_cli("add", "a", "80", "--path", "/.").returncode, 2)
        weird = os.path.join(self.tmp, "{$HOME}")
        os.makedirs(weird)
        self.assertEqual(self.run_cli("add", "a", "--dir", weird).returncode, 2)
        self.assertEqual(self.run_cli("add", "a", "--dir", os.path.expanduser("~")).returncode, 2)

    def test_path_only_name_gets_404_fallback(self):
        text = self.t.render({"routes": [{"name": "b", "path": "/x", "port": 1}]})
        self.assertIn("respond 404", text[text.index("b.tail {"):])
        text = self.t.render({"routes": [{"name": "b", "port": 1}]})
        self.assertNotIn("respond 404", text[text.index("b.tail {"):])

    def test_admin_is_unix_socket(self):
        self.assertIn("admin unix/", self.t.render({"routes": []}))

    def test_rm(self):
        self.run_cli("add", "a", "1000")
        self.run_cli("add", "a", "1001", "--path", "/p")
        self.assertEqual(self.run_cli("rm", "a", "--path", "/p").returncode, 0)
        self.assertEqual(self.routes(), [{"name": "a", "port": 1000}])
        self.assertEqual(self.run_cli("rm", "nope").returncode, 1)

    def test_dir_route(self):
        r = self.run_cli("add", "docs", "--dir", self.tmp)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.routes(), [{"name": "docs", "dir": os.path.realpath(self.tmp)}])

    def test_render_orders_longest_path_first_and_strips_prefix(self):
        text = self.t.render({"routes": [
            {"name": "builds", "port": 8461},
            {"name": "builds", "path": "/robob", "port": 9000},
            {"name": "builds", "path": "/robob/cards", "port": 9001},
        ]})
        block = text[text.index("builds.tail {"):]
        self.assertLess(block.index("handle_path /robob/cards/*"), block.index("handle_path /robob/*"))
        self.assertLess(block.index("handle_path /robob/*"), block.index("\thandle {"))
        self.assertIn("redir /robob /robob/{?query} 308", block)
        self.assertIn("reverse_proxy 127.0.0.1:9001", block)
        self.assertIn("skip_install_trust", text)
        self.assertIn("gateway.tail {", text)

    @unittest.skipUnless(shutil.which("caddy") or os.path.exists("/opt/homebrew/bin/caddy"), "caddy not installed")
    def test_render_is_valid_caddyfile(self):
        caddy = shutil.which("caddy") or "/opt/homebrew/bin/caddy"
        text = self.t.render({"routes": [
            {"name": "robob", "port": 3773},
            {"name": "builds", "path": "/robob", "port": 8461},
            {"name": "docs", "dir": "/tmp/some dir"},
        ]})
        path = os.path.join(self.tmp, "Caddyfile")
        with open(path, "w") as f:
            f.write(text)
        r = subprocess.run([caddy, "adapt", "--config", path, "--adapter", "caddyfile"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


class SiteTest(unittest.TestCase):
    def test_mobileconfig_is_stable_and_public_only(self):
        loader = importlib.machinery.SourceFileLoader("site_mod", os.path.join(BIN, "tail-gateway-site"))
        spec = importlib.util.spec_from_loader("site_mod", loader)
        site = importlib.util.module_from_spec(spec)
        loader.exec_module(site)
        der = b"\x30\x82fake-der-bytes"
        a, b = site.mobileconfig(der), site.mobileconfig(der)
        self.assertEqual(a, b)
        self.assertIn("com.apple.security.root", a)
        self.assertNotIn("PRIVATE KEY", a)
        r = subprocess.run(["plutil", "-lint", "-"], input=a, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()

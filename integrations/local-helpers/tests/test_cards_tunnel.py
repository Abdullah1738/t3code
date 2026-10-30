"""cards-health and cards-tunnel against a fake curl, launchctl, cloudflared and Telegram notify. Nothing is sent."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class CardsTunnelTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="cards-tunnel-test-")
        self.log = os.path.join(self.home, "calls.log")
        self.creds = os.path.join(self.home, ".cloudflared", "cards-tunnel.json")
        # curl: FAKE_PUBLIC / FAKE_LOCAL = 0 (answers) or 22 (fails) for the public and loopback /healthz.
        fakes = {
            "curl": '#!/bin/sh\nfor a; do u=$a; done\necho "curl $u" >> "$FAKE_LOG"\n'
                    'case "$u" in https://*) exit "${FAKE_PUBLIC:-0}";; *) exit "${FAKE_LOCAL:-0}";; esac\n',
            "launchctl": '#!/bin/sh\necho "launchctl $*" >> "$FAKE_LOG"\n',
            "cloudflared": '#!/bin/sh\necho "cloudflared $*" >> "$FAKE_LOG"\n',
            "notify": '#!/bin/sh\nshift 2\necho "notify $* BUN_INSPECT=${BUN_INSPECT-unset}" >> "$FAKE_LOG"\n',
        }
        for name, body in fakes.items():
            path = os.path.join(self.home, name)
            with open(path, "w") as fh:
                fh.write(body)
            os.chmod(path, 0o755)

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def set_up_tunnel(self):
        os.makedirs(os.path.dirname(self.creds), exist_ok=True)
        with open(self.creds, "w") as fh:
            json.dump({"TunnelID": "11111111-2222-3333-4444-555555555555"}, fh)

    def script(self, name, public=0, local=0):
        env = {"HOME": self.home, "PATH": "/usr/bin:/bin", "FAKE_LOG": self.log, "FAKE_PUBLIC": str(public),
               "FAKE_LOCAL": str(local), "CARDS_CURL": os.path.join(self.home, "curl"),
               "CARDS_LAUNCHCTL": os.path.join(self.home, "launchctl"),
               "CARDS_CLOUDFLARED": os.path.join(self.home, "cloudflared"),
               "CARDS_NOTIFY": os.path.join(self.home, "notify"), "BUN_INSPECT": "ws://127.0.0.1:1/x"}
        r = subprocess.run(["/bin/zsh", os.path.join(HERE, "bin", name)], env=env, capture_output=True, text=True,
                           timeout=30)
        return r.returncode, r.stderr

    def fails(self):
        with open(os.path.join(self.home, ".local", "state", "cards-health", "fails")) as fh:
            return fh.read().strip()

    def calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as fh:
            return fh.read().splitlines()

    def test_nothing_happens_before_setup(self):
        self.assertEqual(self.script("cards-health", public=22)[0], 0)
        self.assertEqual(self.calls(), [])
        rc, err = self.script("cards-tunnel")
        self.assertEqual(rc, 0)  # launchd doesn't restart a tunnel that isn't set up yet
        self.assertIn("not set up yet", err)
        self.assertEqual(self.calls(), [])

    def test_tunnel_runs_the_named_tunnel_against_the_share_server(self):
        self.set_up_tunnel()
        self.assertEqual(self.script("cards-tunnel")[0], 0)
        call = self.calls()[-1]
        self.assertIn("tunnel --no-autoupdate", call)
        self.assertIn("run --credentials-file " + self.creds, call)
        self.assertIn("--url http://127.0.0.1:18793 11111111-2222-3333-4444-555555555555", call)

    def test_healthy_link_does_nothing(self):
        self.set_up_tunnel()
        self.assertEqual(self.script("cards-health")[0], 0)
        self.assertEqual(self.calls(), ["curl https://cards.abdullah.fund/healthz"])

    def test_broken_card_page_is_not_reported_healthy(self):
        # spectrum-bridge's /healthz returns 503 when a live share's page is gone. curl -f turns that into a failure,
        # so the failure counter must climb and the tunnel is restarted, instead of resetting to zero as healthy.
        self.set_up_tunnel()
        self.script("cards-health", public=22)
        self.assertEqual(self.fails(), "1")
        self.script("cards-health", public=22)
        calls = self.calls()
        self.assertIn("kickstart", " ".join(calls))
        self.assertTrue(any(c.startswith("notify") and "Card links are down" in c for c in calls))
        self.assertEqual(self.fails(), "2")

    def test_down_link_restarts_the_tunnel_alerts_once_then_says_its_back(self):
        self.set_up_tunnel()
        self.script("cards-health", public=22)
        calls = self.calls()
        self.assertIn("curl http://127.0.0.1:18793/healthz", calls)
        self.assertTrue(any(c.startswith("launchctl kickstart -k gui/") and c.endswith("/com.ardud.cards-tunnel")
                            for c in calls), calls)
        self.assertFalse([c for c in calls if c.startswith("notify")])  # one miss isn't an alert
        self.script("cards-health", public=22)
        self.script("cards-health", public=22)
        alerts = [c for c in self.calls() if c.startswith("notify")]
        self.assertEqual(len(alerts), 1, alerts)
        self.assertIn("Card links are down", alerts[0])
        self.assertIn("it was restarted", alerts[0])
        self.assertTrue(alerts[0].endswith("BUN_INSPECT=unset"))
        self.script("cards-health")
        alerts = [c for c in self.calls() if c.startswith("notify")]
        self.assertEqual(len(alerts), 2)
        self.assertIn("Card links are back", alerts[1])
        self.script("cards-health")
        self.assertEqual(len([c for c in self.calls() if c.startswith("notify")]), 2)

    def test_share_server_down_names_the_bridge_and_leaves_the_tunnel(self):
        self.set_up_tunnel()
        self.script("cards-health", public=22, local=7)
        self.script("cards-health", public=22, local=7)
        calls = self.calls()
        self.assertFalse([c for c in calls if c.startswith("launchctl")])
        alerts = [c for c in calls if c.startswith("notify")]
        self.assertEqual(len(alerts), 1)
        self.assertIn("share server on port 18793 isn't answering", alerts[0])

    def test_setup_needs_his_login_first(self):
        rc, err = self.script("cards-tunnel-setup")
        self.assertEqual(rc, 2)
        self.assertIn("cloudflared tunnel login", err)
        self.assertEqual(self.calls(), [])
        os.makedirs(os.path.join(self.home, ".cloudflared"), exist_ok=True)
        open(os.path.join(self.home, ".cloudflared", "cert.pem"), "w").close()
        self.set_up_tunnel()  # an existing tunnel is reused: no second create
        self.assertEqual(self.script("cards-tunnel-setup")[0], 0)
        calls = self.calls()
        self.assertFalse([c for c in calls if " create " in c])
        self.assertIn("cloudflared tunnel route dns 11111111-2222-3333-4444-555555555555 cards.abdullah.fund", calls)
        self.assertTrue(calls[-1].startswith("launchctl kickstart -k"))


if __name__ == "__main__":
    unittest.main()

"""Run the actual shell check with local command fixtures, never the host's VPN."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class MullvadLogging(unittest.TestCase):
    def test_check_success_and_failure_log_only_relay_and_link(self):
        scripts = Path(__file__).resolve().parents[1]
        source = (scripts.parents[1]/'server/home/mullvad.sh').read_text()
        # Keep all functions and the real EXIT trap, replace only dispatch and external commands.
        source = source[:source.rindex('case "${1:-}" in\n  install)')]
        for good in (True,False):
            with self.subTest(good=good), tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)
                (root/'enabled').touch()
                body=source.replace('ENABLED=/etc/offbox/vpn-enabled','ENABLED='+str(root/'enabled'))
                body=body.replace('helper=/opt/boatd/toollog.py','helper='+str(scripts/'toollog.py'))
                status='Connected to de-fra-wg-001' if good else 'Disconnected'
                body+='''
systemctl() { case "$*" in *offbox-exit-proxy*) return 1 ;; *mullvad-early*) echo masked ;; esac; }
mountpoint() { return 1; }
nft() { [[ "$*" != *offbox_vpn_guard* ]]; }
mullvad() { case "$*" in status) echo "STATUS" ;; *) echo ': on' ;; esac; }
curl() { echo '{"mullvad_exit_ip":VPN}'; }
incus() { return 0; }
tailscale() { echo '{"BackendState":"Running","Self":{"Online":true}}'; }
probe_exit() { echo 200; }
cmd_check
'''.replace('STATUS',status).replace('VPN','true' if good else 'false')
                file=root/'check.sh';file.write_text(body)
                result=subprocess.run(['bash',str(file),'check'],env={**os.environ,'OFFBOX_LOG_DIR':str(root/'logs')},capture_output=True,text=True)
                self.assertEqual(result.returncode,0 if good else 1,result.stderr+result.stdout)
                rows=[json.loads(s) for p in (root/'logs').glob('*.ndjson') for s in p.read_text().splitlines()]
                self.assertEqual(len(rows),1,result.stderr)
                self.assertEqual(rows[0]['name'],'mullvad.check')
                self.assertEqual(rows[0]['ok'],good)
                self.assertEqual(rows[0]['props']['linkType'],'wireguard' if good else 'down')
                if good:self.assertEqual(rows[0]['props']['exitRelay'],'de-fra-wg-001')


if __name__=='__main__':unittest.main()

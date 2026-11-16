#!/usr/bin/env python3
"""Keep the configured person box and its loopback tunnels reachable. Never allocate."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request


def router_ports(config):
    ports = (config.get('boxRouterPort', 19465), config.get('macRouterPort', 20128))
    if any(type(port) is not int or not 1024 <= port <= 65535 for port in ports):
        raise RuntimeError('invalid_router_port')
    return ports


class Supervisor:
    def __init__(self, config, deps, clock=time.monotonic, sleep=time.sleep):
        self.config, self.deps = config, deps
        self.clock, self.sleep = clock, sleep
        self.children = []

    def stop_tunnels(self):
        for child in self.children:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        self.children = []

    def connect(self):
        self.stop_tunnels()
        box = self.config['boxId']
        if not self.deps.active():
            return False
        self.deps.ensure(box)
        self.deps.setup(box)
        self.deps.runner_ready(box)
        try:
            self.children = [self.deps.tunnel(box, False)]
            self.children.append(self.deps.tunnel(box, True))
            self.children.append(self.deps.router_tunnel(box))
            deadline = self.clock() + 20
            while True:
                if not self.deps.active() or any(p.poll() is not None for p in self.children):
                    raise RuntimeError('tunnel_not_ready')
                try:
                    self.deps.both_ready()
                    return True
                except Exception:
                    if self.clock() >= deadline:
                        raise
                    self.sleep(min(0.25, deadline - self.clock()))
        except BaseException:
            self.stop_tunnels()
            raise


class OffboxDeps:
    def __init__(self, config, bridge_config, scripts):
        self.config, self.bridge_config = config, Path(bridge_config)
        router_ports(config)
        # Resolve the same person identity as offbox-person. No pool selection, sync or fallback.
        os.environ['OFFBOX_THREAD'] = 'person:moni'
        os.environ['OFFBOX_BACKEND'] = 'server'
        os.chdir(Path.home() / '.local/share/offbox-person/moni')
        sys.path.insert(0, str(Path(scripts).resolve()))
        from offbox_lib import allocation, api, common, home, lease, ssh_sync
        self.api, self.common, self.home, self.lease, self.ssh_sync = api, common, home, lease, ssh_sync
        self.allocation = allocation
        if api.BACKEND != 'server' or common.token_owner() != 'moni':
            raise RuntimeError('person_backend_required')

    def active(self):
        try:
            entry = json.loads(self.bridge_config.read_text())['chatBackends']['moni']
            return entry['kind'] == 'remote-box' and entry['boxId'] == self.config['boxId'] and entry['epoch'] == self.config['epoch']
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def ensure(self, box):
        if not box.startswith('bx_'):
            raise RuntimeError('invalid_box')
        self.home.person_gate()
        with self.common.db() as con:
            if self.common.box_owner(con, box) != 'moni':
                raise RuntimeError('box_owner_mismatch')
            self.common.require_mine(con, box)
            state = self.api.get(box)
            if not state or state.get('owner') != 'moni':
                raise RuntimeError('box_missing_or_wrong_owner')
            pending = con.execute('SELECT 1 FROM kv WHERE k=?', (f'resume_unanswered:{box}',)).fetchone()
            if pending:
                self.lease._resume_confirmed(con, box, 1800, None, pending=True)
                state = self.api.wait_state(box, self.api.LIVE_STATES, timeout=60)
            elif state['state'] in self.api.STOPPED_STATES:
                # Existing offbox confirmation reconciles a lost resume response on this exact id.
                self.lease._resume_confirmed(con, box, 1800, None)
                state = self.api.wait_state(box, self.api.LIVE_STATES, timeout=60)
            elif state['state'] in self.api.STARTING_STATES:
                # An acknowledged resume can still be booting; another POST starts another worker.
                state = self.api.wait_state(box, self.api.LIVE_STATES, timeout=60)
            if not state or state.get('owner') != 'moni' or state['state'] not in self.api.LIVE_STATES:
                raise RuntimeError('box_not_ready')
            self.allocation.clear_resume(con, box)

    def setup(self, box):
        self.ssh_sync.setup(box)

    def runner_ready(self, box):
        command = ('systemctl --user start moni-box-runner && '
                   'test -f ~/person/agent/config.json && '
                   'systemctl --user is-active --quiet moni-box-runner')
        subprocess.run(self.ssh_sync.ssh_base(box) + [box, command], check=True, timeout=30,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def tunnel(self, box, reverse):
        remote = self.config['boxCallbackPort'] if reverse else self.config['boxRunnerPort']
        local = self.config['callbackPort'] if reverse else int(self.config['url'].rsplit(':', 1)[1])
        return self.ssh_sync.tunnel(box, remote, local, reverse)

    def router_tunnel(self, box):
        box_port, mac_port = router_ports(self.config)
        # SSH runs on the Mac; -R binds only the box loopback and targets only this Mac loopback port.
        return self.ssh_sync.tunnel(box, box_port, mac_port, True)

    def post(self, base, token_file, path, body):
        token = Path(token_file).read_text().strip()
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                                     headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.load(response)

    def both_ready(self):
        self.lease.touch(self.config["boxId"])
        self.lease.ensure_ttl(self.config["boxId"], 1800)
        # /lease checks the box-to-router HTTP round trip and callback before granting the runner a lease.
        result = self.post(self.config['url'], self.config['tokenFile'], '/lease',
                           {'epoch': self.config['epoch'], 'boxId': self.config['boxId']})
        if result.get('boxId') != self.config['boxId'] or result.get('epoch') != self.config['epoch']:
            raise RuntimeError('runner_identity_mismatch')

    def pause(self):
        try:
            self.post(self.config['url'], self.config['tokenFile'], '/pause', {})
        except Exception:
            pass  # A box without a bridge lease pauses itself after 20 seconds.


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--bridge-config')
    parser.add_argument('--offbox-scripts', required=True)
    parser.add_argument('--ensure-only', action='store_true')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    config = config.get('chatBackends', {}).get('moni', config)
    deps = OffboxDeps(config, args.bridge_config or args.config, args.offbox_scripts)
    if args.ensure_only:
        deps.ensure(config['boxId'])
        deps.setup(config['boxId'])
        return
    supervisor = Supervisor(config, deps)
    backoff = 1
    try:
        while True:
            if not deps.active():
                deps.pause()
                supervisor.stop_tunnels()
                time.sleep(5)
                continue
            try:
                if not supervisor.children or any(p.poll() is not None for p in supervisor.children):
                    if not supervisor.connect():
                        continue
                deps.both_ready()
                backoff = 1
                time.sleep(5)
            except Exception:
                print(json.dumps({'event': 'moni-supervisor-error', 'code': 'reconnect'}), flush=True)
                supervisor.stop_tunnels()
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
    finally:
        supervisor.stop_tunnels()


if __name__ == '__main__':
    main()

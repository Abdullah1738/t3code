"""Full-line wrapper protocol; ordinary command output is never a source of run identity."""
from dataclasses import dataclass
import re

COMMAND_STARTED_MARKER = 'offbox-command-started:'
PREFIX = 'offbox evidence '
STEP_RESULT = re.compile(r'offbox step (\d+) rc=(-?\d+)(?: \[n=([^\]\r\n]+)\])?: ([^\r\n]*)')
STARTED = re.compile(r'offbox-command-started: (\S+?)(?: \[n=([^\]\r\n]+)\])?')
STEP_RETRY = re.compile(r'offbox-server: the server restarted while this run was going '
                        r'\(attempt (\d+) is lost\); it is queued again as attempt (\d+)'
                        r'(?: \[run=(\S+?)(?: n=([^\]\r\n]+))?\])?')
EVIDENCE = re.compile(r'(wrapper|begin|start|end|signal=\w+)((?: \w+=[^\s\[\]]+)*)'
                      r'(?: \[n=([^\]\r\n]+)\])?')


@dataclass(frozen=True)
class Marker:
    kind: str
    fields: dict
    line: str


@dataclass(frozen=True)
class Protocol:
    run_id: str = ''
    nonce: str = ''

    def accepts(self, nonce):
        # Remove the no-nonce branch once all pre-nonce runs have aged out.
        return (nonce or '') == self.nonce

    def parse(self, line, *, trace=False):
        line = line.removesuffix('\n').removesuffix('\r')
        match = STARTED.fullmatch(line)
        if match and match[1] == self.run_id and self.accepts(match[2]):
            return Marker('command_started', {}, line)
        match = STEP_RETRY.fullmatch(line)
        if match and self.accepts(match[4]) and (match[3] == self.run_id or not self.nonce and not match[3]):
            return Marker('retry', {'attempt': int(match[2])}, line)
        match = STEP_RESULT.fullmatch(line)
        if match and self.accepts(match[3]):
            return Marker('step', {'step': int(match[1]), 'rc': int(match[2])}, line)
        note = line.removeprefix(PREFIX)
        if note == line and not trace:
            return None
        match = EVIDENCE.fullmatch(note)
        if not match or not self.accepts(match[3]):
            return None
        kind = match[1]
        fields = dict(field.split('=', 1) for field in match[2].split())
        if kind.startswith('signal='):
            fields['signal'] = kind.split('=', 1)[1]
            kind = 'signal'
        required = {'begin': ('planned',), 'start': ('step',), 'end': ('step', 'rc')}.get(kind, ())
        if any(key not in fields for key in required):
            return None
        for key in ('step', 'rc', 'planned', 'pid', 'epoch'):
            if key in fields:
                if not re.fullmatch(r'-?\d+', fields[key]):
                    return None
                fields[key] = int(fields[key])
        return Marker(kind, fields, note)

    def command_started(self, text):
        return any((marker := self.parse(line)) and marker.kind == 'command_started'
                   for line in text.split('\n'))

    def ambiguous_start(self, text):
        # A glued stderr line cannot prove start, but cannot authorize replay either (#308).
        expected = f'{COMMAND_STARTED_MARKER} {self.run_id}' + (f' [n={self.nonce}]' if self.nonce else '')
        return bool(self.run_id) and any(expected in line and not self.parse(line) for line in text.split('\n'))

    def blocks_replay(self, text):
        return self.command_started(text) or self.ambiguous_start(text)

    def scan(self, text, *, trace=False):
        for line in text.split('\n'):
            marker = self.parse(line, trace=trace)
            if marker:
                yield marker

    def steps(self, text):
        results, seen = [], set()
        ignored = 0
        for line in text.split('\n'):
            marker = self.parse(line)
            if marker and marker.kind in ('command_started', 'retry'):
                results.clear()
                seen.clear()
            elif marker and marker.kind == 'step':
                n = marker.fields['step']
                if n not in seen:
                    results.append((n, marker.fields['rc']))
                    seen.add(n)
            elif marker is None and any(prefix in line for prefix in
                                       (COMMAND_STARTED_MARKER, 'offbox step ', PREFIX,
                                        'offbox-server: the server restarted')):
                ignored += 1
        return results, ignored


def for_run(run=None, path=None):
    """Read identity from the caller's row or durable state, never from the output being parsed."""
    from pathlib import Path
    import json
    from offbox_lib import common
    row = dict(run) if run is not None and not isinstance(run, str) else {'run_id': run} if run else {}
    path = Path(path) if path else None
    run_id = row.get('run_id') or (path.name.split('.log', 1)[0] if path else '')
    nonce = row.get('protocol_nonce')
    if nonce is None and run_id:
        state = (path.parent if path else common.LOGS_DIR) / (run_id + '.state.json')
        try:
            nonce = json.loads(state.read_text()).get('protocol_nonce', '')
        except (OSError, ValueError):
            nonce = ''
    return Protocol(run_id, nonce or '')

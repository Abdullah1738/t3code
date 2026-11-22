"""Read-only Homebrew dependency and opt-link integrity check."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time

from jobs import read_state, save_state
from toollog import emit


FORMULA = r'[a-z0-9@+_.-]+(?:/[a-z0-9@+_.-]+)*'
ALERT_BYTES = 3000


def dangling_links(root='/opt/homebrew/opt'):
    broken = []
    for path in sorted(Path(root).iterdir()):
        if os.path.islink(path) and not os.path.exists(path):
            broken.append(dict(name=path.name, target=os.readlink(path)))
    return broken


def parse_missing(output):
    missing = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r'\s*('+FORMULA+r'):\s*(.*?)\s*', line)
        if not match:
            raise ValueError('invalid brew missing output')
        deps = match[2].split()
        if not deps or not all(re.fullmatch(FORMULA, dep) for dep in deps):
            raise ValueError('invalid brew missing dependencies')
        missing.setdefault(match[1], set()).update(deps)
    return [dict(formula=name, deps=sorted(deps)) for name, deps in sorted(missing.items())]


def collect(opt_root='/opt/homebrew/opt', run=subprocess.run):
    start = time.monotonic()
    props = dict(dangling=[], missing=[], status='error')
    try:
        props['dangling'] = dangling_links(opt_root)
    except OSError:
        props['reason'] = 'opt_unavailable'
    else:
        try:
            result = run(['/opt/homebrew/bin/brew', 'missing'], capture_output=True,
                         text=True, timeout=60, env={**os.environ,
                         'HOMEBREW_NO_AUTO_UPDATE': '1', 'HOMEBREW_NO_ANALYTICS': '1'})
            props['exitCode'] = result.returncode
            # brew missing exits 1 for missing dependencies as well as failures.
            # Only parsed dependency rows make exit 1 an integrity result.
            if result.returncode not in (0, 1):
                props['reason'] = 'brew_exit'
            else:
                props['missing'] = parse_missing(result.stdout)
                if result.returncode and not props['missing']:
                    props['reason'] = 'brew_exit'
                else:
                    props['status'] = 'broken' if props['dangling'] or props['missing'] else 'ok'
        except FileNotFoundError:
            props['reason'] = 'brew_absent'
        except subprocess.TimeoutExpired:
            props['reason'] = 'brew_timeout'
        except OSError:
            props['reason'] = 'brew_unavailable'
        except (ValueError, UnicodeError):
            props['reason'] = 'brew_parse'
    props['durationMs'] = (time.monotonic()-start)*1000
    return props


def alert_content(props):
    dangling = sorted(props['dangling'], key=lambda row: (row['name'], row['target']))
    missing = sorted((dict(formula=row['formula'], deps=sorted(set(row['deps'])))
                      for row in props['missing']), key=lambda row: row['formula'])
    payload = json.dumps(dict(dangling=dangling, missing=missing), sort_keys=True,
                         separators=(',', ':'))
    key = 'mac-upkeep:homebrew-integrity:'+hashlib.sha1(payload.encode()).hexdigest()
    def short(text):
        return text if len(text) <= 160 else text[:159]+'…'
    parts = [("%s -> %s (dangling)" % (row['name'], short(row['target'])), row['name'])
             for row in dangling]
    parts += [("%s missing %s" % (row['formula'], short(', '.join(row['deps']))), row['formula'])
              for row in missing]
    text = 'Homebrew integrity: %d dangling links; %d missing dependency sets.' % (len(dangling), len(missing))
    for index, (detail, formula) in enumerate(parts):
        line = '\n'+detail+'. Repair: brew reinstall -- '+shlex.quote(formula)+'.'
        # Leave space for an omission count. UTF-8 bytes also bound Telegram's
        # UTF-16 character count, including astral characters in link targets.
        if len((text+line).encode('utf-8')) > ALERT_BYTES-100:
            text += '\n%d more findings; see homebrew.integrity logs for full details.' % (len(parts)-index)
            break
        text += line
    return key, text


def check(send, opt_root='/opt/homebrew/opt', run=subprocess.run):
    props = collect(opt_root, run)
    status = props['status']
    emit('homebrew', 'error' if status == 'error' else 'event', 'homebrew.integrity',
         ok=status == 'ok', duration_ms=props['durationMs'], props=props,
         error_tag='homebrew.'+props['reason'] if status == 'error' else None)
    if status == 'broken':
        key, text = alert_content(props)
        try:
            state = read_state('homebrew-integrity-alert')
            if state.get('alertedKey') == key:
                return props
            # Text is canonical too: a timeout after queueing must retry the
            # same key and content under the bridge's deduplication contract.
            sent = send(text, key)
            if sent:
                save_state('homebrew-integrity-alert', dict(alertedKey=key))
        except Exception:
            sent = False
        emit('homebrew', 'event' if sent else 'error', 'homebrew.integrity_alert',
             ok=sent, error_tag=None if sent else 'homebrew.notify_failed')
    return props

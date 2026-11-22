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


def receipt_missing(opt_root='/opt/homebrew/opt', cellar_root='/opt/homebrew/Cellar'):
    opt = Path(opt_root)
    cellar = Path(cellar_root).resolve()
    missing, errors = [], 0
    for path in sorted(opt.iterdir()):
        if not path.is_symlink():
            continue
        try:
            target = path.resolve()
            if not target.is_relative_to(cellar):
                continue
            parts = target.relative_to(cellar).parts
            if len(parts) != 2 or parts[0] != path.name:
                continue
            receipt = json.loads((target/'INSTALL_RECEIPT.json').read_text(encoding='utf-8'))
            if not isinstance(receipt, dict):
                raise ValueError('invalid receipt')
            dependencies = receipt.get('runtime_dependencies', [])
            if not isinstance(dependencies, list):
                raise ValueError('invalid receipt dependencies')
            names = set()
            for dependency in dependencies:
                full_name = dependency.get('full_name') if isinstance(dependency, dict) else None
                if not isinstance(full_name, str) or not re.fullmatch(FORMULA, full_name):
                    raise ValueError('invalid receipt dependency name')
                name = full_name.rsplit('/', 1)[-1]
                if name in ('.', '..'):
                    raise ValueError('invalid receipt dependency name')
                if not (opt/name).exists():
                    names.add(name)
            if names:
                missing.append(dict(formula=path.name, deps=sorted(names)))
        except (OSError, ValueError, UnicodeError, RuntimeError):
            errors += 1
    return missing, errors


def collect(opt_root='/opt/homebrew/opt', run=subprocess.run, *, cellar_root='/opt/homebrew/Cellar'):
    start = time.monotonic()
    props = dict(dangling=[], missing=[], receiptErrors=0)
    checked = False
    try:
        props['dangling'] = dangling_links(opt_root)
    except OSError:
        pass
    else:
        checked = True
    try:
        props['missing'], props['receiptErrors'] = receipt_missing(opt_root, cellar_root)
    except (OSError, RuntimeError):
        pass
    else:
        checked = True
    try:
        # Ruby startup is slow under load. Formula receipts remain authoritative
        # even if this secondary probe, which also covers casks, cannot finish.
        result = run(['/usr/bin/nice', '-n', '15', '/opt/homebrew/bin/brew', 'missing'],
                     capture_output=True, text=True, timeout=240, env={**os.environ,
                     'HOMEBREW_NO_AUTO_UPDATE': '1', 'HOMEBREW_NO_ANALYTICS': '1'})
        props['exitCode'] = result.returncode
        if result.returncode == 127:
            props['brewError'] = 'brew_absent'
        elif result.returncode == 126:
            props['brewError'] = 'brew_unavailable'
        elif result.returncode not in (0, 1):
            props['brewError'] = 'brew_exit'
        else:
            missing = parse_missing(result.stdout)
            if result.returncode and not missing:
                props['brewError'] = 'brew_exit'
            else:
                checked = True
                combined = {}
                for row in props['missing']+missing:
                    # Both sources identify the same opt entry, even when Brew
                    # prints a tap-qualified formula or dependency name.
                    name = row['formula'].rsplit('/', 1)[-1]
                    combined.setdefault(name, set()).update(dep.rsplit('/', 1)[-1] for dep in row['deps'])
                props['missing'] = [dict(formula=name, deps=sorted(deps))
                                    for name, deps in sorted(combined.items())]
    except FileNotFoundError:
        props['brewError'] = 'brew_absent'
    except subprocess.TimeoutExpired:
        props['brewError'] = 'brew_timeout'
    except OSError:
        props['brewError'] = 'brew_unavailable'
    except (ValueError, UnicodeError):
        props['brewError'] = 'brew_parse'
    props['status'] = 'broken' if props['dangling'] or props['missing'] else 'ok' if checked else 'error'
    if props['status'] == 'error':
        props['reason'] = 'opt_unavailable'
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


def check(send, opt_root='/opt/homebrew/opt', run=subprocess.run, *, cellar_root='/opt/homebrew/Cellar'):
    props = collect(opt_root, run, cellar_root=cellar_root)
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

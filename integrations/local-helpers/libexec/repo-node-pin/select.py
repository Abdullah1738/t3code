"""Offline Node/pnpm selection. Output is shell-quoted data, never repo code."""
import json
import os
import re
import sys

def quote(text):
    return "'" + text.replace("'", "'\"'\"'") + "'"


def directories(root):
    try:
        return [e.path for e in os.scandir(root) if e.is_dir()]
    except OSError:
        return []


LTS = {'argon': 4, 'boron': 6, 'carbon': 8, 'dubnium': 10, 'erbium': 12, 'fermium': 14,
       'gallium': 16, 'hydrogen': 18, 'iron': 20, 'jod': 22, 'krypton': 24}


def read(path, limit=-1):
    try:
        with open(path, encoding='utf-8') as f:
            return f.read(limit)
    except (OSError, UnicodeError):
        return ''


def package(path):
    try:
        value = json.loads(read(path))
        return value if isinstance(value, dict) else {}
    except ValueError:
        return {}


def version(text):
    if not isinstance(text, str):
        return None
    m = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)', text)
    return tuple(map(int, m.groups())) if m else None


def bounds(token):
    m = re.fullmatch(r'(>=|<=|>|<|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?', token)
    if not m:
        raise ValueError('unsupported version range')
    op = m[1] or ''
    parts = []
    wildcard = False
    for v in m.groups()[1:]:
        if v is None or not v.isdigit():
            wildcard = True
        elif wildcard:
            raise ValueError('number after wildcard')
        else:
            parts.append(int(v))
    lo = tuple((parts + [0, 0, 0])[:3])
    top = (10**9, 0, 0)
    def upper(n):
        if not n:
            return top
        p = parts[:n]
        p[-1] += 1
        return tuple((p + [0, 0, 0])[:3])
    hi = upper(len(parts))
    if op in ('', '='):
        return lo, hi
    if op == '>=':
        return lo, top
    if op == '>':
        return hi, top
    if op == '<':
        return (0, 0, 0), lo
    if op == '<=':
        return (0, 0, 0), hi
    if op == '~':
        return lo, upper(min(2, len(parts)))
    if op == '^':
        n = next((i + 1 for i, p in enumerate(parts) if p), len(parts))
        return lo, upper(n)


def satisfies(v, spec):
    # Same interval rule as offbox: union of comparator intersections, highest installed wins.
    for alt in spec.strip().split('||'):
        alt = re.sub(r'(>=|<=|>|<|=|\^|~)\s+', r'\1', alt.strip())
        hyphen = re.fullmatch(r'(\S+)\s+-\s+(\S+)', alt)
        if hyphen:
            intervals = [(bounds(hyphen[1])[0], bounds(hyphen[2])[1])]
        else:
            if not alt:
                raise ValueError('empty version range')
            intervals = [bounds(t) for t in alt.split()]
        if all(lo <= v < hi for lo, hi in intervals):
            return True
    return False


def pin_spec(text, nvm):
    pin = next((l.split('#')[0].strip() for l in text.splitlines() if l.split('#')[0].strip()), '')
    if pin in ('node', 'stable'):
        return '*'
    if pin == 'lts/*':
        return ' || '.join(str(v) for v in LTS.values())
    if pin.startswith('lts/'):
        return str(LTS.get(pin[4:], pin))
    # Resolve local aliases only, with a bounded walk and no calls to nvm.
    for _ in range(8):
        if re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_-]*', pin):
            alias = read(os.path.join(nvm, 'alias', pin)).strip()
            if alias:
                pin = alias
                continue
        break
    if pin in ('node', 'stable'):
        return '*'
    if pin == 'lts/*':
        return ' || '.join(str(v) for v in LTS.values())
    if pin.startswith('lts/'):
        return str(LTS.get(pin[4:], pin))
    return pin


def repo_inputs(cwd):
    pin = engines = manager = lock = ''
    while True:
        pkg = package(os.path.join(cwd, 'package.json'))
        pin = pin or read(os.path.join(cwd, '.nvmrc')) or read(os.path.join(cwd, '.node-version'))
        eng = pkg.get('engines', {})
        candidate = eng.get('node', '') if isinstance(eng, dict) else ''
        engines = engines or (candidate if isinstance(candidate, str) else '')
        manager = manager or pkg.get('packageManager', '')
        lock = lock or read(os.path.join(cwd, 'pnpm-lock.yaml'), 4096)
        parent = os.path.dirname(cwd)
        if os.path.exists(os.path.join(cwd, '.git')) or parent == cwd:
            break
        cwd = parent
    return pin, engines, manager, lock


def select(cwd, base_path, home, helper):
    nvm = os.environ.get('NVM_DIR', os.path.join(home, '.nvm'))
    pin, engines, manager, lock = repo_inputs(cwd)
    warnings = []
    installed = []
    for d in directories(os.path.join(nvm, 'versions/node')):
        v = version(os.path.basename(d))
        if v and os.access(os.path.join(d, 'bin/node'), os.X_OK):
            installed.append((v, d))
    installed.sort(reverse=True)
    node_dir = ''
    spec = (pin_spec(pin, nvm) if pin else '') or engines
    if spec:
        try:
            matches = [d for v, d in installed if satisfies(v, spec) and (not engines or satisfies(v, engines))]
            if not matches and pin and engines:
                matches = [d for v, d in installed if satisfies(v, engines)]
                if matches:
                    warnings.append(f'{spec} unavailable; using {os.path.basename(matches[0])} from engines.node ({engines})')
            if matches:
                node_dir = os.path.join(matches[0], 'bin')
            else:
                warnings.append(f'no installed Node satisfies {spec}; install explicitly: nvm install {quote(spec)}')
        except (ValueError, TypeError):
            try:
                matches = [d for v, d in installed if engines and satisfies(v, engines)]
            except (ValueError, TypeError):
                matches = []
            if matches:
                node_dir = os.path.join(matches[0], 'bin')
                warnings.append(f'unsupported Node pin {spec!r}; using {os.path.basename(matches[0])} from engines.node ({engines})')
            else:
                warnings.append(f'unsupported Node pin {spec!r}; PATH left unchanged')
    wanted = []
    if isinstance(manager, str) and manager.startswith('pnpm@'):
        m = re.match(r'pnpm@(\d+)(?:\.|$)', manager)
        if m:
            wanted = [int(m[1])]
        else:
            warnings.append(f'unsupported packageManager {manager!r}; choose a numeric pnpm version')
    elif not manager and lock:
        m = re.search(r'''(?m)^lockfileVersion:\s*['"]?(\d+)(?:\.\d+)?['"]?\s*(?:#.*)?$''', lock)
        if m:
            wanted = {'9': [10, 9], '6': [8], '5': [7, 6]}.get(m[1], [])
    paths = base_path.split(':')
    if node_dir:
        paths.insert(0, node_dir)
    node = next((os.path.join(p, 'node') for p in paths if os.access(os.path.join(p, 'node'), os.X_OK)), '')
    cli = hint = ''
    if wanted:
        candidates = []
        roots = [os.path.join(d, 'lib/node_modules/pnpm') for _, d in installed]
        roots += [os.path.dirname(os.path.dirname(os.path.realpath(os.path.join(p, 'pnpm')))) for p in paths if os.path.exists(os.path.join(p, 'pnpm'))]
        cache = os.environ.get('COREPACK_HOME', os.path.join(home, '.cache/node/corepack'))
        roots += directories(os.path.join(cache, 'v1/pnpm'))
        for root in set(roots):
            pkg = package(os.path.join(root, 'package.json'))
            v = version(pkg.get('version', ''))
            bins = pkg.get('bin', {})
            entry = bins.get('pnpm', '') if isinstance(bins, dict) else bins
            target = os.path.join(root, entry) if isinstance(entry, str) else ''
            if pkg.get('name') == 'pnpm' and v and v[0] in wanted and entry and os.path.isfile(target):
                # Do not execute candidate binaries to discover versions or enter Corepack's downloader.
                candidates.append((wanted.index(v[0]), tuple(-x for x in v), target))
        if candidates and node:
            cli = sorted(candidates)[0][2]
        else:
            hint = f'no cached/installed pnpm {wanted[0]}.x; install explicitly: corepack prepare pnpm@{wanted[0]} --activate'
            warnings.append(hint)
        paths.insert(0, os.path.join(helper, 'pnpm-bin'))
    return ':'.join(paths), node, cli, hint, warnings, node_dir


if __name__ == '__main__':
    path, node, cli, hint, warnings, added_node = select(sys.argv[1], sys.argv[2], os.environ['HOME'], os.path.dirname(os.path.abspath(__file__)))
    for name, value in [('PATH', path), ('_repo_node_added_node', added_node), ('ROBOB_REPO_NODE', node), ('ROBOB_REPO_PNPM_CLI', cli), ('ROBOB_REPO_PNPM_HINT', hint)]:
        print('export ' + name + '=' + quote(value))
    print('_repo_node_warning=' + quote('; '.join(warnings)))

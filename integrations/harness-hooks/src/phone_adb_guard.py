"""Phone ownership at shell admission; never contacts adb or changes lock files."""
from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
import re
import shlex
import stat
import sys
import time

from rootwide_search_guard import _tokens
from statev2_guard import _heredocs, _substitutions, AmbiguousScript

OWNER_KEYS = {"PH_LEASE_OWNER", "PHONE_HOLD_OWNER"}
SEPARATORS = {";", "&&", "||", "|", "|&", "&", "\n", "(", ")", "{", "}"}
ASSIGN = re.compile(r"^[A-Za-z_]\w*=")
LIMIT = 16384
QUOTED = '\0phone_quoted__'


def _literal(word):
    word = word.replace(QUOTED, '').replace('\0dollar', '$').replace('\0tilde', '~').replace('\0literal:', '')
    return re.sub(r'\x00escaped([0-9a-f]+)__', lambda m: chr(int(m[1], 16)), word)


def _commands(command, inherited_bodies=None):
    bodies = dict(inherited_bodies or {})
    source, extracted = _heredocs(command, offset=len(bodies), known=bodies)
    bodies.update(extracted)
    prefix = '__phone_sub_'
    while prefix in source:
        prefix = '_' + prefix
    substitutions = {}
    # Mask substitutions before tokenization so their separators do not leak
    # into the parent environment. Inspect them in that command's scope.
    for start, stop, body in reversed(_substitutions(source, shell=True, spans=True)):
        key = f'{prefix}{len(substitutions)}__'
        substitutions[key] = body
        source = source[:start] + key + source[stop:]
    # Reserved words and assignment names must be unquoted, even though a
    # quoted executable/argument has the same value after shell decoding.
    source = re.sub(r"'[^']*'|\"(?:\\.|[^\"\\])*\"|\\[^\n]",
                    lambda m: m[0][0] + QUOTED + m[0][1:] if m[0][0] in "'\"" else QUOTED + m[0], source)
    words, previous = [], None
    for token in [*_tokens(source.replace('\\\n', '')), ';']:
        if token == '\n' and not words and previous in {'&&', '||', '|', '|&'}:
            continue
        if token in SEPARATORS:
            documents = [bodies[words[i + 1]] if word == '<<' else (_literal(words[i + 1]) + '\n', True)
                         for i, word in enumerate(words[:-1])
                         if word == '<<' and words[i + 1] in bodies or word == '<<<']
            nested = [body for key, body in substitutions.items() if any(key in word for word in words)]
            yield words, token, documents, nested, bodies
            words = []
            previous = token
        else:
            words.append(token)


def _argv(words):
    args, i = [], 0
    while i < len(words):
        if words[i] in {'<', '>', '>>', '<<', '<<-', '<<<', '<&', '>&', '<>'}:
            if args and args[-1].isdigit():
                args.pop()
            i += 2
        else:
            args.append(words[i])
            i += 1
    while args and args[0] in {'if', 'while', 'until', 'then', 'elif', 'else', 'do', '!'}:
        args.pop(0)
    return args


def _unwrap(args, inherited):
    env = dict(inherited)
    while args:
        if ASSIGN.match(args[0]):
            name, value = args.pop(0).split('=', 1)
            if name in OWNER_KEYS:
                env[name] = _literal(value)
        elif os.path.basename(_literal(args[0])) in {'env', 'command', 'exec', 'nohup', 'time'}:
            wrapper = os.path.basename(_literal(args.pop(0)))
            while args and _literal(args[0]).startswith('-'):
                flag = _literal(args.pop(0))
                if wrapper == 'env' and re.match(r'^-[iv].', flag):
                    # Boolean short flags may precede a value-taking option.
                    args.insert(0, '-' + flag[2:])
                    flag = flag[:2]
                if flag == '--':
                    break
                if wrapper == 'env' and (flag in {'-', '--ignore-environment'} or re.fullmatch(r'-[iv]+', flag) and 'i' in flag):
                    env.clear()
                elif wrapper == 'env' and flag in {'-u', '--unset'} and args:
                    env.pop(_literal(args.pop(0)), None)
                elif wrapper == 'env' and flag.startswith('--unset='):
                    env.pop(flag.split('=', 1)[1], None)
                elif wrapper == 'env' and flag.startswith('-u') and len(flag) > 2:
                    env.pop(flag[2:], None)
                elif wrapper == 'env' and flag in {'-S', '--split-string'} and args:
                    args[:0] = shlex.split(_literal(args.pop(0)))
                elif wrapper == 'env' and flag.startswith('--split-string='):
                    args[:0] = shlex.split(flag.split('=', 1)[1])
                elif wrapper == 'env' and flag.startswith('-S') and len(flag) > 2:
                    args[:0] = shlex.split(flag[2:])
                elif wrapper == 'env' and flag in {'-v', '--debug'}:
                    continue
                elif wrapper == 'env' and flag == '-P' and args:
                    args.pop(0)
                elif wrapper == 'env' and flag.startswith('-P') and len(flag) > 2:
                    continue
                elif wrapper == 'env' and flag in {'-C', '--chdir'} and args:
                    args.pop(0)
                elif wrapper == 'env' and (flag.startswith('--chdir=') or flag.startswith('-C') and len(flag) > 2):
                    continue
                elif wrapper == 'command' and flag == '-p':
                    continue
                elif wrapper == 'exec' and (label := re.fullmatch(r'-([cl]*)a(.*)', flag)):
                    if 'c' in label[1]:
                        env.clear()
                    if not label[2] and args:
                        args.pop(0)
                elif wrapper == 'exec' and re.fullmatch(r'-[cl]+', flag):
                    if 'c' in flag:
                        env.clear()
                elif wrapper == 'time' and flag == '-p':
                    continue
                elif wrapper == 'time' and (flag in {'--verbose', '--append', '--quiet'} or re.fullmatch(r'-[lpvaq]+', flag)):
                    continue
                elif wrapper == 'time' and flag in {'-o', '-f', '--output', '--format'} and args:
                    args.pop(0)
                elif wrapper == 'time' and (flag.startswith(('--output=', '--format=')) or re.match(r'^-[of].', flag)):
                    continue
                else:
                    return [], env
            if wrapper == 'env':
                # env parses these as argv assignments, including quoted names.
                while args and ASSIGN.match(_literal(args[0])):
                    name, value = _literal(args.pop(0)).split('=', 1)
                    if name in OWNER_KEYS:
                        env[name] = value
        else:
            break
    return args, env


def _shell_source(args):
    """Select a -c payload or executable stdin without running shell options."""
    stdin, noexec, command = False, False, False
    index = 0
    while index < len(args):
        flag = _literal(args[index])
        index += 1
        if flag == '--':
            break
        if flag == '-':
            stdin = True
            break
        if flag in {'--noprofile', '--norc', '--posix', '--restricted', '--login', '--noediting'}:
            continue
        if flag in {'--rcfile', '--init-file'}:
            index += 1
            continue
        if not re.fullmatch(r'[-+][a-zA-Z]+', flag):
            index -= 1
            break
        for char in flag[1:]:
            enabled = flag[0] == '-'
            if char == 'n':
                noexec = enabled
            elif char == 's':
                stdin = enabled
            elif char == 'c':
                command = enabled
            elif char in {'o', 'O'}:
                if char == 'o' and index < len(args) and _literal(args[index]) == 'noexec':
                    noexec = enabled
                index += 1
    if command:
        return (_literal(args[index]) if index < len(args) and not noexec else None), False
    return None, not noexec and (stdin or index == len(args))


def _remote_mutates(words, depth=0, stdin_documents=(), inherited_bodies=None):
    if depth > 8:
        return False
    for raw, _, documents, substitutions, bodies in _commands(' '.join(words), inherited_bodies):
        documents = documents or stdin_documents
        if any(_remote_mutates([body], depth + 1, inherited_bodies=bodies) for body in substitutions):
            return True
        for body, quoted in documents:
            if not quoted and any(_remote_mutates([sub], depth + 1) for sub in _substitutions(body)):
                return True
        args, _ = _unwrap(_argv(raw), {})
        if not args:
            continue
        tool, *rest = args
        tool = os.path.basename(_literal(tool))
        rest = [_literal(arg) for arg in rest]
        if tool in {'sh', 'bash', 'zsh'}:
            payload, stdin = _shell_source(rest)
            if payload is not None and _remote_mutates([payload], depth + 1, inherited_bodies=bodies):
                return True
            if stdin and any(_remote_mutates([body], depth + 1) for body, _ in documents):
                return True
        # Android settings accepts its user selector before the operation.
        if rest[:1] == ['--user']:
            rest = rest[2:]
        if tool == 'cmd':
            while rest[:1] in [['-w'], ['--']]:
                rest = rest[1:]
            if rest[:1] in [['-l'], ['-h'], ['--help']]:
                continue
        if tool == 'wm':
            selected, index = [], 0
            while index < len(rest):
                if rest[index] == '-d':
                    index += 2
                elif re.fullmatch(r'-d\d+', rest[index]):
                    index += 1
                else:
                    selected.append(rest[index])
                    index += 1
            rest = selected
        verb = rest[0] if rest else ''
        if tool == 'wm' and (not rest or verb.startswith('get-') or len(rest) == 1 and verb in {'size', 'density', 'scaling', 'overscan', 'folded-area', 'user-rotation', 'fixed-to-user-rotation'}):
            continue
        if tool == 'cmd':
            operation = rest[1] if len(rest) > 1 else ''
            if (not rest or operation in {'help', 'list', 'get', 'status', 'dump', 'path', 'has-feature', 'resolve-activity', 'check-permission', 'check-signature'}
                    or operation.startswith(('get-', 'list-', 'query-', 'is-')) or rest[1:3] == ['airplane-mode']):
                continue
        if (tool in {'input', 'monkey', 'svc', 'wm', 'locksettings', 'reboot'}
                or tool == 'am' and verb in {'start', 'force-stop', 'broadcast', 'kill', 'instrument'}
                or tool == 'cmd' and verb in {'connectivity', 'wifi', 'statusbar', 'package', 'input', 'phone', 'activity'}
                or tool == 'settings' and verb == 'put'
                or tool == 'pm' and verb in {'clear', 'disable', 'enable', 'uninstall', 'grant', 'revoke'}
                or tool == 'uiautomator' and verb != 'dump'):
            return True
    return False


def _adb_kind(args, documents=()):
    args = [_literal(arg) for arg in args]
    while args and args[0].startswith('-'):
        flag = args.pop(0)
        if flag in {'-s', '-t', '-H', '-P', '-L', '--one-device'}:
            args = args[1:]
        elif (len(flag) > 2 and flag[:2] in {'-s', '-t', '-H', '-P', '-L'}) or flag.startswith('--one-device='):
            continue
        elif flag not in {'-d', '-e', '-a', '--exit-on-write-error'}:
            return None
    if not args:
        return None
    verb, *rest = args
    if verb in {'install', 'uninstall', 'reboot'}:
        return 'state'
    if verb in {'forward', 'reverse'}:
        if rest and rest[0] in {'--list', '--remove', '--remove-all'}:
            return None
        if rest[:1] == ['--no-rebind']:
            rest = rest[1:]
        return 'forward' if len(rest) >= 2 else None
    if verb == 'shell':
        while rest and rest[0].startswith('-'):
            flag = rest.pop(0)
            if flag == '-e':
                rest = rest[1:]
            elif flag != '--' and not re.fullmatch(r'-[Ttnx]+', flag):
                return None
        mutates = _remote_mutates([_literal(w) for w in rest], stdin_documents=documents) if rest else any(_remote_mutates([body]) for body, _ in documents)
        return 'state' if mutates else None
    return None


def calls(command, inherited=None, depth=0, inherited_bodies=None):
    """Pair each mutating call with its own environment, never a sibling's args."""
    if depth > 8:
        return []
    env = dict(inherited or {})
    found, scopes = [], []
    uncertain, control_depth = False, 0
    list_env = stage_env = dict(env)
    pipeline = None
    for words, separator, documents, substitutions, bodies in _commands(command, inherited_bodies):
        control = list(words)
        while control and control[0] in {'then', 'else', 'do', 'elif', '!'}:
            control.pop(0)
        if control[:1] in [['if'], ['while'], ['until'], ['for'], ['case']]:
            control_depth += 1
        for body in substitutions:
            found.extend(calls(body, env, depth + 1, bodies))
        for body, quoted in documents:
            if not quoted:
                for sub in _substitutions(body):
                    found.extend(calls(sub, env, depth + 1))
        args, local = _unwrap(_argv(words), env)
        tool = None
        if args:
            tool = os.path.basename(_literal(args.pop(0)))
            if tool in {'export', 'unset'}:
                for arg in args:
                    arg = _literal(arg)
                    if tool == 'unset':
                        env.pop(arg, None)
                    elif ASSIGN.match(arg):
                        key, value = arg.split('=', 1)
                        if key in OWNER_KEYS:
                            if (uncertain or control_depth) and env.get(key) != _literal(value):
                                env.pop(key, None)
                            else:
                                env[key] = _literal(value)
            elif tool in {'sh', 'bash', 'zsh'}:
                payload, stdin = _shell_source(args)
                if payload is not None:
                    found.extend(calls(payload, local, depth + 1, bodies))
                if stdin:
                    for body, _ in documents:
                        found.extend(calls(body, local, depth + 1))
            elif tool == 'ph' and args[:2] == ['lease', 'run'] and '--' in args:
                split = args.index('--')
                opts = args[2:split]
                if '--owner' in opts and opts.index('--owner') + 1 < len(opts):
                    local['PH_LEASE_OWNER'] = _literal(opts[opts.index('--owner') + 1])
                    found.extend(calls(shlex.join([_literal(w) for w in args[split + 1:]]), local, depth + 1))
            elif tool in {'adb', '$ADB', '${ADB}'}:
                kind = _adb_kind(args, documents)
                if kind:
                    found.append((kind, local))
        elif words and all(ASSIGN.match(w) for w in words):
            env = {key: value for key, value in local.items() if not (uncertain or control_depth) or env.get(key) == value}
        if control[:1] in [['fi'], ['done'], ['esac']]:
            control_depth = max(0, control_depth - 1)
        if separator in {'(', '{'}:
            scopes.append((separator, dict(env), list_env, stage_env, pipeline))
            pipeline = None
            list_env = stage_env = dict(env)
        elif separator in {'|', '|&'}:
            pipeline = pipeline or dict(stage_env)
            env = dict(pipeline)
            stage_env = dict(env)
        else:
            if pipeline is not None:
                # Do not grant later calls a token exported only in a pipeline.
                env, pipeline = pipeline, None
            if separator == '&':
                env = dict(list_env)
            if separator in {')', '}'} and scopes:
                opening, parent, list_env, stage_env, pipeline = scopes.pop()
                # A brace may be an uncalled function body. Never let its
                # exports authorize commands outside that body.
                env = parent
            else:
                stage_env = dict(env)
                if separator in {';', '\n', '&'}:
                    list_env = dict(env)
        if separator in {'&&', '||'}:
            # Even `true` may be a function. Grants on a conditional path
            # cannot prove ownership for a later sibling command.
            uncertain = True
        elif separator in {';', '\n', '&', ')', '}'}:
            uncertain = False
    return found


def _read(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'rb') as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError('lock-file-type')
        raw = source.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError('lock-file-size')
    return raw.decode('utf8')


def _lease(path):
    for attempt in range(2):
        try:
            raw = _read(path)
            if raw is None:
                return None
            lease = json.loads(raw)
            if not isinstance(lease, dict) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,80}', lease['owner']):
                raise ValueError('lease-owner')
            acquired = dt.datetime.fromisoformat(lease['acquired_at'])
            expires = dt.datetime.fromisoformat(lease['expires_at'])
            if acquired.tzinfo is None or expires.tzinfo is None or expires <= acquired or not isinstance(lease['purpose'], str):
                raise ValueError('lease-fields')
            return lease if expires > dt.datetime.now(dt.timezone.utc) else None
        except (ValueError, TypeError, KeyError):
            if attempt:
                raise ValueError('lease-unavailable') from None
            time.sleep(0.05)


def classify(command, *, lock_dir=None, inherited=None):
    try:
        matches = calls(command, inherited if inherited is not None else {k: os.environ.get(k, '') for k in OWNER_KEYS})
    except (ValueError, AmbiguousScript):
        return dict(matched=False, reason=None, rule='phone-adb-unavailable', error='phone-lock-unavailable')
    if not matches:
        return dict(matched=False, reason=None, rule=None, error=None)
    kind = matches[0][0]
    rule = 'phone-adb-' + kind
    try:
        directory = Path(lock_dir or os.environ.get('PH_LOCK_DIR', '~/.local/share/phone-lock')).expanduser()
        hold = _read(directory / 'priority-hold')
        lease = None if hold is not None else _lease(directory / 'lease.json')
        for call_kind, env in matches:
            rule = 'phone-adb-' + call_kind
            if hold is not None:
                allowed = bool(hold.strip()) and env.get('PHONE_HOLD_OWNER') == hold.strip()
                owner, purpose, until = 'an owner request', 'priority hold', 'released'
            elif lease:
                allowed = lease['owner'] in (env.get('PH_LEASE_OWNER'), env.get('PHONE_HOLD_OWNER'))
                owner = lease['owner']
                purpose = ''.join(c for c in lease['purpose'] if c.isprintable())[:80]
                until = lease['expires_at']
            else:
                continue
            if not allowed:
                reason = (f"Phone is held by {owner} ({purpose}) until {until}. Yield, or run 'ph lease status'. "
                          "Prefix your adb call with PH_LEASE_OWNER=<your token> only if you hold the lease.")
                return dict(matched=True, reason=reason, rule=rule, error=None)
        return dict(matched=True, reason=None, rule=rule if hold is not None or lease else rule + '-unleased', error=None)
    except (OSError, ValueError, TypeError, KeyError, OverflowError, RuntimeError):
        return dict(matched=True, reason=None, rule='phone-adb-unavailable', error='phone-lock-unavailable')


if __name__ == '__main__':
    event = json.load(sys.stdin)
    print(json.dumps(classify(event['command'])))

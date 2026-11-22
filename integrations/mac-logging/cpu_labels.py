"""Bounded process labels and redacted spike commands; no argv in state."""
from pathlib import Path
import re
import shlex
import sys

SYSTEM_ROOTS = ('/System/', '/usr/libexec/', '/usr/sbin/', '/usr/bin/', '/sbin/',
                '/Library/Apple/', '/Library/SystemExtensions/')
SECRET_LABEL = re.compile(r'(?i)(password|secret|credential|token[=: ]|cookie|bearer |sk-|ghp_|github_pat_|xox[baprs]-)')


def spawn_family(argv, comm):
    """Allowlisted family labels; raw arguments never leave the sampler."""
    if any('agent-bridges' in a.split('/') for a in argv):
        return 'agent-bridges'
    if any('robob-watch' in a.split('/') for a in argv) and any('runner' in a for a in argv):
        return 'robob-watch runner'
    if argv and 'codex' in argv[0].lower() and 'app-server' in argv[1:]:
        return 'codex app-server'
    if comm.lower().startswith('claude'):
        return 'claude provider'
    if any('Robob.app/Contents/Resources' in a or '/robob/server/' in a for a in argv):
        return 'Robob server'
    return None


class SystemFamily(str):
    # Preserve provenance until the logger: long Apple executable basenames
    # otherwise look like opaque credentials to the shared argv redactor.
    pass


def janitor_redact(value):
    # Use the reviewed #45 helper, from this checkout or its installed location.
    source = Path(__file__).resolve().parents[1] / 'dev-resource-janitor/skill/scripts'
    if not source.is_dir():
        source = Path.home() / '.config/opencode/skills/dev-resource-janitor/scripts'
    sys.path.insert(0, str(source))
    try:
        from leftover_processes import redact
        return redact(value)
    finally:
        sys.path.pop(0)


def family(command):
    from toollog import SECRET

    if command.startswith('ssh: ') and command.endswith(' [mux]'):
        return 'ssh'
    home = ('/Users/' in command or '/home/' in command or str(Path.home()) in command
            or command.startswith('~'))
    name = Path(command).name
    if SECRET_LABEL.search(name) or SECRET.search(name):
        return '[redacted]'
    system = command.startswith(SYSTEM_ROOTS) and '..' not in Path(command).parts and not home
    if not system:
        try:
            name = janitor_redact(name)
        except (ImportError, OSError):
            return '[redacted]'
    if re.fullmatch(r'[Pp]ython(?:\d+(?:\.\d+)*)?', name):
        return 'python'
    if name.startswith('mds'):
        return 'mds*'
    if system:
        return SystemFamily(name)
    if home:
        return name
    # Nested helper bundles have their own basename (including Renderer/GPU).
    bundle = re.findall(r'/([^/]+)\.app/', command)
    try:
        return janitor_redact(bundle[-1] if bundle else name)
    except (ImportError, OSError):
        return '[redacted]'


def command_label(args):
    # cpu_fields imports this module, so load its shared guard at call time.
    from toollog import SECRET

    # The shared argv helper does not cover short cookie values or curl's
    # overloaded short auth flags. Check before opaque-token redaction can
    # erase the flag/header name but leave a short credential behind.
    if (SECRET.search(args) or SECRET_LABEL.search(args)
            or re.search(r'(?:^|[/\s\"\x27])curl\b', args)
            and re.search(r'''(?:^|[\s"'])(?:-(?!-)[^\s]*[uUb]|--(?:proxy-)?user\b)''', args)):
        return '[redacted]'
    try:
        value = janitor_redact(args)
    except (ImportError, OSError):
        return None
    # Redact before truncation, including paths inside quoted/inline programs.
    value = value.replace(str(Path.home()), '~')
    value = re.sub(r'/(?:Users|home)/[^\s/\"\x27]+', '~', value)
    return ''.join(c if c.isprintable() else ' ' for c in value)[:160]


def bounded_detail(value):
    # Error recovery must still work when the shared redactor is unavailable.
    label = command_label(value)
    return label[:200] if isinstance(label, str) else '[redacted]'


def script_hint(args):
    try:
        words = shlex.split(janitor_redact(args))
    except ValueError:
        return None
    skip = False
    module = False
    for word in words[1:]:
        if skip:
            skip = False
            continue
        if word in ('-c', '-e', '--eval', '--print', '-p') or word.startswith(('--eval=', '--print=', '-c', '-e', '-p')):
            return None  # Inline programs are contents, not script names.
        if word in ('-r', '--require', '--import', '--loader', '--experimental-loader', '-X', '-W'):
            skip = True
            continue
        if word == '-m':
            module = True
            continue
        if word.startswith('-'):
            continue
        if '[REDACTED]' in word or not word or '://' in word:
            return None
        if module:
            return word if re.fullmatch(r'[\w.]{1,72}', word) else None
        if not re.search(r'\.(?:[cm]?js|tsx?|jsx|py|sh)$', word) and '/' not in word:
            return None
        parts = word.split('/')
        for marker in ('ExternalSSD/', '.local/share/'):
            if marker in word:
                tail = word.split(marker, 1)[1].split('/')
                return '/'.join(tail) if len(tail) <= 2 else tail[0]+'/…/'+tail[-1]
        return parts[-1] or None
    return None

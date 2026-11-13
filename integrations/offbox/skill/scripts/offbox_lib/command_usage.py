"""Conservative command inspection for pre-command repair and post-command advice."""

import json
import re
import shlex
from dataclasses import dataclass
from pathlib import Path

from . import node_tools

JS_TOOLS = frozenset(('node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'vp', 'vpr',
                      'tsc', 'tsc-rs', 'vitest', 'jest', 'turbo', 'eslint', 'prettier')) | node_tools.REPO_LOCAL_TOOLS.keys()
GO_TOOLS = frozenset(('go', 'gofmt', 'gomobile'))
NON_JS = frozenset(('python', 'python2', 'python3', 'pytest', 'uv', 'uvx', 'pip', 'pip3',
                    'bash', 'sh', 'zsh', 'dash', 'docker', 'docker-compose', 'terraform',
                    'aws', 'git', 'curl', 'wget', 'true', 'false', ':', 'echo', 'printf',
                    'test', '[', 'pwd', 'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'sed',
                    'awk', 'mkdir', 'touch', 'sleep', 'exit', 'export', 'unset', 'set')) | GO_TOOLS
SHELLS = frozenset(('bash', 'sh', 'zsh', 'dash'))
UV_VALUE_OPTIONS = frozenset(('--with', '--with-editable', '--with-requirements', '--python', '-p',
                              '--project', '--directory', '--group', '--no-group', '--only-group',
                              '--extra', '--no-extra', '--package', '--env-file'))
INSTALL_VALUE_OPTIONS = frozenset(('--prefix', '-C', '--cwd', '--dir', '--cache', '--registry',
                                   '--userconfig', '--workspace', '-w', '--loglevel', '--location',
                                   '--filter', '-F', '--filter-prod'))
ASSIGNMENT = re.compile(r'^[A-Za-z_][A-Za-z_0-9]*=')


@dataclass(frozen=True)
class Segment:
    words: tuple[str, ...]
    cwd: Path


@dataclass(frozen=True)
class Usage:
    cwd: Path
    needs_go: bool
    uses_js: bool
    install: str
    packages: tuple[Path, ...]


def uv_options(words: list[str], cwd: Path) -> tuple[list[str], Path, bool]:
    uncertain = False
    while words and words[0].startswith('-'):
        option, words = words[0], words[1:]
        name, _, inline = option.partition('=')
        if name in UV_VALUE_OPTIONS or name == '--from':
            value = inline if '=' in option else (words[0] if words else '')
            if '=' not in option:
                words = words[1:]
            if name == '--directory':
                if value and not re.search(r'[$`~*?]', value):
                    cwd = (cwd / value).resolve()
                else:
                    uncertain = True
        elif option not in ('--frozen', '--locked', '--offline', '--no-sync', '--isolated', '--active', '--no-project', '--'):
            uncertain = True
    return words, cwd, uncertain


def segments(command: str, cwd: Path) -> tuple[list[Segment], bool]:
    """Unwrap only understood shell forms; opaque syntax retains conservative advice."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars="();<>|&\n")
    lexer.whitespace = ' \t\r'
    lexer.whitespace_split = True
    lexer.commenters = ''
    try:
        tokens = list(lexer)
    except ValueError:
        return [], True
    groups: list[list[str]] = [[]]
    uncertain = bool(re.search(r'\$\(|`', command))
    comment = False
    for token in tokens:
        if '\n' in token and set(token) <= set('\n;&|()'):
            comment = False
        elif comment:
            continue
        elif token.startswith('#'):
            # shlex removes quote information, so a quoted hash may be a literal.
            uncertain = True
            comment = True
            continue
        if (token in ('&&', '||', ';', '\n', '|', '|&', '&')
                or ('\n' in token and set(token) <= set('\n;&|'))):
            groups.append([])
        elif token and set(token) <= set('();<>|&{}\n'):
            uncertain = True
            groups.append([])
        else:
            groups[-1].append(token)
    result = []
    for words in groups:
        effective_cwd = cwd
        while words:
            if ASSIGNMENT.match(words[0]):
                words = words[1:]
            elif Path(words[0]).name in ('env', 'exec', 'command', 'corepack'):
                wrapper = Path(words[0]).name
                words = words[1:]
                if words[:1] == ['--']:
                    words = words[1:]
                if wrapper == 'corepack' and words and words[0].partition('@')[0] in JS_TOOLS:
                    words = [words[0].partition('@')[0], *words[1:]]
            elif Path(words[0]).name == 'timeout':
                words = words[1:]
                while words and words[0].startswith('-'):
                    option, words = words[0], words[1:]
                    if option in ('-s', '--signal', '-k', '--kill-after'):
                        words = words[1:]
                if words and re.fullmatch(r'[0-9]+(?:\.[0-9]+)?[smhd]?', words[0]):
                    words = words[1:]
                else:
                    uncertain = True
                    break
            elif Path(words[0]).name == 'uv' and 'run' in words[1:]:
                index = words.index('run', 1)
                _, effective_cwd, unknown = uv_options(words[1:index], effective_cwd)
                uncertain |= unknown
                words, effective_cwd, unknown = uv_options(words[index + 1:], effective_cwd)
                uncertain |= unknown
            elif Path(words[0]).name == 'uvx':
                words, effective_cwd, unknown = uv_options(words[1:], effective_cwd)
                uncertain |= unknown
            else:
                break
        if not words:
            continue
        first = Path(words[0]).name
        if first == 'cd':
            args = words[1:]
            while args and args[0] in ('-L', '-P', '-e'):
                args = args[1:]
            if args[:1] == ['--']:
                args = args[1:]
            if len(args) == 1 and not re.search(r'[$`~*?]', args[0]) and args[0] != '-':
                cwd = (cwd / args[0]).resolve()
                result.append(Segment((), cwd))
            else:
                uncertain = True
            continue
        if first in SHELLS and len(words) >= 3 and re.fullmatch(r'-[el]*c[el]*', words[1]):
            nested, unknown = segments(words[2], effective_cwd)
            result.extend(nested)
            uncertain |= unknown
            continue
        if re.search(r'[$`]', words[0]):
            uncertain = True
        result.append(Segment(tuple(words), effective_cwd))
    return result, uncertain


def nearest_package(cwd: Path, root: Path) -> Path | None:
    while cwd.is_relative_to(root):
        if (cwd / 'package.json').exists():
            return cwd
        if cwd == root:
            break
        cwd = cwd.parent
    return None


def has_dependencies(package: Path) -> bool:
    try:
        manifest = json.loads((package / 'package.json').read_text())
        if not isinstance(manifest, dict):
            return True
        return any(manifest.get(field, {}) != {} for field in
                   ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'))
    except (OSError, ValueError):
        return True


def inspect(root: Path, rel: str, argv: list[str], steps: list[str] | None = None) -> Usage:
    root = root.resolve()
    cwd = (root / rel).resolve()
    parsed = []
    uncertain = False
    for command in steps or [argv[0] if len(argv) == 1 else shlex.join(argv)]:
        found, unknown = segments(command, cwd)
        parsed.extend(found)
        uncertain |= unknown
    needs_go = uncertain or any((folder / name).exists() for folder in (root, cwd)
                                for name in ('go.mod', 'go.work'))
    uses_js = uncertain
    install = ''
    packages = []
    js_command_seen = False
    for segment in parsed:
        needs_go |= any((segment.cwd / name).exists() for name in ('go.mod', 'go.work'))
        if not segment.words:
            continue
        first = Path(segment.words[0]).name
        js = first in JS_TOOLS or 'node_modules/.bin/' in segment.words[0]
        non_js = first in NON_JS or bool(re.fullmatch(r'python[23](?:\.[0-9]+)?', first))
        script = first in SHELLS or first.endswith(('.sh', '.bash', '.py'))
        needs_go |= (first in GO_TOOLS or (not js and (script or not non_js))
                     or (js and any(Path(word).name in GO_TOOLS for word in segment.words[1:])))
        uses_js |= js or (not non_js and not script)
        if js or (not non_js and not script):
            js_command_seen = True
            package = nearest_package(segment.cwd, root)
            if package and has_dependencies(package) and package not in packages:
                packages.append(package)
        args = list(segment.words[1:])
        while args and args[0].startswith('-'):
            option, args = args[0], args[1:]
            if option in INSTALL_VALUE_OPTIONS:
                args = args[1:]
        second = args[0] if args else ''
        if ((first == 'npm' and second in ('ci', 'install', 'i')) or
            (first in ('pnpm', 'bun', 'vp') and second in ('install', 'i')) or
            (first == 'yarn' and second in ('', 'install'))):
            install = install or ' '.join((first, second)).strip()
    if uncertain and not js_command_seen:
        package = nearest_package(parsed[-1].cwd if parsed else cwd, root)
        if package and has_dependencies(package) and package not in packages:
            packages.append(package)
    return Usage(cwd, needs_go, uses_js, install, tuple(packages))

"""Conservative command inspection for pre-command repair and post-command advice."""

import json
import re
import shlex
from dataclasses import dataclass
from pathlib import Path

from . import node_tools

JS_TOOLS = frozenset(('node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'corepack', 'vp', 'vpr',
                      'vite', 'vitest', 'jest', 'tsc', 'tsc-rs', 'tsx', 'ts-node', 'turbo', 'nx', 'deno',
                      'playwright', 'eslint', 'prettier', 'biome')) | node_tools.REPO_LOCAL_TOOLS.keys()
JS_WORD = re.compile(r'(?<![A-Za-z0-9_.-])(?:' + '|'.join(map(re.escape, sorted(JS_TOOLS)))
                     + r')(?![A-Za-z0-9_.-])')
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
MANAGER_DIRECTORIES = {'npm': {'--prefix'}, 'pnpm': {'--dir', '-C'},
                       'yarn': {'--cwd'}, 'bun': {'--cwd'}}
ASSIGNMENT = re.compile(r'^[A-Za-z_][A-Za-z_0-9]*=')


def shell_substitution(command: str, start: int) -> tuple[int, str] | None:
    """Keep nested syntax and comments from becoming commands in the enclosing shell."""
    backtick = command[start] == '`'
    index, depth, quote, word_start = start + (1 if backtick else 2), 1, '', True
    source = ['`' if backtick else '$(']
    while index < len(command):
        char = command[index]
        if quote != "'" and command[index:index + 2] == '${':
            return None
        if not quote and ((word_start and re.match(r'case(?:\s|$)', command[index:]))
                          or command[index:index + 2] in ('<<', '[[')):
            return None
        if char == '\\' and quote != "'" and index + 1 < len(command):
            if command[index + 1] == '\n':
                return None  # A continuation can hide a reserved word or parameter boundary.
            source.append(command[index:index + 2])
            word_start = command[index + 1] == '\n' and word_start
            index += 2
            continue
        if backtick and char == '`':
            return index + 1, ''.join(source) + '`'
        if quote != "'" and (char == '`' or command[index:index + 2] == '$('):
            nested = shell_substitution(command, index)
            if nested is None:
                return None
            index, text = nested
            source.append(text)
            word_start = False
            continue
        if quote:
            source.append(char)
            if char == quote:
                quote = ''
        elif char in ("'", '"'):
            quote = char
            source.append(char)
            word_start = False
        elif char == '#' and word_start:
            end = command.find('\n', index)
            index = len(command) if end == -1 else end
            continue
        else:
            source.append(char)
            if not backtick and char == '(':
                depth += 1
            elif not backtick and char == ')':
                depth -= 1
                if not depth:
                    return index + 1, ''.join(source)
            word_start = char in ' \t\n;|&()<>'
        index += 1
    return None


def shell_source(command: str, js_sources: list[str] | None = None) -> tuple[str, bool]:
    # shlex treats an unquoted hash inside a word as a comment, unlike Bash. Strip only real comments here,
    # and remove numeric redirection descriptors while their adjacency is still available.
    source = []
    quote = ''
    word_start = True
    substitutions = False
    index = 0
    while index < len(command):
        char = command[index]
        if char == "\\" and quote != "'" and index + 1 < len(command):
            source.append(command[index:index + 2])
            if command[index + 1] != "\n":
                word_start = False
            index += 2
            continue
        if quote != "'" and (char == '`' or (char == '$' and command[index:index + 2] == '$(')):
            substitutions = True
            # Keep substitutions within one word: their spaces and separators do not belong to this shell.
            nested = shell_substitution(command, index)
            if nested is None:
                raise ValueError('opaque shell substitution')
            end, text = nested
            if js_sources is not None:
                js_sources.append(text)
            source.append('$(...)' if quote else shlex.quote('$(...)'))
            word_start = False
            index = end
            continue
        if quote:
            source.append(char)
            if char == quote:
                quote = ''
        elif char in ("'", '"'):
            quote = char
            source.append(char)
            word_start = False
        elif char == '#' and word_start:
            end = command.find('\n', index)
            index = len(command) if end == -1 else end
            continue
        elif char.isdigit() and word_start:
            end = index
            while end < len(command) and command[end].isdigit():
                end += 1
            if end < len(command) and command[end] in '<>':
                index = end
                continue
            source.append(char)
            word_start = False
        else:
            source.append(char)
            word_start = char in ' \t\n;|&()<>'
        index += 1
    return ''.join(source), substitutions


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


def manager_directory(words: list[str], cwd: Path) -> tuple[Path, bool]:
    manager = Path(words[0]).name
    options = MANAGER_DIRECTORIES.get(manager, ())
    target, uncertain, index, installing = cwd, False, 1, False
    while options and index < len(words):
        option = words[index]
        if option == '--':
            break
        if not option.startswith('-'):
            if manager != 'npm' and not installing and option not in ('install', 'i', 'ci'):
                break
            installing = True
            index += 1
            continue
        name, sep, value = option.partition('=')
        if '-C' in options and option.startswith('-C') and option != '-C':
            name, sep, value = '-C', '=', option[2:].removeprefix('=')
        index += 1
        if name in options:
            if not sep:
                value = words[index] if index < len(words) else ''
                index += 1
            if value and (sep or not value.startswith('-')) and not re.search(r'[$`~*?]', value):
                target = (cwd / value).resolve()
            else:
                uncertain = True
        elif name in INSTALL_VALUE_OPTIONS and not sep:
            index += 1
    return target, uncertain


def segments(command: str, cwd: Path, js_sources: list[str] | None = None) -> tuple[list[Segment], bool, bool]:
    """Unwrap only understood shell forms; opaque syntax retains conservative advice."""
    js_sources = [] if js_sources is None else js_sources
    substitution_sources = []
    try:
        command, substitutions = shell_source(command, substitution_sources)
        lexer = shlex.shlex(command, posix=True, punctuation_chars="();<>|&\n")
        lexer.whitespace = ' \t\r'
        lexer.whitespace_split = True
        lexer.commenters = ''
        tokens = list(lexer)
    except ValueError:
        js_sources.append(command)
        return [], True, True
    sanitized_substitutions = []
    for source in substitution_sources:
        body = source[1:-1] if source.startswith('`') else source[2:-1]
        segments(body, cwd, sanitized_substitutions)
    js_sources.extend(sanitized_substitutions)
    groups: list[list[str]] = [[]]
    uncertain = any(JS_WORD.search(source) for source in sanitized_substitutions)
    go_uncertain = substitutions
    redirect = False
    for token in tokens:
        if redirect:
            uncertain |= bool(re.search(r'\$\(|`', token))
            redirect = False
            continue
        if token in ('>', '>>', '<', '<>', '>&', '<&', '>|', '&>', '&>>'):
            # A redirection target is not an executable. Keep repair conservative without inventing JS usage.
            go_uncertain = True
            redirect = True
            continue
        if (token in ('&&', '||', ';', '\n', '|', '|&', '&')
                or ('\n' in token and set(token) <= set('\n;&|'))):
            groups.append([])
        elif token and set(token) <= set('();<>|&{}\n'):
            uncertain = True
            groups.append([])
        else:
            groups[-1].append(token)
    uncertain |= redirect
    result = []
    for words in groups:
        # These keywords delimit commands; a for header's word list never executes.
        while words and words[0] in ('do', 'done', 'if', 'then', 'elif', 'else', 'fi', 'while', 'until', '!'):
            words = words[1:]
        if words[:1] == ['for']:
            js_sources.append(shlex.join(words))
            if len(words) < 3 or words[2] != 'in':
                uncertain = True
            continue
        if words[:1] == ['set']:
            js_sources.append(shlex.join(words))
            continue
        original_words = words
        effective_cwd = cwd
        while words:
            if ASSIGNMENT.match(words[0]):
                words = words[1:]
            elif Path(words[0]).name in ('env', 'exec', 'command', 'corepack'):
                wrapper = Path(words[0]).name
                remaining = words[1:]
                if remaining[:1] == ['--']:
                    remaining = remaining[1:]
                if wrapper == 'corepack' and (not remaining or remaining[0].partition('@')[0] not in JS_TOOLS):
                    break
                words = remaining
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
        # Wrapper arguments execute in this shell; a shell -c body is inspected recursively below.
        prefix = original_words[:len(original_words) - len(words)]
        uncertain |= any(re.search(r'\$\(|`', word) and (not ASSIGNMENT.match(word) or JS_WORD.search(word))
                         for word in prefix)
        if not words:
            js_sources.append(shlex.join(original_words))
            continue
        first = Path(words[0]).name
        if first == 'cd':
            js_sources.append(shlex.join(original_words))
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
            # Child comments are sanitized by the child parser; do not scan its raw quoted body again.
            js_sources.append(shlex.join([*prefix, *words[:2], *words[3:]]))
            uncertain |= any(re.search(r'\$\(|`', word) for word in (*words[:2], *words[3:]))
            nested, unknown, nested_go = segments(words[2], effective_cwd, js_sources)
            result.extend(nested)
            uncertain |= unknown
            go_uncertain |= nested_go
            continue
        js_sources.append(shlex.join(original_words))
        if first in ('eval', 'source', '.') or re.search(r'[$`]', words[0]) or any(re.search(r'\$\(|`', word) for word in words):
            uncertain = True
        effective_cwd, unknown = manager_directory(words, effective_cwd)
        uncertain |= unknown
        result.append(Segment(tuple(words), effective_cwd))
    return result, uncertain, go_uncertain or uncertain


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
    go_uncertain = False
    js_sources = []
    commands = steps or [argv[0] if len(argv) == 1 else shlex.join(argv)]
    for command in commands:
        found, unknown, unknown_go = segments(command, cwd, js_sources)
        parsed.extend(found)
        uncertain |= unknown
        go_uncertain |= unknown_go
    needs_go = go_uncertain or any((folder / name).exists() for folder in (root, cwd)
                                for name in ('go.mod', 'go.work'))
    uses_js = uncertain and any(JS_WORD.search(source) for source in js_sources)
    install = ''
    packages = []
    js_command_seen = False
    for segment in parsed:
        needs_go |= any((segment.cwd / name).exists() for name in ('go.mod', 'go.work'))
        if not segment.words:
            continue
        first = Path(segment.words[0]).name
        js = (first in JS_TOOLS or 'node_modules/.bin/' in segment.words[0]
              or first.endswith(('.js', '.mjs', '.cjs', '.ts')))
        non_js = first in NON_JS or bool(re.fullmatch(r'python[23](?:\.[0-9]+)?', first))
        script = first in SHELLS or first.endswith(('.sh', '.bash', '.py'))
        needs_go |= (first in GO_TOOLS or (not js and (script or not non_js))
                     or (js and any(Path(word).name in GO_TOOLS for word in segment.words[1:])))
        uses_js |= js
        if js:
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
    if uses_js and uncertain and not js_command_seen:
        package = nearest_package(parsed[-1].cwd if parsed else cwd, root)
        if package and has_dependencies(package) and package not in packages:
            packages.append(package)
    return Usage(cwd, needs_go, uses_js, install, tuple(packages))

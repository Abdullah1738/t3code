"""Install hints from repository metadata. Never executes a manager or changes a repo."""
import json
import re
from pathlib import Path

KEY = r"(?:[\w-]+|'(?:[^']|'')*'|\"(?:[^\"\\]|\\.)*\")"

VERSION = r"\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?"
PNPM_DESCRIPTOR = re.compile(r"^v?\d+(?:(?:\.\d+){0,2}|(?:\.\d+)?\.(?:x|\*))"
                             r"(?:\+sha(?:224|256|384|512)\.[a-zA-Z0-9+/=]+)?$")


def supported_pnpm_descriptor(pin):
    return isinstance(pin, str) and PNPM_DESCRIPTOR.fullmatch(pin) is not None


def read(path):
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return ""


def quote_end(text, quote, start=0):
    i = start
    while i < len(text):
        if quote == '"' and text[i] == "\\":
            i += 2
            continue
        if text[i] == quote:
            if quote == "'" and text[i:i + 2] == "''":
                i += 2
                continue
            return i
        i += 1
    return None


def starts_quote(text, index):
    # A colon within a plain scalar is not a separator: pnpm:'s-home is plain text.
    prefix = text[:index].rstrip()
    if text[index] not in ("'", '"'):
        return False
    if not prefix or prefix[-1] in '{[,':
        return True
    if prefix[-1] != ':':
        return False
    if text[index - 1].isspace():
        return True
    # JSON-style compact quoted-key mappings allow a value immediately after the colon.
    return re.search(r"(?:^|[,{])\s*(?:\"(?:[^\"\\]|\\.)*\"|'(?:[^']|'')*')\s*:$", prefix) is not None


def without_comments(text):
    out = []
    i = 0
    while i < len(text):
        char = text[i]
        if starts_quote(text, i):
            end = quote_end(text, char, i + 1)
            if end is None:
                out.append(text[i:])
                break
            out.append(text[i:end + 1])
            i = end + 1
        elif char == '#' and (i == 0 or text[i - 1].isspace() or text[i - 1] in ',{['):
            end = text.find('\n', i)
            if end == -1:
                break
            i = end
        else:
            out.append(char)
            i += 1
    return ''.join(out)


def flow_end(text):
    depth = i = 0
    while i < len(text):
        char = text[i]
        if starts_quote(text, i):
            end = quote_end(text, char, i + 1)
            if end is None:
                return None
            i = end + 1
            continue
        if char in '{[':
            depth += 1
        elif char in '}]':
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return None


def config_lines(text):
    """Hide multiline scalar contents: shell/heredoc examples are not configuration."""
    lines = []
    scalar_indent = None
    quote = None
    flow = None
    pending = None
    for line in text.splitlines():
        indent = len(line) - len(line.lstrip())
        if flow is not None:
            prefix, value = flow
            value += '\n' + line
            clean = without_comments(value)
            if flow_end(clean) is not None:
                lines.append(prefix + clean.replace('\n', ' '))
                flow = None
            else:
                flow = (prefix, value)
                lines.append('')
            continue
        if quote:
            if quote_end(line, quote) is not None:
                quote = None
            lines.append('')
            continue
        if scalar_indent is not None:
            if not line.strip() or indent > scalar_indent:
                lines.append('')
                continue
            scalar_indent = None
        if pending is not None and line.strip() and not line.lstrip().startswith('#'):
            parent_indent, prefix = pending
            pending = None
            if indent > parent_indent and not re.match(rf"^\s*(?:-(?:\s|$)|{KEY}\s*:)", line):
                value = line.strip()
                if re.match(r"^(?:['\"]?\$\{\{|[*&!])", value):
                    lines.append(prefix + value)
                    continue
                if value[0] in '{[':
                    clean = without_comments(value)
                    if flow_end(clean) is None:
                        flow = (prefix, value)
                        lines.append('')
                    else:
                        lines.append(prefix + clean)
                    continue
                if value[0] in ("'", '"') and quote_end(value, value[0], 1) is None:
                    quote = value[0]
                scalar_indent = parent_indent
                lines.append(prefix + value)
                continue
        lines.append(line)
        mapping = re.match(rf"^\s*(?:-\s+)?{KEY}\s*:\s*(.*)$", line)
        if not mapping:
            continue
        value = mapping[1]
        dash = re.match(r"^\s*-\s+", line)
        key_indent = dash.end() if dash else indent
        # An anchor alone decorates a nested mapping; it is not a plain scalar body.
        if not value or value.startswith('#') or re.fullmatch(r"&[^\s]+\s*(?:#.*)?", value):
            pending = (key_indent, line[:mapping.start(1)])
            continue
        if value[0] in ("'", '"'):
            if quote_end(value, value[0], 1) is None:
                quote = value[0]
        elif value[0] in '{[':
            clean = without_comments(value)
            if flow_end(clean) is None:
                flow = (line[:mapping.start(1)], value)
                lines[-1] = ''
            else:
                lines[-1] = line[:mapping.start(1)] + clean
        else:
            # Plain scalar continuations and literal/folded blocks both stay opaque.
            scalar_indent = key_indent
    return lines


def flow_fields(text):
    """Top-level comma-separated entries; quoted/nested values stay in their entry."""
    start = i = depth = 0
    while i < len(text):
        char = text[i]
        if starts_quote(text, i):
            end = quote_end(text, char, i + 1)
            if end is None:
                return
            i = end + 1
            continue
        if char in '{[':
            depth += 1
        elif char in '}]':
            depth -= 1
        elif char == ',' and depth == 0:
            yield text[start:i]
            start = i + 1
        i += 1
    yield text[start:]


def declared_manager(root):
    try:
        manifest = json.loads(read(Path(root) / "package.json"))
    except ValueError:
        return None
    pin = manifest.get("packageManager") if isinstance(manifest, dict) else None
    return re.fullmatch(r"(pnpm|yarn|npm|bun)@(.+)", pin) if isinstance(pin, str) else None


def version_note(root):
    pin = declared_manager(root)
    if pin and not re.fullmatch(VERSION, pin[2]):
        return f" packageManager declares {pin[1]} with a non-numeric descriptor; inspect its version and CI install flags before running."
    if pin and pin[1] in {"npm", "bun"}:
        return f" Use {pin[1]} {pin[2]} from package.json packageManager (check {pin[1]} --version first)."
    if not pin and (Path(root) / 'pnpm-lock.yaml').is_file() and ci_pnpm_selection(root)[1]:
        return " CI pnpm version is ambiguous; inspect the setup version expressions and CI pins before choosing <repo-install>."
    return ""


def ci_pnpm_version(root):
    return ci_pnpm_selection(root)[0]


def ci_lines(text):
    """Expose flow step/env keys to the same scan used for block mappings."""
    def entries(value):
        end = flow_end(value)
        return [field.strip() for field in flow_fields(value[1:end]) if field.strip()] if end is not None else []

    out = []
    pending_step = None
    empty_step = None
    for line in config_lines(text):
        if re.fullmatch(r"\s*-\s*(?:#.*)?", line):
            empty_step = len(line) - len(line.lstrip())
            continue
        if empty_step is not None:
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            indent = len(line) - len(line.lstrip())
            if indent > empty_step:
                line = ' ' * empty_step + '-' + ' ' * (indent - empty_step - 1) + line.lstrip()
            empty_step = None
        if pending_step:
            indent, value = pending_step
            value = without_comments(value + '\n' + line)
            if flow_end(value) is None:
                pending_step = (indent, value)
                continue
            line = indent + '- ' + value.replace('\n', ' ')
            pending_step = None
        step = re.match(r"^(\s*)-\s+(\{.*)$", line)
        if step and flow_end(step[2]) is None:
            pending_step = (step[1], step[2])
            continue
        fields = entries(step[2]) if step and flow_mapping(step[2]) is not None else []
        if fields:
            indent = step[1]
            expanded = [indent + '- ' + fields[0]] + [indent + '  ' + field for field in fields[1:]]
        else:
            expanded = [line]
        for item in expanded:
            env = re.match(r"^(\s*(?:-\s+)?)(['\"]?env['\"]?)\s*:\s*(\{.*)$", item)
            fields = entries(env[3]) if env and flow_mapping(env[3]) is not None else []
            if fields:
                out.append(env[1] + env[2] + ':')
                out.extend(' ' * (len(env[1]) + 2) + field for field in fields)
            else:
                out.append(item)
    return out


def flow_mapping(value):
    value = re.sub(r"^(?:[&!][^\s]+\s+)+", '', value.strip())
    if not value.startswith('{'):
        return None
    end = flow_end(value)
    if end is None:
        return None
    pairs = []
    for field in flow_fields(value[1:end]):
        if not field.strip():
            continue
        match = re.fullmatch(rf"\s*({KEY})\s*:\s*(.*)", field)
        if not match or '\\' in match[1]:
            return None
        pairs.append((match[1].strip('\"\''), match[2]))
    return pairs


def flow_env_needs_inspection(value):
    env = flow_mapping(value)
    return env is None or any(name == 'PNPM_VERSION' for name, _ in env)


def flow_job_needs_inspection(value):
    pairs = flow_mapping(value)
    if pairs is None:
        return True
    for key, setting in pairs:
        if key == 'env':
            if flow_env_needs_inspection(setting):
                return True
        if key == 'steps':
            if not setting.startswith('[') or flow_end(setting) is None:
                return True
            for step in flow_fields(setting[1:flow_end(setting)]):
                fields = flow_mapping(step)
                if fields is None or any(name == 'uses' or
                                         name == 'env' and flow_env_needs_inspection(value)
                                         for name, value in fields):
                    return True
    return False


def env_scope(path):
    return (not path or path == ['steps'] or
            len(path) == 2 and path[0] == 'jobs' or
            len(path) == 3 and path[0] == 'jobs' and path[2] == 'steps')


def ci_pnpm_pin(root):
    """(literal version, needs inspection, source); only direct literal env references resolve."""
    versions = set()
    sources = set()

    def record(value, source="ci pnpm/action-setup"):
        sources.add(source)
        literal = re.fullmatch(rf"\s*['\"]?({VERSION})['\"]?\s*", value)
        # An unresolved expression must not disappear while an unrelated literal survives.
        versions.add(literal[1] if literal else None)

    workflows = root / ".github/workflows"
    for path in sorted([*workflows.glob("*.yml"), *workflows.glob("*.yaml")]):
        lines = [without_comments(line) for line in ci_lines(read(path))]
        steps_indent = sequence_indent = None
        parents = []
        env_values = {}
        references = []

        def action_version(value, context):
            reference = re.fullmatch(
                r"\s*(['\"]?)\$\{\{\s*env(?:\.PNPM_VERSION|\[\s*(['\"])PNPM_VERSION\2\s*\])\s*\}\}\1\s*",
                value)
            if reference:
                references.append(context)
            else:
                record(value)

        for i, line in enumerate(lines):
            if not line.strip():
                continue
            # Explicit/decorated keys and merges can hide a narrower env override.
            if re.match(rf"^\s*(?:-\s+)?(?:\?(?:\s|$)|<<\s*:|"
                        rf"(?:[!&][^\s]+\s+)+(?:{KEY}|<<)\s*:|\*[^\s:]+\s*:)", line):
                record('unsupported configuration key')
            step = re.match(r"^(\s*)-\s+", line)
            if step:
                # A sequence item is its own scope, even when steps use indentless YAML.
                column = len(step[1]) + 1
                while parents and parents[-1][0] >= column:
                    parents.pop()
                parents.append((column, None, i))
                step_context = tuple(index for _, _, index in parents)
            mapping = re.match(rf"^(\s*)(?:-\s+)?({KEY})\s*:\s*(.*)", line)
            if mapping:
                column, key, value = mapping.start(2), mapping[2].strip('\"\''), mapping[3]
                while parents and parents[-1][0] >= column:
                    parents.pop()
                path = [name for _, name, _ in parents if name is not None]
                if '\\' in mapping[2]:
                    record('unsupported escaped configuration key')
                if key == '<<':
                    record('unsupported merge key')
                if key == 'PNPM_VERSION' and path and path[-1] == 'env' and env_scope(path[:-1]):
                    record(value, "ci PNPM_VERSION")
                    env_values[tuple(index for _, _, index in parents[:-1])] = value
                if key == 'env' and env_scope(path) and value and (
                    not value.startswith('{') or flow_env_needs_inspection(value)
                ):
                    record('unresolved env mapping')
                if key == 'jobs' and not path and value:
                    jobs = flow_mapping(value)
                    if jobs is None or any(flow_job_needs_inspection(job) for _, job in jobs):
                        record('unresolved flow jobs')
                if path == ['jobs'] and value and flow_job_needs_inspection(value):
                    record('unresolved flow job')
                if key == 'steps' and (not path or len(path) == 2 and path[0] == 'jobs'):
                    if value and value != '[]':
                        record('unresolved steps container')
                    else:
                        steps_indent, sequence_indent = column, None
                    parents.append((column, key, i))
                    continue
                parents.append((column, key, i))
            indent = len(line) - len(line.lstrip())
            if steps_indent is not None and (indent < steps_indent or (indent == steps_indent and not step)):
                steps_indent = sequence_indent = None
            if not step or steps_indent is None:
                continue
            sequence_indent = indent if sequence_indent is None else sequence_indent
            if indent != sequence_indent:
                continue
            if re.match(r"[*&!{]", line[step.end():]):
                record('unresolved step properties')
                continue
            key_indent = step.end()
            # YAML mapping order is irrelevant: inspect the whole step, including with before uses.
            block = [" " * key_indent + line[step.end():]]
            for following in lines[i + 1:]:
                if following.strip() and not following.lstrip().startswith('#') and (
                    len(following) - len(following.lstrip()) <= indent
                ):
                    break
                block.append(following)
            action = rf"^ {{{key_indent}}}['\"]?uses['\"]?\s*:\s*(['\"]?)pnpm/action-setup@[^\s'\"]+\1\s*(?:#.*)?$"
            for item in block:
                uses = re.match(rf" {{{key_indent}}}['\"]?uses['\"]?\s*:\s*(.*)", item)
                if uses:
                    value = uses[1].strip()
                    literal = re.fullmatch(r"(?:'[^']*'|\"[^\"]*\"|[^\s'\"]+)", value)
                    if not literal or '\\' in value or re.match(r"(?:[*&!|>]|['\"]?\$\{\{)", value):
                        record('unresolved setup action')
            if not any(re.fullmatch(action, item) for item in block):
                continue
            in_with = False
            with_child_indent = None
            for item in block:
                mapping = re.fullmatch(rf" {{{key_indent}}}['\"]?with['\"]?\s*:\s*(.*)", item)
                if mapping:
                    value = without_comments(mapping[1]).strip()
                    if value and not value.startswith('{'):
                        record('unresolved setup mapping')
                inline = re.match(rf" {{{key_indent}}}['\"]?with['\"]?\s*:\s*(\{{.*)", item)
                if inline:
                    settings = flow_mapping(inline[1])
                    if settings is None:
                        record('unsupported setup mapping')
                    else:
                        for name, value in settings:
                            if name == 'version':
                                action_version(value, step_context)
                if re.fullmatch(rf" {{{key_indent}}}['\"]?with['\"]?\s*:\s*(?:#.*)?", item):
                    in_with = True
                    with_child_indent = None
                    continue
                if item.strip() and not item.lstrip().startswith('#') and (
                    len(item) - len(item.lstrip()) <= key_indent
                ):
                    in_with = False
                if in_with and item.strip() and not item.lstrip().startswith('#'):
                    with_child_indent = with_child_indent or len(item) - len(item.lstrip())
                    match = re.fullmatch(rf" {{{with_child_indent}}}['\"]?version['\"]?\s*:\s*(.*)", item)
                    if match:
                        action_version(without_comments(match[1]), step_context)
        # Env can appear after steps/with. Resolve only ancestors of this exact action;
        # another job, step or workflow cannot supply a missing env value.
        for context in references:
            value = next((env_values[context[:size]] for size in range(len(context), -1, -1)
                          if context[:size] in env_values), 'unresolved PNPM_VERSION reference')
            record(value, "ci PNPM_VERSION")
    needs_inspection = None in versions or len(versions) > 1
    source = "ci PNPM_VERSION" if "ci PNPM_VERSION" in sources else "ci pnpm/action-setup"
    return (next(iter(versions)) if len(versions) == 1 and not needs_inspection else None,
            needs_inspection, source)


def ci_pnpm_selection(root):
    version, needs_inspection, _ = ci_pnpm_pin(root)
    return version, needs_inspection


def pnpm_selection(root, *, ci_root=None):
    """One pin policy for install hints and remote activation; an empty pin needs inspection."""
    root = Path(root)
    if (root / 'package.json').is_file():
        try:
            if not isinstance(json.loads(read(root / 'package.json')), dict):
                return '', 'invalid package.json'
        except ValueError:
            return '', 'invalid package.json'
    declaration = declared_manager(root)
    if declaration:
        return (declaration[2], 'packageManager') if declaration[1] == 'pnpm' else None
    lock = root / 'pnpm-lock.yaml'
    if not lock.is_file():
        return None
    version, needs_inspection, source = ci_pnpm_pin(Path(ci_root) if ci_root is not None else root)
    if needs_inspection:
        return '', 'ambiguous CI pnpm version'
    if version:
        return version, source
    match = re.search(r"^lockfileVersion:\s*[\"']?([^\s\"'#]+)", read(lock), re.M)
    lock_version = match[1] if match else '?'
    # Lockfile 9 spans pnpm 9/10/11; only the fallback is capped to retain package.json overrides.
    return {'9': '10', '6': '8', '5': '7'}.get(lock_version.split('.')[0], ''), f'lockfile {lock_version}'


def install_command(root):
    root = Path(root)
    try:
        manifest = json.loads(read(root / "package.json"))
    except ValueError:
        manifest = {}
    if not isinstance(manifest, dict):
        manifest = {}
    pin = manifest.get("packageManager")
    match = re.fullmatch(rf"(pnpm|yarn|npm|bun)@({VERSION})", pin) if isinstance(pin, str) else None
    declaration = declared_manager(root)
    manager, version = match.groups() if match else (declaration[1], None) if declaration else (None, None)
    if manager is None:
        manager = next((pm for names, pm in (
            (("pnpm-lock.yaml",), "pnpm"), (("yarn.lock",), "yarn"),
            (("bun.lock", "bun.lockb"), "bun"),
            (("package-lock.json", "npm-shrinkwrap.json"), "npm"),
        ) if any((root / name).is_file() for name in names)), "npm")
    if manager == "pnpm":
        selection = pnpm_selection(root)
        if selection:
            version = selection[0]
            if not supported_pnpm_descriptor(version):
                return '<repo-install>'
        return f"corepack pnpm{'@' + version if version else ''} install --frozen-lockfile"
    if manager == "yarn":
        modern = int(re.match(r'\d+', version)[0]) >= 2 if version else (
            "__metadata:" in read(root / "yarn.lock") or (root / ".yarnrc.yml").is_file())
        return f"corepack yarn{'@' + version if version else ''} install " + (
            "--immutable" if modern else "--frozen-lockfile")
    if manager == "bun":
        return "bun install --frozen-lockfile"
    # npm is not normally a Corepack shim; use the selected Node's npm, with its pin in the hint.
    return "npm ci" if declaration or any((root / name).is_file() for name in ("package-lock.json", "npm-shrinkwrap.json")) else "npm install"

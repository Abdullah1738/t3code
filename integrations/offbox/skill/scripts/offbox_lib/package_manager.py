"""Install hints from repository metadata. Never executes a manager or changes a repo."""
import json
import re
from pathlib import Path

KEY = r"(?:[\w-]+|'(?:[^']|'')*'|\"(?:[^\"\\]|\\.)*\")"

VERSION = r"\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?"


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
            if indent > parent_indent and not re.match(rf"^\s*(?:-\s+|{KEY}\s*:)", line):
                value = line.strip()
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
                lines.append('')
                continue
        lines.append(line)
        mapping = re.match(rf"^\s*(?:-\s+)?{KEY}\s*:\s*(.*)$", line)
        if not mapping:
            continue
        value = mapping[1]
        dash = re.match(r"^\s*-\s+", line)
        key_indent = dash.end() if dash else indent
        if not value or value.startswith('#'):
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
    return ""


def ci_pnpm_version(root):
    """Only unambiguous literal pins; expressions/matrices need human inspection."""
    versions = set()
    workflows = root / ".github/workflows"
    for path in sorted([*workflows.glob("*.yml"), *workflows.glob("*.yaml")]):
        lines = config_lines(read(path))
        text = "\n".join(lines)
        for match in re.finditer(rf"(?m)^\s*['\"]?PNPM_VERSION['\"]?\s*:\s*['\"]?({VERSION})['\"]?\s*(?:#.*)?$", text):
            versions.add(match[1])
        for i, line in enumerate(lines):
            step = re.match(r"^(\s*)-\s+", line)
            if not step:
                continue
            indent = len(step[1])
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
            if not any(re.fullmatch(action, item) for item in block):
                continue
            in_with = False
            with_child_indent = None
            for item in block:
                inline = re.match(rf" {{{key_indent}}}['\"]?with['\"]?\s*:\s*(\{{.*)", item)
                if inline:
                    end = flow_end(inline[1])
                    fields = inline[1][1:end] if end is not None else ''
                    for field in flow_fields(fields):
                        literal = re.fullmatch(rf"\s*['\"]?version['\"]?\s*:\s*['\"]?({VERSION})['\"]?\s*", field)
                        if literal:
                            versions.add(literal[1])
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
                    match = re.fullmatch(rf" {{{with_child_indent}}}['\"]?version['\"]?\s*:\s*['\"]?({VERSION})['\"]?\s*(?:#.*)?", item)
                    if match:
                        versions.add(match[1])
    return next(iter(versions)) if len(versions) == 1 else None


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
        version = version or (ci_pnpm_version(root) if not declaration else None)
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


def hint_command(root):
    command = install_command(root)
    # This repository's vp bootstrap also sets up its toolchain. Keep the established hint.
    try:
        manifest = json.loads(read(Path(root) / "package.json"))
    except ValueError:
        manifest = {}
    if isinstance(manifest, dict) and (not manifest.get("packageManager") or
                                      str(manifest["packageManager"]).startswith("pnpm@")) and any(
        isinstance(manifest.get(key), dict) and "vite-plus" in manifest[key]
        for key in ("dependencies", "devDependencies")
    ):
        return "vp i"
    return command

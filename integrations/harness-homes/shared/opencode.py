"""Migrate only shared MCP entries, preserving surrounding OpenCode JSONC."""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import generate_homes as gh

SHARED_IDS = ("flighty", "inbody")


def remote_entries(manifest):
    return {s["id"]: {"type": "remote", "url": s["url"], "timeout": s["toolTimeoutSec"] * 1000}
            for s in manifest["mcpServers"] if s["id"] in SHARED_IDS}


def patch(text, entries):
    parsed = gh.loads_jsonc(text)
    if not isinstance(parsed, dict) or not isinstance(parsed.get("mcp"), dict):
        raise gh.HomeError('OpenCode config needs an "mcp" object')
    # Token offsets refer to the original text, so comments and unrelated secrets
    # never need to be reserialized or printed.
    tokens = list(re.finditer(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/|[^\s]', text))
    tokens = [t for t in tokens if not t[0].startswith(("//", "/*")) and t[0] != "\ufeff"]
    spans = {}

    def value(i, path):
        start = i
        if tokens[i][0] == "{":
            i += 1
            while tokens[i][0] != "}":
                key = json.loads(tokens[i][0])
                i = value(i + 2, (*path, key))
                if tokens[i][0] == ",":
                    i += 1
            i += 1
        elif tokens[i][0] == "[":
            depth = 1
            i += 1
            while depth:
                depth += (tokens[i][0] == "[") - (tokens[i][0] == "]")
                i += 1
        else:
            i += 1
            while i < len(tokens) and tokens[i][0] not in (",", "}", "]"):
                i += 1
        if path in spans:
            raise gh.HomeError("duplicate OpenCode config key")
        spans[path] = (tokens[start].start(), tokens[i - 1].end())
        return i

    value(0, ())
    replacements = []
    expected = json.loads(json.dumps(parsed))
    for name, entry in entries.items():
        old = parsed["mcp"].get(name)
        if not isinstance(old, dict):
            raise gh.HomeError(f"OpenCode mcp.{name} missing or invalid; refusing migration")
        new = dict(entry)
        if "enabled" in old:
            new["enabled"] = old["enabled"]
        expected["mcp"][name] = new
        start, end = spans[("mcp", name)]
        replacements.append((start, end, json.dumps(new)))
    for start, end, replacement in sorted(replacements, reverse=True):
        text = text[:start] + replacement + text[end:]
    if gh.loads_jsonc(text) != expected:
        raise gh.HomeError("OpenCode migration changed unrelated config")
    return text


def main():
    manifest = gh.load_manifest()
    path = Path(gh.opencode_config_path(manifest, None))
    original = path.read_text()
    updated = patch(original, remote_entries(manifest))
    if updated != original:
        # Owner-approved installation only. Private backup is the way back.
        backup = str(path) + ".before-shared-mcp"
        if not Path(backup).exists():
            gh.Writer(False).file(backup, original.encode(), 0o600)
        gh.Writer(False).file(str(path), updated.encode(), 0o600)


if __name__ == "__main__":
    main()

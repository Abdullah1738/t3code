"""Small derived rules index. Corpus imports run separately from request-time reads."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import sqlite3
import time
import uuid
from contextlib import closing
from functools import lru_cache
from pathlib import Path
from urllib.parse import quote
from recall_fact_scope import TranscriptContext, normalized, durable, comparison_text, automation, owner_body, directive_body, standing_text, task_metadata


SCHEMA = """
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY, dedup_hash TEXT NOT NULL UNIQUE, text TEXT NOT NULL,
  scope TEXT NOT NULL, actions TEXT NOT NULL, recipient TEXT NOT NULL,
  constraints_json TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_sources (
  source_key TEXT PRIMARY KEY, rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  citation TEXT NOT NULL, provenance TEXT NOT NULL, priority INTEGER NOT NULL,
  source_session TEXT NOT NULL, source_event INTEGER, source_path TEXT NOT NULL,
  source_timestamp REAL NOT NULL, generation TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS rule_transcript_generations(source_path TEXT PRIMARY KEY, active_generation TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS rule_sources_rule ON rule_sources(rule_id, priority DESC);
CREATE INDEX IF NOT EXISTS rule_sources_path ON rule_sources(source_path);
CREATE TABLE IF NOT EXISTS rule_keys (
  rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind, value, rule_id)
);
CREATE TABLE IF NOT EXISTS rule_aliases (
  scope TEXT NOT NULL, repo TEXT NOT NULL, path TEXT NOT NULL,
  citation TEXT NOT NULL, PRIMARY KEY(scope, repo, path)
);
CREATE INDEX IF NOT EXISTS rule_aliases_repo ON rule_aliases(repo);
CREATE INDEX IF NOT EXISTS rule_aliases_path ON rule_aliases(path);
CREATE TABLE IF NOT EXISTS rule_files (
  path TEXT PRIMARY KEY, mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_import_progress (
  source_path TEXT PRIMARY KEY, identity TEXT NOT NULL, last_id INTEGER NOT NULL,
  updated_at REAL NOT NULL
);
"""

_WORD = re.compile(r"[\w]+(?:[-./@][\w]+)*", re.UNICODE)
_DIRECTIVE = re.compile(
    r"\b(always|never|must|should|prefer|avoid|remember|next time|from now on)\b|"
    r"\b(?:do not|don't|dont|use|keep|only|no)\b", re.I
)
_CORRECTION = re.compile(
    r"\bremember (?:this|that)(?: for)? next time\b|\bnext time[, :]+|"
    r"\bnext time (?:do|use|don't|dont|never|always|keep|make|please|send|push)\b|"
    r"\bfrom now on\b|\b(?:don't|do not|never)\b[^\n.!?]{1,240}\bagain\b|"
    r"\bowner rule\s*:", re.I
)
_BRANCH = r"[`\"']?([A-Za-z0-9_][A-Za-z0-9_./-]*)[`\"']?"
_BRANCH_PAIR = re.compile(
    r"\b(?:always|only)\s+(?:(?:push|deploy)(?:\s+\w+){0,2}\s+)?"
    r"(?:from|to|on)\s+" + _BRANCH + r"\s*[,;—-]?\s*(?:and\s+)?"
    r"(?:never|not)(?:\s+(?:from|to|on))?\s+" + _BRANCH, re.I
)
_STOP = set("""a an the and or to from for with this that these those next time always never
    only must should don't dont do not again remember rule owner please keep use using no all
    when then have will would could can into about every before after same more than source
    message messages comment comments send sending push deploy services repo branch""".split())
_ACTION_WORDS = {
    "git.push": r"\b(?:push|deploy)(?:es|ing)?\b",
    "git.commit": r"\bcommits?\b",
    "message": r"\b(?:messages?|messaging|emails?|whatsapp|imessage|telegram|cliq|recipients?)\b",
    "comment": r"\b(?:comments?|feedback|pull requests?|PRs?)\b",
    "order": r"\b(?:orders?|ordering|checkout|baskets?|commerce|deliver(?:y|ies))\b",
    "booking": r"\b(?:book(?:ing|ings)?|reservations?|rides?|uber|careem)\b",
    "payment": r"\b(?:pay|paying|payments?|charges?|spend|money)\b",
    "file.write": r"\b(?:edits?|editing|files?|code|docs?|documentation|markdown|markers?)\b",
    "file.read": r"\b(?:read|reading|grep|glob|inspect|inspecting)\b",
    "deploy": r"\bdeploy(?:s|ing|ment)?\b",
}
_READ_TOOLS = {"read", "grep", "glob", "list", "search", "webfetch", "websearch"}
_SHELL_TOOLS = {"shell", "bash", "exec", "exec_command", "execute_command", "run_command", "shell_command"}


def _path(value: str) -> str:
    return os.path.abspath(os.path.expanduser(value)) if value else ""


def _tokens(text: str) -> set[str]:
    return {word.lower() for word in _WORD.findall(text)}


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _arguments(arguments) -> dict:
    if isinstance(arguments, str):
        try:
            value = json.loads(arguments)
        except ValueError:
            return {"command": arguments}
        return value if isinstance(value, dict) else {}
    return arguments if isinstance(arguments, dict) else {}


def _tool_name(tool: str) -> str:
    return re.split(r"[./:]|__", tool.lower())[-1]


def _constraints(text: str) -> list[dict]:
    if not re.search(r"\b(?:push|deploy)\b", text, re.I):
        return []
    if re.search(r"\b(?:example|proposal|proposed|historical|previously|used to)\b", text, re.I):
        return []
    result = []
    for match in _BRANCH_PAIR.finditer(text):
        allowed, forbidden = (v.rstrip(".") for v in match.groups())
        if allowed != forbidden:
            result.append({"kind": "branch", "action": "git.push", "allowed": allowed,
                           "forbidden": [forbidden]})
    return result


def _actions(text: str, constraints: list[dict]) -> list[str]:
    text = text.replace("’", "'")
    actions = {name for name, pattern in _ACTION_WORDS.items() if re.search(pattern, text, re.I)}
    if constraints:
        actions.update(("git.push", "deploy"))
    if re.search(r"\b(?:no|never|don't|do not)\s+(?:AI|agent|generated.by)\b", text, re.I):
        actions.update(("message", "comment", "file.write", "git.commit"))
    return sorted(actions)


def _recipient(text: str) -> str:
    match = re.search(
        r"\b(?:when (?:messaging|emailing)|messages? to|(?:sending|writing) to)\s+"
        r"([A-Z][\w@.+-]*)", text
    )
    return match[1] if match else ""


def _scope_hint(text: str, fallback: str) -> str:
    if (re.match(r"\s*(?:[-*]|\d+\.)?\s*Crpko\b", text, re.I)
            or re.search(r"\b(?:for|on|in)\s+(?:all\s+)?Crpko\b", text, re.I)):
        return "crpko"
    return fallback


def _blocks(text: str):
    """Keep source spelling and lines; fences and quoted examples aren't instructions."""
    current, start, fence = [], 0, False
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith(("```", "~~~")):
            if current:
                yield start, number - 1, "\n".join(current)
                current = []
            fence = not fence
            continue
        if fence or line.lstrip().startswith(">") or not line.strip() or line.startswith("#"):
            if current:
                yield start, number - 1, "\n".join(current)
                current = []
            continue
        # A new list item has its own citation, not authority over neighboring items.
        if current and re.match(r"^\s*(?:[-*]|\d+[a-z]?\.)\s", line):
            yield start, number - 1, "\n".join(current)
            current = []
        if not current:
            start = number
        current.append(line)
    if current:
        yield start, len(text.splitlines()), "\n".join(current)


def _file_scope(path: Path, text: str) -> str:
    if path.name == "AGENTS.md":
        if ".config/opencode" in str(path) or str(path.parent) == str(Path.home()):
            return ""
        return str(path.parent)
    # A skill's project family comes from its own name/heading, not incidental examples.
    header = "\n".join(text.splitlines()[:10]) + " " + path.parent.name
    return "crpko" if re.search(r"\bcrpko(?:\b|[-_])", header, re.I) else ""


def _owner_text(text: str, metadata: dict) -> str:
    if (metadata.get("createdBy") in ("system", "assistant") or metadata.get("synthetic")
            or task_metadata(metadata) or metadata.get('origin') in ('automation', 'watcher')):
        return ""
    text = owner_body(text)
    if automation(text) or text.lstrip().startswith(("# AGENTS.md instructions", "<user_instructions>")):
        return ""
    return text


def _owner_correction(text: str) -> bool:
    text = directive_body(text)
    if re.match(r"a revision\b[^\n]*new essay", text, re.I):
        return True
    if not _CORRECTION.search(text):
        return False
    return bool(re.match(
        r"\s*(?:remember\b|next time\b|from now on\b|owner rule:|don't\b|do not\b|never\b|use\b|always\b)", text, re.I
    ))


def _scope_path(scope: str, cwd: str) -> bool:
    return not scope or scope == cwd or (scope.startswith("/") and cwd.startswith(scope.rstrip("/") + "/"))


def _git_pushes(command: str, cwd: str, *, verb="push") -> list[dict]:
    """Parse literal command segments only. Unknown/expanded targets can get context, not deny."""
    if not command or len(command) > 65536:
        return []
    from recall_classifier import without_heredoc_data
    command = without_heredoc_data(command)
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()\n")
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        lexer.commenters = "#"
        words = list(lexer)
    except ValueError:
        return []
    segments, segment = [], []
    controls = {";", "&&", "||", "|", "\n", "(", ")", "&"}
    expanded = []
    for word in words:
        expanded.extend(re.findall(r"&&|\|\||[;&|()\n]", word) if re.fullmatch(r"[;&|()\n]+", word) else [word])
    for word in expanded:
        if word in controls:
            if segment:
                segments.append(segment)
            segment = []
            if word in {"(", ")"}:
                segments.append([word])
        else:
            segment.append(word)
    if segment:
        segments.append(segment)
    result = []
    location = _path(cwd)
    stack, directories = [], []
    for words in segments:
        if words == ["("]:
            stack.append((location, list(directories)))
            continue
        if words == [")"]:
            if stack: location, directories = stack.pop()
            continue
        if any(word in ("(", "&") or "$" in word or "`" in word for word in words):
            continue
        if words[0] == "cd":
            while len(words) > 2 and (words[1] == "--" or re.fullmatch(r"-[LPe@]+", words[1])):
                words = [words[0], *words[2:]]
        if words[0] == "pushd" and len(words) == 3 and words[1] == "--":
            words = [words[0], words[2]]
        if words[0] in {"cd", "pushd"} and len(words) == 2:
            if words[0] == "pushd": directories.append(location)
            location = _path(os.path.join(location, os.path.expanduser(words[1])))
            continue
        if words[0] == "popd":
            if directories: location = directories.pop()
            continue
        words = list(words)
        while words:
            if words[0] in {"env", "command"}:
                words.pop(0)
                if words and words[0] == "--": words.pop(0)
            elif re.match(r"^[A-Za-z_][A-Za-z_0-9]*=", words[0]):
                words.pop(0)
            else:
                break
        if words and os.path.basename(words[0]) in {"bash", "sh", "zsh"} and len(words) == 3 and words[1] in {"-c", "-lc"}:
            result.extend(_git_pushes(words[2], location, verb=verb))
            continue
        if not words or os.path.basename(words.pop(0)) != "git":
            continue
        effective = location
        while words and words[0].startswith("-"):
            option = words.pop(0)
            if option in ("-C", "--work-tree") and words:
                effective = _path(os.path.join(effective, os.path.expanduser(words.pop(0))))
            elif option.startswith("--work-tree="):
                effective = _path(os.path.join(effective, os.path.expanduser(option.split("=", 1)[1])))
            elif option == "-c" and words:
                words.pop(0)
            elif option.startswith("--config-env=") or option in (
                    "--no-pager", "--no-optional-locks", "--literal-pathspecs"):
                continue
            else:
                words = []
        if not words or words.pop(0) != verb:
            continue
        if verb == "commit":
            result.append({"cwd": effective})
            continue
        positional, repo = [], ""
        deletion = dry_run = uncertain = False
        while words:
            word = words.pop(0)
            if word == "--":
                positional.extend(words)
                break
            if word in ("--delete", "-d"):
                deletion = True
            elif word in ("--dry-run", "-n"):
                dry_run = True
            elif word in ("--all", "--mirror"):
                uncertain = True
            elif word == "--tags":
                continue
            elif word == "--repo" and words:
                repo = words.pop(0)
            elif word.startswith("--repo="):
                repo = word.split("=", 1)[1]
            elif word in ("-o", "--push-option", "--receive-pack", "--exec") and words:
                words.pop(0)
            elif word.startswith(("--push-option=", "--receive-pack=", "--exec=", "--force-with-lease=",
                                  "--recurse-submodules=", "--signed=")):
                continue
            elif word in ("-f", "--force", "--force-with-lease", "--force-if-includes", "-u",
                          "--set-upstream", "--atomic", "--no-verify", "--porcelain", "-q", "--quiet",
                          "-v", "--verbose", "--follow-tags", "--signed", "--no-signed", "--progress",
                          "--prune", "--ipv4", "--ipv6", "-4", "-6"):
                continue
            elif word.startswith("-"):
                uncertain = True
            else:
                positional.append(word)
        if not repo and positional:
            repo = positional.pop(0)
        destinations = []
        if not deletion and not uncertain:
            for refspec in positional:
                refspec = refspec.lstrip("+")
                if refspec.startswith(":") or any(c in refspec for c in "*?[]"):
                    continue
                destination = refspec.split(":", 1)[-1]
                if destination.startswith("refs/heads/"):
                    destination = destination[len("refs/heads/"):]
                elif destination.startswith("refs/"):
                    continue
                if destination and destination != "HEAD":
                    destinations.append(destination)
        result.append({"cwd": effective, "repo": repo, "destinations": destinations})
    return result



_TOOLING_PATHS = ('~/.config/opencode/skills', '~/.config/opencode/plugin', '~/.config/opencode/plugins',
    '~/.config/opencode/AGENTS.md', '~/.config/opencode/opencode.json', '~/.config/opencode/opencode.jsonc',
    '~/.claude/skills', '~/.claude/agents', '~/.claude/settings.json', '~/.claude.json',
    '~/.codex/skills', '~/.codex/config.toml', '~/.agents/skills', '~/.robob/harness-homes',
    '~/.local/share/harness-homes/manifest.json')

def _specific_path(path):
    path = path.rstrip('/.')
    if path in {'', '/', '~', '/tmp', '/private/tmp', '/var/tmp', '/Volumes/ExternalSSD'}: return False
    if path.startswith(('/tmp/', '/private/tmp/', '/var/tmp/', '/dev/', '/usr/', '/bin/')): return False
    return len(Path(path).parts) >= 3 and not any(c in path for c in '{}$')


def _path_triggers(text):
    if 'harness-config-parity' in text or re.search(r'agent tooling reaches every harness', text, re.I):
        return list(_TOOLING_PATHS) + ['@harness-manifest', '@mcp-config']
    return [p.rstrip('.)]') for p in re.findall(r'(?<![\w:/])(?:~/|/)[^\s`\"\'<>;,]+', text)]


_SHELL_MARKS = {char: chr(0xE000+i) for i, char in enumerate(';&|()<>\n$~')}


def _restore_shell(value, *, variables=True):
    for char, marker in _SHELL_MARKS.items():
        if variables or char not in '$~': value = value.replace(marker, char)
    return value


def _write_words(command):
    # POSIX lexing joins adjacent quoted/unquoted fragments ("$HOME"/file).
    # Protect quoted operators first so their origin survives quote removal.
    protected, quote, escaped = [], None, False
    for char in command:
        if escaped:
            protected.append(_SHELL_MARKS.get(char, char))
            escaped = False
            continue
        if char == '\\' and quote != "'":
            protected.append(char)
            escaped = True
            continue
        if char in {'"', "'"} and (quote is None or quote == char):
            quote = None if quote else char
            protected.append(char)
            continue
        if quote and (char in ';&|()<>\n~' or quote == "'" and char == '$'):
            char = _SHELL_MARKS[char]
        protected.append(char)
    lex = shlex.shlex(''.join(protected), posix=True, punctuation_chars=';&|()<>\n')
    lex.whitespace = ' \t\r'
    lex.whitespace_split = True
    return [(_restore_shell(word, variables=False), not any(mark in word for mark in _SHELL_MARKS.values()))
            for word in lex]


def _write_paths(tool, arguments, cwd):
    name = _tool_name(tool)
    location = str(arguments.get('workdir', arguments.get('cwd', cwd)) or cwd)
    paths = []
    if name in {'write', 'edit', 'multiedit', 'multi_edit', 'patch', 'apply_patch'}:
        paths.extend(arguments[k] for k in ('file_path','filePath','path','file','filename') if isinstance(arguments.get(k),str))
        for edit in arguments.get('edits', []):
            if isinstance(edit, dict): paths.extend(_write_paths('edit', edit, location))
        patch = str(arguments.get('patch', arguments.get('input', '')))
        paths.extend(re.findall(r'^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$', patch, re.M))
    if name in _SHELL_TOOLS:
        from recall_classifier import without_heredoc_data
        command = without_heredoc_data(str(arguments.get('command', arguments.get('cmd',''))))
        try:
            words = _write_words(command)
        except ValueError: words = []
        segment, stack, directories = [], [], []
        def consume(items):
            nonlocal location
            tokens = [v for v, _ in items]
            if not tokens: return
            for i, (token, syntax) in enumerate(items[:-1]):
                if syntax and re.fullmatch(r'>+|[0-9]*>+',token): paths.append((tokens[i+1],location))
            while tokens and (re.match(r'^[A-Za-z_][A-Za-z_0-9]*=',tokens[0]) or tokens[0] in {'command','env'}): tokens=tokens[1:]
            if not tokens: return
            exe = Path(tokens[0]).name
            if exe in {'cd','pushd'} and len(tokens)>1:
                dest=tokens[-1]
                dest=re.sub(r'^\$(?:HOME\b|\{HOME\})', str(Path.home()), dest)
                if exe == 'pushd': directories.append(location)
                location=_restore_shell(_path(dest) if dest.startswith(('/','~')) else os.path.join(location,dest))
            if exe == 'popd' and directories: location=directories.pop()
            if exe in {'tee','cp','mv','install','mkdir','touch'}:
                dests=[t for t in tokens[1:] if not t.startswith('-')]
                if exe in {'cp','mv','install'}: dests=dests[-1:]
                paths.extend((t,location) for t in dests)
            if exe=='sed' and any(t.startswith('-i') for t in tokens[1:]):
                paths.extend((t,location) for t in tokens[1:] if not t.startswith('-'))
            if exe in {'sh','bash','zsh'}:
                for i, flag in enumerate(tokens[1:], 1):
                    if re.fullmatch(r'-[A-Za-z]*c[A-Za-z]*',flag) and i+1<len(tokens):
                        paths.extend(_write_paths('bash',{'command':_restore_shell(tokens[i+1])},location))
                        break
        for word, syntax in words+[(';',True)]:
            if syntax and re.fullmatch(r'[;&|()\n]+',word):
                consume(segment); segment=[]
                for control in re.findall(r'[()]', word):
                    if control == '(': stack.append((location,list(directories)))
                    elif stack: location,directories=stack.pop()
            else: segment.append((word,syntax))
    result=[]
    for value in paths:
        path, base=value if isinstance(value,tuple) else (value,location)
        path=re.sub(r'^\$(?:HOME\b|\{HOME\})', str(Path.home()), path)
        result.append(_restore_shell(_path(path) if path.startswith(('/','~')) else os.path.normpath(os.path.join(base,path))))
    return result

def _matches_path(trigger,path):
    if trigger=='@harness-manifest': return path.endswith('/harness-homes/manifest.json')
    if trigger=='@mcp-config': return Path(path).name.lower() in {'.mcp.json','mcp.json','mcp.jsonc','mcp_config.json','mcp-config.json'}
    root=_path(trigger).rstrip('/')
    return path==root or path.startswith(root+'/')


def _call_actions(tool: str, arguments: dict, cwd: str, write_paths=None) -> tuple[set[str], list[str]]:
    name = _tool_name(tool)
    if name in _READ_TOOLS:
        return {name, tool.lower(), "file.read"}, [_path(cwd)]
    command = str(arguments.get("command", arguments.get("cmd", "")))
    location = _path(str(arguments.get("workdir", arguments.get("cwd", cwd)) or cwd))
    actions = {name, tool.lower()}
    if any(isinstance(arguments.get(key), str) and arguments[key].strip()
           for key in ("recipient", "to", "contact", "chat", "chat_name")):
        actions.add("message")
    pushes = _git_pushes(command, location) if name in _SHELL_TOOLS else []
    commits = _git_pushes(command, location, verb="commit") if name in _SHELL_TOOLS else []
    if commits:
        actions.add("git.commit")
    if pushes:
        actions.add("git.push")
    if (write_paths if write_paths is not None else _write_paths(tool, arguments, cwd)) or name in ("patch", "edit", "write", "apply_patch", "multiedit", "multi_edit"):
        actions.add("file.write")
    content = tool + " " + command
    from recall_classifier import deterministic
    if deterministic(tool, arguments) is False:
        # Local search/output text is never a message action or recipient.
        return actions, list(dict.fromkeys([commit["cwd"] for commit in commits])) or [location]
    if re.search(r"\b(?:send|notify|reply|message|email|mailsend)\b|(?:_|\.)(?:send|reply|notify)", content, re.I):
        actions.add("message")
    if re.search(r"\b(?:comment|review|post)\b|(?:_|\.)(?:comment|post|review)", content, re.I):
        actions.add("comment")
    if re.search(r"\b(?:order|checkout|purchase)\b|(?:_|\.)(?:order|purchase)", content, re.I):
        actions.add("order")
    if re.search(r"\b(?:book|booking|reserve|ride)\b", content, re.I):
        actions.add("booking")
    if re.search(r"\b(?:pay|payment|charge)\b", content, re.I):
        actions.add("payment")
    if re.search(r"\bdeploy\b", content):
        actions.add("deploy")
    return actions, list(dict.fromkeys([push["cwd"] for push in pushes] + [commit["cwd"] for commit in commits])) or [location]


@lru_cache(maxsize=64)
def _has_explicit(path, generation):
    # File/WAL generations change on remember/import. Cache the empty common
    # case without caching applicable rules or missing newly saved instructions.
    with closing(sqlite3.connect(Path(path).as_uri() + "?mode=ro", uri=True, timeout=.05)) as con:
        return bool(con.execute("SELECT 1 FROM rule_sources WHERE provenance='explicit' LIMIT 1").fetchone())


def scoped_fact(record, text, session_id=None):
    compared = comparison_text(record['text'], text)
    sources = record.get('sources', [])
    if sources and all(s['provenance'] == 'owner_correction' for s in sources) and not durable(compared):
        sessions = set(record.get('sessions', [])) | {s['source_session'] for s in sources}
        if not session_id or session_id not in sessions:
            independent = comparison_text(compared, '')
            compared = independent if independent != compared and durable(independent) else ''
    if not compared:
        return None
    return {**record, 'text': compared,
            'constraints': _constraints(compared) if compared != record['text'] else record.get('constraints', []),
            'triggers': {**record.get('triggers', {}), 'text': compared}}


def fact_applies(record, text, session_id=None):
    return scoped_fact(record, text, session_id) is not None


def filter_facts(records, text, session_id=None):
    return [fact for record in records if (fact := scoped_fact(record, text, session_id)) is not None]


def dedupe_facts(records):
    def authority(r):
        return (r.get('priority', 0), r.get('source_timestamp', 0), r.get('source_event') or -1, r['id'])
    unique = {}
    for record in records:
        key = normalized(record['text'])
        if key not in unique or authority(record) > authority(unique[key]):
            unique[key] = record
    return list(unique.values())


class _RuleConnection(sqlite3.Connection):
    has_generations = False


def _active_source_clause(con):
    if not con.has_generations:
        return "1"
    return "(s.provenance!='owner_correction' OR s.generation=COALESCE((SELECT active_generation FROM rule_transcript_generations g WHERE g.source_path=s.source_path),''))"


def _active_generation(con, path):
    if not con.has_generations:
        return ''
    row = con.execute("SELECT active_generation FROM rule_transcript_generations WHERE source_path=?", (path,)).fetchone()
    return row[0] if row else ''


class RuleIndex:
    def __init__(self, path):
        self.path = Path(path).expanduser().absolute()
        if self.path.exists() and self.path.stat().st_size:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as con:
            con.execute("PRAGMA journal_mode=WAL")
            con.executescript(SCHEMA)

    def _connect(self, readonly: bool = False):
        if readonly:
            con = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True, timeout=0.05, factory=_RuleConnection)
            con.execute("PRAGMA query_only=ON")
            con.execute("BEGIN")
        else:
            con = sqlite3.connect(self.path, timeout=0.1, factory=_RuleConnection)
            con.execute("PRAGMA foreign_keys=ON")
        con.row_factory = sqlite3.Row
        con.has_generations = (any(r[1] == 'generation' for r in con.execute('PRAGMA table_info(rule_sources)'))
                               and con.execute("SELECT 1 FROM sqlite_master WHERE name='rule_transcript_generations'").fetchone() is not None)
        return con

    def _put(self, con, text, scope, actions, recipient, source):
        constraints = _constraints(text)
        actions = sorted(set(actions if actions is not None else _actions(text, constraints)))
        scope = _path(scope) if scope.startswith(("/", "~")) else scope.lower().strip()
        recipient = recipient or _recipient(text)
        generation = source.get('generation', _active_generation(con, source.get('path', ''))) if source['provenance'] == 'owner_correction' else ''
        identity = ([normalized(text), scope, source.get('session', ''), generation]
                    if source['provenance'] == 'owner_correction' else [text, scope, actions, recipient.lower()])
        digest = hashlib.sha256(_json(identity).encode()).hexdigest()
        now = time.time()
        old = con.execute("SELECT * FROM rules WHERE dedup_hash=?", (digest,)).fetchone()
        if old and source['provenance'] == 'owner_correction':
            strongest = con.execute("SELECT source_timestamp,source_event FROM rule_sources WHERE rule_id=? "
                                    "ORDER BY source_timestamp DESC,source_event DESC LIMIT 1", (old['id'],)).fetchone()
            if strongest and (source.get('timestamp', now), source.get('event') or -1) < (strongest[0], strongest[1] or -1):
                text, recipient = old['text'], old['recipient']
                actions, constraints = json.loads(old['actions']), json.loads(old['constraints_json'])

        con.execute(
            "INSERT INTO rules(dedup_hash,text,scope,actions,recipient,constraints_json,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(dedup_hash) DO UPDATE SET text=excluded.text,actions=excluded.actions,recipient=excluded.recipient,"
            "constraints_json=excluded.constraints_json,updated_at=excluded.updated_at",
            (digest, text, scope, _json(actions), recipient, _json(constraints), now, now),
        )
        rule_id = con.execute("SELECT id FROM rules WHERE dedup_hash=?", (digest,)).fetchone()[0]
        columns = "source_key,rule_id,citation,provenance,priority,source_session,source_event,source_path,source_timestamp"
        values = (source['key'] + (':generation:' + generation if generation else ''), rule_id,
                  source['citation'], source['provenance'], source['priority'], source.get('session', ''),
                  source.get('event'), source.get('path', ''), source.get('timestamp', now))
        if con.has_generations:
            columns += ',generation'
            values += (generation,)
        con.execute(
            "INSERT INTO rule_sources(" + columns + ") VALUES(" + ','.join('?' for _ in values) + ") "
            "ON CONFLICT(source_key) DO UPDATE SET rule_id=excluded.rule_id,citation=excluded.citation,"
            "provenance=excluded.provenance,priority=excluded.priority,source_timestamp=excluded.source_timestamp", values)
        keys = [(rule_id, "session", sid) for sid in source.get("sessions", [])] + [(rule_id, "scope", scope)] + [(rule_id, "action", action.lower()) for action in actions]
        # Recipient triggers must survive an unknown tool/action classification.
        keys.extend((rule_id, "path", value) for value in _path_triggers(text) if "file.write" in actions)
        keys.extend((rule_id, "recipient", token) for token in _tokens(recipient))
        keys.extend((rule_id, "token", token) for action in actions for token in _tokens(action)
                    if token not in _ACTION_WORDS)
        if not actions:
            keys.extend((rule_id, "token", word) for word in sorted(_tokens(text) - _STOP) if len(word) > 3)
        con.executemany("INSERT OR IGNORE INTO rule_keys VALUES(?,?,?)", keys)
        return rule_id, old is None

    def _record(self, con, row):
        result = dict(row)
        result["actions"] = json.loads(result["actions"])
        result["constraints"] = json.loads(result.pop("constraints_json"))
        sources = [dict(source) for source in con.execute(
            "SELECT citation,provenance,priority,source_session,source_event,source_timestamp "
            "FROM rule_sources s WHERE rule_id=? AND " + _active_source_clause(con) + " ORDER BY priority DESC,source_timestamp DESC,source_event DESC,citation", (row["id"],)
        )]
        if sources:
            result.update(sources[0])
        result["sessions"] = [r[0] for r in con.execute(
            "SELECT value FROM rule_keys WHERE rule_id=? AND kind='session'", (row['id'],))]
        result["citations"] = [source["citation"] for source in sources]
        result["sources"] = sources
        result["triggers"] = {"actions": result["actions"], "recipient": result["recipient"], "text": result["text"]}
        return result

    def remember(self, text, scope='', actions=None, recipient='', source_session='', source_event=None) -> dict:
        if not isinstance(text, str) or not text.strip() or len(text) > 65536:
            raise ValueError("rule text must be nonempty and at most 65536 characters")
        if isinstance(actions, str):
            actions = [actions]
        citation = source_session + (f"#e{source_event}" if source_event is not None else "")
        digest = hashlib.sha256(_json([text, scope, actions, recipient]).encode()).hexdigest()
        source = {"key": "remember:" + digest + ":" + citation, "citation": citation or "remember:" + digest,
                  "provenance": "explicit", "priority": 100, "session": source_session, "event": source_event}
        with closing(self._connect()) as con, con:
            rule_id, _ = self._put(con, text, scope, actions, recipient, source)
            return self._record(con, con.execute("SELECT * FROM rules WHERE id=?", (rule_id,)).fetchone())

    def import_files(self, paths) -> dict:
        stats = {"files": 0, "unchanged": 0, "imported": 0, "deduplicated": 0, "oversized": 0, "errors": []}
        with closing(self._connect()) as con, con:
            for value in paths:
                path = Path(value).expanduser().absolute()
                if path.name not in ("SKILL.md", "AGENTS.md"):
                    raise ValueError("rules files must be SKILL.md or AGENTS.md")
                try:
                    info = path.stat()
                    if info.st_size > 4 * 1024 * 1024:
                        raise ValueError("rules file exceeds 4 MiB")
                    old = con.execute("SELECT mtime_ns,size FROM rule_files WHERE path=?", (str(path),)).fetchone()
                    if old and tuple(old) == (info.st_mtime_ns, info.st_size):
                        stats["unchanged"] += 1
                        continue
                    text = path.read_text(encoding="utf-8")
                except (OSError, UnicodeError, ValueError) as exc:
                    stats["errors"].append({"path": str(path), "error": str(exc)})
                    continue
                stats["files"] += 1
                con.execute("DELETE FROM rule_sources WHERE source_path=?", (str(path),))
                scope = _file_scope(path, text)
                for first, last, block in _blocks(text):
                    if len(block) > 65536:
                        stats["oversized"] += 1
                        continue
                    if not _DIRECTIVE.search(block):
                        continue
                    block_scope = _scope_hint(block, scope)
                    citation = f"{path}#L{first}" + (f"-L{last}" if last != first else "")
                    _, added = self._put(con, block, block_scope, None, "", {
                        "key": f"file:{path}:{first}", "citation": citation,
                        "provenance": "skill" if path.name == "SKILL.md" else "agents",
                        "priority": 80 if path.name == "SKILL.md" else 90,
                        "path": str(path), "timestamp": info.st_mtime,
                    })
                    stats["imported" if added else "deduplicated"] += 1
                con.execute("INSERT OR REPLACE INTO rule_files VALUES(?,?,?)", (str(path), info.st_mtime_ns, info.st_size))
            # Upgrade old derived indexes even when the source files are unchanged.
            # Hooks only read this artifact; compilation belongs to the importer.
            for row in con.execute("SELECT id,text FROM rules WHERE actions LIKE '%file.write%'").fetchall():
                con.executemany("INSERT OR IGNORE INTO rule_keys VALUES(?,?,?)",
                                [(row['id'], 'path', p) for p in _path_triggers(row['text'])])
            con.execute("DELETE FROM rules WHERE NOT EXISTS (SELECT 1 FROM rule_sources s WHERE s.rule_id=rules.id)")
        return stats

    def _publish_transcript_replay(self, con, path, stats, deadline):
        if con.execute("SELECT 1 FROM rule_transcript_replay WHERE source_path=? LIMIT 1", (path,)).fetchone():
            return None
        build = con.execute("SELECT payload FROM rule_transcript_staging WHERE source_path=? AND event_id=0", (path,)).fetchone()
        if not build:
            return True
        if time.monotonic() >= deadline:
            return False
        # Pages compile into an inactive generation. Publishing only switches a
        # pointer, so a small tick never has to repeat an unbounded rebuild.
        con.execute("INSERT OR REPLACE INTO rule_transcript_generations VALUES(?,?)", (path, build[0]))
        con.execute("DELETE FROM rule_transcript_staging WHERE source_path=?", (path,))
        return True

    def _cleanup_transcript_generations(self, con, path, deadline):
        if time.monotonic() >= deadline:
            return
        active = _active_generation(con, path)
        build = con.execute("SELECT payload FROM rule_transcript_staging WHERE source_path=? AND event_id=0", (path,)).fetchone()
        rows = con.execute("SELECT source_key,rule_id FROM rule_sources WHERE provenance='owner_correction' "
                           "AND source_path=? AND generation NOT IN (?,?) LIMIT 128",
                           (path, active, build[0] if build else active)).fetchall()
        con.executemany("DELETE FROM rule_sources WHERE source_key=?", [(r[0],) for r in rows])
        if rows:
            ids = sorted({r[1] for r in rows})
            con.execute("DELETE FROM rules WHERE id IN (" + ','.join('?' for _ in ids) + ") "
                        "AND NOT EXISTS (SELECT 1 FROM rule_sources s WHERE s.rule_id=rules.id)", ids)

    def import_transcripts(self, source_path, max_rows=2000, seconds=2.0) -> dict:
        """Explicit source only. Each committed page advances an ID cursor, including skipped rows."""
        import robob_readonly
        path = robob_readonly.safe_path(source_path).resolve(strict=True)
        if path == self.path.resolve():
            raise ValueError("transcript source must differ from the rules index")
        info = path.stat()
        identity = f"{info.st_dev}:{info.st_ino}"
        end = time.monotonic() + max(0.0, min(float(seconds), 60.0))
        remaining = max(0, min(int(max_rows), 100000))
        stats = {"rows": 0, "imported": 0, "deduplicated": 0, "cursor": 0, "complete": False}
        with closing(self._connect()) as con, closing(sqlite3.connect(
                "file:" + quote(str(path), safe="/") + "?mode=ro", uri=True, timeout=0.05,
                isolation_level=None)) as source:
            source.row_factory = sqlite3.Row
            source.execute("PRAGMA query_only=ON")
            source.set_progress_handler(lambda: int(time.monotonic() >= end), 1000)
            if not remaining or time.monotonic() >= end:
                return stats
            try:
                context = TranscriptContext(source)
            except sqlite3.OperationalError as exc:
                if "interrupt" in str(exc):
                    return stats
                raise
            if not any(r[1] == 'generation' for r in con.execute('PRAGMA table_info(rule_sources)')):
                con.execute("ALTER TABLE rule_sources ADD COLUMN generation TEXT NOT NULL DEFAULT ''")
            con.execute("CREATE TABLE IF NOT EXISTS rule_transcript_generations(source_path TEXT PRIMARY KEY, active_generation TEXT NOT NULL)")
            con.execute("CREATE INDEX IF NOT EXISTS rule_sources_generation ON rule_sources(source_path,generation,provenance)")
            con.execute("CREATE INDEX IF NOT EXISTS rule_sources_latest ON rule_sources(rule_id,source_timestamp DESC,source_event DESC)")
            con.has_generations = True
            # Re-derive previously promoted events without restarting the corpus
            # scan. Stage bounded pages before publishing their replacement atomically.
            con.executescript("""
                CREATE TABLE IF NOT EXISTS rule_transcript_policy(source_path TEXT PRIMARY KEY, identity TEXT, version INTEGER);
                CREATE TABLE IF NOT EXISTS rule_transcript_replay(source_path TEXT, event_id INTEGER,
                    PRIMARY KEY(source_path,event_id));
                CREATE TABLE IF NOT EXISTS rule_transcript_staging(source_path TEXT,event_id INTEGER,block_key TEXT,payload TEXT,
                    PRIMARY KEY(source_path,event_id,block_key));
                CREATE TABLE IF NOT EXISTS rule_session_kinds(source_path TEXT,session_id TEXT,PRIMARY KEY(source_path,session_id));
            """)
            with con:
                policy = con.execute("SELECT identity,version FROM rule_transcript_policy WHERE source_path=?", (str(path),)).fetchone()
                policy_identity = identity + "|" + context.signature
                source_changed = policy and policy['identity'].split('|', 1)[0] != identity
                if not policy or policy['identity'] != policy_identity or policy['version'] != 5:
                    if not source_changed:
                        con.execute("INSERT OR IGNORE INTO rule_transcript_replay SELECT source_path,source_event FROM rule_sources "
                                    "WHERE provenance='owner_correction' AND source_path=? AND source_event IS NOT NULL AND generation=?", (str(path), _active_generation(con, str(path))))
                    else:
                        con.execute("DELETE FROM rule_transcript_replay WHERE source_path=?", (str(path),))
                        con.execute("INSERT OR REPLACE INTO rule_transcript_generations VALUES(?,?)", (str(path), uuid.uuid4().hex))
                        con.execute("DELETE FROM rule_session_kinds WHERE source_path=?", (str(path),))
                    con.execute("DELETE FROM rule_transcript_staging WHERE source_path=?", (str(path),))
                    if not source_changed and con.execute("SELECT 1 FROM rule_sources WHERE provenance='owner_correction' AND source_path=? LIMIT 1", (str(path),)).fetchone():
                        con.execute("INSERT OR REPLACE INTO rule_transcript_staging VALUES(?,0,'@pending',?)", (str(path), uuid.uuid4().hex))
                    con.execute("INSERT OR REPLACE INTO rule_transcript_policy VALUES(?,?,5)", (str(path), policy_identity))
            context.rejected_sessions = {r[0] for r in con.execute("SELECT session_id FROM rule_session_kinds WHERE source_path=?", (str(path),))}
            previous = con.execute("SELECT identity,last_id FROM rule_import_progress WHERE source_path=?", (str(path),)).fetchone()
            cursor = previous["last_id"] if previous and previous["identity"] == identity else 0
            with con:
                if self._publish_transcript_replay(con, str(path), stats, end) is False:
                    stats['cursor'] = cursor
                    return stats
            while remaining and time.monotonic() < end:
                try:
                    replay = [r[0] for r in con.execute(
                        "SELECT event_id FROM rule_transcript_replay WHERE source_path=? ORDER BY event_id LIMIT ?",
                        (str(path), min(remaining, 128)))]
                    predicate = "id IN (" + ",".join("?" for _ in replay) + ")" if replay else "id>?"
                    params = replay if replay else [cursor]
                    source_column = "source," if 'source' in context.columns else ""
                    rows = source.execute(
                        "SELECT " + source_column + "id,session_id,timestamp,speaker,content_type,metadata_json,"
                        "CASE WHEN speaker='user' AND content_type='text' THEN substr(content,1,65537) ELSE '' END AS content "
                        "FROM episodic_events WHERE " + predicate + " ORDER BY id LIMIT ?", (*params, min(remaining, 128))
                    ).fetchall()
                except sqlite3.OperationalError as exc:
                    if "interrupt" in str(exc):
                        break
                    raise
                if not rows and replay:
                    with con:
                        con.executemany("DELETE FROM rule_transcript_replay WHERE source_path=? AND event_id=?",
                                        [(str(path), event) for event in replay])
                        published = self._publish_transcript_replay(con, str(path), stats, end)
                    if published is False:
                        break
                    continue
                if not rows:
                    break
                with con:
                    for row in rows:
                        if time.monotonic() >= end:
                            break
                        try:
                            metadata = json.loads(row["metadata_json"] or "{}")
                        except (ValueError, TypeError):
                            metadata = {}
                        if not isinstance(metadata, dict):
                            metadata = {}
                        text = _owner_text(row['content'], metadata)
                        opening = row['speaker'] == 'user' and (context.task_opening(row['content']) or task_metadata(metadata))
                        candidate = opening or row['speaker'] == 'user' and any(_owner_correction(block) for _, _, block in _blocks(text))
                        try:
                            sessions, rejected = context.get(row) if candidate else ({row['session_id']}, False)
                        except sqlite3.OperationalError as exc:
                            if "interrupt" in str(exc):
                                break
                            raise
                        if (opening or rejected) and not sessions.issubset(context.rejected_sessions):
                            context.rejected_sessions.update(sessions)
                            context.cache.clear()
                            con.executemany("INSERT OR IGNORE INTO rule_session_kinds VALUES(?,?)", [(str(path), sid) for sid in sessions])
                            con.execute("DELETE FROM rule_sources WHERE provenance='owner_correction' AND source_path=? AND source_session IN (" + ','.join('?' for _ in sessions) + ")", (str(path), *sorted(sessions)))
                            con.execute("DELETE FROM rules WHERE NOT EXISTS (SELECT 1 FROM rule_sources s WHERE s.rule_id=rules.id)")
                        if rejected or opening:
                            text = ""
                        cwd = metadata.get("cwd", metadata.get("dir", metadata.get("directory", "")))
                        cwd = cwd if isinstance(cwd, str) else ""
                        citation = f"{row['session_id']}#e{row['id']}"
                        project_context = " ".join(str(metadata.get(k, "")) for k in ("title", "project", "project_name"))
                        if cwd and re.search(r"\bcrpko\b", text + " " + project_context, re.I):
                            location = _path(cwd)
                            con.execute("INSERT OR IGNORE INTO rule_aliases VALUES(?,?,?,?)",
                                        ("crpko", Path(location).name.lower(), location, citation))
                        # A capped last paragraph may be incomplete; don't promote its fragment.
                        if len(text) > 65536:
                            text = text[:text.rfind("\n\n", 0, 65536)] if "\n\n" in text[:65536] else ""
                        for first, _, block in _blocks(text):
                            if not _owner_correction(block):
                                continue
                            scope = _scope_hint(block, _path(cwd))
                            source_record = {
                                "key": f"transcript:{path}:{row['id']}:" + hashlib.sha256(block.encode()).hexdigest(),
                                "citation": citation, "provenance": "owner_correction", "priority": 95,
                                "session": row["session_id"], "sessions": sorted(sessions), "event": row["id"], "path": str(path),
                                "timestamp": row["timestamp"],
                            }
                            build = con.execute("SELECT payload FROM rule_transcript_staging WHERE source_path=? AND event_id=0", (str(path),)).fetchone() if replay else None
                            source_record['generation'] = build[0] if build else _active_generation(con, str(path))
                            _, added = self._put(con, block, scope, None, "", source_record)
                            stats["imported" if added else "deduplicated"] += 1
                        if replay:
                            con.execute("DELETE FROM rule_transcript_replay WHERE source_path=? AND event_id=?", (str(path), row['id']))
                        else:
                            cursor = row["id"]
                        stats["rows"] += 1
                        remaining -= 1
                    con.execute("INSERT OR REPLACE INTO rule_import_progress VALUES(?,?,?,?)",
                                (str(path), identity, cursor, time.time()))
                    published = self._publish_transcript_replay(con, str(path), stats, end) if replay else None
                if published is False:
                    break
            with con:
                self._cleanup_transcript_generations(con, str(path), end)
            stats["cursor"] = cursor
            # This is an indexed existence probe, not a corpus count or scan.
            if time.monotonic() < end:
                try:
                    stats["complete"] = (source.execute("SELECT 1 FROM episodic_events WHERE id>? LIMIT 1", (cursor,)).fetchone() is None
                                         and con.execute("SELECT 1 FROM rule_transcript_replay WHERE source_path=? LIMIT 1", (str(path),)).fetchone() is None
                                         and con.execute("SELECT 1 FROM rule_transcript_staging WHERE source_path=? LIMIT 1", (str(path),)).fetchone() is None
                                         and con.execute("SELECT 1 FROM rule_sources WHERE provenance='owner_correction' AND source_path=? AND generation<>? LIMIT 1", (str(path), _active_generation(con, str(path)))).fetchone() is None)
                except sqlite3.OperationalError as exc:
                    if "interrupt" not in str(exc):
                        raise
        return stats

    def search_facts(self, messages, cwd, limit=8, session_id=None):
        """Bounded search of saved facts, independent of their action labels.

        The derived index is small. Search text as well as token keys because
        older/action-labelled imports did not index entity words. No corpus I/O.
        """
        text = " ".join(messages)
        generic = set("your you its it is are was were has had have been done hello thanks update notification alert due tomorrow today payment amount available card account people place schedule limit over under about owner build builds finished successfully complete completed test tests status ready work working fix fixed code tool tools file files".split())
        terms = _tokens(text) - _STOP - generic
        terms = {t for t in terms if len(t) >= 3 and (not t.isdigit() or len(t) >= 4)}
        if not terms: return []
        scopes = {"", _path(cwd), *map(str, Path(_path(cwd)).parents)}
        with closing(self._connect(readonly=True)) as con:
            deadline = time.monotonic()+.08
            con.set_progress_handler(lambda: int(time.monotonic()>deadline), 1000)
            ancestors = sorted(scopes - {""})
            aliases = con.execute("SELECT scope FROM rule_aliases WHERE repo=? OR path IN (" +
                                  ",".join("?" for _ in ancestors) + ")",
                                  (Path(_path(cwd)).name.lower(), *ancestors)).fetchall()
            scopes.update(r[0] for r in aliases)
            if any(part.lower().startswith('crpko') for part in Path(_path(cwd)).parts):
                scopes.add('crpko')
            rows = con.execute("SELECT r.* FROM rules r WHERE scope IN ("+",".join("?" for _ in scopes)+") "
                               "AND EXISTS (SELECT 1 FROM rule_sources s WHERE s.rule_id=r.id AND " + _active_source_clause(con) + ") LIMIT 4000", sorted(scopes)).fetchall()
            tokens = [(_tokens(r['text']) - _STOP - generic) for r in rows]
            token_groups = {}
            for row, ts in zip(rows, tokens):
                token_groups.setdefault(normalized(row['text']), set()).update(ts)
            frequency = {t: sum(t in ts for ts in token_groups.values()) for t in terms}
            matches = []
            for row, ts in zip(rows, tokens):
                overlap = terms & ts
                distinctive = {t for t in overlap if frequency[t] <= max(3, len(token_groups)*.025)}
                if not distinctive or row['text'].lstrip().startswith('---'): continue
                record = self._record(con, row)
                record = scoped_fact(record, text, session_id)
                if record is None:
                    continue
                if record.get('citation'):
                    matches.append((len(distinctive), len(overlap), record))
            representatives = {r['id'] for r in dedupe_facts([match[2] for match in matches])}
            ranked = sorted((m for m in matches if m[2]['id'] in representatives),
                            key=lambda x:(-x[0],-x[1],-x[2].get('priority',0),x[2]['id']))
            return [r for _, _, r in ranked[:limit]]

    def applicable(self, cwd, tool, arguments, *, explicit_only=False, candidates_only=False) -> list[dict]:
        arguments = _arguments(arguments)
        write_paths = _write_paths(tool, arguments, cwd)
        if explicit_only and not write_paths:
            generation = []
            for path in (self.path, Path(str(self.path) + "-wal")):
                try:
                    info = path.stat()
                    generation.append((info.st_ino, info.st_size, info.st_mtime_ns))
                except FileNotFoundError:
                    generation.append(None)
            if not _has_explicit(str(self.path), tuple(generation)):
                return []
        with closing(self._connect(readonly=True)) as con:
            actions, locations = _call_actions(tool, arguments, cwd, write_paths) if tool else (set(), [_path(cwd)])
            scopes = {""}
            by_location = {}
            for location in locations:
                ancestors = [location] + [str(parent) for parent in Path(location).parents]
                local_scopes = {"", *ancestors}
                placeholders = ",".join("?" for _ in ancestors)
                aliases = con.execute(
                    "SELECT scope FROM rule_aliases WHERE repo=? OR path IN (" + placeholders + ")",
                    [Path(location).name.lower(), *ancestors],
                ).fetchall()
                local_scopes.update(row[0] for row in aliases)
                local_scopes.update(part.lower() for part in Path(location).parts if part.lower().startswith("crpko"))
                if any(part.lower().startswith("crpko") for part in Path(location).parts):
                    local_scopes.add("crpko")
                by_location[location] = local_scopes
                scopes.update(local_scopes)
            params = list(sorted(scopes))
            sql = "SELECT r.* FROM rules r WHERE r.id IN (SELECT rule_id FROM rule_keys WHERE kind='scope' AND value IN (" + ",".join("?" for _ in params) + "))"
            sql += " AND EXISTS (SELECT 1 FROM rule_sources s WHERE s.rule_id=r.id AND " + _active_source_clause(con) + ")"
            if candidates_only:
                sql += " AND (r.id IN (SELECT rule_id FROM rule_keys WHERE kind='path') OR (r.actions LIKE '%file.write%' AND r.text LIKE '%harness-config-parity%') OR r.constraints_json != '[]' OR r.id IN (SELECT rule_id FROM rule_sources WHERE provenance='explicit') OR (r.recipient != '' AND r.id IN (SELECT rule_id FROM rule_sources WHERE provenance='owner_correction')))"
            if explicit_only and not write_paths:
                sql += " AND r.id IN (SELECT rule_id FROM rule_sources WHERE provenance='explicit')"
            if tool:
                action_values = sorted(actions)
                # JSON field names (especially "command") are not action evidence.
                values = " ".join(str(v) for v in arguments.values() if isinstance(v, str))
                token_values = sorted(_tokens(tool + " " + values) - _STOP - {"command", "cmd", "input", "bash", "shell", "echo", "ok"})
                clauses = []
                if action_values:
                    clauses.append("(kind='action' AND value IN (" + ",".join("?" for _ in action_values) + "))")
                    params.extend(action_values)
                if token_values:
                    clauses.append("(kind IN ('token','recipient') AND value IN (" + ",".join("?" for _ in token_values) + "))")
                    params.extend(token_values)
                if not clauses:
                    return []
                sql += " AND r.id IN (SELECT rule_id FROM rule_keys WHERE " + " OR ".join(clauses) + ")"
            records = []
            argument_text = (tool + " " + _json(arguments)).lower()
            for row in con.execute(sql, params).fetchall():
                record = self._record(con, row)
                triggers = [r[0] for r in con.execute("SELECT value FROM rule_keys WHERE rule_id=? AND kind='path'", (row["id"],))]
                triggers = triggers or (_path_triggers(record["text"]) if "file.write" in record["actions"] else [])
                if tool and triggers:
                    triggers = [t for t in triggers if t.startswith('@') or _specific_path(t)]
                    if any(_matches_path(t,p) for t in triggers for p in write_paths):
                        record["path_matched"] = True
                    elif not ((set(record['actions']) & actions) - {'file.write'}):
                        continue
                if tool and record["actions"] and not (set(record["actions"]) & actions):
                    continue
                if tool and record["recipient"] and not (actions & {"message", "comment", "order", "booking", "payment"}):
                    continue
                if tool and not record["actions"] and not record["recipient"]:
                    if len(set(token_values) & (_tokens(record["text"]) - _STOP)) < 2:
                        continue
                if tool and record["recipient"] and not re.search(
                        r"(?<![\w])" + re.escape(record["recipient"].lower()) + r"(?![\w])", argument_text):
                    continue
                record["matched_cwds"] = [location for location, local in by_location.items() if record["scope"] in local]
                git_actions = set(record["actions"]) & {"git.commit", "git.push"}
                if git_actions and not ((set(record["actions"]) & actions) - {"git.commit", "git.push", "deploy"}):
                    command = str(arguments.get("command", arguments.get("cmd", "")))
                    initial = str(arguments.get("workdir", arguments.get("cwd", cwd)) or cwd)
                    relevant = {call["cwd"] for action in git_actions
                                for call in _git_pushes(command, initial, verb=action.split(".")[1])}
                    record["matched_cwds"] = [location for location in record["matched_cwds"] if location in relevant]
                    if not record["matched_cwds"]:
                        continue
                records.append(record)
                record['specific_matched'] = bool(record.get('citation') and (
                    record.get('path_matched') or
                    (record.get('provenance') == 'explicit' and (
                        bool(record.get('recipient')) or
                        bool(set(record['actions']) & {_tool_name(tool), tool.lower()}) or
                        bool(record.get('scope') and set(record['actions']) & actions & {'git.commit', 'git.push'})))))
            return sorted(records, key=lambda r: (-r.get("priority", 0), -r.get("source_timestamp", 0), r["id"]))


def evaluate_conflict(rules, tool, arguments, cwd) -> dict | None:
    """Only a literal push to an explicitly prohibited branch proves a conflict."""
    arguments = _arguments(arguments)
    # A recipient-scoped prohibition naming an exact phrase is a clear conflict
    # only when that phrase is actually present in outgoing text/body input.
    values = [str(v) for k, v in arguments.items() if k.lower() in {"text", "body", "message", "content"} and isinstance(v, str)]
    recipients = [str(v).casefold().strip() for k, v in arguments.items()
                  if k.lower() in {"recipient", "to", "contact", "chat", "chat_name"} and isinstance(v, str)]
    message_action = bool(re.search(r"(?:^|[._/])(?:send|reply|message)(?:$|[._/])", _tool_name(tool)))
    for rule in rules:
        if not rule.get("citation") or not rule.get("recipient"):
            continue
        if not message_action or rule["recipient"].casefold().strip() not in recipients:
            continue
        match = re.search(r"\b(?:never|don't|do not)\s+(?:say|write|use)(?:\s+the phrase)?\s+['\"‘“]([^'\"’”]{2,120})['\"’”]", rule.get("text", ""), re.I)
        if match and any(match.group(1).casefold() in value.casefold() for value in values):
            return {"decision": "deny", "reason": f"Revise the message to {rule['recipient']}: don't say {match.group(1)!r}. Source: {rule['citation']} — {rule['text']}",
                    "citations": [rule["citation"]], "rule_ids": [rule["id"]]}
    if _tool_name(tool) not in _SHELL_TOOLS:
        return None
    command = str(arguments.get("command", arguments.get("cmd", "")))
    cwd = str(arguments.get("workdir", arguments.get("cwd", cwd)) or cwd)
    for push in _git_pushes(command, cwd):
        applicable = []
        for rule in rules:
            if not rule.get("citation"):
                continue
            matched = rule.get("matched_cwds")
            if matched is not None:
                if push["cwd"] not in matched:
                    continue
            elif not _scope_path(rule.get("scope", ""), push["cwd"]):
                continue
            for constraint in rule.get("constraints", _constraints(rule.get("text", ""))):
                if constraint.get("kind") == "branch":
                    applicable.append((rule, constraint))
        for violated in push["destinations"]:
            evidence = [(r, c) for r, c in applicable if violated in c.get("forbidden", []) or violated == c.get("allowed")]
            if not evidence:
                continue
            priority = max(r.get("priority", 0) for r, _ in evidence)
            strongest = [(r, c) for r, c in evidence if r.get("priority", 0) == priority]
            # Contradictory authority is context, not proof that an action must be denied.
            if any(c.get("allowed") == violated for _, c in strongest):
                continue
            for rule, constraint in strongest:
                if violated in constraint.get("forbidden", []):
                    repo = Path(push["cwd"]).name or "this repository"
                    return {"decision": "deny", "reason": f"{repo}: don't push to {violated}; push to {constraint['allowed']} instead. Source: {rule['citation']} — {rule['text']}",
                            "citations": [rule["citation"]], "rule_ids": [rule["id"]] if "id" in rule else []}
    return None

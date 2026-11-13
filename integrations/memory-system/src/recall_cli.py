"""recall: search and read every past agent session (Codex, Hermes, OpenCode, Muse Code).

  recall list [words] [--cwd DIR] [--source S] [--since 7d] [-n 20] [--all]
  recall query <words> [--tools] [--cwd DIR] [--source S] [--since/--until] [-n 10]
  recall search "<question>" [--cwd DIR] [--since/--until] [--source S] [--timeout 30]
  recall view <session>[#5-12|#e<event>] [--tools] [--reasoning]
  recall inject "<prompt>" [--cwd DIR]      (what the auto-recall would add)
  recall refresh [--full]                   (session catalog)

Every command takes --json. Session ids accept unique prefixes.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

import recall_core as rc

REF_RE = re.compile(r"^(?P<id>[^#@\s]+)(?:[#@](?P<frag>\S+))?$")


def parse_ref(ref: str) -> tuple[str, int | None, int | None, int | None]:
    m = REF_RE.match(ref.strip())
    if not m:
        raise ValueError(f"bad session reference: {ref}")
    ident, frag = m.group("id"), m.group("frag")
    start = end = at = None
    if frag:
        if frag.startswith("e") and frag[1:].isdigit():
            at = int(frag[1:])
        elif ref.strip()[len(ident)] == "@" and frag.isdigit():
            at = int(frag)
        elif re.fullmatch(r"\d+-\d+", frag):
            a, b = frag.split("-")
            start, end = int(a), int(b)
        elif frag.isdigit():
            start = int(frag)
            end = start + 19
        else:
            raise ValueError(f"bad range '{frag}': use #5-12, #5 or #e<event-id>")
    return ident, start, end, at


# ---------------------------------------------------------------------------
# formatting (shared with the MCP server)


def format_session_line(s: dict) -> str:
    title = s.get("title") or s.get("first_prompt") or "(untitled)"
    bits = [rc.fmt_ts(s.get("last_ts"), False), s.get("source", "?"), s["session_id"], f'"{rc.nice_title(title)[:90]}"']
    if s.get("cwd"):
        bits.append(f"({s['cwd']})")
    if s.get("parent_id"):
        bits.append(f"[subagent of {s['parent_id']}]")
    return " ".join(bits)


def format_search(res: dict, *, show_queries: bool = True) -> str:
    sessions = res.get("sessions") or []
    lines = []
    if show_queries:
        used = [q.get("match") or q.get("error") or "-" for q in res.get("queries", [])]
        lines.append(f"{len(sessions)} of {res.get('total_sessions', 0)} sessions · {res.get('elapsed_ms', 0)} ms · fts: {' | '.join(used)}")
    for i, s in enumerate(sessions, 1):
        lines.append(f"\n[{i}] {format_session_line(s)} · {s.get('matches', 0)} hits")
        for h in s.get("hits", []):
            lines.append(f"    e{h['event_id']} {rc.fmt_ts(h['ts'])} {h['speaker']}: {h['snippet']}")
        lines.append(f"    read: recall view {s['session_id']}#e{s['hits'][0]['event_id']}" if s.get("hits") else "")
    if not sessions:
        lines.append("No matches. Try fewer or different words, or --tools to include commands and tool output.")
    return "\n".join(l for l in lines if l is not None)


def format_view(ref: str, *, include_tools: bool = False, include_reasoning: bool = False, total_chars: int = 60000,
                resolved_session: str | None = None) -> str:
    ident, start, end, at = parse_ref(ref)
    sid = resolved_session if resolved_session is not None else rc.resolve_session(ident)
    if not sid:
        return f"No session matches '{ident}'."
    head = rc.session_header(sid)
    if at is not None:
        msgs, _ = rc.read_around(sid, at, include_tools=include_tools, include_reasoning=include_reasoning)
        if not msgs:
            return f"{head}\n\nEvent e{at} is not in this session."
        body, _ = rc.render_messages(msgs, total_chars=total_chars, relative=True)
        first, last = msgs[0].event_id, msgs[-1].event_id
        head += f"\naround e{at}; earlier: recall view {sid}#e{first} · later: recall view {sid}#e{last}"
        return f"{head}\n\n{body}"
    start = start or 1
    count = (end - start + 1) if end else 40
    msgs = rc.session_messages(sid, include_tools=include_tools, include_reasoning=include_reasoning, start=start, count=count + 1)
    more = len(msgs) > count
    msgs = msgs[:count]
    body, last = rc.render_messages(msgs, total_chars=total_chars)
    if last is not None and (more or last.n < msgs[-1].n):
        head += f"\nshowing #{msgs[0].n}-{last.n}; next: recall view {sid}#{last.n + 1}-{last.n + count}"
    elif not msgs and start > 1:
        body = f"(no messages from #{start})"
    return f"{head}\n\n{body}"


def format_list(rows: list[dict]) -> str:
    if not rows:
        return "No sessions."
    return "\n".join(format_session_line(r) for r in rows)


# ---------------------------------------------------------------------------


def _common(p: argparse.ArgumentParser, *, window: bool = True) -> None:
    p.add_argument("--json", action="store_true")
    p.add_argument("--source", choices=["codex", "hermes", "opencode", "muse", "claude"])
    p.add_argument("--cwd", help="only sessions in this directory (or below)")
    if window:
        p.add_argument("--since", help="YYYY-MM-DD, 7d, 3w, 2m")
        p.add_argument("--until")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="recall", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="recent sessions")
    p.add_argument("words", nargs="*")
    p.add_argument("-n", type=int, default=20)
    p.add_argument("--all", action="store_true", help="include subagent sessions")
    _common(p)

    p = sub.add_parser("query", help="exact keyword search, sessions best-first")
    p.add_argument("words", nargs="+")
    p.add_argument("-n", type=int, default=10)
    p.add_argument("--tools", action="store_true", help="also search commands, tool output and errors")
    p.add_argument("--exact", action="store_true", help="all words must match (no fallback)")
    _common(p)

    p = sub.add_parser("search", help="ask a question; Haiku answers with citations")
    p.add_argument("question", nargs="+")
    p.add_argument("--timeout", type=float, default=30)
    _common(p)

    p = sub.add_parser("view", help="read a session")
    p.add_argument("ref", help="<session>[#5-12|#5|#e<event>]")
    p.add_argument("--tools", action="store_true")
    p.add_argument("--reasoning", action="store_true")
    p.add_argument("--max-chars", type=int, default=60000)
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("inject", help="preview what auto-recall would add to a prompt")
    p.add_argument("prompt", nargs="+")
    p.add_argument("--cwd")
    p.add_argument("--session")
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("refresh", help="update the session catalog")
    p.add_argument("--full", action="store_true")
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("remember", help="save an explicit owner instruction for later pre-action checks")
    p.add_argument("text")
    p.add_argument("--scope", default="")
    p.add_argument("--action", default="")
    p.add_argument("--recipient", default="")
    p.add_argument("--source-session", default="")
    p.add_argument("--rules-db", default=os.environ.get("RECALL_RULES_DB", str(rc.DATA / "recall_rules.db")))

    for command in ('redact', 'redact-backups'):
        p = sub.add_parser(command, help='count-only redaction; requires approved --yes to write')
        p.add_argument('--needle-file', required=command == 'redact-backups')
        p.add_argument('--root', default=os.environ.get('MEMORY_ROOT', str(rc.ROOT)))
        p.add_argument('--dry-run', action='store_true')
        p.add_argument('--yes', action='store_true')
        if command == 'redact':
            p.add_argument('--session')
            p.add_argument('--item')
            p.add_argument('--reason', required=True, help='incident identifier; no secret text')
        else:
            backup_root = '/Volumes/ExternalSSD/memory-system-backup'
            p.add_argument('--repository', default=backup_root+'/restic/live')
            p.add_argument('--stage', default=backup_root+'/replica')
            p.add_argument('--paths-from')
            p.add_argument('--cold-repository', default=backup_root+'/restic/cold-archive')
            p.add_argument('--dropbox-destination', default='/Backups/memory-system/live')
            p.add_argument('--cold-destination', default='/Backups/memory-system/cold-archive')
            p.add_argument('--local-only', action='store_true', help='fixtures/local repo only; excludes Dropbox and cold archive')

    a = ap.parse_args(argv)
    if a.cmd in ('redact', 'redact-backups'):
        try:
            if a.cmd == 'redact':
                from redact import run
            else:
                from redact_backups import run
            result = run(a)
            print(json.dumps(result))
            return 0 if result['verify'] or a.dry_run else 1
        except Exception:
            # Even a SQLite/path/JSON error can contain the needle. No traceback,
            # payload, reason, hash, length or subprocess output may escape.
            print(json.dumps({'verify': False, 'errors': 1}), file=sys.stderr)
            return 2

    out = lambda obj, text: print(json.dumps(obj, indent=1, default=str) if a.json else text)  # noqa: E731

    from redact_lock import fence
    lease = fence(rc.ROOT)
    lease.__enter__()
    try:
        if a.cmd == "remember":
            from recall_rules import RuleIndex
            index = RuleIndex(a.rules_db)
            try:
                print(json.dumps(index.remember(a.text, scope=a.scope, actions=[a.action] if a.action else None,
                                                 recipient=a.recipient, source_session=a.source_session)))
            finally:
                close = getattr(index, "close", None)
                if close:
                    close()
        elif a.cmd == "list":
            rows = rc.list_sessions(
                text=" ".join(a.words) or None,
                source=a.source,
                cwd=a.cwd,
                since=rc.parse_when(a.since),
                until=rc.parse_when(a.until),
                include_children=a.all,
                limit=a.n,
            )
            out(rows, format_list(rows))
        elif a.cmd == "query":
            res = rc.search(
                " ".join(a.words),
                source=a.source,
                since=rc.parse_when(a.since),
                until=rc.parse_when(a.until),
                include_tools=a.tools,
                cwd=a.cwd,
                cwd_only=bool(a.cwd),
                limit_sessions=a.n,
                exact=a.exact,
            )
            for warning in dict.fromkeys(q["warning"] for q in res["queries"] if q.get("warning")):
                print(f"recall: {warning}", file=sys.stderr)
            out(res, format_search(res))
        elif a.cmd == "search":
            import recall_ask as ra

            res = ra.ask(" ".join(a.question), cwd=a.cwd, cwd_only=bool(a.cwd), since=a.since, until=a.until, source=a.source, timeout=a.timeout,
                         here=os.environ.get("PWD") or None)
            text = res["answer"]
            if res["sources"]:
                text += "\n\n" + ra.format_sources(res["sources"])
            text += f"\n\n({res['timings'].get('total_ms', res['timings'].get('search_ms'))} ms; queries: {', '.join(res['queries'])})"
            out(res, text)
        elif a.cmd == "view":
            text = format_view(a.ref, include_tools=a.tools, include_reasoning=a.reasoning, total_chars=a.max_chars)
            out({"text": text}, text)
        elif a.cmd == "inject":
            import recall_ask as ra

            t0 = time.monotonic()
            res = ra.inject(" ".join(a.prompt), cwd=a.cwd, session_id=a.session, anonymous_preview=not a.session)
            res["elapsed_ms"] = int((time.monotonic() - t0) * 1000)
            out(res, res.get("note") or f"(nothing injected: {res.get('skipped')}; queries: {res.get('queries')}; {res['elapsed_ms']} ms)")
        elif a.cmd == "refresh":
            res = rc.refresh_catalog(full=a.full, progress=None if a.json else (lambda d, n: print(f"{d}/{n}", file=sys.stderr)))
            out(res, json.dumps(res))
    except (ValueError, rc.Timeout) as e:
        print(f"recall: {e}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 0
    finally:
        lease.__exit__(None, None, None)
    return 0


if __name__ == "__main__":
    sys.exit(main())

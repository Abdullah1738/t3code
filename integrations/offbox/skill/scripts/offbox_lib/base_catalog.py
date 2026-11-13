"""Read saved-base metadata across backends without allocating or importing backend-bound APIs."""
from __future__ import annotations

import os
import sqlite3

from . import common


def backend_label(name: str) -> str:
    return "home" if name == "server" else "boat standby"


def rows(backend: str, *, include_expired: bool = False, include_other_owners: bool = False) -> list[dict]:
    path = common.db_path_for(backend)
    if not path.exists():
        return []
    # Person work cannot use the shared Boat account, including its saved state.
    if backend == "boat" and common.person() and common.home_config() is not None:
        return []
    try:
        con = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
        try:
            con.row_factory = sqlite3.Row
            columns = {r[1] for r in con.execute("PRAGMA table_info(bases)")}
            if not columns:
                return []
            result = [dict(r) for r in con.execute("SELECT * FROM bases ORDER BY repo_key, is_default DESC, created_at DESC")]
            for r in result:
                r.setdefault("saved", None)
                r.setdefault("expired_at", None)
                if backend == "server" and r.get("token_owner") is None:
                    r["token_owner"] = common.base_owner(r.get("created_by"))
            return [r for r in result
                    if (include_expired or r.get("expired_at") is None or r.get("saved"))
                    and (include_other_owners or backend != "server" or (r.get("token_owner") or common.DEFAULT_OWNER) == common.token_owner())]
        finally:
            con.close()
    except sqlite3.Error as error:
        raise common.local_error(error) from error


def all_rows(*, include_expired: bool = False) -> list[dict]:
    return [{**r, "backend": backend_label(backend)}
            for backend in ("server", "boat") for r in rows(backend, include_expired=include_expired)]


def full_name(name: str, repo_key: str) -> str:
    return name if ":" in name else f"{repo_key}:{name}"


def missing(name: str) -> common.OffboxError:
    repo = name.split(":", 1)[0]
    saved = [r for r in all_rows() if r["repo_key"] == repo]
    choices = [f"{r.get('short') or r['name'].split(':', 1)[-1]} "
               f"({r['backend']}{', default' if r['is_default'] else ''})" for r in saved[:8]]
    if len(saved) > 8:
        choices.append(f"{len(saved) - 8} more (offbox bases)")
    return common.OffboxError(f"no saved base '{name}'. Saved bases for {repo}: "
                             f"{', '.join(choices) or 'none'}. Use --base <name>, or omit --base for the default.", code=2)


def validate(name: str, repo_key: str) -> None:
    full = full_name(name, repo_key)
    available = [r for r in all_rows() if r["name"] == full]
    if not available:
        raise missing(full)
    selected = backend_label(common.backend())
    # Automatic failover also pins Boat in the re-executed process; home-only bases still use its recipe fallback.
    if (common.backend_pinned() and not os.environ.get("OFFBOX_FAILOVER")
            and not any(r["backend"] == selected for r in available)):
        r = available[0]
        raise common.OffboxError(f"base '{full}' exists only on {r['backend']} (box {r['box_id']}, "
                                 f"saved {common.iso(r['created_at'])}); the pinned {selected} backend has no copy. "
                                 "Remove the backend pin or choose a base on that backend. Nothing ran.", code=2)

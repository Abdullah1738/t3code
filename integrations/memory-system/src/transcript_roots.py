"""Native transcript homes captured into memory.db (manifest: transcript_roots.json).

Only the Robob-owned harness homes listed in the manifest are read. A root
that does not exist is reported as missing, never as "no sessions", so health
can tell a dead disk from an idle harness.
"""

import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.environ.get("TRANSCRIPT_ROOTS", os.path.join(HERE, "transcript_roots.json"))


def load(path=MANIFEST):
    with open(path) as f:
        entries = json.load(f)
    if not isinstance(entries, list):
        raise ValueError(f"{path}: expected a JSON list")
    out = []
    for e in entries:
        if not isinstance(e, dict) or not all(isinstance(e.get(k), str) and e.get(k) for k in ("driver", "instance", "root")):
            raise ValueError(f"{path}: each entry needs string driver, instance and root")
        out.append(dict(e))
    return out


def resolve(entries=None):
    """Return [{driver, instance, root, path, exists}] with ~ expanded and realpath applied."""
    rows = []
    for e in load() if entries is None else entries:
        path = os.path.realpath(os.path.expanduser(e["root"]))
        rows.append(dict(e, path=path, exists=os.path.isdir(path)))
    return rows


def existing(entries=None):
    return [r for r in resolve(entries) if r["exists"]]

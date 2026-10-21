#!/usr/bin/env python3
"""Fake dropbox_mirror.py: Dropbox is the local directory FAKE_DROPBOX. Same CLI, summary line and the two
module functions the backup's guard uses (Api().call("files/get_metadata"), dbx_hash)."""

import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

DROPBOX = Path(os.environ.get("FAKE_DROPBOX", "/nonexistent"))


def dbx_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Api:
    def call(self, ep, arg):
        assert ep == "files/get_metadata"
        p = DROPBOX / arg["path"].lstrip("/")
        return {"content_hash": dbx_hash(p)} if p.is_file() else None


def main():
    local, remote = Path(sys.argv[1]), DROPBOX / sys.argv[2].lstrip("/")
    files = {str(p.relative_to(local)) for p in local.rglob("*") if p.is_file()}
    for f in files:
        dst = remote / f
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            # restic packs are read-only; Dropbox replaces a file, it doesn't write into it
            dst.unlink()
        shutil.copyfile(local / f, dst)
    deleted = 0
    if "--delete" in sys.argv:
        for p in list(remote.rglob("*")):
            if p.is_file() and str(p.relative_to(remote)) not in files:
                p.unlink()
                deleted += 1
    print(json.dumps({"ok": True, "local_files": len(files), "uploaded": len(files), "deleted": deleted,
                      "errors": []}))


if __name__ == "__main__":
    main()

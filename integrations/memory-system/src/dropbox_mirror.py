#!/opt/homebrew/bin/python3
"""Mirror a local directory (restic repo) to Dropbox and verify it.

Uploads go through the official Dropbox CLI (dbxcli, ~/.local/bin/dbxcli).
Listing/verification reads Dropbox metadata (content_hash) with the same
dbxcli OAuth credentials (~/.config/dbxcli/auth.json, refreshed in memory,
never written back or printed).

  dropbox_mirror.py LOCAL_DIR /Dropbox/Path [--delete] [--jobs 4] [--dry-run]
  dropbox_mirror.py LOCAL_DIR /Dropbox/Path --verify-only

A file counts as mirrored only when the Dropbox content_hash equals the
locally computed Dropbox hash (sha256 of per-4MiB sha256 digests). Exit 0 only
when every local file is verified remotely (and, with --delete, no remote
extras remain). Prints one JSON summary line at the end.
"""
import argparse, concurrent.futures as cf, hashlib, http.client, json, os, subprocess, sys, time
import urllib.error, urllib.parse, urllib.request

DBX = os.path.expanduser("~/.local/bin/dbxcli")
AUTH = os.path.expanduser("~/.config/dbxcli/auth.json")
BLOCK = 4 * 1024 * 1024


def load_auth(path=AUTH):
    """Parse the dbxcli auth file. Trailing bytes after the JSON object are an
    error, not silently ignored: a stray brace once broke every Dropbox run."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    # JSON whitespace is exactly space, tab, CR, LF; str.strip() also eats NBSP etc.
    ws = " \t\r\n"
    start = len(text) - len(text.lstrip(ws))
    try:
        d, end = json.JSONDecoder().raw_decode(text, start)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"{path} is not valid JSON: {e.msg} at char {e.pos} "
                           f"(of {len(text)}); repair the file, don't print it") from None
    if text[end:].strip(ws):
        raise RuntimeError(f"{path} has {len(text) - end} trailing byte(s) after the JSON "
                           f"object at char {end} (of {len(text)}); repair the file")
    return d


def token():
    d = load_auth()
    p = (d.get("") or next(iter(d.values())))["personal"]
    body = urllib.parse.urlencode({"grant_type": "refresh_token",
                                   "refresh_token": p["refresh_token"],
                                   "client_id": p["app_key"]}).encode()
    r = urllib.request.urlopen("https://api.dropboxapi.com/oauth2/token", body, timeout=60)
    return json.load(r)["access_token"]


class Api:
    def __init__(self):
        self.tok, self.t = token(), time.time()

    def call(self, ep, arg):
        if time.time() - self.t > 3000:
            self.tok, self.t = token(), time.time()
        for attempt in range(6):
            req = urllib.request.Request("https://api.dropboxapi.com/2/" + ep,
                                         json.dumps(arg).encode(),
                                         {"Authorization": "Bearer " + self.tok,
                                          "Content-Type": "application/json"})
            try:
                return json.load(urllib.request.urlopen(req, timeout=120))
            except urllib.error.HTTPError as e:
                msg = e.read().decode(errors="replace")
                if e.code == 409 and "not_found" in msg:
                    return None
                if e.code in (429, 500, 502, 503, 504):
                    time.sleep(2 ** attempt); continue
                raise RuntimeError(f"{ep} HTTP {e.code}: {msg[:300]}")
            except (urllib.error.URLError, TimeoutError, ConnectionError,
                    http.client.HTTPException, json.JSONDecodeError):
                # A dropped or truncated response (IncompleteRead, reset) is transient:
                # these calls are reads or idempotent batch checks, so retry them.
                time.sleep(2 ** attempt)
        raise RuntimeError(f"{ep}: retries exhausted")

    def list_files(self, root):
        out = {}
        r = self.call("files/list_folder", {"path": root, "recursive": True, "limit": 2000})
        if r is None:
            return out
        while True:
            for e in r["entries"]:
                if e[".tag"] == "file":
                    rel = e["path_display"][len(root):].lstrip("/")
                    out[rel.lower()] = {"path": e["path_display"], "size": e["size"],
                                        "hash": e.get("content_hash")}
            if not r.get("has_more"):
                return out
            r = self.call("files/list_folder/continue", {"cursor": r["cursor"]})


def dbx_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(BLOCK)
            if not b:
                break
            h.update(hashlib.sha256(b).digest())
    return h.hexdigest()


def local_files(root):
    out = {}
    for d, _, fs in os.walk(root):
        for n in fs:
            if n.startswith(".") or n.endswith(".tmp"):
                continue
            p = os.path.join(d, n)
            if os.path.islink(p) or not os.path.isfile(p):
                continue
            rel = os.path.relpath(p, root)
            out[rel.lower()] = {"rel": rel, "abs": p, "size": os.path.getsize(p)}
    return out


def wait_delete(api, job, limit=1800):
    t0 = time.time()
    while time.time() - t0 < limit:
        r = api.call("files/delete_batch/check", {"async_job_id": job})
        tag = (r or {}).get(".tag")
        if tag == "complete":
            bad = [e for e in r.get("entries", []) if e.get(".tag") == "failure"]
            return f"{len(bad)} deletes failed" if bad else None
        if tag != "in_progress":
            return f"delete_batch {tag}"
        time.sleep(5)
    return "delete_batch still running"


def upload(src, dst, tok):
    # dbxcli refreshes and rewrites auth.json unlocked and non-atomically when it
    # runs from the file, so parallel puts can corrupt the shared file. Hand it the
    # token we already hold in memory via DBXCLI_ACCESS_TOKEN (never saved locally).
    env = dict(os.environ, DBXCLI_ACCESS_TOKEN=tok)
    for attempt in range(4):
        r = subprocess.run([DBX, "put", "--if-exists", "overwrite", "-w", "4",
                            "-c", str(32 * 1024 * 1024), "--timeout", "30m", src, dst],
                           capture_output=True, text=True, env=env)
        if r.returncode == 0:
            return None
        time.sleep(5 * (attempt + 1))
    return (r.stderr or r.stdout)[-300:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("local"); ap.add_argument("remote")
    ap.add_argument("--delete", action="store_true")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify-only", action="store_true")
    a = ap.parse_args()
    root = a.remote.rstrip("/")
    t0 = time.time()
    api = Api()
    loc = local_files(a.local)
    rem = api.list_files(root)

    hashes = {}
    def lh(k):
        return hashes.setdefault(k, dbx_hash(loc[k]["abs"]))

    # which local files need upload: missing or size differs; same size -> hash check
    need, checked = [], 0
    with cf.ThreadPoolExecutor(8) as ex:
        same = [k for k in loc if k in rem and rem[k]["size"] == loc[k]["size"]]
        for k, h in zip(same, ex.map(lh, same)):
            checked += 1
            if h != rem[k]["hash"]:
                need.append(k)
    need += [k for k in loc if k not in rem or rem[k]["size"] != loc[k]["size"]]
    extras = [k for k in rem if k not in loc]

    errors = []
    uploaded = 0
    if not a.verify_only and not a.dry_run and need:
        with cf.ThreadPoolExecutor(a.jobs) as ex:
            futs = {ex.submit(upload, loc[k]["abs"], f"{root}/{loc[k]['rel']}", api.tok): k
                    for k in need}
            for fu in cf.as_completed(futs):
                err = fu.result()
                if err:
                    errors.append({"file": loc[futs[fu]]["rel"], "error": err})
                else:
                    uploaded += 1
        # re-verify everything we touched
        rem = api.list_files(root)
        for k in need:
            if k not in rem or rem[k]["hash"] != lh(k):
                errors.append({"file": loc[k]["rel"], "error": "hash mismatch after upload"})
    elif need:
        errors += [{"file": loc[k]["rel"], "error": "missing or different remotely"} for k in need]

    deleted = 0
    if a.delete and extras and not a.verify_only and not a.dry_run:
        # delete in batches via API (dbxcli rm per file is slow for many packs)
        for i in range(0, len(extras), 500):
            batch = [{"path": rem[k]["path"]} for k in extras[i:i + 500]]
            r = api.call("files/delete_batch", {"entries": batch})
            # delete_batch is async; a 500-file job can take minutes, and
            # listing before it finishes reports the pending files as extras
            if r and r.get(".tag") == "async_job_id":
                err = wait_delete(api, r["async_job_id"])
                if err:
                    errors.append({"error": err})
            deleted += len(batch)
        rem = api.list_files(root)
        extras = [k for k in rem if k not in loc]
    if a.delete and extras:
        errors.append({"error": f"{len(extras)} remote files not present locally"})

    summary = {"ok": not errors, "local_files": len(loc),
               "local_bytes": sum(v["size"] for v in loc.values()),
               "remote_files": len(rem), "needed": len(need), "uploaded": uploaded,
               "hash_checked": checked, "deleted": deleted, "extras": len(extras),
               "errors": errors[:20], "secs": round(time.time() - t0)}
    print(json.dumps(summary))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())

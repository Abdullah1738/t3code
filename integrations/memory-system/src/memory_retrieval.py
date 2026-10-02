#!/usr/bin/env python3
"""Hybrid retrieval over the memory store.

Facts (semantic_facts): exact vector search (Qwen3-Embedding-0.6B, brute
force over fp16 vectors kept in memory, scored in fp32 chunks) fused with BM25 (semantic_fts) via
reciprocal rank fusion, filtered to active facts, near-duplicate results
collapsed. History (episodic_events): FTS5 over episodic_fts, ranked by bm25
inside the most recent N matches so common terms stay fast.

Read-only against memory.db and fact_vectors.db.
Run with the project venv: .venv/bin/python src/memory_retrieval.py "query"
"""
import json
import os
import re
import sqlite3
import sys
import threading
import time

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM_DB = os.path.join(ROOT, "data", "memory.db")
VEC_DB = os.path.join(ROOT, "data", "fact_vectors.db")
NOTES_DB = os.path.join(ROOT, "data", "agent_notes.db")
VEC_SNAP = os.path.join(ROOT, "data", "fact_vectors.snapshot")
MODEL = "Qwen/Qwen3-Embedding-0.6B"
DIM = 1024
QUERY_INSTRUCT = (
    "Instruct: Given a question or topic from a software engineer's AI coding "
    "assistant, retrieve remembered facts, decisions, constraints, workflows, "
    "solved problems and personal details that are relevant\nQuery:"
)
FACT_TYPES = ("decision", "preference", "solved_problem", "profile", "workflow", "constraint")
RRF_K = 60
STOP = set(
    "a an and are as at be by can do does for from has have how i in is it its me my "
    "of on or our should that the this to was we what when where which who why will "
    "with you your did were been about into there their them then than so not no".split()
)


def ro(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30, check_same_thread=False)
    con.execute("PRAGMA query_only=1")
    return con


SQLITE_MAX_INT = 2**63 - 1


class QueryError(ValueError):
    """Bad user-supplied query (e.g. invalid raw FTS5 syntax)."""


def fts_query(text, mode="or"):
    """Turn free text into a safe FTS5 query (quoted tokens). Unicode word
    characters are kept (FTS5 unicode61 indexes CJK, accents, etc.); single
    ASCII characters are dropped as noise."""
    toks = [t.strip(".-") for t in re.findall(r"\w[\w.\-]*", (text or "").lower())]
    toks = [t for t in toks if (len(t) > 1 or (t and not t.isascii())) and t not in STOP]
    toks = list(dict.fromkeys(toks))
    if not toks:
        return None
    joiner = " OR " if mode == "or" else " AND "
    return joiner.join('"%s"' % t.replace('"', "") for t in toks[:16])


def invalidate_snapshot():
    """Make the vector snapshot unusable (next start reads fact_vec). Call after
    rewriting existing fact_vec rows."""
    try:
        os.remove(VEC_SNAP + ".json")
    except FileNotFoundError:
        pass


def fmt_ts(ts):
    if not ts:
        return None
    try:
        # local time, matching how `since` (YYYY-MM-DD) is parsed via mktime
        return time.strftime("%Y-%m-%d", time.localtime(float(ts)))
    except (TypeError, ValueError):
        return str(ts)


class Memory:
    def __init__(self, device=None, preload=False):
        self.device = device
        self._model = None
        self._ids = None
        self._mat = None
        self._vec_count = 0
        self._lock = threading.Lock()
        # MPS/Metal is not thread-safe: concurrent encode() calls abort the
        # process (IOGPUMetalCommandBuffer assertion). Serialize all encodes.
        self._enc_lock = threading.Lock()
        self._vw_lock = threading.Lock()  # fact_vectors.db writer connection
        # One read-only sqlite connection per thread: a shared connection
        # interleaves cursors across concurrent requests (wrong-shape rows).
        self._tl = threading.local()
        if preload:
            self._load_vectors()
            self._embed(["warmup"])

    @property
    def mem(self):
        con = getattr(self._tl, "con", None)
        if con is None:
            con = self._tl.con = ro(MEM_DB)
        return con

    # vectors -----------------------------------------------------------
    # In memory the vectors stay fp16 (as stored; 1.5GB for 726k facts instead
    # of 3GB as fp32) in a preallocated buffer with spare rows, so the minutely
    # appends write in place instead of copying the whole matrix (each copy used
    # to leave another multi-GB block behind in malloc). Readers take a
    # consistent (ids, mat) view under _lock; appends only write past the end
    # of any view already handed out.
    def _set_vectors(self, ids, mat, cap=0):
        """Replace the in-memory vectors. Caller holds _lock."""
        n = len(ids)
        cap = max(cap, int(n * 1.05) + 4096)
        self._idbuf = np.empty(cap, dtype=np.int64)
        self._vbuf = np.empty((cap, DIM), dtype=np.float16)
        self._idbuf[:n] = ids
        for i in range(0, n, 65536):  # chunked: mat may be an mmap or fp32
            j = min(i + 65536, n)
            self._vbuf[i:j] = mat[i:j]
        self._n = n
        self._publish()

    def _append_vectors(self, ids, mat):
        """Append rows (any float dtype). Caller holds _lock."""
        k = len(ids)
        if not k:
            return
        if getattr(self, "_vbuf", None) is None:
            self._set_vectors(ids, mat)
            return
        n = self._n
        if n + k > len(self._idbuf):  # grow ~5%; old buffer lives on in any open views
            idbuf, vbuf = self._idbuf, self._vbuf
            self._set_vectors(idbuf[:n], vbuf[:n], cap=int((n + k) * 1.05) + 4096)
        self._idbuf[n:n + k] = ids
        self._vbuf[n:n + k] = mat
        self._n = n + k
        self._publish()

    def _publish(self):
        self._ids = self._idbuf[:self._n]
        self._mat = self._vbuf[:self._n]
        self._vec_count = self._n
        self._sorted = None  # vec_of lookup index, rebuilt lazily

    @staticmethod
    def _rows_to_arrays(rows):
        ids = np.fromiter((r[0] for r in rows), dtype=np.int64, count=len(rows))
        mat = np.frombuffer(b"".join(r[1] for r in rows), dtype=np.float16).reshape(len(rows), DIM)
        return ids, mat

    def _load_vectors(self):
        with self._lock:
            v = ro(VEC_DB)
            try:
                if getattr(self, "_vbuf", None) is not None:
                    # Incremental refresh. fact_vec is keyed by monotonic fact ids, so
                    # MAX(fact_id) (index lookup, instant) tells us whether anything is
                    # new; count(*) scans the 2.8GB table (~20s) while holding _lock.
                    have_max = int(self._ids.max()) if len(self._ids) else 0
                    if v.execute("SELECT COALESCE(MAX(fact_id),0) FROM fact_vec").fetchone()[0] > have_max:
                        rows = v.execute("SELECT fact_id, vec FROM fact_vec WHERE fact_id>? ORDER BY fact_id",
                                         (have_max,)).fetchall()
                        self._append_vectors(*self._rows_to_arrays(rows))
                else:
                    snap = self._read_snapshot()
                    if snap is not None:
                        # snapshot plus whatever was embedded after it was written;
                        # anything filled in below its max is caught by reconcile_vectors
                        self._set_vectors(*snap)
                        del snap
                        start = int(self._ids.max()) if len(self._ids) else 0
                    else:
                        # no usable snapshot: stream fact_vec in chunks (no 1.5GB
                        # bytes join); max(fact_id) is a cheap capacity estimate (ids are
                        # dense; count(*) would take ~20s). Headroom so the first appends
                        # don't trigger a full-size grow copy.
                        max_id = v.execute("SELECT COALESCE(MAX(fact_id),0) FROM fact_vec").fetchone()[0]
                        cap = int(max_id * 1.05) + 4096
                        self._set_vectors(np.zeros(0, np.int64), np.zeros((0, DIM), np.float16), cap=cap)
                        start = -1
                    cur = v.execute("SELECT fact_id, vec FROM fact_vec WHERE fact_id>? ORDER BY fact_id", (start,))
                    while True:
                        rows = cur.fetchmany(50000)
                        if not rows:
                            break
                        self._append_vectors(*self._rows_to_arrays(rows))
            finally:
                v.close()
            self._vec_loaded_at = time.time()

    # Snapshot of fact_vec (ids + fp16 vectors) as one .npy pair. Reading the
    # 2.8GB sqlite table row by row takes ~30s at startup; the snapshot ~5s.
    # Anything that rewrites existing fact_vec rows (a re-embed) must call
    # invalidate_snapshot() and restart the server (its in-memory copy is stale
    # too); appends and hole fills are picked up on their own.
    def _read_snapshot(self):
        try:
            with open(VEC_SNAP + ".json") as fh:
                meta = json.load(fh)
            if not isinstance(meta, dict) or meta.get("model") != MODEL or meta.get("dim") != DIM:
                return None
            ids = np.load(VEC_SNAP + ".ids.npy")
            # mmap: _set_vectors copies it into the fp16 buffer in chunks, so the
            # file never sits in memory twice
            mat = np.load(VEC_SNAP + ".vec.npy", mmap_mode="r")
            if ids.ndim != 1 or mat.shape != (len(ids), DIM) or len(ids) != meta.get("count"):
                return None
            if mat.dtype != np.float16:
                return None
            return ids.astype(np.int64), mat
        except Exception as e:  # truncated/corrupt files: fall back to sqlite
            print(f"vector snapshot unusable ({type(e).__name__}: {e}); reading fact_vec", file=sys.stderr,
                  flush=True)
            return None

    _snap_lock = threading.Lock()

    def write_snapshot(self, min_growth=5000):
        """Write the in-memory vectors to the snapshot if it is missing or at
        least `min_growth` vectors behind. Atomic (fsynced temp files + rename,
        metadata last). Returns the number of vectors written, 0 if skipped."""
        with Memory._snap_lock:
            with self._lock:
                ids, mat = self._ids, self._mat
            if ids is None or not len(ids):
                return 0
            try:
                with open(VEC_SNAP + ".json") as fh:
                    have = int(json.load(fh).get("count", 0))
            except Exception:
                have = -1
            if have >= 0 and len(ids) - have < min_growth and len(ids) >= have:
                return 0
            d = os.path.dirname(VEC_SNAP)
            for f in os.listdir(d):  # leftovers from a crash mid-write
                if f.startswith(os.path.basename(VEC_SNAP) + ".tmp"):
                    try:
                        os.remove(os.path.join(d, f))
                    except OSError:
                        pass
            tmp = f"{VEC_SNAP}.tmp{os.getpid()}"

            def _save(path, fn):
                with open(path, "wb") as fh:
                    fn(fh)
                    fh.flush()
                    os.fsync(fh.fileno())

            _save(tmp + ".ids.npy", lambda fh: np.save(fh, ids))
            _save(tmp + ".vec.npy", lambda fh: np.save(fh, np.asarray(mat, dtype=np.float16)))  # no copy
            meta = {"model": MODEL, "dim": DIM, "count": int(len(ids)), "max_id": int(ids.max()),
                    "written_at": time.time()}
            _save(tmp + ".json", lambda fh: fh.write(json.dumps(meta).encode()))
            # metadata is removed first and written last, so a reader never pairs
            # new arrays with old metadata (count mismatch -> falls back to sqlite)
            invalidate_snapshot()
            os.replace(tmp + ".ids.npy", VEC_SNAP + ".ids.npy")
            os.replace(tmp + ".vec.npy", VEC_SNAP + ".vec.npy")
            os.replace(tmp + ".json", VEC_SNAP + ".json")
            dfd = os.open(d, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
            return int(len(ids))

    def refresh(self, max_age=300):
        if self._mat is None or time.time() - getattr(self, "_vec_loaded_at", 0) > max_age:
            self._load_vectors()

    def embed_new_facts(self, batch=256):
        """Embed facts not yet in fact_vec and append them in-memory, so recall
        sees them within seconds of extraction. semantic_facts is insert-only
        and ids are monotonic, so 'id > max(embedded)' is the pending set.
        Returns the number embedded."""
        rows = self.mem.execute(
            "SELECT id, statement FROM semantic_facts WHERE id>? ORDER BY id LIMIT ?",
            (self._max_embedded_id(), batch)).fetchall()
        if not rows:
            return 0
        emb = self._embed([s or "" for _, s in rows])  # fp32, L2-normalized
        # Write outside _lock (a busy fact_vectors.db must not stall recall), then
        # pull everything newer than the in-memory max from disk. That picks up
        # our rows and any another process (janitor, embed_facts.py) wrote,
        # instead of appending ours and skipping past theirs.
        with self._vw_lock:
            w = self._vec_writer()
            w.executemany(
                "INSERT OR REPLACE INTO fact_vec(fact_id, model, vec) VALUES(?,?,?)",
                [(fid, MODEL, emb[j].astype(np.float16).tobytes())
                 for j, (fid, _) in enumerate(rows)])
            w.commit()
        self._load_vectors()
        return len(rows)

    def reconcile_vectors(self):
        """Load vectors that exist on disk but not in memory (e.g. holes filled
        below the max by another process). The count(*) runs without _lock
        (~20s on the 2.8GB table), so call it rarely from a background thread.
        Returns the number of vectors added."""
        v = ro(VEC_DB)
        try:
            n = v.execute("SELECT count(*) FROM fact_vec").fetchone()[0]
            if self._ids is not None and n == len(self._ids):
                return 0
            disk = np.fromiter((r[0] for r in v.execute("SELECT fact_id FROM fact_vec")), dtype=np.int64)
            with self._lock:
                have = self._ids if self._ids is not None else np.zeros(0, dtype=np.int64)
                missing = np.setdiff1d(disk, have)
            if len(missing) == 0:
                return 0
            got = []
            for i in range(0, len(missing), 500):
                chunk = [int(x) for x in missing[i:i + 500]]
                got += v.execute("SELECT fact_id, vec FROM fact_vec WHERE fact_id IN (%s)"
                                 % ",".join("?" * len(chunk)), chunk).fetchall()
        finally:
            v.close()
        if not got:
            return 0
        ids, mat = self._rows_to_arrays(got)
        with self._lock:
            keep = ~np.isin(ids, self._ids) if self._ids is not None else np.ones(len(ids), bool)
            if not keep.any():
                return 0
            self._append_vectors(ids[keep], mat[keep])
        return int(keep.sum())

    def _vec_writer(self):
        con = getattr(self, "_vec_w", None)
        if con is None:
            con = sqlite3.connect(VEC_DB, timeout=60, check_same_thread=False)
            con.execute("PRAGMA busy_timeout=60000")
            self._vec_w = con
        return con

    def _max_embedded_id(self):
        v = ro(VEC_DB)
        try:
            return v.execute("SELECT COALESCE(MAX(fact_id),0) FROM fact_vec").fetchone()[0]
        finally:
            v.close()

    def _embed(self, texts, query=False):
        with self._enc_lock:
            return self._embed_locked(texts, query)

    def _embed_locked(self, texts, query=False):
        if self._model is None:
            import torch
            from sentence_transformers import SentenceTransformer

            dev = self.device or ("mps" if torch.backends.mps.is_available() else "cpu")
            kw = {"torch_dtype": torch.float16} if dev != "cpu" else {}
            try:
                # cached copy first: the online path spends ~8s on Hub
                # metadata requests at every server start
                self._model = SentenceTransformer(MODEL, device=dev, model_kwargs=kw, local_files_only=True)
            except OSError:
                self._model = SentenceTransformer(MODEL, device=dev, model_kwargs=kw)
        prompt = QUERY_INSTRUCT if query else None
        # small batches: the Metal allocator keeps each batch's activations
        # cached (~1GB extra at 32); background embedding isn't latency-bound
        e = self._model.encode(texts, prompt=prompt, normalize_embeddings=True, convert_to_numpy=True,
                               batch_size=8)
        if len(texts) > 8 and str(self._model.device).startswith("mps"):
            import torch
            torch.mps.empty_cache()
        return e.astype(np.float32)

    def vector_hits(self, query, n=100):
        self.refresh()
        q = self._embed([query], query=True)[0]
        with self._lock:  # consistent (ids, mat) view; appends only write past it
            ids, mat = self._ids, self._mat
        if mat is None:
            return []
        # fp16 @ fp32 in numpy has no BLAS path (~1s); upcast in small chunks
        # instead (~50ms, bit-identical to a full fp32 matrix)
        s = np.empty(len(mat), dtype=np.float32)
        for i in range(0, len(mat), 4096):
            np.dot(mat[i:i + 4096].astype(np.float32), q, out=s[i:i + 4096])
        n = min(n, len(s))
        if n <= 0:
            return []
        top = np.argpartition(-s, n - 1)[:n]
        top = top[np.argsort(-s[top])]
        return [(int(ids[i]), float(s[i])) for i in top]

    def vec_of(self, fid):
        with self._lock:
            ids, mat = self._ids, self._mat
            if ids is None or not len(ids):
                return None
            srt = getattr(self, "_sorted", None)
            if srt is None:  # sorted index instead of a 726k-entry dict (~100MB)
                order = np.argsort(ids, kind="stable")
                srt = self._sorted = (ids[order], order)
        keys, order = srt
        j = int(np.searchsorted(keys, fid))
        if j >= len(keys) or keys[j] != fid:
            return None
        i = int(order[j])
        return mat[i].astype(np.float32)

    # agent notes (memory_remember) ---------------------------------------
    def note_hits(self, query, k=3, min_sim=0.5):
        """Unmerged memory_remember notes relevant to query. Nothing merges
        agent_notes into semantic_facts yet, so recall reads them directly.
        Notes are few; their vectors are cached by id."""
        if not os.path.exists(NOTES_DB) or not (query or "").strip():
            return []
        con = ro(NOTES_DB)
        try:
            rows = con.execute(
                "SELECT id, fact_type, statement, created_at FROM agent_notes "
                "WHERE merged_fact_id IS NULL ORDER BY id DESC LIMIT 2000").fetchall()
        except sqlite3.OperationalError:  # table not created yet
            return []
        finally:
            con.close()
        if not rows:
            return []
        cache = self.__dict__.setdefault("_note_vecs", {})
        todo = [r for r in rows if r[0] not in cache]
        if todo:
            for r, v in zip(todo, self._embed([r[2] for r in todo])):
                cache[r[0]] = v
        q = self._embed([query], query=True)[0]
        sims = [(float(cache[r[0]] @ q), r) for r in rows]
        sims.sort(key=lambda x: -x[0])
        return [
            {"id": r[0], "type": r[1], "statement": r[2], "date": fmt_ts(r[3]), "sim": round(s, 4)}
            for s, r in sims[:k] if s >= min_sim
        ]

    # facts -------------------------------------------------------------
    def bm25_hits(self, query, n=100):
        fq = fts_query(query)
        if not fq:
            return []
        rows = self.mem.execute(
            "SELECT rowid, bm25(semantic_fts) FROM semantic_fts WHERE semantic_fts MATCH ? "
            "ORDER BY bm25(semantic_fts) LIMIT ?",
            (fq, n),
        ).fetchall()
        return [(int(r[0]), float(r[1])) for r in rows]

    def fetch_facts(self, ids):
        if not ids:
            return {}
        out = {}
        for i in range(0, len(ids), 500):
            chunk = ids[i : i + 500]
            q = (
                "SELECT f.id, f.fact_type, f.subject, f.predicate, f.object, f.statement, f.confidence, "
                "f.valid_from, f.valid_until, f.is_active, f.superseded_by_id, f.source_event_id, "
                "e.source, e.session_id, e.speaker "
                "FROM semantic_facts f LEFT JOIN episodic_events e ON e.id = f.source_event_id "
                "WHERE f.id IN (%s)" % ",".join("?" * len(chunk))
            )
            for r in self.mem.execute(q, chunk):
                out[r[0]] = {
                    "id": r[0],
                    "type": r[1],
                    "subject": r[2],
                    "predicate": r[3],
                    "object": r[4],
                    "statement": r[5],
                    "confidence": r[6],
                    "date": fmt_ts(r[7]),
                    "valid_from": r[7],
                    "valid_until": r[8],
                    "active": bool(r[9]),
                    "superseded_by": r[10],
                    "source_event_id": r[11],
                    "source": r[12],
                    "session_id": r[13],
                }
        return out

    def recall(self, query, k=10, types=None, include_inactive=False, since=None, dedupe=0.92,
               n_vec=150, n_bm25=150, recency_weight=0.0):
        """Hybrid fact recall. Returns ranked fact dicts with fusion scores."""
        vh = self.vector_hits(query, n_vec)
        bh = self.bm25_hits(query, n_bm25)
        score = {}
        for rank, (fid, _) in enumerate(vh):
            score[fid] = score.get(fid, 0.0) + 1.0 / (RRF_K + rank + 1)
        for rank, (fid, _) in enumerate(bh):
            score[fid] = score.get(fid, 0.0) + 1.0 / (RRF_K + rank + 1)
        vsim = dict(vh)
        facts = self.fetch_facts(list(score))
        now = time.time()
        cands = []
        for fid, sc in score.items():
            f = facts.get(fid)
            if not f:
                continue
            if not include_inactive and not f["active"]:
                continue
            if types and f["type"] not in types:
                continue
            if since and (f["valid_from"] or 0) < since:
                continue
            if recency_weight and f["valid_from"]:
                age_days = max(0.0, (now - float(f["valid_from"])) / 86400)
                sc *= 1.0 + recency_weight / (1.0 + age_days / 30.0)
            f["score"] = round(sc, 5)
            f["vec_sim"] = round(vsim[fid], 4) if fid in vsim else None
            cands.append(f)
        cands.sort(key=lambda f: (-f["score"], -(f["valid_from"] or 0)))
        out, kept_vecs = [], []
        for f in cands:
            if dedupe:
                v = self.vec_of(f["id"])
                if v is not None and kept_vecs and max(float(v @ kv) for kv in kept_vecs) >= dedupe:
                    continue
                if v is not None:
                    kept_vecs.append(v)
            out.append(f)
            if len(out) >= k:
                break
        return out

    # history -----------------------------------------------------------
    def search_history(self, query, limit=10, source=None, session_id=None, speakers=("user", "assistant"),
                       content_types=("text",), window=4000, mode="and", since=None, _deadline=None):
        """FTS over raw conversation events. Ranks by bm25 within the most recent
        `window` matches (by rowid) to keep common-term queries fast.

        Filters are applied in SQL *before* the window is taken (previously the
        newest 4000 raw matches were taken first and then filtered, and those are
        dominated by tool output, so older user/assistant text hits and whole
        sources were silently missed). Source/session filters also bound the FTS
        rowid range so selective filters on common terms stay fast. Exact
        duplicate events (importers keep several copies of the same message) are
        collapsed."""
        raw = (query or "").strip()
        if raw.startswith("fts:"):
            fq = raw[4:].strip()
        else:
            fq = fts_query(raw, mode=mode)
        if not fq:
            return []
        cond = ["episodic_fts MATCH ?"]
        params = [fq]
        if since:
            newest = self.mem.execute("SELECT max(timestamp) FROM episodic_events").fetchone()[0]
            if newest is None or since > newest:
                return []  # `since` after the newest event
        segs = self._segments(source=source, session_id=session_id, since=since)
        if segs == []:
            return []  # unknown source/session, or nothing in range
        if source:
            cond.append("+e.source = ?")
            params.append(source)
        if session_id:
            cond.append("+e.session_id = ?")
            params.append(session_id)
        if speakers:
            cond.append("+e.speaker IN (%s)" % ",".join("?" * len(speakers)))
            params += list(speakers)
        if content_types:
            cond.append("+e.content_type IN (%s)" % ",".join("?" * len(content_types)))
            params += list(content_types)
        if since:
            cond.append("+e.timestamp >= ?")
            params.append(int(since))
        # Event ids are not contiguous per source or per time (OpenCode has an old
        # block at ~67M and the rest after codex/hermes at ~119M+), so one
        # BETWEEN min AND max bound would walk every codex match. Query each dense
        # id segment separately, newest first, until the window is full.
        where = " AND ".join(cond)
        sql_seg = (
            "SELECT e.id, e.source, e.session_id, e.turn_id, e.timestamp, e.speaker, e.content_type, "
            "e.content, bm25(episodic_fts) FROM episodic_fts f JOIN episodic_events e ON e.id = f.rowid "
            "WHERE %s AND f.rowid BETWEEN ? AND ? ORDER BY f.rowid DESC LIMIT ?" % where
        )
        sql_all = sql_seg.replace(" AND f.rowid BETWEEN ? AND ?", "")
        # Default searches (user/assistant text) go to episodic_text_fts, which
        # holds only those events and stores source/session/speaker/timestamp
        # itself. The generic path has to read each candidate episodic_events
        # row to check content_type, and content_type sits after the content
        # column, so every matching tool output's overflow pages get read.
        # Content for the few displayed hits is fetched afterwards.
        text_path = (content_types is not None and tuple(content_types) == ("text",) and speakers
                     and set(speakers) <= {"user", "assistant"} and self._text_fts_ready())
        if text_path:
            tcond, params = ["episodic_text_fts MATCH ?"], [fq]
            if source:
                tcond.append("source = ?")
                params.append(source)
            if session_id:
                tcond.append("session_id = ?")
                params.append(session_id)
            if set(speakers) != {"user", "assistant"}:
                tcond.append("speaker IN (%s)" % ",".join("?" * len(speakers)))
                params += list(speakers)
            if since:
                tcond.append("ts >= ?")
                params.append(int(since))
            sql_seg = (
                "SELECT rowid, source, session_id, NULL, ts, speaker, 'text', NULL, bm25(episodic_text_fts) "
                "FROM episodic_text_fts WHERE %s AND rowid BETWEEN ? AND ? ORDER BY rowid DESC LIMIT ?"
                % " AND ".join(tcond)
            )
            sql_all = sql_seg.replace(" AND rowid BETWEEN ? AND ?", "")
        if _deadline is None:
            _deadline = time.time() + 30  # shared with the AND->OR fallback
        rows, timed_out = [], False
        try:
            for seg in (segs or [None]):
                left = _deadline - time.time()
                if left <= 0:
                    timed_out = True
                    break
                if len(rows) >= window:
                    break
                if seg is None:
                    got, to = self._timed(sql_all, params + [window], timeout=left)
                else:
                    got, to = self._timed(sql_seg, params + [seg[0], seg[1], window - len(rows)], timeout=left)
                rows += got
                if to:
                    timed_out = True
                    break
        except sqlite3.OperationalError as e:
            msg = str(e)
            if text_path and "no such table: episodic_text_fts" in msg:
                # index dropped since the readiness check: retry on the generic path
                Memory._text_fts_state[:] = [time.time(), False]
                return self.search_history(query, limit, source, session_id, speakers, content_types, window,
                                           mode, since, _deadline=_deadline)
            if raw.startswith("fts:") and not any(s in msg for s in ("locked", "disk", "I/O", "malformed")):
                raise QueryError(f"invalid FTS5 expression: {e}") from None
            raise
        if timed_out:
            print(f"search_history: timed out ({len(rows)} partial rows) q={raw[:80]!r} source={source} "
                  f"session={session_id} since={since}", file=sys.stderr, flush=True)
        # Only fall back to OR when AND genuinely found nothing (not when it timed out).
        if not rows and not timed_out and mode == "and" and not raw.startswith("fts:"):
            return self.search_history(query, limit, source, session_id, speakers, content_types, window, "or",
                                       since, _deadline=_deadline)
        rows.sort(key=lambda r: r[8])
        out, seen = [], set()
        for r in (self._with_content(rows) if text_path else rows):
            # collapse exact copies and same-session hits that would display the
            # same snippet (e.g. repeated injected goal/task-list prompts)
            snip = snippet(r[7] or "", fq)
            keys = ((r[2], r[5], hash(r[7] or "")), (r[2], r[5], snip))
            if any(k in seen for k in keys):
                continue
            seen.update(keys)
            out.append({
                "event_id": r[0], "source": r[1], "session_id": r[2], "turn_id": r[3],
                "date": fmt_ts(r[4]), "timestamp": r[4], "speaker": r[5], "type": r[6],
                "bm25": round(r[8], 3), "snippet": snip,
            })
            if len(out) >= limit:
                break
        return out

    def _with_content(self, rows, batch=40):
        """Yield text-index rows (content/turn_id NULL) with content and turn_id
        filled from episodic_events, in order, a small batch at a time (the
        caller stops once it has `limit` distinct hits). Rows deleted since the
        index was read are skipped."""
        for i in range(0, len(rows), batch):
            chunk = rows[i:i + batch]
            ids = [r[0] for r in chunk]
            got = {x[0]: x for x in self.mem.execute(
                "SELECT id, turn_id, content FROM episodic_events WHERE id IN (%s)" % ",".join("?" * len(ids)),
                ids)}
            for r in chunk:
                x = got.get(r[0])
                if x is not None:
                    yield (r[0], r[1], r[2], x[1], r[4], r[5], r[6], x[2], r[8])

    _text_fts_state = [0.0, False]

    def _text_fts_ready(self, ttl=60):
        """True once build_text_fts.py has fully backfilled episodic_text_fts
        (checked at most once a minute)."""
        st = Memory._text_fts_state
        if time.time() - st[0] < ttl:
            return st[1]
        try:
            row = self.mem.execute(
                "SELECT done FROM fts_build_state WHERE name='episodic_text_fts'").fetchone()
            # table plus all three triggers, else new events would be missing
            ok = bool(row and row[0]) and self.mem.execute(
                "SELECT count(*) FROM sqlite_master WHERE name IN ('episodic_text_fts', "
                "'episodic_text_fts_insert', 'episodic_text_fts_delete', 'episodic_text_fts_update')"
            ).fetchone()[0] == 4
        except sqlite3.OperationalError:
            ok = False
        st[0], st[1] = time.time(), ok
        return ok

    def _timed(self, sql, params, timeout=30):
        """Run a read query. Returns (rows, timed_out); on timeout (sqlite
        progress handler interrupt) rows holds whatever arrived before it."""
        con = self.mem
        deadline = time.time() + timeout
        timed_out = [False]

        def check():
            if time.time() > deadline:
                timed_out[0] = True
                return 1
            return 0

        con.set_progress_handler(check, 20000)
        rows = []
        try:
            cur = con.execute(sql, params)
            while True:
                chunk = cur.fetchmany(500)
                if not chunk:
                    break
                rows += chunk
        except sqlite3.OperationalError as e:
            if not (timed_out[0] and "interrupt" in str(e)):
                raise
        finally:
            con.set_progress_handler(None, 0)
        return rows, timed_out[0]

    _range_cache = {}
    _seg_cache = {}
    _since_cache = {}
    _seg_lock = threading.Lock()
    SEG_GAP = 200_000        # id gaps smaller than this don't split a segment
    SINCE_MAX_IDS = 2_000_000  # beyond this many events, `since` is filtered, not bounded

    @classmethod
    def _to_segments(cls, ids):
        """Sorted id array -> [(lo, hi)] dense segments, newest first. The newest
        segment is left open-ended so events appended after caching are found."""
        if len(ids) == 0:
            return []
        ids = np.sort(ids)
        cut = np.nonzero(np.diff(ids) > cls.SEG_GAP)[0]
        los = np.concatenate([[ids[0]], ids[cut + 1]])
        his = np.concatenate([ids[cut], [ids[-1]]])
        segs = [(int(a), int(b)) for a, b in zip(los, his)]
        segs[-1] = (segs[-1][0], SQLITE_MAX_INT)
        return segs[::-1]

    def _source_segments(self, source):
        with self._seg_lock:
            return self._source_segments_locked(source)

    def _source_segments_locked(self, source):
        hit = self._seg_cache.get(source)
        if hit and time.time() - hit[1] < 600:
            return hit[0]
        lo, hi = self._id_range(source=source)
        if lo is None:
            segs = []
        else:
            n = self.mem.execute("SELECT count(*) FROM episodic_events WHERE source=?", (source,)).fetchone()[0]
            if n > 0.5 * (hi - lo + 1):  # dense (codex, hermes): one range
                segs = [(lo, SQLITE_MAX_INT)]
            else:  # sparse (opencode: an old block at ~67M plus the live tail)
                ids = np.fromiter((r[0] for r in self.mem.execute(
                    "SELECT id FROM episodic_events WHERE source=?", (source,))), dtype=np.int64)
                segs = self._to_segments(ids)
        self._seg_cache[source] = (segs, time.time())
        return segs

    def _since_segments(self, since):
        """Id segments of events at/after `since`, or None when too many events
        match for bounding to help (then `since` is only a row filter).
        Cached per `since` value (the newest segment is open-ended, so new events
        stay covered); the lock stops concurrent callers from each pulling ~1M ids
        through Python, which under GIL contention took over a minute."""
        key = int(since)
        with self._seg_lock:
            hit = self._since_cache.get(key)
            if hit and time.time() - hit[1] < 600:
                return hit[0]
            segs = self._since_segments_uncached(since)
            self._since_cache[key] = (segs, time.time())
            if len(self._since_cache) > 64:
                self._since_cache.pop(next(iter(self._since_cache)))
            return segs

    def _since_segments_uncached(self, since):
        ids = np.fromiter((r[0] for r in self.mem.execute(
            "SELECT id FROM episodic_events INDEXED BY idx_episodic_timestamp WHERE timestamp >= ? LIMIT ?",
            (int(since), self.SINCE_MAX_IDS + 1))), dtype=np.int64)
        if len(ids) > self.SINCE_MAX_IDS:
            return None
        return self._to_segments(ids)

    @staticmethod
    def _intersect(a, b):
        if a is None:
            return b
        if b is None:
            return a
        out = []
        for lo1, hi1 in a:
            for lo2, hi2 in b:
                lo, hi = max(lo1, lo2), min(hi1, hi2)
                if lo <= hi:
                    out.append((lo, hi))
        return sorted(set(out), key=lambda s: -s[1])

    def _segments(self, source=None, session_id=None, since=None):
        """Rowid segments (newest first) that can hold matching events.
        None = unbounded; [] = nothing can match."""
        segs = None
        if session_id:
            # Sessions can span id blocks too (OpenCode sessions started in the old
            # ~67M block and continued at ~119M+); one min..max range would walk
            # every codex match in between. Session index makes this cheap.
            q = "SELECT id FROM episodic_events WHERE session_id=?"
            p = [session_id]
            if source:
                q += " AND source=?"
                p.append(source)
            ids = np.fromiter((r[0] for r in self.mem.execute(q, p)), dtype=np.int64)
            if len(ids) == 0:
                return []
            segs = self._to_segments(ids)
            segs[0] = (segs[0][0], int(ids.max()))
        elif source:
            segs = self._source_segments(source)
            if segs:
                # A source that stopped growing (hermes, codex) gets its newest segment
                # closed at its cached max id so it doesn't walk newer events. A source
                # still near the global max stays open-ended so fresh events show up.
                # No index gives max(id) per source cheaply; the 60s cache bounds staleness.
                hi = self._id_range(source=source)[1]
                top = self.mem.execute("SELECT max(id) FROM episodic_events").fetchone()[0] or 0
                if hi is not None and top - hi > self.SEG_GAP:
                    segs = [(segs[0][0], hi)] + segs[1:]
        if since:
            segs = self._intersect(segs, self._since_segments(since))
        return segs

    def _id_range(self, source=None, session_id=None):
        """(min_id, max_id) of events for a session or source; (None, None) when
        unfiltered or nothing matches. Source ranges are cached for 60s."""
        if session_id:
            if source:
                r = self.mem.execute("SELECT min(id), max(id) FROM episodic_events WHERE source=? AND session_id=?",
                                     (source, session_id)).fetchone()
            else:
                r = self.mem.execute("SELECT min(id), max(id) FROM episodic_events WHERE session_id=?",
                                     (session_id,)).fetchone()
            return (r[0], r[1]) if r and r[0] is not None else (None, None)
        if source:
            hit = self._range_cache.get(source)
            if hit and time.time() - hit[2] < 60:
                return hit[0], hit[1]
            r = self.mem.execute("SELECT min(id), max(id) FROM episodic_events WHERE source=?",
                                 (source,)).fetchone()
            if not r or r[0] is None:
                return None, None
            self._range_cache[source] = (r[0], r[1], time.time())
            return r[0], r[1]
        return None, None

    def session_context(self, session_id, around_event_id=None, before=5, after=5, max_chars=1500,
                        speakers=("user", "assistant"), content_types=("text",)):
        """Return a slice of a session's text events, centered on an event id if given.

        The unary '+' on speaker/content_type keeps sqlite (no ANALYZE stats) from
        choosing idx_episodic_speaker, which scanned tens of millions of rows
        (20s+, or effectively forever for an unknown session)."""
        if around_event_id is not None:
            around_event_id = max(0, min(int(around_event_id), SQLITE_MAX_INT))
        params = [session_id]
        cond = "session_id = ?"
        if speakers:
            cond += " AND +speaker IN (%s)" % ",".join("?" * len(speakers))
            params += list(speakers)
        if content_types:
            cond += " AND +content_type IN (%s)" % ",".join("?" * len(content_types))
            params += list(content_types)
        if around_event_id:
            prev = self.mem.execute(
                f"SELECT id FROM episodic_events WHERE {cond} AND id < ? ORDER BY id DESC LIMIT ?",
                params + [around_event_id, before],
            ).fetchall()
            start = prev[-1][0] if prev else around_event_id
            rows = self.mem.execute(
                f"SELECT id, timestamp, speaker, content_type, content FROM episodic_events "
                f"WHERE {cond} AND id >= ? ORDER BY id LIMIT ?",
                params + [start, len(prev) + 1 + after],
            ).fetchall()
        else:
            rows = self.mem.execute(
                f"SELECT id, timestamp, speaker, content_type, content FROM episodic_events "
                f"WHERE {cond} ORDER BY id LIMIT ?",
                params + [before + after],
            ).fetchall()
        return [
            {"event_id": r[0], "date": fmt_ts(r[1]), "speaker": r[2], "type": r[3],
             "content": (r[4] or "")[:max_chars] + ("..." if r[4] and len(r[4]) > max_chars else "")}
            for r in rows
        ]


def snippet(text, fq, width=320):
    terms = [t.strip('"') for t in re.split(r"\s+(?:OR|AND)\s+", fq)]
    low = text.lower()
    pos = min((low.find(t) for t in terms if t and low.find(t) >= 0), default=0)
    start = max(0, pos - width // 3)
    s = text[start : start + width].replace("\n", " ")
    return ("..." if start else "") + s + ("..." if start + width < len(text) else "")


if __name__ == "__main__":
    import argparse
    import json

    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--types", default=None)
    ap.add_argument("--history", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    m = Memory()
    t = time.time()
    if a.history:
        res = m.search_history(a.query, limit=a.k)
    else:
        res = m.recall(a.query, k=a.k, types=a.types.split(",") if a.types else None)
    dt = time.time() - t
    if a.json:
        print(json.dumps(res, indent=1, default=str))
    else:
        for r in res:
            if a.history:
                print(f"[{r['date']} {r['source']} {r['speaker']} bm25={r['bm25']}] {r['snippet']}")
            else:
                print(f"[{r['score']:.4f} v={r['vec_sim']} {r['type']} {r['date']} {r['source']}] {r['statement'][:300]}")
    print(f"-- {len(res)} results in {dt:.2f}s", file=sys.stderr)

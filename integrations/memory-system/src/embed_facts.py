#!/usr/bin/env python3
"""Embed semantic_facts.statement into data/fact_vectors.db.

Vectors live in a separate sidecar DB so embedding never writes to memory.db.
Model: Qwen/Qwen3-Embedding-0.6B (1024 dims), no instruction prefix for
documents. Stored as float16 blobs, L2-normalized. Incremental: only facts
whose id is not yet in fact_vec are embedded.

Run with the project venv: .venv/bin/python -u src/embed_facts.py
"""
import argparse
import os
import sqlite3
import sys
import time

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM_DB = os.path.join(ROOT, "data", "memory.db")
VEC_DB = os.path.join(ROOT, "data", "fact_vectors.db")
MODEL = "Qwen/Qwen3-Embedding-0.6B"
DIM = 1024


def open_vec(path=VEC_DB):
    con = sqlite3.connect(path, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute(
        "CREATE TABLE IF NOT EXISTS fact_vec("
        "fact_id INTEGER PRIMARY KEY, model TEXT NOT NULL, vec BLOB NOT NULL, "
        "embedded_at TEXT DEFAULT CURRENT_TIMESTAMP)"
    )
    con.execute("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)")
    con.execute("INSERT OR REPLACE INTO meta VALUES('model', ?)", (MODEL,))
    con.execute("INSERT OR REPLACE INTO meta VALUES('dim', ?)", (str(DIM),))
    con.execute("INSERT OR REPLACE INTO meta VALUES('dtype', 'float16')")
    con.commit()
    return con


def load_model(device="mps"):
    import torch
    from sentence_transformers import SentenceTransformer

    kw = {"torch_dtype": torch.float16} if device != "cpu" else {}
    return SentenceTransformer(MODEL, device=device, model_kwargs=kw)


def pending_ids(vcon, mcon, limit=None):
    done = set(r[0] for r in vcon.execute("SELECT fact_id FROM fact_vec"))
    ids = [r[0] for r in mcon.execute("SELECT id FROM semantic_facts ORDER BY id") if r[0] not in done]
    return ids[:limit] if limit else ids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunk", type=int, default=4096, help="facts per DB read/write chunk")
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--device", default="mps")
    a = ap.parse_args()

    mcon = sqlite3.connect(f"file:{MEM_DB}?mode=ro", uri=True, timeout=60)
    vcon = open_vec()
    ids = pending_ids(vcon, mcon, a.limit)
    print(f"pending={len(ids):,}", flush=True)
    if not ids:
        return
    model = load_model(a.device)
    t0 = time.time()
    n = 0
    for i in range(0, len(ids), a.chunk):
        chunk = ids[i : i + a.chunk]
        q = "SELECT id, statement FROM semantic_facts WHERE id IN (%s)" % ",".join("?" * len(chunk))
        rows = [(fid, s or "") for fid, s in mcon.execute(q, chunk)]
        # sort by length so batches have similar padding
        rows.sort(key=lambda r: len(r[1]))
        texts = [r[1][:2000] for r in rows]
        emb = model.encode(texts, batch_size=a.batch, normalize_embeddings=True, convert_to_numpy=True)
        emb = emb.astype(np.float16)
        vcon.executemany(
            "INSERT OR REPLACE INTO fact_vec(fact_id, model, vec) VALUES(?,?,?)",
            [(fid, MODEL, emb[j].tobytes()) for j, (fid, _) in enumerate(rows)],
        )
        vcon.commit()
        n += len(rows)
        el = time.time() - t0
        print(f"embedded {n:,}/{len(ids):,}  {n/el:.0f}/s  eta {(len(ids)-n)/(n/el)/60:.0f}m", flush=True)
    print("DONE", n, f"{time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    sys.exit(main())

# Fact consolidation (step 4) - design

Why not naive slot supersession: on 661K facts, normalized (subject, predicate) groups with
multiple objects are mostly paraphrase duplicates, some are genuine state changes, and some are
compatible multi-valued facts (user prefers A and B). Retiring every older fact in a group would
destroy valid memory. Embeddings alone can't tell contradiction from paraphrase either.

Pipeline (all decisions live in sidecar `data/consolidation.db` until audited and applied):

1. `src/embed_facts.py` -> `data/fact_vectors.db` (Qwen3-Embedding-0.6B, fp16, L2-normalized).
2. `src/consolidate.py candidates`: blocked exact kNN (numpy, CPU) over all fact vectors, top-k
   neighbors with cosine >= 0.85. Pairs stored as (a < b) in `cand_pairs`.
   Exact normalized-statement duplicates are linked deterministically (`label=duplicate`, judge=rule).
3. `src/consolidate.py judge`: LLM judge (glm-5.3-flash via surplus, batched pairs) labels each pair:
   - duplicate: same fact, same meaning (paraphrase). Newer one is reinforcement.
   - supersedes: both describe the same slot, newer value replaces older (state change,
     reversed decision, moved path, new version).
   - refines: one adds detail to the other, both true. Keep both, link.
   - contradicts: conflict with no clear temporal order.
   - compatible: related but independent facts, both true.
   Cost tracked in `judge_runs.cost_usd` and counted against the same $200 budget.
4. Audit: sample 100 supersedes/duplicate decisions, read them by hand, report to the user.
5. Apply (only when DB writers are quiet, in small batches):
   - duplicate clusters: union-find, canonical = earliest fact (first time it was said), others get
     `superseded_by_id=canonical`? No: duplicates are not state changes. They get an evidence_edges
     `support` row (dup -> canonical) and are hidden from retrieval via a `canonical_id` view.
   - supersedes: older.valid_until = newer.valid_from, older.superseded_by_id = newer.id,
     newer.supersedes_id = older.id, older.is_active = 0, evidence_edges `supersede`. History kept.
   - contradicts: evidence_edges `contradict`, both stay active, surfaced for review.
   - refines/compatible: evidence_edges `related`.

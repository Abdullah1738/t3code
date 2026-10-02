#!/bin/zsh
# wait for full embed, then incremental embed, then kNN candidates on MPS
cd /Users/ardud/.local/share/memory-system
while kill -0 11950 2>/dev/null; do sleep 30; done
echo "full embed exited $(date)"
nice -n 5 .venv/bin/python -u src/embed_facts.py > logs/embed_incr.log 2>&1
echo "incr embed exit=$? $(date)"
.venv/bin/python -u src/consolidate.py candidates --device mps > logs/cons_candidates.log 2>&1
echo "candidates exit=$? $(date)"

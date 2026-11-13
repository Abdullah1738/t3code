python3 - <<'PY'
from pathlib import Path
Path('tmp/card-2697/rebase4-flag-facts.md').write_text('''# Verified final facts

Card #2697. PR https://github.com/Equicom-Crypto/crpko-devops/pull/1131.
Published head 01ee8e5a985dbd95e15f8a2eba40a6464e2c16f0, based on main-dev f8ffb9c18225b9464bcb88abe256301fb2d72462. GitHub REST mergeable=true for that exact head/base. New automatic Terraform dev CI run 42579552604, https://github.com/Equicom-Crypto/crpko-devops/actions/runs/42579552604, queued at last check. No hosted CI pass claimed.
Upstream package scripts preserved, GC test exactly once immediately after breakglass, membership assertion retained. Runtime GC and workflow unchanged. Focused results GC21, shard23, Kafka/codec140, actor admission1 passed. Working tree clean.
Timed command run ONCE on this rebased content: /usr/bin/time -p node --test scripts/test-validate-plan-package.mjs. Exit0; 444 tests passed,0 failed. real638.52seconds (10min38.52seconds), user732.74seconds, sys158.60seconds. Linux Node24.22.1. Recorded shard weight222seconds, so actual wall time greater; do not infer same duration on GitHub runner or causes. Logs tmp/card-2697/plan-suite-time.txt and plan-suite-timed.log.
PR body corrected and published unchanged to say GC runs exactly once in hosted shards without fixing shard number. No live AWS, manual workflow dispatch, deploy, enable/disable, or data deletion. No outside repository changes needed.
Evaluator asked to flag with head,run ID,timing and stop. Evaluator owns CI check-backs. Native PR watch off. s1 open until green wake; do not claim ready or green.

Write ONLY tmp/card-2697/rebase4-flag-note.md, <=120words, plain factual flag note. Include full head SHA,run ID and URL, mergeable confirmation, timed command's444pass and real638.52s, Linux Node24.22.1, focused counts21/23/140/1, pendingCI and evaluator checkbacks with watchoff. Mention chain preserved, no outside-repo/live changes. Text must work as card_flag reason; no placeholders. Parent publishes unchanged. No git,gh,tests,otherexploration or publishing. Apply skill banned text and ASCII gates. Timing user/sys optional to fit length.
''')
print('Final flag facts written')
PY
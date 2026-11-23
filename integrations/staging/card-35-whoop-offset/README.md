# Card #35: WHOOP timezone offsets

Staged only. No live source, database, Keychain item, log, status, watcher or service was changed. No live WHOOP sync, refresh, login or API call was made. The evaluator owns install and natural hourly readback after review.

## Change

`whoop/whoop.py` uses one `parse_timezone_offset()` for all four local-time conversions. It accepts signed two-digit hours, signed HHMM or HH:MM (positive or negative), and UTC defaults `Z`, empty string and None. Hours must be 00–23, minutes 00–59. Other shapes, ranges and JSON types use UTC without dropping a record. Each sleep/cycle record parses once, so its two timestamps share a timezone and one fallback count, even if either timestamp is absent. Offset strings and raw JSON retain source provenance; non-string offsets use `+00:00` in the text column and retain their original value in raw JSON. The timestamp conversion and seconds precision otherwise stay unchanged.

`sync.run` initializes `offsetFallbacks=0` and `offsetSamples=[]` for each run. Only malformed offsets increment the count. Samples retain at most three distinct raw strings (unexpected non-string values use their string representation). A failed run retains diagnostics; the context resets in the existing finally block.

The logger's allowlist needs two fields and a small string-list sanitizer. Without this helper change, the requested props are silently discarded. **Evaluator s3 therefore needs the vault and runner `toollog.py` swaps in addition to whoop.py.** Both helpers must stay byte-identical. These are file-only installs; no restart or full robob-watch deploy is needed. Auth/token/reminder behavior, other log schemas and rollup classification are unchanged.

## Verification

`test_whoop_offsets.py` covers all supported forms (including `+05:30`, `-03:00`, negative compact forms and signed zero), an invalid-shape/range/type matrix, both real importers, upsert idempotence, local dates, full/incremental sync, raw/kept counts, exactly one fallback for one bad record, sample deduplication/cap, missing timestamps, failure retention and run reset. It compares all 2,880 legal signed HH:MM offsets with the unchanged `.base` function, byte for byte.

Sync tests use fake Keychain and HTTP with real SQLite schema/upserts, real `_sync()` and actual toollog NDJSON in temporary directories. Existing WHOOP, reminder, toollog and error-detail tests from #34 are retained. No real database or health logs are included. `tests-red.log` records four selected regressions failing against unchanged importer/helper bases, including the actual split ValueError and missing log props. `synthetic-readback.json` is produced by the passing single-bad-record integration test, from the emitted row and returned import counts.

Local final: **167 tests passed** on `/usr/bin/python3` 3.9.6 in 69.710s (`tests-local-final.log`). Offbox run `run-1123-045328-1481b334`: **167 tests passed**, exit 0, 7.213s on Boat box `bx_cbp4ub39`, with no reruns. Results are pinned in `verification.json`. `tests-offbox.log` retains remote exit 0. The waiter reported an incomplete local log; `tests-offbox-retained.log` recovers the full retained stdout/stderr directly from the box and includes the complete test summary. This warning does not affect the test outcome. `tests-local.log` is the first attempt and retains a test-fixture-only timeout mismatch (expected 30s while the API uses 40s); the final suite fixes the fixture. `tests-offsets-local.log` is the intermediate focused pass. Only final evidence applies to the pinned payload.

Reproduce with `/usr/bin/python3 -I -B /Users/ardud/.robob/staging/card-35-whoop-offset/run_tests.py` locally. For remote tests export via `prepare_payload.py`, then run `/usr/bin/python3 -I -B run_tests.py` from the printed private payload directory. `test-payload.json` pins exactly the code/schema/test files exported, including the unchanged importer base used for comparison. Never sync the vault or staging root to offbox. The watcher interpreter is `/usr/bin/python3` (local Python 3.9.6).

## Artifacts and mirror

`manifest.json` pins every live target base and candidate. Untouched `whoop.py.base`, `toollog.py.base`, `runner-toollog.py.base` and individual unified patches accompany `vault.patch` and `runner.patch`. `patch-check.log` records zero-fuzz reconstruction against the bases and a reconstruction of every fork-mirror target. `source-inventory.json` records the pinned #34 code/schema dependencies; source copies are fixtures, not install targets. `SHA256SUMS` covers every staged artifact except itself.

`fork.patch` preserves vault diffs/tests under `integrations/staging/card-35-whoop-offset/`, the same archive convention used for #34, and supplies the matching helper at `integrations/robob-watch/toollog.py`. This thread's pinned fork (5bd5026bd8e4b24d846845b62f6cd6524f3e26ca) lacks the #34 mirror and runner helper, so these are explicit additions. If the evaluator's current fork already contains the helper, **rebase that one mirror hunk against the installed #34 base**; don't overwrite newer code or apply an addition over an existing file. The vault diffs remain based on #34's exact live bytes. No PR, commit or push is made by this worker.

## Sibling paths and rule audit

- `import_sleep`: wake date, start/end, naps and unscored rows all use the parser; raw record preservation and generated sleep-needed stripping are retained.
- `import_cycles`: cycle date and both timestamps use the same parser. Recovery and body records have no independent timezone conversion. Grep finds no remaining offset split or other timezone parser in whoop.py.
- `main(sync)`, hourly whoop-sync (3600s), recovery-card `sync --days 2`, incremental/full imports, and callback `sync(full=True)` all converge on these importers. No watcher command/cadence/context change is needed.
- `mirror_sleep_sessions` reads the imported start/end/date; it never reparses the raw offset. Existing output with signed HH:MM stays identical. No schema/data migration or validate.py change is needed.
- Logger consumers: vault CLI, rollup, runner and its Python watchers. The helper schema change must be installed in both helper locations; fork mirror carries the same bytes. No client/provider/wire-contract/UI paths apply.
- Read vault-staging, health-food-live-file-installs, release-policy, sqlite-test-fixtures-wal, toollog-readback, WHOOP/nutrition skills, and watcher callers. Current release-policy overrides the older per-install ask text. No skill, rule, agent prompt, credential, live configuration or service restart is required.

## Evaluator install and readback

After review and offbox pass, verify SHA256SUMS and re-hash **all three targets** against manifest. Stop on mismatch. whoop.py base must be `645f654d3370d8223eca925312a6f12507b8df8cd8f81f4455aeec349e6c1f5a`; both helpers base on `55e4422bda8f8fad4e2f7a2ece46536fd03f9ec0bcc4cd57cc83f87cd7de6b36`. Back up to `*.bak-YYYYMMDD-card35`, hash the backups, reconstruct private copies with `patch -F0 -p1`, require candidate hashes, and rerun the pinned synthetic suite. Rebase/apply and push the fork mirror as needed. Install both helpers first, then whoop.py, via same-directory temporary files and atomic mv, preserving permissions. Plain files only; no listener, runner, Robob or OpenCode restart. Roll back by atomic restoration of hash-verified backups.

Do not manually sync, refresh or call WHOOP: the evaluator observes the next natural hourly tick. Required s4 evidence: sync.run ok=true and keptCount>0; status.json ok with last_sync_at after 22 Nov; newest health.db whoop_sleep after 21 Nov; validate.py passes. Evaluator carries the result to #34 and the owner in the card discussion. This worker has not claimed those live readbacks.

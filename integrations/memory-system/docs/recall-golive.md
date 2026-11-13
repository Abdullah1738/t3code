# Recall rebuild go-live runbook (revised 2026-11-07 08:20 +04)

Owner: coordinator. Nothing below has been executed except the measurements
and the checks marked "verified". Robob, OpenCode and agent-bridges are never
restarted by this runbook (one optional OpenCode restart for the plugin is
called out separately and needs Abdullah's go). Previous version:
`recall-golive.md.bak-20261107-pre-golive-tree`. Design: `recall-rebuild.md`.

## Go / no-go (check every line right before Phase 1)

| # | gate | how to check | at 08:20 |
|---|---|---|---|
| 0 | **launchd jobs can open the ExternalSSD** (no sandboxd/TCC hang) | `ps -axo pid,etime,command \| grep -E 'src/sync_\|health_check' \| grep -v grep`: nothing older than its stage limit; capture log shows `[capture] end: ok` | **NO-GO**. Hung since 06:12, see Blockers |
| 1 | Native exporter `ready=1` and `updated_at` < 2 min old | `sqlite3 "file:$HOME/.robob/userdata/readonly/opencode.sqlite?mode=ro" "SELECT key,value FROM ardud_readonly_meta WHERE key IN ('ready','updated_at','history_ready','destructive_ready')"` | **NO-GO**. ready=0, bootstrap 17,428/34,150 sessions applied at 08:05, 38-46/min |
| 2 | Backup green within 4 h | `cat ~/.local/share/memory-system/logs/backup_last.json`: `ok:true`, `ts` > now-4h | **NO-GO**. Last ok 23:58 (8.4 h); 06:04 run killed in its files step by the hang (replicas themselves OK: memory.db 386 s) |
| 3 | ExternalSSD free >= 300 GB | `df -g /Volumes/ExternalSSD` | GO: 387 GB |
| 4 | memory.db WAL small (< 1 GB) | `ls -l /Volumes/ExternalSSD/memory-system-data/memory.db-wal` | **NO-GO**. 2.16 GB, pinned since 06:12 (truncate stage times out on the hang); Phase 2 TRUNCATE clears it once readers are stopped |
| 5 | Branch `robob/recall-golive` pushed, tests green | `git ls-remote origin refs/heads/robob/recall-golive` = `f438e896bb...` | GO |
| 6 | Abdullah has OK'd the outage window | Telegram | pending |

Decision: deploy memory-system **all at once in Phase 7 from the go-live
tree**, not in two steps. Why: the only non-rebuild memory-system code not yet
live is the replica/native-export consumer set (robob_readonly users in
sync_opencode_v2, sync_thread_identity, recall_core, health_check, reapers,
backup). Those refuse to run until the native export is ready, so shipping
them early would stall OpenCode capture until gate 1 passes anyway. The live
copy is exactly origin/main `5b386376ce` (verified file by file), so a
rollback target is clean. Shipping everything after the export is ready, while
capture is stopped for the migration, is one cutover instead of two.

Tonight is go only if gates 0-4 all flip. Gate 0 needs Abdullah (see
Blockers). Gate 1: ~16,700 sessions left at 38-46/min is ~6-7 h, so the
first full pass ends around 14:00-15:30 (estimate). The exporter can finish
that first pass stale and publish `ready=1` only after the next incremental
pass, so allow extra time. Gate 2 needs one clean backup after gate 0. If
gate 1 isn't green by ~23:00, move the window one night.

## Tree

- Branch `robob/recall-golive` on origin (not main), worktree
  `/Volumes/ExternalSSD/t3code-wt/recall-golive`. Head **`f438e896bb`**.
- Built as: `robob/native-readiness` (`73fa05a7e6`) + merge origin/main
  `5966a8053a` (`960baafaa5`) + merge `robob/recall-rebuild` `8f890f420c`
  (`d820d12bbf`) + three fix commits:
  - `00b8fe4fcb` test(memory): Linux runner fixes (taskpolicy shim, run_limited
    emulation, WAL fixture on stdlib sqlite) + tick-order assertions.
  - `778ba6aafe` fix(memory): `recall_cli.py` was missing `import os`; every
    `recall` CLI command (query/view/list, used in Phase 8) died with
    NameError on the rebuild branch. Regression test added.
  - `f438e896bb` test(stream-recovery): stub `harnessCutoverStatus` in main's
    new execute-stall test (NR's stallScan calls it first).
- Conflicts and resolutions:
  - `memory_capture_tick.sh`: rebuild's rules stage kept, then `wal_truncate.py`
    as the last stage, log line `rc muse= claude= codex= identity= opencode=
    rules=$rules_rc wal=$wal_rc`. Lock deadline = HARD + MUSE + CLAUDE + CODEX
    + 60 (identity) + 15 (rules) + WAL_HARD, so the rules stage is budgeted.
    Asserted in `tests/test_stages.sh`.
  - `harness-homes/manifest.json`: NR's guard hooks (widened shell matchers,
    codex Stop/SubagentStop/SessionEnd for desktop-lease) + NR's
    `mcpParity`/`paritySources` kept; ALL recall_hook entries taken from the
    rebuild (UserPromptSubmit, PreToolUse 4 s, PreCompact, SessionStart,
    PostToolUse(+Failure), codex PostCompact; 2 s). The old 15 s
    Stop/SubagentStart/SessionEnd recall hooks are dropped because the new
    adapter ignores those events.
  - main vs NR in `control/model.ts` (same #586 fix, kept NR's comment),
    `control/resolverCallers.test.ts` (harness takes NR's `cutoverComplete`
    and main's `"absent"` mode + `base`; all three new tests kept),
    `offbox/tests/test_identity.py` (= main), `stream-recovery/lib/stall.mjs`
    (both imports).
  - No real conflict in recall_core / sync_* / health_check: the rebuild
    already merged the replica branch through `fe4213e667`, and NR's later
    commits touch none of those files. The merged src is byte-identical to the
    rebuild's for every recall/sync/health file, and identical to NR for every
    replica/export consumer (robob_readonly, export_opencode, reapers, backend).
    The rebuild keeps native-readiness semantics: capture reads only
    `ardud_native_sessions` rows with `applied_seq` set and `dirty=0`,
    refuses unready exports, and tightens reader timeouts to 0.1 s.

## Tests (go-live tree)

- Box (Ubuntu, stdlib SQLite 3.45 + pysqlite3 3.51 via
  `tests/run_rebuild_tests.py`): **542 Python tests OK**, plugin 10/10,
  shell fixtures (`test_stages.sh` + `test_backup_replica.sh`) ALL PASS,
  harness-homes 83 OK, compileall + `bash -n`/`zsh -n` OK.
- One earlier full run on the same tree had 5 timing-sensitive
  NativeAdapter hook tests fail (0.98 s vs 0.8 s limits, a 20 ms SQLite lock)
  while the box was under load; reruns (3x isolated + full) all passed.
  Treat as flaky under load, not a regression. The rebuild's own runner also
  hid the known env issues (FTS >= 3.47, root permission test) this time.
- Local (Mac): `test_stages.sh` ALL PASS incl. the throttled-parent I/O check;
  recall venv single files (homes, wal_truncate, capture_budget, engine,
  rules, storage, bounds, acceptance_push, classifier, admission) OK.
- Server (merge touched `apps/server/src/ardud/control`):
  `vp test run model.test.ts resolverCallers.test.ts` 54/54; `vp exec tsc
  --noEmit -p .` rc 0, 0 errors (box, xlarge).
- Other merged integrations: stream-recovery 145/145, opencode-plugins 77/77,
  offbox classify 141/141 + bun 8/8. spectrum-bridge (20 fail/17 errors) and
  offbox unit (27 fail/4 err, macOS `sandbox-exec`) fail identically on
  origin/main and NR on the Linux box: pre-existing, not from the merge.

## ProcessType rule (owner finding, 7 Nov)

launchd agents without `ProcessType Interactive` get 10-95 random-read IOPS on
the USB ExternalSSD (vs ~3,500 from a shell); `taskpolicy -d default` / nice
inside the job don't lift it. Every memory LaunchAgent that touches the SSD
must have `ProcessType Interactive` and no `LowPriorityIO`. The migration and
index phases below run from an interactive shell and aren't affected.

- Tracked plists in the go-live tree comply (`com.abdullah.recall`,
  `com.abdullah.opencode-readonly`). The rebuild changes no plist; the only
  plist edit tonight is adding env keys to recall's (Phase 7). Keep
  `ProcessType Interactive`, don't add `LowPriorityIO`.
- Live now: memory-sync, memory-backup, recall, life-wiki-detect,
  life-wiki-nightly Interactive, no LowPriorityIO. **Still non-compliant:
  `com.abdullah.session-reaper` has `LowPriorityIO true`** (Interactive set),
  `com.abdullah.location-reaper` has no ProcessType + `LowPriorityIO`,
  memory-health has no ProcessType. Fix session-reaper before re-enabling it
  in Phase 9 (`plutil -remove LowPriorityIO`); location-reaper doesn't read
  memory.db.
- When the native exporter moves from tmux to its LaunchAgent, install
  `scripts/com.abdullah.opencode-readonly.plist` from this tree (Interactive,
  no LowPriorityIO, `nice -n 15` in ProgramArguments).

## Size and timing estimates

Unchanged measurements from 6-7 Nov (replica page walk, 100k-id sample, real
10-minute trial copy, 400k-row hot projection benchmark). NEWDIR total
**~180-185 GB** (cold ~98-100, hot ~75-80, rules/catalog < 0.1, WAL budget 5).
Current free 387 GB, so ~200 GB left after migration, ~100 GB after the first
post-cutover backup adds ~100 GB of restic chunks. That's the tight point;
gate 3 (>= 300 GB) keeps it at >= 100 GB.

Revised timings:
- Rules transcript import: measured today against the immutable replica,
  ~127k rows/s, so the 37.7 M-row scan is **~5 min** (was "minutes"; now
  measured). Use `--max-rows 100000 --seconds 60` (the importer caps at
  100k rows/60 s per call); ~380 calls.
- Old 9 GB WAL TRUNCATE took 280 s; at < 1 GB expect seconds.
- Cold copy and hot index estimates unchanged (45-60 and 55-75 min). The
  whole outage stays **~2-2.5 h**.

## Go-live sequence

```bash
U=$(id -u)
GL=/Volumes/ExternalSSD/t3code-wt/recall-golive
MS=$GL/integrations/memory-system
OLD=/Volumes/ExternalSSD/memory-system-data
NEW=/Volumes/ExternalSSD/memory-system-data-v2
PY=/opt/homebrew/bin/python3
```

### Phase 0: prerequisites (before the window, no outage)

1. Gates 0-5 green (table above). Re-run gate 0 within 10 minutes of Phase 1.
2. `git -C $GL status --short` empty and `git -C $GL rev-parse HEAD` =
   `f438e896bb...`. Deploy from this exact head.
3. Read-only stats while capture runs (optional, ~minutes):
   `cd $MS && $PY scripts/recall_stats.py --source $OLD/memory.db > /var/folders/vt/8qndzr_j44z70bh0rn2zyfkm0000gn/T/opencode/recall-stats.json`.
4. Telegram Abdullah the window (recall search + capture paused, sessions
   continue; capture catches up afterwards).

### Phase 1: freeze (~5 min)

```bash
cp ~/.config/opencode/recall.json ~/.config/opencode/recall.json.pre-golive
$PY - <<'PY'
import json,os;p=os.path.expanduser('~/.config/opencode/recall.json');d=json.load(open(p));d['mode']='off';json.dump(d,open(p,'w'))
PY
# wait for the current tick, then stop writers and readers of memory.db
while grep -q '"running"' ~/.local/share/memory-system/logs/capture_last.json || [ -d ~/.local/share/memory-system/logs/state/capture.lock ]; do sleep 2; done
launchctl bootout gui/$U/com.abdullah.memory-sync
launchctl bootout gui/$U/com.abdullah.session-reaper
launchctl bootout gui/$U/com.abdullah.memory-backup     # only if not mid-run; else wait for "backup done"
launchctl bootout gui/$U/com.abdullah.life-wiki-detect
launchctl bootout gui/$U/com.abdullah.life-wiki-nightly # 03:00 run would read memory.db mid-migration
launchctl bootout gui/$U/com.abdullah.memory-health      # it opens memory.db read-only every 15 min
launchctl bootout gui/$U/com.abdullah.recall
lsof $OLD/memory.db $OLD/opencode_raw.db                 # must print nothing
```
Leave the native exporter (tmux `-L export` / its LaunchAgent) running; it
never touches memory.db.

### Phase 2: clean source (~1 min at < 1 GB WAL)

```bash
$PY - <<'PY'
import sqlite3
for db in ("/Volumes/ExternalSSD/memory-system-data/memory.db","/Volumes/ExternalSSD/memory-system-data/opencode_raw.db"):
    c=sqlite3.connect(db,timeout=300,isolation_level=None); c.execute("PRAGMA busy_timeout=300000")
    print(db, c.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()); c.close()
PY
ls -l $OLD/memory.db-wal $OLD/opencode_raw.db-wal 2>/dev/null   # 0 bytes or absent
```
Recommended: one final incremental backup with writers stopped
(`launchctl bootstrap gui/$U ~/Library/LaunchAgents/com.abdullah.memory-backup.plist && launchctl kickstart gui/$U/com.abdullah.memory-backup`,
wait for `backup done` in `logs/backup-$(date +%Y%m).log`, ~10-35 min, then
`launchctl bootout gui/$U/com.abdullah.memory-backup`).

### Phase 3: cold copy (~45-60 min + index DDL)

```bash
cd $MS
$PY src/recall_migrate.py --source $OLD/memory.db --target-dir $NEW      # dry run; must not error
until $PY src/recall_migrate.py --source $OLD/memory.db --target-dir $NEW \
      --execute --offline-confirmed --max-rows 1000000 --seconds 60 --batch-rows 250 > /tmp/mig.json 2>&1 \
      && grep -q '"ready": true' /tmp/mig.json; do
  tail -c 400 /tmp/mig.json; grep -q '"error"' /tmp/mig.json && break
done
```
Errors are printed as `{"ready": false, "error": ...}` on stderr with exit 1;
`2>&1` puts them in the file so the loop stops on them. Don't delete sidecars to get past a WAL refusal.

### Phase 4: hot index (~55-75 min)

```bash
until $PY scripts/index_hot.py --source $NEW/memory.db --index $NEW/recall_hot.db \
      --max-rows 200000 --seconds 60 > /tmp/hot.json 2>&1 && grep -q '"caught_up": true' /tmp/hot.json; do
  tail -c 300 /tmp/hot.json; grep -q -i '"error"\|Traceback' /tmp/hot.json && break
done
```

### Phase 5: rules index (~5-10 min)

```bash
until $PY scripts/index_rules.py --db $NEW/recall_rules.db --skills ~/.config/opencode/skills \
      --agents ~/.config/opencode/AGENTS.md --agents ~/trading-core/AGENTS.md --transcripts $NEW/memory.db \
      --max-rows 100000 --seconds 60 --repo-agents > /tmp/rules.json 2>&1 && grep -q '"complete": true' /tmp/rules.json; do
  grep -q Traceback /tmp/rules.json && break; done
```

### Phase 6: switch paths (~2 min)

Don't symlink `opencode_raw.db` into NEW (two paths = two WALs). Move it.
```bash
lsof $OLD/opencode_raw.db                                   # must print nothing
mv $OLD/opencode_raw.db $NEW/opencode_raw.db
mv $OLD/backup-manifests $NEW/backup-manifests
cp -p $OLD/.ssdmove-origin $NEW/ 2>/dev/null
ln -sfn $NEW ~/.local/share/memory-system/data.new && mv -fh ~/.local/share/memory-system/data.new ~/.local/share/memory-system/data
readlink ~/.local/share/memory-system/data                  # -> memory-system-data-v2
```
`recall_catalog.db` is not carried over (new catalog). `$OLD/memory.db` stays
as rollback.

### Phase 7: deploy code (~5 min)

```bash
cd $GL
cp -p ~/Library/LaunchAgents/com.abdullah.recall.plist ~/Library/LaunchAgents/com.abdullah.recall.plist.bak-golive
integrations/deploy.zsh memory-system --dry-run
integrations/deploy.zsh memory-system            # also runs plugin/install.zsh (plugin + remember skill, .bak copies)
integrations/deploy.zsh harness-homes && integrations/harness-homes/install.zsh --check
# recall plist: add hot/rules paths, keep everything else (ProcessType Interactive, no LowPriorityIO)
P=~/Library/LaunchAgents/com.abdullah.recall.plist
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:RECALL_HOT_DB string $HOME/.local/share/memory-system/data/recall_hot.db" \
  -c "Add :EnvironmentVariables:RECALL_RULES_DB string $HOME/.local/share/memory-system/data/recall_rules.db" $P
/usr/bin/plutil -lint $P && /usr/bin/plutil -extract ProcessType raw $P      # Interactive
/usr/bin/plutil -extract LowPriorityIO raw $P 2>&1 | grep -q 'No value' && echo no-LowPriorityIO
/usr/libexec/PlistBuddy -c "Remove :LowPriorityIO" ~/Library/LaunchAgents/com.abdullah.session-reaper.plist
```
Notes:
- `plugin/install.zsh` rewrites `recall.json` (wait/timeout 500 ms, preaction
  3000 ms, work off) and keeps the current `mode`, which is `off` here. That's
  intended; Phase 8 turns it on.
- OpenCode doesn't reload a changed plugin file until the OpenCode service
  restarts (Bun module cache; confirmed in past sessions). Until then the old
  plugin keeps calling `/api/inject`, which the new server still serves as the
  cheap compat path, so nothing breaks. The new `/api/check` pre-action path
  for OpenCode starts only after the next OpenCode restart, which needs
  Abdullah's go. Claude/Codex hooks start on their next session (harness-homes).
- The memory-sync plist keeps `ROBOB_STATE_DB` = read-only replica; it doesn't
  need `RECALL_RULES_DB` (the tick defaults to `data/recall_rules.db`, which
  the symlink now resolves to NEW).

### Phase 8: restart and verify (~15 min, outage ends)

```bash
launchctl bootstrap gui/$U ~/Library/LaunchAgents/com.abdullah.recall.plist
curl -s -m 5 localhost:18765/api/health      # ok, hot_index present, rules_ready true, catalog bootstrapping
launchctl bootstrap gui/$U ~/Library/LaunchAgents/com.abdullah.memory-sync.plist
# one full tick: capture_last.json ok; "rc ... rules=0 wal=0"; WAL {...} truncated true
tail -5 ~/.local/share/memory-system/logs/capture-$(date +%Y%m%d).log
launchctl bootstrap gui/$U ~/Library/LaunchAgents/com.abdullah.memory-health.plist
launchctl bootstrap gui/$U ~/Library/LaunchAgents/com.abdullah.life-wiki-detect.plist
launchctl bootstrap gui/$U ~/Library/LaunchAgents/com.abdullah.life-wiki-nightly.plist
# Restore ~/.local/bin/recall from the repo wrapper before CLI checks.
install -m 755 /Volumes/ExternalSSD/t3code-fork/integrations/memory-system/scripts/recall "$HOME/.local/bin/recall"
recall query "<a known recent phrase>"
recall view <old ses>#e<old event id>       # cold citation across cutover
$PY - <<'PY'                                 # mode back on, keeping the installer's new timeouts
import json,os;p=os.path.expanduser('~/.config/opencode/recall.json');d=json.load(open(p));d['mode']='on';json.dump(d,open(p,'w'),indent=2)
PY
```
OpenCode capture only advances for sessions the native export has applied;
with gate 1 green that's all of them. health_check's `recall` check fails if
the hot index backlog > 20,000 or rules are missing; expect it to settle
within a few ticks.

### Phase 9: backup and reaper (30-90 min, then next day)

```bash
launchctl bootstrap gui/$U ~/Library/LaunchAgents/com.abdullah.memory-backup.plist
launchctl kickstart gui/$U/com.abdullah.memory-backup
```
First replica after cutover is a full copy of the ~100 GB new cold store
(sqlite3_rsync ~20-30 min unthrottled), restic adds ~100 GB. Note
`recall_hot.db` and **`recall_rules.db` are not in the backup loop**; hot is
rebuildable, but explicit `recall_remember` saves exist only in
`recall_rules.db`. Follow-up: add it to `memory_backup.sh` (small file).
Only after `backup done` + `health_check` green, and only with the
session-reaper plist fixed (Phase 7), and only once the export's
`destructive_ready=1`:
`launchctl bootstrap gui/$U ~/Library/LaunchAgents/com.abdullah.session-reaper.plist`.
Then live acceptance (`$PY ~/.local/share/memory-system/scripts/acceptance_push.py prepare` /
`verify --root ...`, rebuild doc step 12).

## Rollback

Before Phase 6: abort; `rm -rf $NEW` (new files only); restore
`recall.json.pre-golive`; bootstrap every agent stopped in Phase 1. Old store
untouched, no code changed.

After Phase 6:
1. `recall.json` mode off; bootout memory-sync, recall, life-wiki-detect,
   life-wiki-nightly, memory-health, session-reaper, memory-backup.
2. TRUNCATE-checkpoint `$NEW/opencode_raw.db`, then `mv $NEW/opencode_raw.db $OLD/`
   and `mv $NEW/backup-manifests $OLD/`.
3. `ln -sfn $OLD ~/.local/share/memory-system/data.new && mv -fh ~/.local/share/memory-system/data.new ~/.local/share/memory-system/data`
4. Code back to the pre-golive release = origin/main `5b386376ce` for
   memory-system (verified identical to the live copy at 08:00) and
   `robob/native-readiness` `73fa05a7e6` for harness-homes (identical to live):
   ```bash
   git -C /Volumes/ExternalSSD/t3code-fork worktree add --detach /Volumes/ExternalSSD/t3code-wt/recall-rollback 5b386376ce
   /Volumes/ExternalSSD/t3code-wt/recall-rollback/integrations/deploy.zsh memory-system
   git -C /Volumes/ExternalSSD/t3code-wt/recall-rollback checkout 73fa05a7e6 -- integrations/harness-homes
   /Volumes/ExternalSSD/t3code-wt/recall-rollback/integrations/deploy.zsh harness-homes
   ```
   deploy.zsh never deletes on the live side, so files new in the rebuild stay
   under `~/.local/share/memory-system/` unused. The old deploy.zsh doesn't
   install the plugin: restore `~/.config/opencode/plugin/recall.ts` and
   `recall.json` from the newest `.bak-<stamp>` the installer wrote, and
   remove `~/.config/opencode/skills/remember-this-next-time/`.
   `cp -p ~/Library/LaunchAgents/com.abdullah.recall.plist.bak-golive ~/Library/LaunchAgents/com.abdullah.recall.plist`.
5. Bootstrap memory-sync, recall, memory-health, life-wiki-*; mode on. Capture
   re-reads sources into OLD from its own ledgers. Never copy NEW back over OLD.
6. Keep `$NEW` until Abdullah says otherwise.

## Blockers / open items

1. **launchd jobs hang opening files on the ExternalSSD (since 06:12).**
   The 06:04 backup's `rsync` (Homebrew, ad-hoc signed, upgraded 3 Nov)
   triggered a TCC `kTCCServiceSystemPolicyRemovableVolumes` prompt through
   sandboxd at 06:12:03 (`AUTHREQ_PROMPTING`, never answered, no dialog
   visible). Since then every launchd-started reader of the SSD sits in
   `open()`: all capture stages time out each tick (`rc muse=124 ... wal=124`,
   2,111 s ticks), health_check pid 14300 and life-wiki pid 66457 have been
   stuck ~1 h, the WAL truncate can't run (WAL 2.16 GB). Killing the rsync
   (06:57, backup logged `FAIL [files]`) did not release it. Interactive
   shells are mostly fine, but `link()` on the SSD also hangs from shells
   (git needs `-c core.createObject=rename` to commit; `mv`/`mkdir` work).
   Same pattern as card #1905 (3 Nov), cleared by a sandboxd restart.
   **Needs Abdullah**: answer a pending Removable Volumes prompt if one shows
   on unlock, or `sudo killall sandboxd` (needs sudo, not an agent call).
   Telegram sent ~07:00 (key `recall-golive:sandboxd-removable-volumes-hang`).
   Durable fix to consider: grant Full Disk Access / Removable Volumes to the
   Homebrew rsync, sqlite3 and python binaries (ad-hoc signatures change on
   every brew upgrade, which re-triggers this).
2. Native exporter still bootstrapping (gate 1). Don't stop it.
3. Backup needs one clean run after blocker 1 (gate 2).
4. Live `com.abdullah.session-reaper` still has `LowPriorityIO` (fix in
   Phase 7 before re-enabling).
5. `recall_rules.db` (explicit remember saves) isn't backed up (follow-up).
6. OpenCode's new pre-action plugin path needs one OpenCode service restart
   (Abdullah's go); until then OpenCode keeps the compat `/api/inject` path.

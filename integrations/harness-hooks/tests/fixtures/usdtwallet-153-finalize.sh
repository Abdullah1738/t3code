git rev-parse HEAD master
git diff --check
python3 - <<'PY'
from pathlib import Path
import json,shutil,subprocess,hashlib,xml.etree.ElementTree as ET
p=Path('tmp/cards/153');head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
assert head=='ac64ffc4b0b5d242b2b7c035a69db67366d9b280'
assert head==subprocess.check_output(['git','rev-parse','master'],text=True).strip()
diff=subprocess.check_output(['git','diff','--binary']);sha=hashlib.sha256(diff).hexdigest()
assert sha==(p/'fix.sha256').read_text().strip()
s=Path('tmp/unit-tests/616666502d394315935f19681539edd7')
(p/'C').mkdir(exist_ok=True)
shutil.copytree(s,p/'C/artifacts',dirs_exist_ok=True)
shutil.copy('/Users/ardud/.local/share/offbox/logs/run-1108-042332-4cb5.log',p/'C/offbox.log')
r=json.loads((s/'result.json').read_text())
(p/'C/manifest.json').write_text(json.dumps(dict(run='run-1108-042332-4cb5',box='bx_ebkpvp45',head=head,patch_sha256=sha,result=r),indent=2)+'\n')
summary={}
for label in ['A','B','C']:
 m=json.loads((p/label/'manifest.json').read_text());r=m['result']
 assert m['head']==head and m['patch_sha256']==sha and r['rc']==0 and not r['forced_termination']
 for name,phase in r['phases'].items():
  assert phase['rc']==0 and phase['gradle_rc']==0 and not phase['forced_termination'] and phase['error'] is None
  assert all(phase['counts'][key]==0 for key in ['failures','errors','skipped'])
  print(label,name,phase['counts'],'suites',phase['suites'],'seconds',phase['seconds'],'task',phase['task_seconds'],'fs',phase['backing_fs']['type'])
 summary[label]=m
 summary['baseline-'+label]=json.loads((p/('baseline-'+label)/'manifest.json').read_text())
summary['red']=json.loads((p/'red/summary.json').read_text())
(p/'validation-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
reg=[]
for label in ['A','C']:
 for phase in summary[label]['result']['phases']:
  for f in (p/label/'artifacts'/phase/'xml').glob('*.xml'):
   for c in ET.parse(f).getroot().findall('testcase'):
    if c.get('classname','').endswith('TestWaitsTest') or c.get('name') in ['pollWithContextKeepsIdleObservationWhenRefreshStartsScans','shadowClockAdvanceDoesNotExpirePollWithContext','pollReturnsOnTheFirstSuccessfulObservation','awaitReturnsOnTheFirstSuccessfulObservation','busyWhileASwapRuns']:
     reg.append(dict(run=label,phase=phase,classname=c.get('classname'),name=c.get('name'),seconds=c.get('time'),passed=not any(c.find(t) is not None for t in ['failure','error','skipped'])))
assert all(row['passed'] for row in reg)
(p/'regression-results.json').write_text(json.dumps(reg,indent=2)+'\n')
report=f'''# Card 153: first successful poll observation

Status: complete, ready for independent board review. No commits or pushes.

## Exact reviewed state

- Worktree: /Users/ardud/.robob/worktrees/usdtwallet-android/test-poll-success-observation
- Branch: test/poll-success-observation
- HEAD/base: {head}
- Implementation is uncommitted. Git binary patch SHA256: {sha} (fix.patch).
- Red-first base: 4889220e2102c11a1894b2f4173fafa0e88be446.
- core.aar SHA256: 2aedec40fb81e800d3dde434baad690fa749471d510e7762a731cf7888221bfa
- core-debug.aar SHA256: ae58a215ee1d0035c99927285ec3526819b138bbbd568d8a83bffa7d8509cc37
- AARs copied from main checkout. No core/ changes.

## Final validation on ac64ffc4

All runs below used large bx_ebkpvp45, template crpko-go, the normal wrapper, both AAR includes and artifact pull. All exited 0 with zero failures/errors/skips and no forced termination. No failed-gate retries.

| Run | Offbox ID | Selection | Tests / suites | Phase / test-task seconds |
| --- | --- | --- | --- | --- |
| A | run-1108-042029-c582 | TestWaitsTest, ObservedStepTest, SwapWalletTest | 277 / 3 | 30.0 / 22.0 |
| B | run-1108-042206-6aaf | #148 batch | 353 / 6 | 40.0 / 37.0 |
| C fast | run-1108-042332-4cb5 | full suite, tmpfs | 2,112 / 122 | 125.1 / 121.1 |
| C disk | run-1108-042332-4cb5 | real-disk durability selection, ext4 | 931 / 20 | 53.0 / 46.0 |

C normal wrapper total: {summary['C']['result']['seconds']} s. Exact task seconds and filesystem/fsync measurements are in C/artifacts/result.json. Full XML, Gradle logs, wrapper results and run manifests are under A/, B/, C/. validation-summary.json indexes every run; regression-results.json records all required regressions and busyWhileASwapRuns passing. A comprises TestWaitsTest 15, SwapWalletTest 256, ObservedStepTest 6.

B's six classes: SwapRestartNavigationTest, SwapSpeedUpScreenTest, SwapFeeWaitUiTest, SwapLiveRunUiTest, BridgeDecisionScreenTest, SwapWalletTest.

Common command prefix (from the worktree):

```sh
offbox run --bg --remote --size large --template crpko-go \\
  --include android/app/libs/core.aar --include android/app/libs/core-debug.aar \\
  --pull tmp/unit-tests -- python3 scripts/run-unit-tests.py
```

A/B append one --tests flag per fully qualified com.usdtwallet.app class listed above. C appends nothing: both phases are mandatory. Full selections are retained in the phase JSON. No local Gradle, bound increase, clock workaround or runner change.

## Red-first proof on master 4889220e

run-1108-040307-55e4, large bx_jesu2tnn: 264 tests / 2 suites, exactly three deliberate failures, zero errors/skips, no forced termination. All three helpers were unchanged from master; the regression-only patch and SHA256 are in red/regressions.patch and red/manifest.txt.

- true,false: pollWithContextReturnsOnImmediateTransientSuccess failed in 0.001 s, timeout at reads=2.
- false,true,false: pollWithContextReturnsOnTransientSuccessAfterPolling failed in 0.002 s, timeout at reads=3.
- Real Wallet idle then held refresh scans: pollWithContextKeepsIdleObservationWhenRefreshStartsScans failed in 0.030 s, despite its successful first idle sample.
- Negative clock control shadowClockAdvanceDoesNotExpirePollWithContext passed in 0.025 s: first predicate advances shadow time by 60 s during the unchanged 5,000 ms wait. Same regression source retained for green.

Complete XML and Gradle output: red/artifacts/. red/summary.json lists the cases. No research logging or reflective clock was added.

## Parallel landing and earlier green gates

Initial gates on 4889220e also passed: A run-1108-040628-24ee (277), B run-1108-040742-13f7 (353), C run-1108-040858-d7d0 (fast 2,109 + disk 928). Evidence retained under baseline-A/, baseline-B/, baseline-C/.

Card #151 landed concurrently as ac64ffc4, changing only WalletEthHoldTest and adding three cases. The worktree fast-forwarded with this poll patch byte-for-byte unchanged, then A/B/C all ran again on ac64ffc4. Current master counts are 2,100 fast / 927 disk before this patch; our 12 new cases add 12 fast / 4 disk (8 TestWaitsTest, 3 SwapWalletTest, 1 ObservedStepTest; the latter two classes are in the disk selection). Final counts are therefore 2,112 / 931.

## Change and audit

One synchronous pollUntil loop keeps System.nanoTime and returns immediately on the first true sample. pollWithContext and SwapWalletTest.poll use Thread.yield; ObservedStepTest.await sleeps 10 ms and asserts the returned boolean. Predicate exceptions propagate unchanged. Context state is captured only on false; timeout text and all configured bounds stay unchanged.

Scripted rows check exact reads and zero successful-state captures. The always-false tests independently measure real elapsed >=50 ms, including directly on the core without diagnostic overhead. Yield and sleep each cover transient/stable success, real timeout and unchanged exception propagation. Existing diagnostic/state-failure/namedWait tests remain unchanged. The Wallet scan gate is released in finally and existing bounded fixture teardown remains.

Four changed test files, 170 insertions / 9 deletions: TestWaits.kt, TestWaitsTest.kt, SwapWalletTest.kt, ObservedStepTest.kt. busyWhileASwapRuns and all original call sites/overrides unchanged. git diff --check clean. No production/config/release/signing/seed files, live nodes, funds or phone used. scope-audit.json verifies scope and original tests; SIBLINGS.md and affected-call-sites.txt list inspected entry points and exclusions. Installed skills, watcher text and board wiki checked; no conflicting rule found.

## Evaluator follow-up

No live configuration, skill or deployment change needed. After review, evaluator commits/pushes, then copies this tmp/cards/153 evidence into the main checkout before removing the worktree. Wiki testing update is evaluator s6 after landing: close busyWhileASwapRuns with landed SHA and remove its retry allowance. UnknownSwapUiTest currently waits on append-only call entry at ui/UnknownSwapUiTest.kt:519 before asserting the UI at :520; this is not one of the re-reading helpers, and its predicate cannot revert in that test. UI publication may still lag call entry, which remains an unproved separate issue. See SIBLINGS.md. No wiki rule edits here.
'''
# Use measured values rather than typed task durations.
for name in ['fast','disk']:
 phase=summary['C']['result']['phases'][name]
 if name=='fast':report=report.replace('125.1 / 121.1',f"{phase['seconds']} / {phase['task_seconds']}")
 else:report=report.replace('53.0 / 46.0',f"{phase['seconds']} / {phase['task_seconds']}")
(p/'RESULT.md').write_text(report)
with (p/'PLAN.md').open('a') as f:f.write('\nFinal C run-1108-042332-4cb5 passed fast 2112/122 + ext4 disk 931/20; no failures/errors/skips or forced termination. HEAD/master ac64ffc4 unchanged. All final evidence archived; ready s2 + needs_review.\n')
print('Final manifest and RESULT complete; patch unchanged:',sha)
PY
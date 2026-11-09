cat > tmp/cards/150/FINDINGS.md <<'EOF'
# Card #150: ETH hold recheck disk failure

## Verdict

**Test ordering bug in WalletEthHoldTest's fake core. No product fix is indicated.**
The unlock-triggered hold check can erase `f.core.released` while the test is setting it. The later explicit forced check then receives an ordinary `held=[hold], released=[]` answer and correctly writes one hold to disk. Its return is a persistence barrier for that answer; it cannot recover a release that the fake already discarded.

The cause is proven by red/green/red on real disk with the same source and every original target assertion retained. Only the order of the test assignment relative to the fake's reset changes. The historical #148 failure has no branch trace, so its precise instruction-level schedule cannot be recovered; this reproduces its exact assertion through a demonstrated race in the same baseline code. An adjacent inconsistent-snapshot window belongs to the same fake race and is a static finding, not a second claimed dynamic proof.

Research base: `43b272104d2a086531cac4758dc611fd0dcdab58`, immediately after ETH hold merge `b18d080a`. Main checkout stayed at that SHA. No commits, pushes, permanent test/product edits, real funds, nodes, phone, local Gradle, or changed test bounds.

## Evidence and run ledger

All retained paths below are relative to `/Users/ardud/src/usdtwallet-android/tmp/cards/150/`.
All executed test selections used large crpko-go box `bx_ebkpvp45`, real `/tmp`, ext4 `/dev/vda1`. The runner calls these selected passes `fast`, but `--real-disk` disables tmpfs; each result.json verifies the backing filesystem.

| Run | Selection and result | Artifacts |
| --- | --- | --- |
| Historical `run-1108-011815-7d8b` | #148 disk lane: 924 tests, only target failed, expected 0 / got 1 at original line 273 | `from-148/disk/` |
| `run-1108-030806-cba8` | Unmodified baseline class: 21 tests, 0 failures | `baseline/` (token `4647cd5615a34b47b2bd46f585f98533`) |
| `run-1108-031115-cb9a`, natural-01 | Trace-only full class, no latch ordering: 21 tests, 0 failures | `evidence/natural-01/` |
| Same run, natural-02 | Trace-only full class: target passed; **sibling timing test failed**, expected 1 / got 2 | `evidence/natural-02/`, `natural-02-trace.txt` |
| `run-1108-031320-75a0`, red-1 | Target alone, assignment before reset: 1 test, exact original disk assertion fails (0 vs 1) | `proof/red-1/`, `proof/red-1-trace.txt` |
| Same run, green | Target alone, assignment after reset: 1 test, all original assertions pass | `proof/green/`, `proof/green-trace.txt` |
| Same run, red-2 | Return to assignment before reset: 1 test, exact original disk assertion fails again | `proof/red-2/`, `proof/red-2-trace.txt` |

The natural class loop stopped on its first red (the sibling). Proof reached the cause-proven stop, so the alternative 200-class / three-full-disk-lane non-reproduction budget was not needed or claimed. No full gate was run for this research. Neither target nor sibling is silently counted as green.

An intermediate invocation, `run-1108-031255-520e`, ran no tests: a local runner-edit command used the wrong working-directory-relative path, leaving the previous driver in place; its existing artifact directory was rejected. It is excluded. The successful proof used a new artifact root. The outer batch command returns zero after collecting results; **individual runner exits and XML** are authoritative: 1 / 0 / 1. `verify-evidence.py` checks these and the ordering from the retained data.

The historical failed gate's fsync sample was median 0.1674 ms, p95 0.7283 ms, maximum 1.7172 ms. There is no basis to call that failure a slow-disk timeout.

## Call graph and ownership

Source references in this report use the research base's original line numbers.

- `WalletEthHoldTest.kt:167`: fixture uses Default/IO real threads; Main is an UnconfinedTestDispatcher. `sendWatchDelay` and `swapWatchDelay` suspend forever. They do not disable the immediate foreground refresh check.
- `WalletEthHoldTest.kt:192`: `open(f)` awaits `wallet.unlock` only.
- `Wallet.kt:854`, `:976`, `:1008`: unlock -> publishOrClose -> publishUnlocked. At `:1029`, refresh runs after publishing Unlocked.
- `Wallet.kt:1296`: refresh schedules `scope.launch(IO) { checkEthHolds(force=true) }`; that job is not joined by unlock.
- `Wallet.kt:1396`: resumeSync schedules another forced check. It is not invoked by this target.
- `Wallet.kt:3107`: ensureSendWatch's delayed loop calls reconcileSendsForTest -> `checkEthHolds(force=false)` at `:3124`. The fixture's delay blocks that loop. The 60-second throttle applies only to non-forced checks.
- `Wallet.kt:1821`: the test wrapper calls the same checker with force=true. `signFence` serializes both wallet checks, but the test's direct `FakeCore.released` assignment does not acquire it.
- `WalletEthHoldTest.kt:112`: fake check logs entry, tests `released.length()`, possibly clears `holds`, serializes `{held, released}`, then unconditionally assigns `released=JSONArray()` in `.also`. The field is plain mutable state, without a mutex or atomic transaction.

## Decisive interleaving

Red-1 trace times are monotonic nanoseconds, for ordering only:

1. Unlock's refresh call `880557986532` enters the native fake and serializes one held item with no releases at `880560869696`.
2. The fake pauses just before its normal unconditional reset (`880561443865`). The latch is in test code, with the existing five-second test bound.
3. The test installs its cancelled release at `880561605258` and resumes the fake.
4. The fake resets the shared field to an empty array at `880562494728`. The test's release is lost, never returned to Wallet.
5. The unlock check writes its original held=1/released=0 answer and returns from the write at `880656048685`.
6. The explicit forced call `880562489599` acquires signFence, calls the fake, also receives held=1/released=0, and finishes its write at `880775023222`.
7. Immediately after the forced call returns (`880775510928`), diskHolds=1, fakeHolds=1, released=0. Both checks have saveFailed=false. The event-membership assertion passes, then the original disk assertion fails.

Green uses the identical compiled probe. The first fake reset occurs at `885631486550`; the release is installed after it at `885632267737`. The forced check receives held=0/released=1, writes and applies the release, refreshes balances, and leaves diskHolds=0. The final forced call takes the no-known-holds branch without another native read. The same ordering switch back to red produces the same failure in red-2.

The probe adds caller names, call IDs, monotonic timestamps, branches, native answers and write completion to Wallet, and a one-shot latch inside the fake. It changes no wallet decisions, disk writer, response validation, original assertions or bounds. `probe.patch`, `apply-probe.py`, `probe-runner.py` (natural batch), `proof-runner.py` (proof batch), and `probe-source-sha256.json` preserve the experiment. The green control is an ordering control, not a fix.

## Hypotheses resolved

| Hypothesis | Evidence and conclusion |
| --- | --- |
| Earlier event hides an early return | Event membership is indeed insufficient evidence, but **not the failing path reproduced**: both red forced calls enter native check and write. No session, pricing, restore or throttle return occurs. |
| Parse/require throws, caught without saving | No catch appears in either red target trace. Both answers contain a valid saved hold and no releases; coverage require passes. Writes return normally. |
| Separate writer has not saved yet | Ruled out for this failure. `SendLedger.writeEth:118` calls synchronous `writeDocument:163`. It saves, reads back, decodes/verifies, finishes the state-write marker, then publishes the ledger document (`:202-208`). `Store.stateBlob:182` and `saveStateBlob:198` are synchronized; save fsyncs the temporary file, renames and forces directories. The trace shows write completion before the disk read. |
| Fake's release update is lost | **Proven**, red/green/red. The normal reset overwrites the test's intervening assignment. |
| Fake builds a contradictory held/released answer | Additional feasible window: assign after the empty-release predicate but before serialization, yielding held=1/released=1. Static risk only; not required for this verdict. |

The real native core does not have this fake's update/reset structure. `core/mobile/eth_hold.go:789-813` removes a hold and appends its final result while holding `st.mu`. `EthHoldCheck:831-845` captures held state and the release queue, serializes them, and clears the queue under the same mutex. This source comparison supports a test-only fix; it is not a claim of an exhaustive native concurrency audit.

## Sibling sweep

All release assignments, forced-check calls and disk assertions in WalletEthHoldTest were inspected. SendWalletTest's 177 disk-read/reference sites were indexed in `send-disk-sites.txt` and checked by their operation/observation pattern; `send-sweep-index.txt` also records event waits and fault seams. No code was changed in either class.

| Site (WalletEthHoldTest unless named) | Finding / disposition for fix card |
| --- | --- |
| recheckReleasesSavesAndRefreshesThenStopsChecking, :266 | Proven release-reset race. Own the unlock-check ordering and preserve all assertions. |
| distressReleaseDoesNotRevealHiddenHistory, :334 | Same post-open assignment at :342. Current check-holds membership can refer to unlock; unchanged hidden history can pass even if the release was lost. Drain initial check, install release, require evidence of actual consumption/durable release before asserting hidden history unchanged. Preserve privacy assertions. |
| failedHoldSaveKeepsEthPausedEvenIfNativeHoldWasReleased, :351 | Same post-open assignment at :357 and late stateSaveFault installation. Can pass on an unchanged original hold without demonstrating a consumed native release plus failed save. Drain initial check before installing fault/release; assert native hold cleared / release consumed and intended failed write while saved guard remains. |
| holdChecksUseSixtySecondsAndAnExplicitForegroundCheck, :409 | **Observed sibling failure** at :420 in natural-02. Explicit test call can run before unlock check; test records checked=1, unlock check increments to 2, non-forced reconcile correctly throttles, assertion expects 1. Trace shows test then refresh then throttled reconcile. Drain unlock's check before changing clock or recording counts; don't relax counts or 60,000 ms. |
| changedOutcomeUpdatesOnlyExactNonceRowAndKeepsOtherTerminalGuards, :293; unchangedFinalDropSettlesAnUnknownSendButDoesNotOverrideATerminalOne, :310 | Release set before open. Safe from the demonstrated post-open overwrite. Explicit check waits behind any initial check; keep exact nonce/outcome assertions. |
| holdSavedAndRestoredBeforeStatusOrSigning :218; confirmedCancelHashSavesItsHoldEvenWithoutLandedAs :380; thrownOutcomeReadsStillSaveTheirNewNativeHolds :390 | Native outcome call and hold capture/write are awaited before disk reads. Not a StateFlow-only persistence wait. No same-shape defect found. |
| prepareAndSettle :450, assignments :465/:494; concurrent pricing tests :519-535 | Intentional pricing/status latch protocol; pricing blocks ordinary hold checks while native finality is queued. Keep this concurrency coverage. Route release scripting through any new synchronized fake API, without holding its mutex across existing pricing/status latches. The fallback assignment after pricing is another reason not to leave raw queue writes. |
| Other WalletEthHoldTest cases | No post-open release/reset or event-count/disk-completion shape found. Restore-failure cases may never enter native check, so do not make the generic open helper wait for one unconditionally. |
| SendWalletTest fixture :133/:366/:395; disk helpers :427 | Maps/queues are ConcurrentHashMap/ConcurrentLinkedQueue; timer reconciliation is held. It has no ethHoldCheck/released override and thus no direct twin of this fake queue reset. |
| SendWalletTest synchronous disk assertions (send, retry, status, reconcile) | Awaited wallet operation or explicit async completion before disk read; SendLedger publishes after durable save. Representative :726/:732, :912, :1091, :1448, :1667, :2404, :2580, :3147, :3591. No same cause found. |
| SendWalletTest waitForInitialTronResultRead :472; originalLiveResultUsesReleasePolicyToJournalAutomaticRetry :1243 | Waits combine event evidence with actual durable attempt state (:475, :1257). These are good patterns, not entry-event-only persistence barriers. |
| SendWalletTest direct mutation during suspended status :3568 | afterStatus latch plus concurrent answer map; both async calls are awaited before disk assertions (:3589-3592). Map update isn't followed by an unconditional queue reset. Preserve the schedule. |

## Sol fix packet

Title: Make ETH hold test scripting atomic and own the initial unlock check.
Routing: GPT-6.1 Sol xhigh implementation; test-only code changes; Critical review under board rules. Priority 4 unless the owner changes it.

Scope: `android/app/src/test/java/com/usdtwallet/app/WalletEthHoldTest.kt`. Product files are read-only context: Wallet.kt, SendLedger.kt, Store.kt, MobileCore.kt, core/mobile/eth_hold.go. SendWalletTest is a sibling check unless a new concrete defect is proven. No product hook is required for the demonstrated race.

1. Make the fake's release installation and the read/clear/serialize/reset transaction use one synchronization boundary. Prefer a private release queue plus a small `enqueueRelease`/snapshot API; do not merely add volatile, which cannot prevent a lost update. Keep holds/release snapshots consistent and use detached JSON where needed. Replace all direct released assignments/read assertions in this class. Do not hold this fake monitor while waiting on the existing pricing/status latches.
2. Add a narrow fixture helper for cases requiring the *initial* unlock check to finish. Install a check-entry latch before open; after that exact check has entered, acquire/release the wallet's existing signFence from the test to drain its save. Reflection to signFence already has precedent in SendWalletTest. Waiting for `check-holds` alone, or acquiring signFence without proving the scheduled check entered, is insufficient. Keep the wait at five seconds, release latches in finally, and use namedWait diagnostics. Do not change generic open for restore-failure/no-hold cases.
3. Use that helper before post-open release/fault scripting in the target, distress-release, and failed-hold-save cases, and before the clock/count baseline in the 60-second test. Preserve all existing asserts and add the missing actual-release/fault evidence described in the sweep. Never replace the target's disk assertion with polling: the forced call must already be durable when it returns.
4. Red-first tests: adapt the retained reset seam to overlap a release producer with the fake consumer. Require an update started while the consumer transaction is held to wait and then survive for the next check; the old unsynchronized fake must fail. Cover producer-before-check, producer-during-check, producer-after-check, and no-release orders, checking coherent held/released output and no lost/duplicate release. All waits bounded and cleanup in finally.
5. Add an ordering regression for the initial-check drain: hold unlock's first native check, run the preparation helper asynchronously, and prove the helper cannot finish or record the count/install the scripted release until that exact check/save is drained. Release and complete; retain the full target disk/pause/balance/no-repeat assertions. Include a delayed-unlock schedule for the 60-second test (explicit manual call otherwise runs first) with the original count assertions. Demonstrate the old helper/fake mutation red, fixed green, old mutation red, then remove the mutation.
6. Validate WalletEthHoldTest and SendWalletTest on real disk, repeat the target and timing test under controlled ordering, then run the standard two-phase full gate (no --no-durability-lane). All on large crpko-go boxes; include both AARs and pull artifacts. Do not raise bounds. Report any unrelated baseline red by name and preserve it.

Recipe from the repo root:

```sh
offbox run --remote --size large --template crpko-go \
  --include android/app/libs/core.aar --include android/app/libs/core-debug.aar \
  --pull tmp/unit-tests -- python3 scripts/run-unit-tests.py \
  --tests com.usdtwallet.app.WalletEthHoldTest --real-disk
```

For the sibling selection add `--tests com.usdtwallet.app.SendWalletTest`; for the full gate omit all `--tests` and `--real-disk`, retaining the default fast+disk phases.

Done when: deterministic mutation proof catches the lost update and late initial check; the target and three named sibling cases prove their intended operation with unchanged bounds/assertions; native pricing-concurrency tests remain covered; selected real-disk and full two-phase gates pass or explicitly account for unrelated reds; no probe remains. Workers do not commit or push.

## Review / evaluator handoff

- Probe removed: both scratch source files were restored byte-for-byte to their git base, the private driver removed, and the detached scratch worktree removed after evidence copy. Main `git status --short` is empty; base SHA unchanged. The patch is retained only as an inert research artifact under ignored tmp/.
- Searched current workflow/debugging/remote-compute rules and board wiki rules/testing/eth-holds. Relevant lessons: entry events don't prove completion; watcher/manual recovery needs explicit ownership; StateFlow publication is not universally a persistence barrier, but this ledger's synchronous write is one. No conflicting skill, watcher or live configuration changes are needed. No deployment, release, APK, funds, phone or outward messaging steps.
- Evaluator's later s3 remains untouched: add the requested OPEN baseline-flake entry for the original target, one explicitly named retry in other cards' gates until fixed, and create the Sol fix card from this packet. Include the observed timing sibling and the two weak-evidence siblings in that card. This research does not independently grant a retry waiver for the sibling.
EOF
cat > tmp/cards/150/verify-evidence.py <<'PY'
from pathlib import Path
import json,re,xml.etree.ElementTree as E
base=Path(__file__).resolve().parent
for label,rc in [('red-1',1),('green',0),('red-2',1)]:
    root=base/'proof'/label
    result=json.loads((root/'result.json').read_text())
    assert result['rc']==rc and result['tests']==1 and result['failures']==rc
    phase=result['phases']['fast']
    assert phase['backing_fs']['type']=='ext4' and phase['tmpdir']=='/tmp'
    xml=E.parse(next((root/'fast/xml').glob('*.xml'))).getroot()
    test=xml.find('testcase')
    assert test.get('name')=='recheckReleasesSavesAndRefreshesThenStopsChecking'
    if rc: assert test.find('failure').get('message')=='java.lang.AssertionError: expected:<0> but was:<1>'
    trace=xml.find('system-out').text
    assert ' catch ' not in trace and ' early ' not in trace
    installed=int(re.search(r't=(\d+) test installed',trace)[1])
    reset=int(re.search(r't=(\d+) fake reset',trace)[1])
    assert (installed < reset)==bool(rc)
    assert f'test forced returned diskHolds={rc}' in trace
    assert trace.count('write returned')==2
    assert ('no known holds' in trace)==(rc==0)
    print(f'{label}: rc={rc}, exact assertion/order/branch/write evidence verified')
print('Historical failure and natural sibling are retained separately; no full-gate or 200-run claim.')
PY
python3 tmp/cards/150/verify-evidence.py
mkdir -p tmp/cards/146; cat > tmp/cards/146/add-tests.py <<'PY'
from pathlib import Path
p=Path('android/app/src/main/java/com/usdtwallet/app/Wallet.kt')
s=p.read_text().replace('    private val swapWatchLock = Any()', '''    @Volatile internal var swapWatchPassFinishedHook: (() -> Unit)? = null
    @Volatile internal var swapStartingTakenHook: (() -> Unit)? = null
    @Volatile internal var swapBeforeRestoreHook: ((Boolean) -> Unit)? = null
    @Volatile internal var swapBeforeActiveCheckHook: ((Chain) -> Unit)? = null
    private val swapWatchLock = Any()''')
s=s.replace('                reconcileSwaps()\n', '                reconcileSwaps()\n                swapWatchPassFinishedHook?.invoke()\n',1)
s=s.replace('        swapStarting.add(q.chain)\n        try {','        swapStarting.add(q.chain)\n        try {\n        swapStartingTakenHook?.invoke()')
s=s.replace('            if (swapStarting.contains(c) || swapJobs[c]?.isActive == true) continue\n            reconcileIdleHook', '            swapBeforeActiveCheckHook?.invoke(c)\n            if (swapStarting.contains(c) || swapJobs[c]?.isActive == true) continue\n            reconcileIdleHook')
s=s.replace('private suspend fun restoreSavedEthSteps(home: HistoryWriter, owner: Any, epoch: Long): Boolean {\n', 'private suspend fun restoreSavedEthSteps(home: HistoryWriter, owner: Any, epoch: Long): Boolean {\n        swapBeforeRestoreHook?.invoke(false)\n')
s=s.replace('        return signFence.withLock {\n            if (swapStarting.contains(Chain.ETH)', '        return signFence.withLock {\n            swapBeforeRestoreHook?.invoke(true)\n            if (swapStarting.contains(Chain.ETH)')
p.write_text(s)
p=Path('android/app/src/test/java/com/usdtwallet/app/SwapWalletTest.kt');s=p.read_text()
idx=s.index('    private fun unlockKeepsTheHash(fail: Fail)')
tests=''
for point in ['BeforeRestore','UnderFence','ActiveCheck']:
 for timing in ['DuringPass','InDelay']:
  for fail in ['WRITE','SEAL']:
   tests+=f'    @Test fun refusedStartWake_{point}_{timing}_{fail}() =\n        unlockKeepsTheHash(Fail.{fail}, SkipPoint.{point}, {str(timing=="InDelay").lower()})\n\n'
helper='''    private enum class SkipPoint { BeforeRestore, UnderFence, ActiveCheck }

    /** Force the real first unlock pass to skip ETH, without driving reconcile or its clock. */
    private class RefusedStartSchedule(val w: Wallet, val point: SkipPoint, val inDelay: Boolean) {
        val starting = CountDownLatch(1)
        val skipped = CountDownLatch(1)
        val waiting = CountDownLatch(1)
        val releasePass = CountDownLatch(1)
        val first = AtomicBoolean(true)
        fun await(latch: CountDownLatch) = check(latch.await(5, TimeUnit.SECONDS)) { "refused-start schedule timed out: $point/$inDelay" }
        fun gate() {
            if (first.compareAndSet(true, false)) await(starting)
        }
        init {
            w.swapStartingTakenHook = {
                starting.countDown()
                await(if (inDelay) waiting else skipped)
            }
            w.swapBeforeRestoreHook = { underFence ->
                if (point == SkipPoint.BeforeRestore && !underFence || point == SkipPoint.UnderFence && underFence) gate()
            }
            w.swapBeforeActiveCheckHook = { c -> if (c == Chain.ETH && point == SkipPoint.ActiveCheck) gate() }
            w.swapWatchPassFinishedHook = {
                skipped.countDown()
                if (!inDelay) await(releasePass)
            }
            w.swapWatchDelay = { ms ->
                check(ms == 8_000L)
                waiting.countDown()
                kotlinx.coroutines.delay(ms)
            }
        }
        fun close() {
            starting.countDown()
            releasePass.countDown()
            w.swapStartingTakenHook = null
            w.swapBeforeRestoreHook = null
            w.swapBeforeActiveCheckHook = null
            w.swapWatchPassFinishedHook = null
        }
    }

'''
s=s[:idx]+tests+helper+s[idx:]
s=s.replace('private fun unlockKeepsTheHash(fail: Fail) {','private fun unlockKeepsTheHash(fail: Fail, point: SkipPoint? = null, inDelay: Boolean = false) {')
start=s.index('    private fun unlockKeepsTheHash(');end=s.index('\n    @Test',start)
chunk=s[start:end]
chunk=chunk.replace('        restoreStorage(fail)\n        unlockOk(w)', '        restoreStorage(fail)\n        val schedule = point?.let { RefusedStartSchedule(w, it, inDelay) }\n        try {\n        unlockOk(w)')
chunk=chunk.replace('        val prep = Prepared(','''        if (schedule != null) {
            assertEquals("the pass skipped ETH while the start guard was held", 0, core.events.count { it == "status" })
            schedule.releasePass.countDown()
        }
        val prep = Prepared(''')
chunk=chunk.replace('        assertEquals("step happened exactly once", 1, core.events.count { it == "step" })\n    }','''        assertEquals("step happened exactly once", 1, core.events.count { it == "step" })
        } finally { schedule?.close() }
    }''')
s=s[:start]+chunk+s[end:];p.write_text(s)
PY
python3 tmp/cards/146/add-tests.py
cp android/app/src/main/java/com/usdtwallet/app/Wallet.kt tmp/cards/146/Wallet-hooks-only.kt
cat > tmp/cards/146/run.py <<'PY'
from pathlib import Path
import subprocess, sys, json, os
os.environ.update(JAVA_HOME='/usr/lib/jvm/java-17-openjdk-amd64',ANDROID_HOME=str(Path.home()/'android-sdk'),ANDROID_SDK_ROOT=str(Path.home()/'android-sdk'))
mode=sys.argv[1]
root=Path.cwd();dest=root/'tmp/cards/146/runs'/mode;dest.mkdir(parents=True,exist_ok=True)
args=['--tests','com.usdtwallet.app.SwapWalletTest.refusedStartWake*']
rc=0
for lane in ['fast','disk']:
 cmd=[sys.executable,'scripts/run-unit-tests.py',*args,'--log-dir',str(dest/lane)]
 if lane=='disk':cmd+=['--real-disk']
 with (dest/(lane+'.log')).open('w') as out:r=subprocess.run(cmd,stdout=out,stderr=subprocess.STDOUT)
 result=json.loads((dest/lane/'result.json').read_text());print(lane,json.dumps(result),flush=True);rc=rc or r.returncode
sys.exit(rc)
PY
offbox run --template crpko-go --remote --include android/app/libs/core.aar --include android/app/libs/core-debug.aar --include tmp/cards/146/run.py --pull tmp/cards/146/runs/red -- python3 tmp/cards/146/run.py red
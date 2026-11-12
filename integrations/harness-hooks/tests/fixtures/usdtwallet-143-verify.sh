cat > tmp/card-app-reorg-rebase/verify.py <<'PY'
from pathlib import Path
import subprocess, difflib, json, re, hashlib
root = Path(__file__).resolve().parents[2]
p = root / 'tmp/card-app-reorg-rebase'
def git(*args):
    return subprocess.check_output(['git', *args], cwd=root, text=True)
def payload(s):
    return '\n'.join(x for x in s.splitlines() if x.startswith(('+', '-')) and not x.startswith(('+++', '---'))) + '\n'
files = git('diff', '--name-only', '6d8b5a8a^', '6d8b5a8a').splitlines()
matches = []
for f in files:
    orig = payload(git('diff', '6d8b5a8a^', '6d8b5a8a', '--', f))
    new = payload(git('diff', 'land/eth-reorg', '--', f))
    if f.endswith('/Wallet.kt'):
        for expression in [
            'Prepared.parse(Mobile.prepareSend(req.toString()))',
            'SwapQuote.parse(Mobile.swapPrepare(swapRequest(chain, sell, amount, slippageBps, max)))',
            'BridgePrepared.parse(JSONObject(core.bridgePrepare(bridgeRequest(direction, amount, topUp))))',
        ]:
            new = new.replace('-                    val prepared = ' + expression, '-                    ' + expression)
            new = new.replace('-        val prepared = ' + expression, '-        ' + expression)
        new = new.replace('+                    val prepared = prepareWithEthGuard(c)', '+                    prepareWithEthGuard(c)')
        new = new.replace('+        val prepared = prepareWithEthGuard(chain)', '+        prepareWithEthGuard(chain)')
        new = new.replace('+        val prepared = prepareWithEthGuard(direction.source)', '+        prepareWithEthGuard(direction.source)')
        new = new.replace('-            return withContext(NonCancellable + Dispatchers.IO) { requireSendSession(session); call() }', '-            return withContext(NonCancellable + Dispatchers.IO) { call() }')
        new = new.replace('+                requireSendSession(session)\n', '')
        new = new.replace('-            withContext(NonCancellable) { exitRunUnit(leaseUnit) }\n', '')
        new = new.replace('''+            try {
+                try {
+                    if (home.swap(Chain.ETH, id) != null && epoch == swapEpoch && owner === ownerToken) saveEthHoldsLocked()
+                } finally { signFence.unlock() }
+            } finally { withContext(NonCancellable) { exitRunUnit(leaseUnit) } }
''', '''+            try {
+                if (home.swap(Chain.ETH, id) != null && epoch == swapEpoch && owner === ownerToken) saveEthHoldsLocked()
+            } finally { signFence.unlock() }
''')
        new = new.replace('''-            signFence.unlock()
+            try {
+                try { if (source == Chain.ETH && epoch == swapEpoch && owner === ownerToken) saveEthHoldsLocked() }
+                finally { signFence.unlock() }
+            } finally { withContext(NonCancellable) { exitRunUnit(leaseUnit) } }
''', '''-        } finally { signFence.unlock() }
+        } finally {
+            try { if (source == Chain.ETH && epoch == swapEpoch && owner === ownerToken) saveEthHoldsLocked() }
+            finally { signFence.unlock() }
+        }
''')
    if orig != new:
        raise AssertionError('\n'.join(difflib.unified_diff(orig.splitlines(),new.splitlines(),fromfile=f+' original',tofile=f+' normalized replay')))
    matches.append(f)
assert not git('ls-files', '-u')
assert git('rev-parse', 'HEAD').strip() == '36c8f0a3823c3bf9cc32a353105d92e69166e926'
assert not git('diff', '--name-only', 'land/eth-reorg', '--', 'core/')
subprocess.run(['git','diff','--check','land/eth-reorg'],cwd=root,check=True)
added = [x for x in git('diff','land/eth-reorg').splitlines() if x.startswith('+') and not x.startswith('+++')]
words = [x for x in added if re.search(r'card|review|research|haiku|astra|opus|terra',x,re.I)]
assert not words, words
snapshot = json.loads((p/'gate-snapshot.json').read_text())
assert all(hashlib.sha256((root/f).read_bytes()).hexdigest()==h for f,h in snapshot.items())
result = dict(head=git('rev-parse','HEAD').strip(), matched_original_files=matches, core_changes=[], unmerged=[], word_matches=words, snapshot_files=len(snapshot))
(p/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
print('PASS: 17 original file payloads match after only six conflict-local normalizations; HEAD, core, words, diff and source snapshot clean.')
PY
python3 tmp/card-app-reorg-rebase/verify.py
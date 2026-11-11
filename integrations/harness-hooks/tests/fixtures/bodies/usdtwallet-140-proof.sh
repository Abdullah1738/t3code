#!/usr/bin/env bash
set -eu
root="$PWD"
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ANDROID_HOME="$HOME/android-sdk" ANDROID_SDK_ROOT="$HOME/android-sdk"
export PATH="$JAVA_HOME/bin:$PATH"
source_file=android/app/src/test/java/com/usdtwallet/app/BridgeRestartTest.kt
out="$root/tmp/card140/runs/proof"
mkdir -p "$out"
cp "$source_file" "$out/fixed.kt"
restore() { cd "$root"; cp "$out/fixed.kt" "$source_file"; }
trap restore EXIT
python3 scripts/run-unit-tests.py --tests com.usdtwallet.app.BridgeRestartTest.aSecondBridgeTrackedFirstStillLetsTheFirstBeTracked --log-dir "$out/fixed" > "$out/fixed.wrapper.log" 2>&1
cd "$root"
python3 - <<'PY'
from pathlib import Path
p = Path('android/app/src/test/java/com/usdtwallet/app/BridgeRestartTest.kt')
s = p.read_text()
old = '''        second.optString("state") == "arrived" && synchronized(tracks) {
            tracks.contains("0xfirst") && tracks.contains("0xsecond")
        }'''
assert s.count(old) == 1
p.write_text(s.replace(old, '        second.optString("state") == "arrived"'))
PY
set +e
python3 scripts/run-unit-tests.py --tests com.usdtwallet.app.BridgeRestartTest.aSecondBridgeTrackedFirstStillLetsTheFirstBeTracked --log-dir "$out/mutant" > "$out/mutant.wrapper.log" 2>&1
rc=$?
set -e
echo "MUTATION_RC=$rc"
[ "$rc" = 1 ]
python3 - "$out" <<'PY'
import sys, xml.etree.ElementTree as ET
from pathlib import Path
out=Path(sys.argv[1])
failures=[f for p in (out/'mutant').rglob('TEST-*.xml') for f in ET.parse(p).getroot().iter('failure')]
assert len(failures)==1, failures
assert 'second arrival alone must not complete the wait while first tracking is blocked' in failures[0].get('message',''), failures[0].attrib
print('MUTATION_EXPECTED_FAILURE_CONFIRMED')
PY
restore
cmp "$source_file" "$out/fixed.kt"
echo FIXED_SOURCE_RESTORED
cd "$root"
python3 scripts/run-unit-tests.py --tests com.usdtwallet.app.BridgeRestartTest --log-dir "$out/restored-class" > "$out/restored-class.wrapper.log" 2>&1
echo PROOF_GREEN

cat > /Users/ardud/worktrees/torssh-release-test/tmp/release-setup.6q14vS/tap.py <<'PY'
import sys,pathlib,subprocess,time,re,xml.etree.ElementTree as ET,uiautomator2 as u2
if (pathlib.Path.home()/'.local/share/phone-lock/priority-hold').exists():raise SystemExit('PHONE_BUSY')
subprocess.run(['/Users/ardud/.local/android/venv/bin/python','-I','/Users/ardud/worktrees/torssh-release-test/tmp/release-setup.6q14vS/unlock-phone.py'],check=True,stdout=subprocess.DEVNULL)
kind,label=sys.argv[1:3]
for attempt in range(2):
 try:
  d=u2.connect('002473611000997');nodes=list(ET.fromstring(d.dump_hierarchy()).iter('node'));break
 except Exception:
  if attempt:raise
  subprocess.run(['ph','ui'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
field='text' if kind=='text' else 'content-desc';nodes=[n for n in nodes if n.get(field)==label];assert nodes,'exact UI element absent';n=next((n for n in nodes if n.get('clickable')=='true'),nodes[0]);assert n.get('enabled')=='true','UI element disabled';b=list(map(int,re.findall(r'\d+',n.get('bounds'))));assert len(b)==4 and 0<=b[1]<b[3]<=2392
subprocess.run(['adb','-s','002473611000997','shell','input','tap',str((b[0]+b[2])//2),str((b[1]+b[3])//2)],check=True);time.sleep(.8);print('tapped exact '+kind+': '+label)
PY
/Users/ardud/.local/android/venv/bin/python -I /Users/ardud/worktrees/torssh-release-test/tmp/release-setup.6q14vS/tap.py text Settings
/Users/ardud/.local/android/venv/bin/python -I /Users/ardud/worktrees/torssh-release-test/tmp/release-setup.6q14vS/pin-input.py
python3 -I /Users/ardud/worktrees/torssh-release-test/tmp/release-setup.6q14vS/phone.py adb shell input keyevent KEYCODE_ENTER
python3 -I /Users/ardud/worktrees/torssh-release-test/tmp/release-setup.6q14vS/phone.py ui | head -18
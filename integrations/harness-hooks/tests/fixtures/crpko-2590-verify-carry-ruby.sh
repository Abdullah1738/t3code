cat > tmp/card-2590/verify_carry.py <<'PY'
from collections import Counter
from pathlib import Path
import subprocess,re,json

def git(*args):
    return subprocess.check_output(['git',*args],text=True)

def delta(args):
    return Counter(line for line in git('diff','-U0',*args,'--','binaries').splitlines() if line[:1] in ('+','-') and not line.startswith(('+++','---')))
source=delta(['2ea8fd22','01e3c120'])
carry=delta(['--cached','origin/native-v1'])
missing=list((source-carry).elements())
extra=list((carry-source).elements())
assert not missing and not extra,(missing,extra)
paths=['binaries/trading-core/'+f+'.md' for f in ['Contracts','Events','Lifecycle','TDD']]
assert sorted(git('diff','--cached','--name-only','origin/native-v1','--','binaries').splitlines())==sorted(paths)
tdd=Path(paths[-1]).read_text()
original=git('show','origin/native-v1:'+paths[-1])
assert '- ATT-026:' not in original and '- ATT-026:' not in tdd
for n in range(27,33):
    assert len(re.findall(r'^- ATT-'+str(n).zfill(3)+':',tdd,re.M))==1
assert not re.search(r'^(<<<<<<<|=======|>>>>>>>)',tdd,re.M)
# Reconstruct TDD solely from native-v1 plus exactly the packet's changed rows.
source_tdd=git('show','01e3c120:'+paths[-1])
for prefix in ['TWAP-012','ATT-004']:
    old=next(line for line in original.splitlines() if line.startswith('- '+prefix+':'))
    new=next(line for line in source_tdd.splitlines() if line.startswith('- '+prefix+':'))
    original=original.replace(old,new,1)
last=next(line for line in original.splitlines() if line.startswith('- ATT-025:'))
rows=[line for line in source_tdd.splitlines() if re.match(r'- ATT-0(27|28|29|30|31|32):',line)]
original=original.replace(last,last+'\n'+'\n'.join(rows),1)
assert original==tdd
report={'base':git('rev-parse','origin/native-v1').strip(),'source_additions':sum(v for k,v in source.items() if k.startswith('+')),'source_deletions':sum(v for k,v in source.items() if k.startswith('-')),'sorted_plus_minus':'exact match; no differing added/removed lines','ATT_026':'absent on both base and carry, context only in source patch','ATT_027_to_032':'present once each, exact source text','TDD':'native-v1 preserved except ATT-004, TWAP-012, six inserted rows','paths':paths}
Path('tmp/card-2590/diff-check.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
PY
python3 tmp/card-2590/verify_carry.py
LC_ALL=en_US.UTF-8 ruby -ryaml -rjson -e 'p="tmp/changelog/pending.yml"; actual=YAML.load(File.read(p)); base=YAML.load(`git show origin/native-v1:tmp/changelog/pending.yml`); added=JSON.parse(File.read("tmp/card-2590/changelog-entries.json")); added.each{|path, changes| base.fetch("files").find{|f| f["path"]==path}.fetch("changes").concat(changes)}; abort "unexpected YAML changes" unless actual==base; paths=actual.fetch("files").map{|f| f.fetch("path")}; abort "duplicate paths" unless paths.uniq==paths; abort "binary YAML" if File.read(p).match?(/!binary/); puts "YAML.load: exactly four intended additions, original entries preserved, no duplicate paths, no !binary"'
git add -f tmp/changelog/pending.yml
git diff --cached --check
git diff --cached --stat
python3 - <<'PY'
from pathlib import Path
import subprocess,os,json
results=[]
for p in sorted(Path('tmp/scripts').glob('audit_*.rb')):
    args=['ruby',str(p)]
    r=subprocess.run(args,env={**os.environ,'LC_ALL':'en_US.UTF-8'},text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    Path('tmp/card-2590/'+p.stem+'.log').write_text(r.stdout)
    results.append({'command':'LC_ALL=en_US.UTF-8 '+' '.join(args),'exit_code':r.returncode,'output':r.stdout.strip()})
    print(json.dumps(results[-1]),flush=True)
Path('tmp/card-2590/audits.json').write_text(json.dumps(results,indent=2)+'\n')
assert len(results)==6 and all(r['exit_code']==0 for r in results)
PY
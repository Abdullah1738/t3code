python3 - <<'PY'
from pathlib import Path
import subprocess
root=Path('/Volumes/ExternalSSD/crpko-devops')
for folder,base,patch in [('crypko-frontend','origin/main-dev','crypko-frontend-main-dev.patch'),('prototype-ui','origin/feat/prototype-ui','crypko-frontend-feat-prototype-ui.patch')]:
    repo=root/'tmp/card-2791'/folder
    expected=(root/'tmp/card-2779/upstream'/patch).read_text()
    diff=subprocess.check_output(['git','diff','--no-ext-diff','--','sst.config.ts'],cwd=repo,text=True)
    # git adds a function-context suffix to @@; the unified patch itself must match.
    actual='\n'.join(line.split('@@')[0]+'@@' if line.startswith('@@') else line for line in [])
    original=subprocess.check_output(['git','show',f'{base}:sst.config.ts'],cwd=repo,text=True)
    changed=(repo/'sst.config.ts').read_text()
    addition='    // Pulumi debug diagnostics stringify RPC responses, including secret values.\n    Object.assign($util.log, { debug: () => Promise.resolve() });\n\n'
    reconstructed=original.replace('  async run() {\n','  async run() {\n'+addition,1).replace('This must stay the first thing in run().','Keep this before resource creation.',1)
    assert changed==reconstructed
    files=subprocess.check_output(['git','diff','--name-only'],cwd=repo,text=True).splitlines()
    assert files==['sst.config.ts']
    assert changed.index('Object.assign($util.log')<changed.index('registerStackTransformation')<changed.index('new aws.Provider')
    print(folder+': exact approved edits, sole changed file, guard ordering passed')
PY
node tmp/card-2791/crypko-frontend/scripts/validate-qa-deploy.mjs
"""Install prebuilt diskless-reader artifacts during an approved deployment."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def run(args):
    root=Path(args.root).resolve();venv=root/'venv/redact-reader';python=venv/'bin/python'
    target=root/'bin/recall-restic-reader'
    if not args.check:
        binary=Path(args.binary).resolve();wheel=Path(args.wheel).resolve()
        if not binary.is_file() or not wheel.name.startswith('apsw-3.54.1.0-') or not wheel.is_file():
            raise ValueError('artifacts')
        if not python.is_file():
            subprocess.run([sys.executable,'-m','venv',str(venv)],check=True,capture_output=True)
        subprocess.run([str(python),'-m','pip','install','--no-index','--no-deps',str(wheel)],check=True,capture_output=True)
        target.parent.mkdir(parents=True,exist_ok=True)
        fd,name=tempfile.mkstemp(prefix='.reader-',dir=target.parent)
        try:
            with os.fdopen(fd,'wb') as output,binary.open('rb') as source:
                shutil.copyfileobj(source,output);output.flush();os.fchmod(output.fileno(),0o755);os.fsync(output.fileno())
            os.replace(name,target)
        finally:
            if os.path.exists(name):os.unlink(name)
    if not target.is_file() or not os.access(target,os.X_OK):raise ValueError('helper missing')
    subprocess.run([str(python),'-c','import apsw; assert apsw.apswversion()=="3.54.1.0"'],check=True,capture_output=True)
    return {'verify':True,'installed':0 if args.check else 2}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',required=True)
    parser.add_argument('--binary');parser.add_argument('--wheel');parser.add_argument('--check',action='store_true')
    args=parser.parse_args()
    try:print(json.dumps(run(args)))
    except Exception:
        print(json.dumps({'verify':False,'errors':1}));sys.exit(1)

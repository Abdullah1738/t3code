#!/usr/bin/python3
import sys
from pathlib import Path
# Isolated mode deliberately ignores PYTHONPATH and the current directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
if sys.argv[1:2] == ['poll']:
    from poller import poll
    raise SystemExit(poll())
if sys.argv[1:2] == ['rollup']:
    from rollup import main
    del sys.argv[1]
    main()
else:
    raise SystemExit('usage: run.py poll|rollup')

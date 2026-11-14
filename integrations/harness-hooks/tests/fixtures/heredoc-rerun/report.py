import json
from pathlib import Path
import sys
import urllib.request

credential = json.loads(Path(sys.argv[1]).read_text())
with urllib.request.urlopen('http://127.0.0.1:1/api/ardud/control/install-report') as response:
    print(json.dumps(json.load(response)))

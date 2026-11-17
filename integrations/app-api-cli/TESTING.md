# Python fixtures

Run Python fixtures offbox from this directory. The logger suite replays the
Minutes checkout fixture with real RSA encryption, so it needs `cryptography`
even though the logger itself uses only the standard library. Install the pinned
test dependency in a temporary virtual environment:

```sh
offbox run -- 'set -eu
fixture_root=$(mktemp -d)
python3 -m venv "$fixture_root/venv"
"$fixture_root/venv/bin/python" -m pip install -r test/requirements.txt
export PATH="$fixture_root/venv/bin:$PATH"
export TOOLLOG_ROOT="$fixture_root/logs" ROBOB_TOOL_LOG_DIR="$fixture_root/logs"
export PYTHONPATH=.:capture
python3 -B -m unittest discover -s test -p "test_toollog*.py"'
```

Use discovery from this directory: the lane fixtures import sibling test modules
by name. A missing dependency is a failed setup, not a reason to skip a lane or
replace its encryption with a stub.

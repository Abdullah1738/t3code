"""Reject shared MCP startup paths that require a mounted volume."""
import json
from pathlib import Path
import plistlib
import subprocess


def internal_path(path):
    path = Path(path)
    for candidate in (path, path.resolve()):
        if candidate.is_relative_to('/Volumes'):
            raise ValueError(f'shared MCP runtime must not read /Volumes/: {path}')
    return path


def validate_plist(path, *, require_interpreter=False):
    data = plistlib.loads(Path(path).read_bytes())
    args = data['ProgramArguments']
    for arg in args:
        if arg.startswith('/'):
            internal_path(arg)
    interpreter = internal_path(args[0])
    config = interpreter.parent.parent / 'pyvenv.cfg'
    internal_path(config)
    if config.exists():
        for line in config.read_text().splitlines():
            key, sep, value = line.partition('=')
            if sep and key.strip() in ('home', 'executable'):
                internal_path(value.strip())
    if require_interpreter and not interpreter.is_file():
        raise ValueError(f'shared MCP interpreter missing: {interpreter}')
    return interpreter


def validate_inbody(interpreter):
    internal_path(interpreter)
    # -I ignores user packages and PYTHONPATH, as the service should not need either.
    result = subprocess.run([str(interpreter), '-I', '-c', '''
import json, sys
import inbody_api_mcp.server
print(json.dumps([sys.executable, sys.prefix, sys.base_prefix, *sys.path,
    *(m.__file__ for m in tuple(sys.modules.values()) if getattr(m, '__file__', None))]))
'''], check=True, capture_output=True, text=True, timeout=30)
    for path in json.loads(result.stdout):
        internal_path(path)

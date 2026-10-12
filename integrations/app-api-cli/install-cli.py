#!/usr/bin/env python3
"""Install the delivery account, email and opt-in Dia CLI launchers after deployment."""
import os
from pathlib import Path

HOME = Path.home()
MARKER = '# app-api-cli managed launcher\n'
COMMANDS = {'talabat-auth': 'talabat_auth.py', 'amazon-orders': 'amazon_email_orders.py',
            'amazon-browser-orders': 'amazon_dia_cli.py'}
HELPERS = ('amazon_browser_orders.py', 'amazon_dia_transport.mjs')


def main():
    root = HOME / '.local/share/app-api-cli'
    python = HOME / '.local/share/uv/tools/mitmproxy/bin/python'
    target = HOME / '.local/bin'
    if not python.is_file():
        raise SystemExit('Capture Python environment is missing')
    for module in HELPERS:
        if not (root / module).is_file():
            raise SystemExit(f'Deploy {module} before installing launchers')
    for name, module in COMMANDS.items():
        if not (root / module).is_file():
            raise SystemExit(f'Deploy {module} before installing launchers')
        path = target / name
        if path.is_symlink() or (path.exists() and MARKER not in path.read_text()):
            raise SystemExit(f'Refusing to overwrite unmanaged launcher: {path}')
    target.mkdir(parents=True, exist_ok=True)
    for name, module in COMMANDS.items():
        path = target / name
        temp = target / f'.{name}.{os.getpid()}.tmp'
        with temp.open('x') as output:
            output.write('#!/bin/sh\n' + MARKER +
                         'exec "$HOME/.local/share/uv/tools/mitmproxy/bin/python" '
                         f'"$HOME/.local/share/app-api-cli/{module}" "$@"\n')
        temp.chmod(0o755)
        temp.replace(path)
        print(path)


if __name__ == '__main__':
    main()

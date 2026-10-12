#!/usr/bin/env python3
"""Install only the native commerce launcher after source deployment."""
from pathlib import Path
import os


def main():
    home=Path.home()
    module=home/'.local/share/app-api-cli/commerce_cli.py'
    python=home/'.local/share/uv/tools/mitmproxy/bin/python'
    target=home/'.local/bin/commerce'
    marker='# app-api-cli managed commerce launcher\n'
    if not module.is_file() or not python.is_file():
        raise SystemExit('Deploy commerce source first')
    if target.is_symlink() or target.exists() and marker not in target.read_text():
        raise SystemExit('Refusing unmanaged commerce launcher')
    temporary=target.parent/f'.commerce.{os.getpid()}.tmp'
    with temporary.open('x') as out:
        out.write('#!/bin/sh\n'+marker+'exec "$HOME/.local/share/uv/tools/mitmproxy/bin/python" '
                  '"$HOME/.local/share/app-api-cli/commerce_cli.py" "$@"\n')
    temporary.chmod(0o755);temporary.replace(target)
    print(target)


if __name__=='__main__':main()

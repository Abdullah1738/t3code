"""Shared-phone priority gate and redacted navigation for diagnostic work."""
import os
from pathlib import Path
import re
import subprocess
import sys
import time

HOLD = Path.home()/'.local/share/phone-lock/priority-hold'
SERIAL = '002473611000997'


def held():
    try: age = time.time()-HOLD.stat().st_mtime
    except FileNotFoundError: return False
    if age >= 2700:
        print('Stale priority hold (>45 minutes); left in place', file=sys.stderr)
        return False
    return True


def check():
    if held(): raise SystemExit('Priority phone hold; no phone command sent')


def redact(text):
    text = re.sub(r'AIza[A-Za-z0-9_-]+', '[redacted api key]', text)
    text = re.sub(r'eyJ[A-Za-z0-9_.-]+', '[redacted token]', text)
    text = re.sub(r'(?<!\d)(?:\d[ -]?){12,19}(?!\d)', '[redacted number]', text)
    text = re.sub(r'(?i)((?:mastercard|visa|amex|card|rain)[^\n]{0,25}?)(\d{4})', r'\1****', text)
    return text


def main():
    # Every individual command gets another hold check. Arguments are a JSON array
    # on stdin to support a short multi-step navigation batch without a shell.
    import json
    for command in json.load(sys.stdin):
        check()
        if command[0] == 'adb': command = ['adb','-s',SERIAL,*command[1:]]
        elif command[0] != 'ph': raise SystemExit('Only adb/ph navigation supported')
        result = subprocess.run(command, capture_output=True, text=True, timeout=50,
                                env={**os.environ,'PH_SERIAL':SERIAL})
        print(redact(result.stdout), end='', flush=True)
        if result.returncode:
            print(redact(result.stderr), file=sys.stderr)
            raise SystemExit(result.returncode)


if __name__ == '__main__': main()

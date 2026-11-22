"""Bounded host metadata. Short wire keys keep poll additions below 120 bytes."""
import json
import os
import re
import subprocess
import sys
import time

ERRORS = {'timeout', 'missing', 'garbage', 'command', 'unsupported', 'error'}


def clean_host(value):
    if not isinstance(value, dict):
        return {}
    result = {}
    for key in ('l1', 'l5', 'l15', 'c', 'f', 'a', 'p'):
        number = value.get(key)
        if type(number) not in (int, float) or not 0 <= number <= 2**50:
            continue
        if key.startswith('l'):
            if number <= 999999:
                result[key] = round(number, 2)
        elif type(number) is int and number <= (2**50 if key in ('f', 'a') else 65536 if key == 'c' else 4):
            if key != 'p' or number in (1, 2, 4):
                result[key] = number
    if isinstance(value.get('e'), str) and value['e'] in ERRORS:
        result['e'] = value['e']
    # Keep even malformed/extreme metadata within the poll row budget.
    for key in ('a', 'f'):
        if len(json.dumps({'props': {'host': result}}, separators=(',', ':')).encode()) - 1 <= 120:
            break
        result.pop(key, None)
    return result


def poll_props(value, at_ms):
    props = dict(host=clean_host(value), hostAtMs=int(at_ms))
    for key in ('a', 'f', 'l15', 'l5'):
        if len(json.dumps({'props': props}, separators=(',', ':')).encode()) - 1 <= 120:
            break
        props['host'].pop(key, None)
    return props


class Sampler:
    # Start/end observations share one budget, including failed commands.
    def __init__(self):
        self.remaining = 1.75

    def __call__(self):
        host = {}
        try:
            host.update(zip(('l1', 'l5', 'l15'), os.getloadavg()))
            host['c'] = os.cpu_count() or 1
            if sys.platform != 'darwin':
                host['e'] = 'unsupported'
                return clean_host(host)
            def command(args):
                if self.remaining <= 0:
                    raise subprocess.TimeoutExpired(args, 0)
                started = time.monotonic()
                try:
                    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                            stderr=subprocess.DEVNULL, text=True, timeout=self.remaining)
                finally:
                    self.remaining = max(0, self.remaining - (time.monotonic() - started))
                if result.returncode:
                    raise RuntimeError('command')
                return result.stdout
            pressure = command(['/usr/sbin/sysctl', '-n', 'kern.memorystatus_vm_pressure_level']).strip()
            if pressure not in ('1', '2', '4'):
                raise ValueError('pressure')
            host['p'] = int(pressure)
            memory = command(['/usr/bin/vm_stat'])
            size = re.search(r'page size of (\d+) bytes', memory)
            pages = {key: re.search(r'^Pages ' + key + r':\s+(\d+)\.\s*$', memory, re.M)
                     for key in ('free', 'inactive')}
            if not size or not all(pages.values()) or int(size[1]) not in (4096, 16384):
                raise ValueError('memory')
            host['f'] = int(pages['free'][1]) * int(size[1])
            # Inactive pages are reclaimable; this is an estimate, not a macOS counter.
            host['a'] = host['f'] + int(pages['inactive'][1]) * int(size[1])
        except subprocess.TimeoutExpired:
            host['e'] = 'timeout'
        except FileNotFoundError:
            host['e'] = 'missing'
        except ValueError:
            host['e'] = 'garbage'
        except RuntimeError:
            host['e'] = 'command'
        except Exception:
            host['e'] = 'error'
        return clean_host(host)

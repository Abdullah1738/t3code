python3 - <<'PY'
from pathlib import Path
p=Path('integrations/robob-watch/checks/money-cases/charges.py')
s=p.read_text().replace("STATE_DB = Path(os.environ.get('MONEY_CASES_STATE_DB', '~/.robob/userdata/statev2.sqlite')).expanduser()", "# Robob's server-owned read replica, never the live statev2 (a long read here\n# stalled Robob's writer for 80 s on 7 Nov 2026).\nSTATE_DB = Path(os.environ.get('MONEY_CASES_STATE_DB', '~/.robob/userdata/readonly/state.sqlite')).expanduser()")
start=s.index('    try:\n        done = subprocess.run(cmd',s.index('def search('));end=s.index("    # split on",start)
s=s[:start]+"    done = msgs(cmd, deadline, 15, memo, stats)\n"+s[end:]
s=s.replace('def search(query, since, until=None, source=None, n=20, deadline=None):','def search(query, since, until=None, source=None, n=20, deadline=None, memo=None, stats=None):')
pos=s.index('\ndef day(')
s=s[:pos]+'''
def msgs(argv, deadline, cap, memo=None, stats=None):
    key = tuple(argv)
    if memo is not None and key in memo:
        result = memo[key]
        if isinstance(result, Lookup):
            raise result
        return result
    timeout = left(deadline, cap)
    if stats is not None:
        stats['msgs_calls'] += 1
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        if done.returncode:
            raise Lookup(f'msgs exit {done.returncode}: {done.stderr.strip()[:200]}')
    except (OSError, subprocess.TimeoutExpired, Lookup) as e:
        error = e if isinstance(e, Lookup) else Lookup(f'msgs: {e}')
        if memo is not None:
            memo[key] = error
        raise error from e
    if memo is not None:
        memo[key] = done
    return done

''' +s[pos:]
s=s.replace('def owner_texts(since, until, deadline=None):','def owner_texts(since, until, deadline=None, stats=None):')
s=s.replace('    left(deadline, 5)\n',"    budget = left(deadline, 4)\n    stop = time.time() + min(4, budget - (0.5 if deadline is not None else 0))\n")
s=s.replace("uri=True, timeout=2)","uri=True, timeout=1)")
s=s.replace('        try:\n            rows = db.execute(',"        try:\n            db.set_progress_handler(lambda: int(time.time() >= stop), 10000)\n            if stats is not None:\n                stats['owner_queries'] += 1\n            rows = db.execute(")
s=s.replace("    except sqlite3.Error as e:\n        raise Lookup(f'Robob state: {e}') from e", "    except sqlite3.Error as e:\n        if isinstance(e, sqlite3.OperationalError) and 'interrupted' in str(e):\n            raise Lookup('Robob state: query over time') from e\n        raise Lookup(f'Robob state: {e}') from e")
start=s.index('def show(');end=s.index('\n\ndef amount_pattern',start)
s=s[:start]+'''def show(row, deadline=None, memo=None, stats=None):
    """The whole mail for a search row (msgs show)."""
    try:
        return msgs([MSGS, 'show', str(row['id'])], deadline, 10, memo, stats).stdout
    except KeyError as e:
        raise Lookup(f'msgs show: {e}') from e
'''+s[end:]
s=s.replace('def receipt(charge, at, now, find=None, deadline=None, read=None):','def receipt(charge, at, now, find=None, deadline=None, read=None, memo=None, stats=None):')
s=s.replace('    find, read = find or search, read or show\n',"    find = find or (lambda *a, **kw: search(*a, **kw, memo=memo, stats=stats))\n    read = read or (lambda row, deadline: show(row, deadline, memo=memo, stats=stats))\n",1)
s=s.replace('def found(charge, at, now, deadline=None, find=None, said=None, errors=None):','def found(charge, at, now, deadline=None, find=None, said=None, errors=None, memo=None, stats=None):')
s=s.replace('row = receipt(charge, at, now, find, deadline)','row = receipt(charge, at, now, find, deadline, memo=memo, stats=stats)')
p.write_text(s)
PY
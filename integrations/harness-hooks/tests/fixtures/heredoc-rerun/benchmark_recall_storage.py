"""Compare historical and current indexers on synthetic catch-up; run offbox.

--baseline is recall_storage.py exported by git show. All databases are temporary.
The fixture has 200k source rows, a half-built hot index, mostly delete/reinsert
journal traffic and repeated updates to indexed rows. No transcript data is used.
"""
import argparse
from contextlib import closing
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import recall_storage as current
from test_recall_storage import SCHEMA


def load_baseline(path):
    spec = importlib.util.spec_from_file_location('baseline_storage', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rows(start, stop):
    for i in range(start, stop):
        content = ('command response fixture source line ' + str(i) + ' ') * (2 + i % 140)
        yield (i, 'opencode', 'session-' + str(i // 200), 'turn-' + str(i),
               1700000000 + i, 'assistant', content,
               'text' if i % 3 == 0 else 'tool_result', 'model', 1, '{}', None)


def digest(path):
    result = {}
    with closing(sqlite3.connect(path)) as con:
        for table in ('episodic_events', 'episodic_text_fts'):
            h = hashlib.sha256()
            for row in con.execute(f'SELECT rowid,* FROM {table} ORDER BY rowid'):
                h.update(repr(row).encode())
            result[table] = h.hexdigest()
        for table in ('episodic_fts', 'episodic_text_fts'):
            # Exact positions are covered by the rebuild-equivalence tests;
            # compare term/document counts here without sorting 100M positions.
            con.execute(f'CREATE VIRTUAL TABLE temp.vocab USING fts5vocab(main,{table},row)')
            h = hashlib.sha256()
            for row in con.execute('SELECT * FROM vocab ORDER BY term'):
                h.update(repr(row).encode())
            result[table + '_tokens'] = h.hexdigest()
            con.execute('DROP TABLE temp.vocab')
    return result


def benchmark(baseline, count=200000, pause=0):
    if count < 200000:
        raise ValueError('benchmark requires at least 200k rows')
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        cold, seed = root / 'cold.db', root / 'seed.db'
        with closing(sqlite3.connect(cold)) as con, con:
            con.executescript(SCHEMA)
            con.executemany('INSERT INTO episodic_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', rows(1, count + 1))
            current.install_change_journal(con)
        seeded = current.build_index(cold, seed, max_rows=count // 2, seconds=600)
        assert seeded['last_id'] == count // 2, seeded
        with closing(sqlite3.connect(cold)) as con, con:
            con.execute('DELETE FROM episodic_events WHERE id%2=0')
            con.executemany('INSERT INTO episodic_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', rows(count+1, count+count//2+1))
            for repeat in range(3):
                con.execute("UPDATE episodic_events SET content=content || ? WHERE id<=2000 AND id%2=1", (f' update{repeat}',))
        results = {}
        for name, module in [('old', baseline), ('new', current)]:
            hot = root / (name + '.db')
            with closing(sqlite3.connect(seed)) as source, closing(sqlite3.connect(hot)) as target:
                source.backup(target)
            started = time.monotonic()
            stats = module.build_index(cold, hot, max_rows=count * 4, seconds=600)
            elapsed = time.monotonic() - started
            assert stats['caught_up'], stats
            results[name] = dict(seconds=elapsed, ids_per_second=(stats['last_id']-seeded['last_id'])/elapsed,
                                 journal_per_second=stats['change_seq']/elapsed, stats=stats)
            print(json.dumps(dict(phase=name, **results[name]), sort_keys=True), flush=True)
        assert digest(root/'old.db') == digest(root/'new.db'), 'projection differs from baseline'
        ratio = results['old']['seconds'] / results['new']['seconds']
        print(json.dumps(dict(rows=count, speedup=ratio, results=results), sort_keys=True), flush=True)
        assert ratio >= 2, f'{ratio:.2f}x speedup, expected >=2x'
        assert results['new']['ids_per_second'] >= 2*97
        assert results['new']['journal_per_second'] >= 2*188
        hot = root / 'bounded.db'
        with closing(sqlite3.connect(seed)) as source, closing(sqlite3.connect(hot)) as target:
            source.backup(target)
        started = time.monotonic()
        rounds = 0
        while True:
            stats = current.build_index(cold, hot, max_rows=5000, seconds=2)
            rounds += 1
            if stats['caught_up']:
                break
            # Optional real wait represents the catalog allowance plus the
            # server's backlog retry interval, without opening any live catalog.
            time.sleep(pause)
        elapsed = time.monotonic() - started
        ids = (stats['last_id'] - seeded['last_id']) / elapsed
        changes = stats['change_seq'] / elapsed
        print(json.dumps(dict(phase='bounded', rounds=rounds, pause=pause, seconds=elapsed,
                              ids_per_second=ids, journal_per_second=changes)), flush=True)
        assert digest(root/'new.db') == digest(hot), 'bounded projection differs'
        assert ids >= 2*97 and changes >= 2*188, 'bounded refresh cannot sustain 2x source'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--rows', type=int, default=200000)
    parser.add_argument('--pause', type=float, default=0, help='seconds between bounded calls (catalog + cadence)')
    args = parser.parse_args()
    benchmark(load_baseline(args.baseline), args.rows, args.pause)

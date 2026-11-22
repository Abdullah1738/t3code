"""Replay routing metadata from a supplied day file without changing live rollups."""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rollup import rollup


def replay(source, day):
    counts = Counter()
    with tempfile.TemporaryDirectory(prefix='routing-replay-') as tmp:
        with (Path(tmp)/(day+'.ndjson')).open('w') as output, Path(source).open() as lines:
            for line in lines:
                row = json.loads(line)
                if row.get('tool') == '9router' and isinstance(row.get('name'), str) and row['name'].startswith('proxy.'):
                    counts[row['name']] += 1
                    output.write(line)
        result = rollup(day, tmp)
        assert result['malformed'] == 0, result['malformed']
        for section, name in [('stickyMoves','proxy.sticky_miss'),('fallbacks','proxy.fallback')]:
            assert result[section]['count'] == counts[name] == result['countsByName'].get(name, 0)
            assert sum(result[section]['byReason'].values()) == counts[name]
        return {key:result[key] for key in ('day','countsByName','stickyMoves','fallbacks')}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('--day', required=True)
    args = parser.parse_args()
    print(json.dumps(replay(args.source,args.day),indent=2))

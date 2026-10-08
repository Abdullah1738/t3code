"""Local, projected notification journal and delivery reconciliation ledger."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time

ROOT = Path(os.environ.get('DELIVERY_STORE', str(Path.home() / '.local/state/order-tracker')))
PACKAGES = {'com.talabat': 'talabat', 'com.noon.buyerapp': 'noon',
            'com.careem.acma': 'careem', 'com.amazon.mShop.android.shopping': 'amazon'}


def connect():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(ROOT / 'delivery.sqlite', timeout=10)
    (ROOT / 'delivery.sqlite').chmod(0o600)
    db.row_factory = sqlite3.Row
    db.executescript('''
      CREATE TABLE IF NOT EXISTS pushes (
        key TEXT PRIMARY KEY, app TEXT, posted REAL, detected REAL, text TEXT, ids TEXT);
      CREATE TABLE IF NOT EXISTS health (source TEXT PRIMARY KEY, checked REAL, ok INTEGER, detail TEXT);
      CREATE TABLE IF NOT EXISTS reconciliation (
        app TEXT, order_id TEXT, placed TEXT, detected TEXT, source TEXT,
        evidence_time TEXT, reported TEXT, report_note TEXT, asked TEXT,
        PRIMARY KEY(app, order_id));
    ''')
    return db


def clean_env():
    return {k: v for k, v in os.environ.items() if not k.startswith('BUN_INSPECT')}


def parse_pushes(dump, now=None):
    now = now or time.time()
    for block in re.split(r'(?=NotificationRecord\()', dump.split('Historical notifications:')[0]):
        pkg = re.search(r'pkg=([\w.]+)\b', block[:600])
        if not pkg or pkg[1] not in PACKAGES:
            continue
        ts = re.search(r'\b(?:postTime|when)=(\d{13})', block)
        if not ts or int(ts[1]) / 1000 > now + 120:
            continue
        fields = re.findall(r'android\.(?:title|text|bigText)=\w+ \((.*)\)', block)
        text = ' '.join(dict.fromkeys(fields)).strip()
        if not text:
            continue
        # Project only recognizable order IDs, never intents/tokens/raw extras.
        ids = sorted(set(re.findall(r'(?<![A-Za-z0-9])(?:\d{3}-\d{7}-\d{7}|\d{8,12}|[IN][A-Z0-9]{12,24})(?![A-Za-z0-9])', block)))
        posted = int(ts[1]) / 1000
        key = hashlib.sha256(f'{pkg[1]}|{posted}|{text}'.encode()).hexdigest()
        yield (key, PACKAGES[pkg[1]], posted, now, text[:1500], json.dumps(ids))


def collect():
    now = time.time()
    with connect() as db:
        if (Path.home() / '.local/share/phone-lock/priority-hold').exists():
            db.execute('INSERT OR REPLACE INTO health VALUES (?,?,?,?)',
                       ('phone', now, 0, 'priority_hold'))
            return
        try:
            p = subprocess.run(['adb', '-s', '002473611000997', 'shell', 'dumpsys', 'notification', '--noredact'],
                               capture_output=True, text=True, timeout=12, env=clean_env())
            if p.returncode or 'Notification' not in p.stdout:
                raise RuntimeError('phone_disconnected_or_dump_unavailable')
            db.executemany('INSERT OR IGNORE INTO pushes VALUES (?,?,?,?,?,?)', parse_pushes(p.stdout, now))
            db.execute('DELETE FROM pushes WHERE posted < ?', (now - 30*86400,))
            db.execute('INSERT OR REPLACE INTO health VALUES (?,?,?,?)', ('phone', now, 1, 'ok'))
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as e:
            db.execute('INSERT OR REPLACE INTO health VALUES (?,?,?,?)', ('phone', now, 0, type(e).__name__))


def evidence(cfg, classifier, single=False):
    placed = dt.datetime.fromisoformat(cfg['placed_at'].replace('Z', '+00:00')).timestamp()
    out, errors = [], []
    with connect() as db:
        health = db.execute('SELECT * FROM health WHERE source="phone"').fetchone()
        if not health or time.time() - health['checked'] > 90:
            errors.append('notification_collector_stale')
        elif not health['ok']:
            errors.append('notifications_' + health['detail'])
        for row in db.execute('SELECT * FROM pushes WHERE app=? AND posted>=? ORDER BY posted', (cfg['app'], placed)):
            exact = cfg['order'] in json.loads(row['ids'])
            stage = classifier(row['text'])
            if stage == 'unknown':
                continue
            # Ambiguous pushes still wake a verifier rather than disappearing.
            # Bound association to checkout's delivery window, never old orders.
            eta = dt.datetime.fromisoformat(cfg['eta']).timestamp() if cfg.get('eta') else placed + 7200
            if not exact and not (placed <= row['posted'] <= eta + 1800):
                continue
            iso = lambda n: dt.datetime.fromtimestamp(n, dt.timezone.utc).isoformat()
            out.append({'stage': stage, 'source': 'android_notification_journal',
                        'observed_at': iso(row['posted']), 'detected_at': iso(row['detected']),
                        'confidence': 'exact_order' if exact else ('single_active_app_unconfirmed' if single else 'app_unassigned_unconfirmed'),
                        'evidence': row['text'][:500]})
    return out, errors


def reconcile(cfg, detected=None, source=None, evidence_time=None, reported=None, note=None, asked=None):
    with connect() as db:
        db.execute('INSERT OR IGNORE INTO reconciliation(app,order_id,placed) VALUES (?,?,?)',
                   (cfg['app'], cfg['order'], cfg['placed_at']))
        for key, value in [('detected', detected), ('source', source), ('evidence_time', evidence_time),
                           ('reported', reported), ('report_note', note), ('asked', asked)]:
            if value is not None:
                # Preserve the first machine detection. Human corrections can replace reports.
                expr = f'COALESCE({key},?)' if key in ('detected', 'source', 'evidence_time', 'asked') else '?'
                db.execute(f'UPDATE reconciliation SET {key}={expr} WHERE app=? AND order_id=?',
                           (value, cfg['app'], cfg['order']))
        row = dict(db.execute('SELECT * FROM reconciliation WHERE app=? AND order_id=?',
                              (cfg['app'], cfg['order'])).fetchone())
    row['gap_seconds'] = ((dt.datetime.fromisoformat(row['detected']) - dt.datetime.fromisoformat(row['reported'])).total_seconds()
                          if row['detected'] and row['reported'] else None)
    return row


def health_check():
    with connect() as db:
        row = db.execute('SELECT * FROM health WHERE source="phone"').fetchone()
        if not row or time.time() - row['checked'] > 120:
            raise RuntimeError('notification collector is stale; restart com.ardud.delivery-notifications')
        if not row['ok']:
            raise RuntimeError('notification collection unavailable: ' + row['detail'])


if __name__ == '__main__':
    import sys
    if '--health' in sys.argv:
        health_check()
    else:
        collect()

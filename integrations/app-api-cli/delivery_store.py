"""Local, projected notification journal and delivery reconciliation ledger."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import tempfile
import time

import toollog

ROOT = Path(os.environ.get('DELIVERY_STORE', str(Path.home() / '.local/state/order-tracker')))
PHONE_LOCK = Path.home() / '.local/share/phone-lock'
HOLD_MAX_S = 3600
HOLD_ALERT_S = 900
HOLD_DETAILS = {'deferred_priority_hold', 'priority_hold_stale'}
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


def hold_state(now=None):
    now = time.time() if now is None else now
    hold = PHONE_LOCK / 'priority-hold'
    try:
        metadata = hold.lstat()
    except FileNotFoundError:
        return None
    owner = ''
    try:
        # Every hold entry blocks collection, including dangling symlinks and
        # special files. Only regular files have safe-to-read owner metadata.
        if stat.S_ISREG(metadata.st_mode):
            with hold.open() as stream:
                owner = stream.readline().strip()
    except (OSError, UnicodeError):
        # Unreadable owner metadata must never permit phone access.
        owner = ''
    age = max(0, now - metadata.st_mtime)
    state = {'state': 'live', 'owner': owner[:120],
             'reason': 'no_matching_lease_within_bound', 'age_s': int(age),
             'lease_expires_at': None, 'pid': None}
    try:
        lease = json.loads((PHONE_LOCK / 'lease.json').read_text())
    except (OSError, ValueError):
        lease = None
    expiry = None
    if owner and isinstance(lease, dict) and lease.get('owner') == owner:
        expires = lease.get('expires_at')
        if isinstance(expires, str):
            try:
                parsed = dt.datetime.fromisoformat(expires.replace('Z', '+00:00'))
                if parsed.tzinfo is not None:
                    expiry = parsed.timestamp()
                    state['lease_expires_at'] = expires
            except (ValueError, OverflowError):
                pass
        pid = lease.get('pid')
        if type(pid) is int and 0 < pid <= 2147483647:
            state['pid'] = pid
    if age > HOLD_MAX_S:
        state.update(state='stale', reason='hold_older_than_60m')
    elif expiry is not None and state['pid'] is not None:
        # Partial or malformed leases cannot establish holder liveness.
        state['reason'] = 'lease_live'
        if expiry <= now:
            state.update(state='stale', reason='lease_expired')
        else:
            try:
                os.kill(state['pid'], 0)
            except ProcessLookupError:
                state.update(state='stale', reason='holder_pid_dead')
            except PermissionError:
                pass
    return state


def log_hold_transition(previous, hold):
    detail = ('deferred_priority_hold' if hold['state'] == 'live' else 'priority_hold_stale') if hold else None
    if detail == previous or (detail is None and previous not in HOLD_DETAILS):
        return
    event = ('seen' if hold['state'] == 'live' else 'stale') if hold else 'cleared'
    toollog.emit('order-watch', 'collector.hold_' + event,
                 props={key: hold[key] for key in ('owner', 'reason', 'age_s')} if hold else
                 {'owner': None, 'reason': 'hold_absent', 'age_s': None})


def collect():
    now = time.time()
    with connect() as db:
        previous = db.execute('SELECT detail FROM health WHERE source="phone"').fetchone()
        hold = hold_state(now)
        log_hold_transition(previous['detail'] if previous else None, hold)
        if hold is not None:
            live = hold['state'] == 'live'
            db.execute('INSERT OR REPLACE INTO health VALUES (?,?,?,?)',
                       ('phone', now, int(live), 'deferred_priority_hold' if live else 'priority_hold_stale'))
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


def journal_errors(db):
    health = db.execute('SELECT * FROM health WHERE source="phone"').fetchone()
    if not health or time.time() - health['checked'] > 90:
        return ['notification_collector_stale']
    if not health['ok']:
        return ['notifications_' + health['detail']]
    return []


def rows(app, since, until):
    path = ROOT / 'delivery.sqlite'
    if not path.exists():
        return [], ['notification_collector_stale']
    try:
        db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            errors = journal_errors(db)
            found = db.execute('SELECT posted, detected, text FROM pushes '
                               'WHERE app=? AND posted>=? AND posted<=? ORDER BY posted',
                               (app, since, until))
            return [dict(row) for row in found], errors
        finally:
            db.close()
    except sqlite3.Error as exc:
        return [], ['notifications_' + type(exc).__name__]


def evidence(cfg, classifier, single=False):
    placed = dt.datetime.fromisoformat(cfg['placed_at'].replace('Z', '+00:00')).timestamp()
    out, errors = [], []
    with connect() as db:
        errors.extend(journal_errors(db))
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
    order = cfg['merchant_domain'] + ':' + cfg['order'] if cfg['app'] == 'web' else cfg['order']
    with connect() as db:
        db.execute('INSERT OR IGNORE INTO reconciliation(app,order_id,placed) VALUES (?,?,?)',
                   (cfg['app'], order, cfg['placed_at']))
        for key, value in [('detected', detected), ('source', source), ('evidence_time', evidence_time),
                           ('reported', reported), ('report_note', note), ('asked', asked)]:
            if value is not None:
                # Preserve the first machine detection. Human corrections can replace reports.
                expr = f'COALESCE({key},?)' if key in ('detected', 'source', 'evidence_time', 'asked') else '?'
                db.execute(f'UPDATE reconciliation SET {key}={expr} WHERE app=? AND order_id=?',
                           (value, cfg['app'], order))
        row = dict(db.execute('SELECT * FROM reconciliation WHERE app=? AND order_id=?',
                              (cfg['app'], order)).fetchone())
    row['gap_seconds'] = ((dt.datetime.fromisoformat(row['detected']) - dt.datetime.fromisoformat(row['reported'])).total_seconds()
                          if row['detected'] and row['reported'] else None)
    return row


def record_hold_alert(hold):
    try:
        mtime = (PHONE_LOCK / 'priority-hold').lstat().st_mtime
    except FileNotFoundError:
        return False
    alert_id = hashlib.sha256((hold['owner'] + '|' + str(int(mtime))).encode()).hexdigest()
    path = ROOT / 'hold-alerts.json'
    try:
        sent = json.loads(path.read_text())
        if not isinstance(sent, list) or not all(isinstance(item, str) for item in sent):
            sent = []
    except (OSError, ValueError, UnicodeError):
        sent = []
    if alert_id in sent:
        return False
    with tempfile.NamedTemporaryFile(mode='w', dir=ROOT, prefix='hold-alerts-',
                                     suffix='.tmp', delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump((sent + [alert_id])[-50:], stream)
            stream.close()
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    return True


def health_check():
    now = time.time()
    with connect() as db:
        row = db.execute('SELECT * FROM health WHERE source="phone"').fetchone()
        if not row or now - row['checked'] > 120:
            raise RuntimeError('notification collector is stale; restart com.ardud.delivery-notifications')
        if row['detail'] in HOLD_DETAILS:
            # The collector row can lag behind lease expiry or holder exit.
            hold = hold_state(now)
            if hold is not None and hold['state'] == 'stale':
                raise RuntimeError('notification collection blocked by stale phone priority-hold: '
                                   'owner={owner} reason={reason} age={age_s}s; '
                                   "do not remove another task's hold, report it to its owner".format(**hold))
            if (hold is not None and hold['reason'] == 'no_matching_lease_within_bound'
                    and hold['age_s'] > HOLD_ALERT_S and record_hold_alert(hold)):
                print(json.dumps({
                    'status': 'alert', 'reason': 'phone_priority_hold_without_lease',
                    'owner': hold['owner'], 'age_min': hold['age_s'] // 60,
                    'collection': 'blocked',
                    'note': 'delivery notifications are not being collected; the holder has no lease; '
                            "ask the holder to release it, never remove another task's hold"}))
                toollog.emit('order-watch', 'collector.hold_alert_sent',
                             props={key: hold[key] for key in ('owner', 'age_s', 'reason')})
            return
        if not row['ok']:
            raise RuntimeError('notification collection unavailable: ' + row['detail'])


if __name__ == '__main__':
    import sys
    if '--health' in sys.argv:
        health_check()
    else:
        collect()

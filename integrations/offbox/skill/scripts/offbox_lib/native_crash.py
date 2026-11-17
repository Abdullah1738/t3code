"""Consume setup crash evidence; never infer a bad box from user output alone."""
import contextlib
import sqlite3
import tempfile
from pathlib import Path

import offbox_disk_space as disk
import offbox_protocol as protocol
from . import common, unfit

AFTER_START = 'this box crashed native programs during setup; treat this failure as infra and re-run on another box'


class Move(common.OffboxError):
    pass


def after_start_code(row, code, path):
    from . import runs
    saved = {}
    if code is None:
        saved = common.read_json(runs.LOGS_DIR / f"{row['run_id']}.state.json", {})
        code = dict(row).get('known_exit_code') or saved.get('known_exit_code')
    if code in (None, 0):
        return None
    saved = saved or common.read_json(runs.LOGS_DIR / f"{row['run_id']}.state.json", {})
    record = disk.result(path, code)
    if not (record.get('setup_native_crash') or saved.get('setup_native_crash') is True):
        return None
    if code >= 128:
        return code
    if path.exists():
        _, started, output = path.read_text(errors='replace').partition(runs.COMMAND_STARTED_MARKER)
        if started and 'SIGSEGV' in output:
            return code
    if dict(row).get('command_id'):
        stderr = runs.complete_stream(row, 'stderr')
        if stderr is not None:
            _, started, output = stderr.partition(runs.COMMAND_STARTED_MARKER)
            if started:
                stdout = runs.complete_stream(row, 'stdout') if 'SIGSEGV' not in output else ''
                if 'SIGSEGV' in output or stdout is not None and 'SIGSEGV' in stdout:
                    return code
    return None


def settle(row, code, path, *, report=False):
    from . import runs
    if dict(row).get('status') == 'killed':
        return False
    record = disk.result(path, code)
    saved = common.read_json(runs.LOGS_DIR / f"{row['run_id']}.state.json", {})
    setup = record.get('setup_native_crash') or saved.get('setup_native_crash') is True
    native = record.get('infra_failure') == 'native_crash' or saved.get('infra_failure') == 'native_crash'
    if not setup and not native:
        return False
    reason = record.get('infra_reason') or saved.get('infra_reason') or 'setup_native_crash'
    trigger = 'exit90' if native and code == 90 else 'setup_crash'
    # A recorded setup marker is required. A plain user SIGSEGV remains a user failure.
    if after_start_code(row, code, path) is not None:
        reason, trigger, native = 'native_crash_after_start', 'after_start', True
    values = dict(setup_native_crash=bool(setup))
    if native:
        values.update(infra_failure='native_crash', infra_reason=reason, status='infra')
    runs.save_run_state(row['run_id'], **values)
    with contextlib.closing(common.db()) as con:
        unfit.set_mark(con, row['box_id'], reason, source='auto', run_id=row['run_id'], trigger=trigger)
    if trigger == 'after_start' and report:
        common.say(AFTER_START)
    return native


def before_start(row, code, path):
    """Only complete stderr can authorize replay; display output may be truncated or interleaved."""
    from . import runs
    if code != 90 or disk.result(path, code).get('infra_failure') != 'native_crash':
        return False
    text = runs.complete_stderr(row)
    if text is None or protocol.for_run(row, path).blocks_replay(text):
        return False
    with tempfile.TemporaryDirectory() as tmp:
        evidence = Path(tmp) / 'stderr'
        evidence.write_text(text)
        return disk.result(evidence, code).get('infra_failure') == 'native_crash'


def readback(row, code, path, *, report=False):
    """Late history can supply setup evidence after the original client saved the exit."""
    if dict(row).get('mode') == 'local' or not row['box_id']:
        return row
    from . import runs
    record = disk.result(path, code)
    saved = common.read_json(runs.LOGS_DIR / f"{row['run_id']}.state.json", {})
    if not (record.get('setup_native_crash') or saved.get('setup_native_crash') is True or
            record.get('infra_failure') == 'native_crash' or saved.get('infra_failure') == 'native_crash'):
        return row
    try:
        with contextlib.closing(common.db()) as con:
            current = con.execute('SELECT * FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()
        if current is None or current['status'] == 'killed':
            return current or row
        if settle(current, code, path, report=report):
            with contextlib.closing(common.db()) as con:
                con.execute("UPDATE runs SET status='infra' WHERE run_id=? AND status IN ('done','failed','lost') "
                            "AND exit_code=?", (row['run_id'], code))
                con.commit()
                current = con.execute('SELECT * FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()
        return current
    except (sqlite3.Error, OSError) as error:
        with contextlib.suppress(OSError):
            runs.state_warning(row['run_id'], code, error)
        return row

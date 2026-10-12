"""Opt-in read of the current Amazon.ae orders page via the installed Dia MCP.

No navigation, sign-in, cache, email override or tracker integration. Run with
`python3 amazon_dia_cli.py orders --json` or `track ORDER_ID --json`.
"""
import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import sys
import time

from amazon_browser_orders import BrowserOrdersError, ORDER_ID, SOURCE, parse_dia_result

MAX_BYTES = 2 * 1024 * 1024
TAB_ID = re.compile(r'[A-Za-z0-9-]{1,128}', re.ASCII)
TRANSPORT_ERRORS = frozenset({
    'DIA_TIMEOUT', 'DIA_TRANSPORT_FAILED', 'DIA_RESPONSE_TOO_LARGE',
    'DIA_INVALID_RESPONSE', 'DIA_TOOL_FAILED', 'DIA_BINDING_MISMATCH',
    'DIA_LOCATION_MISMATCH', 'DIA_BRIDGE_UNAVAILABLE', 'PERSONAL_PROFILE_REQUIRED',
    'DIA_PROFILE_UNMAPPED', 'AMAZON_ORDERS_TAB_REQUIRED', 'AMAZON_ORDERS_TAB_AMBIGUOUS',
    'TAB_NOT_FOUND', 'UNSUPPORTED_PAGE', 'PAGE_NOT_READY', 'DIA_TARGET_AMBIGUOUS',
    'INVALID_ARGUMENTS', 'EXTRACTOR_UNAVAILABLE',
})


def _stop_group(process):
    """Reap the leader AND verify the entire private group is absent.

    macOS can return EPERM for an unreaped, zombie-only group. EPERM is never
    success: reap our child, kill surviving descendants, and require ESRCH from
    a group probe. A denied/live group still present at the deadline fails closed.
    """
    def group_missing(sig):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            return True
        except PermissionError:
            # Could be zombie-only OR a real permission failure; check below.
            return False
        return False

    try:
        process.poll()  # Reap an already exited leader before signalling it.
        group_missing(signal.SIGTERM)
        try:
            process.wait(timeout=0.3)
        except subprocess.TimeoutExpired:
            pass
        deadline = time.monotonic() + 1
        while True:
            # Leader exit alone says nothing about its MCP/osascript children.
            group_missing(signal.SIGKILL)
            process.poll()
            if group_missing(0) and process.returncode is not None:
                return
            if time.monotonic() >= deadline:
                raise BrowserOrdersError('DIA_CLEANUP_FAILED')
            time.sleep(0.01)
    except OSError:
        raise BrowserOrdersError('DIA_CLEANUP_FAILED') from None


def _bounded_process(command, *, timeout, max_bytes=MAX_BYTES):
    """Bound bytes before buffering; never inherit inspector/debug/credential env."""
    env = {k: os.environ[k] for k in ('HOME', 'PATH', 'TMPDIR', 'LANG') if k in os.environ}
    deadline = time.monotonic() + timeout
    process = None
    try:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env=env, start_new_session=True)
        chunks, size = [], 0
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BrowserOrdersError('DIA_TIMEOUT')
                if not selector.select(remaining):
                    raise BrowserOrdersError('DIA_TIMEOUT')
                data = os.read(process.stdout.fileno(), min(65536, max_bytes - size + 1))
                if not data:
                    break
                size += len(data)
                if size > max_bytes:
                    raise BrowserOrdersError('DIA_RESPONSE_TOO_LARGE')
                chunks.append(data)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise BrowserOrdersError('DIA_TIMEOUT')
        if process.wait(timeout=remaining) != 0:
            raise BrowserOrdersError('DIA_TRANSPORT_FAILED')
        return b''.join(chunks)
    except subprocess.TimeoutExpired:
        raise BrowserOrdersError('DIA_TIMEOUT') from None
    except OSError:
        raise BrowserOrdersError('DIA_TRANSPORT_FAILED') from None
    finally:
        if process is not None:
            try:
                _stop_group(process)
            finally:
                process.stdout.close()


def read_orders(*, tab_id=None, expected_order_id=None, timeout=30):
    if (not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or
            not math.isfinite(timeout) or not 5 <= timeout <= 60):
        raise BrowserOrdersError('INVALID_ARGUMENTS')
    if tab_id is not None and (not isinstance(tab_id, str) or not TAB_ID.fullmatch(tab_id)):
        raise BrowserOrdersError('INVALID_ARGUMENTS')
    if expected_order_id is not None and (not isinstance(expected_order_id, str) or
                                         not ORDER_ID.fullmatch(expected_order_id)):
        raise BrowserOrdersError('INVALID_ORDER_ID')
    node = shutil.which('node')
    helper = Path(__file__).with_name('amazon_dia_transport.mjs')
    if not node or not helper.is_file():
        raise BrowserOrdersError('DIA_BRIDGE_UNAVAILABLE')
    command = [node, str(helper), '--timeout-ms', str(int(timeout * 1000) - 1000)]
    if tab_id:
        command += ['--tab-id', tab_id]
    payload = _bounded_process(command, timeout=timeout)
    try:
        envelope = json.loads(payload)
    except (ValueError, UnicodeError, RecursionError):
        raise BrowserOrdersError('DIA_INVALID_RESPONSE') from None
    if not isinstance(envelope, dict):
        raise BrowserOrdersError('DIA_INVALID_RESPONSE')
    if 'error' in envelope:
        code = envelope['error']
        raise BrowserOrdersError(code if isinstance(code, str) and code in TRANSPORT_ERRORS
                                 else 'DIA_TRANSPORT_FAILED')
    binding = envelope.get('binding')
    if (not isinstance(binding, dict) or not isinstance(binding.get('tab_id'), str) or
            not TAB_ID.fullmatch(binding['tab_id']) or not isinstance(binding.get('target_id'), str) or
            not TAB_ID.fullmatch(binding['target_id']) or
            (tab_id is not None and binding['tab_id'] != tab_id)):
        raise BrowserOrdersError('DIA_BINDING_MISMATCH')
    result = parse_dia_result(envelope.get('response'), tab_id=binding['tab_id'],
                              target_id=binding['target_id'],
                              observed_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                              expected_order_id=expected_order_id)
    result['transport'] = 'dia_mcp_stdio'
    return result


class _SafeParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's ordinary error text echoes user input; never do that here.
        raise BrowserOrdersError('INVALID_ARGUMENTS')


def main(argv=None):
    parser = _SafeParser(description='Read the current Amazon.ae orders page in Dia Personal; no navigation or auth.')
    parser.add_argument('command', choices=('orders', 'track'))
    parser.add_argument('order_id', nargs='?')
    parser.add_argument('--tab-id', help='Exact existing Personal tab; default requires one unique orders tab.')
    parser.add_argument('--timeout', type=float, default=30, help='Total transport deadline, 5–60 seconds (default 30).')
    parser.add_argument('--json', action='store_true', help='JSON output (also the default).')
    try:
        args = parser.parse_args(argv)
        if (args.command == 'track') != (args.order_id is not None):
            raise BrowserOrdersError('INVALID_ARGUMENTS')
        result = read_orders(tab_id=args.tab_id, expected_order_id=args.order_id, timeout=args.timeout)
    except BrowserOrdersError as error:
        print(json.dumps({'source': SOURCE, 'error': str(error), 'terminal': False,
                          'whole_order_delivered': False, 'tracker_integration_enabled': False}))
        return 1
    except KeyboardInterrupt:
        print(json.dumps({'source': SOURCE, 'error': 'INTERRUPTED'}))
        return 130
    except Exception:
        # No SDK exception, response metadata, traceback or page content in errors.
        print(json.dumps({'source': SOURCE, 'error': 'DIA_TRANSPORT_FAILED'}))
        return 1
    print(json.dumps(result, ensure_ascii=True))
    return 0


def _interrupt(signum, frame):
    # Let _bounded_process's finally kill the full process group on termination.
    raise KeyboardInterrupt


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, _interrupt)
    sys.exit(main())

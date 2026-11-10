"""Talabat is retired (owner, 2026-11-07): every Talabat entry point refuses.

Abdullah: "We will never use talabat again." No search, menus, ordering, auth
or app fallback, for Abdullah or Moni. Flow-id commands on old journal rows
(inspect, recover-payment, release-flow ...) are untouched so past state can
still be reconciled; nothing new starts on Talabat.
"""
import json
import sys

CODE = 'TALABAT_RETIRED'
MESSAGE = ('Talabat retired by owner 2026-11-07: never use Talabat again '
           '(no search, ordering, menus or app fallback). Use noon or Careem.')
EXIT = 5
TALABAT_COMMANDS = frozenset({'test-talabat-shops', 'menu', 'choices'})


def requested(args):
    """True when parsed commerce args would start Talabat work."""
    return (getattr(args, 'command', None) in TALABAT_COMMANDS
            or getattr(args, 'app', None) == 'talabat'
            or getattr(args, 'order_command', None) == 'talabat')


def refuse():
    print(json.dumps({'ok': False, 'app': 'talabat', 'error': CODE, 'message': MESSAGE,
                      'financial_send': False, 'financial_retry': False}))
    print(MESSAGE, file=sys.stderr)
    return EXIT

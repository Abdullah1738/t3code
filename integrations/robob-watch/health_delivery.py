"""Health-only send receipt; accepts no message text or provider output."""
import sys
try:
    import toollog
    component, run, outcome = sys.argv[1:]
    if component in ('meds-nag', 'nutrition-nudge', 'gym-nudge') and toollog.valid_run(run) and outcome in ('ok', 'fail'):
        toollog.delivery('nag', run, outcome == 'ok', 'subprocess_failed', component)
except BaseException:
    pass

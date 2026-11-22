"""One wall-clock budget per box, shared by resume, bring-up, locks and sync."""
from __future__ import annotations

import contextlib
import contextvars
import signal
import threading
import time

from . import api, capacity, ssh_outage
from .common import OffboxError, SshHostKeyMismatch, log, say

_ACTIVE = contextvars.ContextVar('prepare', default=None)
_MOVES = contextvars.ContextVar('prepare_moves', default=None)


class Stalled(api.BudgetExpired):
    def __init__(self, box, phase, seconds, outage_cause=None):
        self.phase = phase
        self.outage_cause = outage_cause if outage_cause is not None and outage_cause.outage else None
        message = f'could not get a box ready in {seconds:g}s (stuck in {phase} on {box}); nothing ran'
        if self.outage_cause is not None:
            message += f'; last outage: {self.outage_cause}'
        super().__init__(message, outage=self.outage_cause is not None, box=box)


class _Expired(BaseException):
    # Transport and lease recovery catch Exception/OffboxError. A deadline must unwind them, not retry inside them.
    pass


@contextlib.contextmanager
def attempts():
    if _MOVES.get() is not None:
        yield
        return
    token = _MOVES.set([])
    try:
        yield
    finally:
        _MOVES.reset(token)


def move_once(error):
    moves = _MOVES.get()
    if moves is not None:
        if moves:
            from . import home
            refused = 400 <= (getattr(error, 'status', None) or 0) < 500
            wrapped = OffboxError(f'{error}. Replacement failed after: {moves[0]}', code=error.code,
                                  started=error.started or moves[0].started,
                                  outage=not refused and home.may_fail_over() and (error.outage or moves[0].outage))
            wrapped.status = getattr(error, 'status', None)
            raise wrapped from error
        moves.append(error)


def can_move():
    return not _MOVES.get()


class Budget:
    def __init__(self, box, end=None, seconds=None):
        seconds = seconds if seconds is not None else capacity.setting('OFFBOX_PREPARE_DEADLINE_SECONDS', 300, minimum=1, maximum=3600)
        self.resume_watch = None
        self.start = time.monotonic()
        self.end = end if end is not None else self.start + seconds
        self.seconds = seconds
        self.total_start = self.end - seconds
        self.box, self.phase = box, 'bring_up'
        self.phase_start = self.start
        self.next_progress = self.start + 30
        self.outage_cause = None

    def check(self, reserve=0):
        if time.monotonic() + reserve >= self.end:
            raise _Expired

    def tick(self, *_):
        try:
            self.check()
        except _Expired:
            # Cleanup may itself call boat (e.g. retiring an interrupted recipe); it gets a bounded grace period.
            signal.setitimer(signal.ITIMER_REAL, .5)
            raise
        now = time.monotonic()
        if now >= self.next_progress:
            say(f'still {self.phase} on {self.box} ({int(now-self.phase_start)}s)')
            self.next_progress = now + 60
        signal.setitimer(signal.ITIMER_REAL, max(.001, min(self.end, self.next_progress) - now))


@contextlib.contextmanager
def guard(box, end=None, seconds=None):
    active = _ACTIVE.get()
    if active is not None:
        active.check()
        yield active
        return
    budget = Budget(box, end, seconds)
    token = _ACTIVE.set(budget)
    main = threading.current_thread() is threading.main_thread()
    old_handler = old_timer = None
    try:
        if main:
            old_handler = signal.signal(signal.SIGALRM, budget.tick)
            old_timer = signal.setitimer(signal.ITIMER_REAL, max(.001, min(budget.end, budget.next_progress)-time.monotonic()))
        with api.budget(max(0, budget.end - time.monotonic())):
            budget.check()
            with phase('bring_up', box):
                yield budget
            budget.check()
    except (SshHostKeyMismatch, api.BoxBootFailed, ssh_outage.SshUnreachable):
        raise
    except (Exception, _Expired) as error:
        if not isinstance(error, _Expired) and time.monotonic() < budget.end:
            raise
        if main:
            signal.setitimer(signal.ITIMER_REAL, 0)
        if budget.resume_watch is not None:
            # Preserve pending-peer recovery when preparation expires before the resume's own cap.
            budget.resume_watch.check()
            budget.resume_watch.stuck(phase=budget.phase)
        else:
            log(f'resume_stuck {budget.box} {budget.phase} {time.monotonic()-budget.total_start:.1f}s')
        outage_cause = error if getattr(error, 'outage', False) else budget.outage_cause
        raise Stalled(budget.box, budget.phase, budget.seconds, outage_cause) from None
    finally:
        if main and old_handler is not None:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old_handler)
            delay, interval = old_timer
            if delay:
                signal.setitimer(signal.ITIMER_REAL, max(.001, delay-(time.monotonic()-budget.start)), interval)
        _ACTIVE.reset(token)


@contextlib.contextmanager
def phase(name, box=None, detail=''):
    budget = _ACTIVE.get()
    if budget is None:
        yield
        return
    previous = budget.phase, budget.box, budget.phase_start, budget.next_progress
    budget.phase, budget.box = name, box or budget.box
    budget.phase_start = time.monotonic()
    budget.next_progress = budget.phase_start + 30
    log(f'{name} {budget.box}' + (f' {detail}' if detail else ''))
    try:
        budget.check()
        yield
        budget.check()
    except _Expired:
        # Keep the failing phase for guard's diagnostic while unwinding nested phase scopes.
        raise
    else:
        budget.phase, budget.box, budget.phase_start, budget.next_progress = previous


def check(reserve=0):
    budget = _ACTIVE.get()
    if budget is not None:
        budget.check(reserve)


def identify(box):
    budget = _ACTIVE.get()
    if budget is not None:
        budget.box = box


def observe_outage(error=None):
    budget = _ACTIVE.get()
    if budget is None or error is not None and api.client_budget_expired(error):
        return
    budget.outage_cause = error if error is not None and error.outage else None


def track_resume(watch):
    budget = _ACTIVE.get()
    if budget is not None:
        budget.resume_watch = watch
    return budget


@contextlib.contextmanager
def pause_for_home_start(*, extra_seconds=0):
    """An answering home server's startup has its own bound, outside box preparation time."""
    budget = _ACTIVE.get()
    if budget is None:
        yield
        return
    began = time.monotonic()
    main = threading.current_thread() is threading.main_thread()
    timer = signal.setitimer(signal.ITIMER_REAL, 0) if main else None
    token = _ACTIVE.set(None)
    try:
        with budget.resume_watch.pause(extra_seconds=extra_seconds) if budget.resume_watch is not None else contextlib.nullcontext():
            yield
    finally:
        elapsed = time.monotonic() - began + extra_seconds
        for field in ('start', 'end', 'total_start', 'phase_start', 'next_progress'):
            setattr(budget, field, getattr(budget, field) + elapsed)
        _ACTIVE.reset(token)
        if timer is not None:
            signal.setitimer(signal.ITIMER_REAL, *timer)

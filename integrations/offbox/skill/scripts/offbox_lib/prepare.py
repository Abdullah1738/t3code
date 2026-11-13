"""One wall-clock budget per box, shared by resume, bring-up, locks and sync."""
from __future__ import annotations

import contextlib
import contextvars
import signal
import threading
import time

from . import api, capacity
from .common import OffboxError, log, say

_ACTIVE = contextvars.ContextVar('prepare', default=None)
_MOVES = contextvars.ContextVar('prepare_moves', default=None)


class Stalled(OffboxError):
    def __init__(self, box, phase, seconds):
        self.box, self.phase = box, phase
        super().__init__(f'could not get a box ready in {seconds:g}s '
                         f'(stuck in {phase} on {box}); nothing ran')


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
            raise OffboxError(f'{error}. Replacement failed after: {moves[0]}') from error
        moves.append(str(error))


def can_move():
    return not _MOVES.get()


class Budget:
    def __init__(self, box, end=None, seconds=None):
        seconds = seconds if seconds is not None else capacity.setting('OFFBOX_PREPARE_DEADLINE_SECONDS', 300, minimum=1, maximum=3600)
        self.start = time.monotonic()
        self.end = end if end is not None else self.start + seconds
        self.seconds = seconds
        self.total_start = self.end - seconds
        self.box, self.phase = box, 'bring_up'
        self.phase_start = self.start
        self.next_progress = self.start + 30

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
    except (Exception, _Expired) as error:
        if not isinstance(error, _Expired) and time.monotonic() < budget.end:
            raise
        if main:
            signal.setitimer(signal.ITIMER_REAL, 0)
        log(f'resume_stuck {budget.box} {budget.phase} {time.monotonic()-budget.total_start:.1f}s')
        raise Stalled(budget.box, budget.phase, budget.seconds) from None
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

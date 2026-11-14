"""Startup health fields shared by the client and its independent monitor."""
import math
import os
import re

START_WAIT_S = 600.0


def wait_seconds():
    try:
        value = float(os.environ.get("OFFBOX_HOME_START_WAIT_S", START_WAIT_S))
        return value if math.isfinite(value) and value >= 0 else START_WAIT_S
    except ValueError:
        return START_WAIT_S


def starting_phase(data):
    if not isinstance(data, dict) or data.get("ok") is True:
        return None
    reasons = data.get("reasons")
    if not isinstance(reasons, list):
        reasons = [reasons] if isinstance(reasons, str) else []
    reasons = reasons or [data.get("message", "")]
    if any("reconcile failed" in str(reason) for reason in reasons):
        return None
    if data.get("starting") is True:
        return str(data.get("phase") or "starting")
    for reason in reasons:
        if reason in ("starting", "waiting for incus", "reconciling runs and boxes after start"):
            return reason
        if re.fullmatch(r"state dataset \S+ (?:not found \(pool \S+ is MISSING\)|is not mounted)", str(reason)):
            return str(reason)
    return None

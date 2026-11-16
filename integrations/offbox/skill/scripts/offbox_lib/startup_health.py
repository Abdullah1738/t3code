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


def accepting_health(data):
    """Loop degradation does not refuse runs; explicit admission failures still do."""
    if not isinstance(data, dict):
        return False
    if data.get("ok") is True:
        return True
    if data.get("degraded") is not True or data.get("up") is False or data.get("starting") or starting_phase(data):
        return False
    disk = data.get("disk") if isinstance(data.get("disk"), dict) else {}
    if data.get("disk_full") or disk.get("disk_full") or disk.get("level") in ("full", "unknown"):
        return False
    reasons = data.get("reasons") or []
    return isinstance(reasons, list) and all(re.match(r"(?:reaper|sampler) has not completed a pass for ", str(r)) for r in reasons)

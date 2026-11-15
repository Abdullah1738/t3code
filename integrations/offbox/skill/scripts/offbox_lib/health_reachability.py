"""Reachability evidence shared by the monitor and pre-start client probes."""
import math
import os
import socket
import urllib.parse


def seconds(name, default):
    try:
        value = float(os.environ.get(name, default))
        return value if math.isfinite(value) and value >= 0 else default
    except ValueError:
        return default


def slow_probe_seconds():
    return seconds("OFFBOX_HOME_SLOW_PROBE_S", 15)


def slow_down_seconds():
    return seconds("OFFBOX_HOME_SLOW_DOWN_AFTER_S", 300)


def tcp_connects(url, timeout=3):
    parsed = urllib.parse.urlsplit(url)
    try:
        with socket.create_connection((parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)),
                                      timeout=max(.001, timeout)):
            return True
    except OSError:
        return False


def timed_out(value):
    if not isinstance(value, (str, BaseException)):
        return False
    text = str(value).lower()
    return any(word in text for word in ("timeout", "timed out", "deadline passed"))

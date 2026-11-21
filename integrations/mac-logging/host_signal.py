"""Best-effort wake-up; a failed or full socket never delays the CPU sampler."""
import os
from pathlib import Path
import socket


def socket_path():
    return Path(os.environ.get('MAC_HOST_SOCKET', str(Path.home()/'.local/state/mac-upkeep/host.sock')))


def notify_cpu_timeout():
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as client:
            client.setblocking(False)
            client.sendto(b'cpu.timeout', str(socket_path()))
        return True
    except OSError:
        return False

"""Read scheduling and process identity without spawning ps (Darwin libproc ABI)."""
import signal
import time


def remaining_deadline(deadline):
    remaining = float(deadline) - time.time()
    if not 0 < remaining <= 10:
        raise TimeoutError('action deadline expired or invalid')
    return remaining


def arm_deadline(deadline):
    # The real-time timer and default SIGALRM disposition survive exec of the
    # utility, including when sudo's parent has already timed out and exited.
    signal.signal(signal.SIGALRM, signal.SIG_DFL)
    signal.setitimer(signal.ITIMER_REAL, remaining_deadline(deadline))


import sys
if __name__ == '__main__':
    arm_deadline(sys.argv[3])

import ctypes as c
import datetime
import os


class BsdInfo(c.Structure):
    _fields_ = [(k, c.c_uint32) for k in (
        'flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid', 'ruid', 'rgid',
        'svuid', 'svgid', 'reserved')] + [('comm', c.c_char*16), ('name', c.c_char*32)] + [
        (k, c.c_uint32) for k in ('nfiles', 'pgid', 'jobc', 'tdev', 'tpgid')] + [
        ('nice', c.c_int32), ('startS', c.c_uint64), ('startUs', c.c_uint64)]


class TaskInfo(c.Structure):
    _fields_ = [(k, c.c_uint64) for k in (
        'virtual', 'resident', 'user', 'system', 'threadsUser', 'threadsSystem')] + [
        (k, c.c_int32) for k in ('policy', 'faults', 'pageins', 'cow', 'messagesSent',
        'messagesReceived', 'syscallsMach', 'syscallsUnix', 'csw', 'threads', 'running', 'priority')]


class TaskAllInfo(c.Structure):
    _fields_ = [('bsd', BsdInfo), ('task', TaskInfo)]


def decode_argv(data):
    argc = int.from_bytes(data[:4], sys.byteorder, signed=True)
    if not 1 <= argc <= 4096:
        raise ValueError('invalid argc')
    end = data.index(b'\0', 4)
    # XNU aligns executable_path to the LP64 pointer width before argv.
    pos = 4 + ((end-4+1+7)//8)*8
    if any(data[end+1:pos]):
        raise ValueError('invalid argv padding')
    argv = []
    for _ in range(argc):
        end = data.index(b'\0', pos)
        argv.append(os.fsdecode(data[pos:end]))
        pos = end+1
    return argv


class Native:
    def __init__(self):
        self.lib = c.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        self.lib.proc_pidinfo.argtypes = (c.c_int, c.c_int, c.c_uint64, c.c_void_p, c.c_int)
        self.lib.proc_pidinfo.restype = c.c_int
        self.lib.proc_listallpids.argtypes = (c.c_void_p, c.c_int)
        self.lib.proc_listallpids.restype = c.c_int
        self.lib.sysctl.argtypes = (c.POINTER(c.c_int), c.c_uint, c.c_void_p,
                                   c.POINTER(c.c_size_t), c.c_void_p, c.c_size_t)
        self.lib.sysctl.restype = c.c_int

    def pids(self):
        values = (c.c_int*32768)()
        count = self.lib.proc_listallpids(values, c.sizeof(values))
        if count <= 0 or count >= len(values):
            raise OSError('process inventory incomplete')
        return [p for p in values[:count] if p > 1]

    def info(self, pid):
        value = TaskAllInfo()
        if self.lib.proc_pidinfo(pid, 2, 0, c.byref(value), c.sizeof(value)) != c.sizeof(value):
            raise OSError('process unavailable')
        b = value.bsd
        if b.pid != pid or not b.flags & 0x10 or b.flags & 5 or b.status == 5:
            raise ValueError('unsafe process')  # system, exiting, zombie or unsupported ABI
        return dict(pid=pid, ppid=b.ppid, uid=b.uid, nice=b.nice, pri=value.task.priority,
                    start=[b.startS, b.startUs],
                    lstart=datetime.datetime.fromtimestamp(b.startS).strftime('%a %b %d %H:%M:%S %Y'),
                    comm=os.fsdecode(b.comm))

    def read(self, pid):
        before = self.info(pid)
        data, size = c.create_string_buffer(262144), c.c_size_t(262144)
        mib = (c.c_int*3)(1, 49, pid)
        if self.lib.sysctl(mib, 3, data, c.byref(size), None, 0) or size.value > len(data):
            raise OSError('argv unavailable')
        argv = decode_argv(data.raw[:size.value])
        after = self.info(pid)
        if identity(before) != identity(after):
            raise ValueError('process changed')
        return dict(after, argv=argv)

    def inventory(self):
        rows = {}
        for pid in self.pids():
            try:
                info = self.info(pid)
                if info['uid'] == os.getuid() and info['comm'] in ('Python', 'python3', 'bun', 'cloudflared'):
                    rows[pid] = self.read(pid)
            except (OSError, ValueError):
                continue  # normal process exit during the census
        return rows


def identity(row):
    return row['pid'], row['ppid'], row['uid'], tuple(row['start'])


def apply_checked(action, expected, deadline):
    import json
    remaining_deadline(deadline)
    native = Native()
    row = json.loads(expected)
    current = native.read(row['pid'])
    if identity(current) != identity(row) or current['argv'] != row['argv']:
        raise ValueError('process changed before action')
    if row.get('parent'):
        parent = row['parent']
        fresh = native.read(parent['pid'])
        if identity(fresh) != identity(parent) or fresh['argv'] != parent['argv']:
            raise ValueError('supervisor changed before action')
    remaining_deadline(deadline)
    # Recheck after sudo authentication, in the process that execs the utility.
    # Darwin renice -n takes an increment, unlike Linux's absolute value.
    if action == 'nice' and current['nice'] > -5:
        os.execv('/usr/bin/renice', ['renice', '-n', str(-5-current['nice']), '-p', str(row['pid'])])
    elif action == 'background' and current['pri'] <= 4:
        os.execv('/usr/sbin/taskpolicy', ['taskpolicy', '-B', '-p', str(row['pid'])])
    elif action not in ('nice', 'background'):
        raise ValueError('unknown action')


if __name__ == '__main__':
    apply_checked(*sys.argv[1:])

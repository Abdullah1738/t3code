"""Darwin host counters without subprocesses. ABI layouts come from the macOS SDK."""
import ctypes as c
import os
import time

from process_argv import decode_args, MAX_BYTES


class SwapUsage(c.Structure):
    _fields_ = [(k, c.c_uint64) for k in ('total', 'available', 'used')]+[
        ('pageSize', c.c_uint32), ('encrypted', c.c_int)]


class VmStatistics64(c.Structure):
    # HOST_VM_INFO64_REV1_COUNT: a supported prefix, independent of newer SDK tails.
    _fields_ = [(k, c.c_uint32) for k in ('free', 'active', 'inactive', 'wired')]+[
        (k, c.c_uint64) for k in ('zeroFill', 'reactivations', 'pageins', 'pageouts',
                                'faults', 'cowFaults', 'lookups', 'hits', 'purges')]+[
        ('purgeable', c.c_uint32), ('speculative', c.c_uint32)]+[
        (k, c.c_uint64) for k in ('decompressions', 'compressions', 'swapins', 'swapouts')]+[
        (k, c.c_uint32) for k in ('compressed', 'throttled', 'external', 'internal')]+[
        ('uncompressed', c.c_uint64)]


class Native:
    def __init__(self, system=None, proc=None):
        self.system = system or c.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        self.proc = proc or c.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        for lib, name, args, result in (
            (self.system, 'sysctlbyname', (c.c_char_p, c.c_void_p, c.POINTER(c.c_size_t), c.c_void_p, c.c_size_t), c.c_int),
            (self.system, 'sysctl', (c.POINTER(c.c_int), c.c_uint, c.c_void_p, c.POINTER(c.c_size_t), c.c_void_p, c.c_size_t), c.c_int),
            (self.system, 'mach_host_self', (), c.c_uint),
            (self.system, 'host_statistics64', (c.c_uint, c.c_int, c.c_void_p, c.POINTER(c.c_uint)), c.c_int),
            (self.system, 'mach_port_deallocate', (c.c_uint, c.c_uint), c.c_int),
            (self.proc, 'proc_listallpids', (c.c_void_p, c.c_int), c.c_int),
            (self.proc, 'proc_pidinfo', (c.c_int, c.c_int, c.c_uint64, c.c_void_p, c.c_int), c.c_int),
            (self.proc, 'proc_name', (c.c_int, c.c_void_p, c.c_uint), c.c_int),
        ):
            fn = getattr(lib, name)
            fn.argtypes, fn.restype = args, result

    def sysctl(self, name, value_type=c.c_uint32):
        value = value_type()
        size = c.c_size_t(c.sizeof(value))
        if self.system.sysctlbyname(name.encode(), c.byref(value), c.byref(size), None, 0):
            raise OSError(c.get_errno(), 'sysctl unavailable')
        if size.value != c.sizeof(value):
            raise ValueError('sysctl size')
        return value

    def swap(self):
        value = self.sysctl('vm.swapusage', SwapUsage)
        return dict(swapTotalBytes=value.total, swapUsedBytes=value.used,
                    swapAvailableBytes=value.available)

    def vm(self):
        host = self.system.mach_host_self()
        try:
            return vm_statistics(self.system.host_statistics64, host)
        finally:
            task = c.c_uint.in_dll(self.system, 'mach_task_self_').value
            self.system.mach_port_deallocate(task, host)

    def process_count(self):
        # A NULL listallpids query includes allocation slack, not the true count.
        return len(self.pids())

    def states(self, pids, budget=2, clock=time.monotonic):
        started = clock()
        runnable = uninterruptible = running_threads = read = skipped = 0
        partial = False
        for pid in pids:
            if clock()-started >= budget:
                partial = True
                break
            tids = (c.c_uint64*4096)()
            size = self.proc.proc_pidinfo(pid, 6, 0, tids, c.sizeof(tids))
            if size <= 0 or size >= c.sizeof(tids) or size % 8:
                skipped += 1
                continue
            running = waiting = False
            for tid in tids[:size//8]:
                if clock()-started >= budget:
                    partial = True
                    break
                info = ThreadInfo()
                size = self.proc.proc_pidinfo(pid, 5, tid, c.byref(info), c.sizeof(info))
                if size != c.sizeof(info):
                    partial = True
                    continue
                running |= info.runState == 1  # TH_STATE_RUNNING
                waiting |= info.runState == 4  # TH_STATE_UNINTERRUPTIBLE
                running_threads += info.runState == 1
            runnable += running
            uninterruptible += waiting
            read += 1
            if clock()-started >= budget:
                partial = True
                break
        return dict(runnable=runnable, uninterruptible=uninterruptible,
                    runnableThreads=running_threads, stateProcessesRead=read,
                    stateProcessesSkipped=skipped, stateScanPartial=partial or skipped > 0,
                    stateScanMs=(clock()-started)*1000, stateScanTimedOut=clock()-started >= budget)

    def pids(self, deadline=None, clock=time.monotonic):
        estimate = self.proc.proc_listallpids(None, 0)
        if estimate <= 0:
            raise OSError(c.get_errno(), 'process count unavailable')
        if deadline is not None and clock() >= deadline:
            raise TimeoutError('process inventory budget')
        capacity = estimate+256
        values = (c.c_int*capacity)()
        count = self.proc.proc_listallpids(values, c.sizeof(values))
        if count <= 0 or count >= capacity:
            raise OSError('process inventory incomplete')
        return [pid for pid in values[:count] if pid > 0]

    def name(self, pid):
        value = c.create_string_buffer(1024)
        count = self.proc.proc_name(pid, value, len(value))
        if count <= 0 or count >= len(value):
            raise OSError('process name unavailable')
        return os.fsdecode(value.value)

    def bsd(self, pid):
        value = self.info(pid, 3, BsdInfo)
        if value.pid != pid:
            raise OSError('process identity changed')
        return dict(pid=value.pid, ppid=value.ppid, comm=os.fsdecode(value.comm),
                    start=(value.startSec, value.startUsec), status=value.status)

    def task(self, pid):
        value = self.info(pid, 4, TaskInfo)
        return dict(cpuNs=value.totalUser+value.totalSystem, rssBytes=value.resident,
                    running=value.numrunning)

    def info(self, pid, flavor, layout, argument=0):
        value = layout()
        c.set_errno(0)
        size = self.proc.proc_pidinfo(pid, flavor, argument, c.byref(value), c.sizeof(value))
        if size != c.sizeof(value):
            number = c.get_errno() if size <= 0 else 0
            raise OSError(number or None, os.strerror(number) if number else 'process info unavailable')
        return value

    def threads(self, pid, deadline, clock=time.monotonic):
        tids = (c.c_uint64*4096)()
        size = self.proc.proc_pidinfo(pid, 6, 0, tids, c.sizeof(tids))
        if size <= 0 or size >= c.sizeof(tids) or size % 8:
            raise OSError('thread inventory incomplete')
        rows = []
        for tid in tids[:size//8]:
            if clock() >= deadline:
                return rows, False
            try:
                value = self.info(pid, 5, ThreadInfo, tid)
            except OSError:
                return rows, False
            rows.append((value.runState, value.curpri, value.priority))
        return rows, True

    def argv(self, pid):
        value, size = c.create_string_buffer(MAX_BYTES), c.c_size_t(MAX_BYTES)
        mib = (c.c_int*3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
        if self.system.sysctl(mib, 3, value, c.byref(size), None, 0):
            raise OSError(c.get_errno(), 'argv unavailable')
        if size.value > MAX_BYTES:
            raise ValueError('argv size')
        return decode_args(value.raw[:size.value])[1]


class ThreadInfo(c.Structure):
    _fields_ = [('userTime', c.c_uint64), ('systemTime', c.c_uint64)]+[
        (k, c.c_int32) for k in ('cpuUsage', 'policy', 'runState', 'flags', 'sleepTime',
                                'curpri', 'priority', 'maxpriority')]+[('name', c.c_char*64)]


class BsdInfo(c.Structure):
    _fields_ = [(k, c.c_uint32) for k in ('flags', 'status', 'xstatus', 'pid', 'ppid',
        'uid', 'gid', 'ruid', 'rgid', 'svuid', 'svgid', 'reserved')]+[
        ('comm', c.c_char*16), ('name', c.c_char*32)]+[
        (k, c.c_uint32) for k in ('nfiles', 'pgid', 'jobc', 'tdev', 'tpgid')]+[
        ('nice', c.c_int32), ('startSec', c.c_uint64), ('startUsec', c.c_uint64)]


class TaskInfo(c.Structure):
    _fields_ = [(k, c.c_uint64) for k in ('virtual', 'resident', 'totalUser', 'totalSystem',
        'threadsUser', 'threadsSystem')]+[(k, c.c_int32) for k in ('policy', 'faults',
        'pageins', 'cowFaults', 'messagesSent', 'messagesReceived', 'syscallsMach',
        'syscallsUnix', 'csw', 'threadnum', 'numrunning', 'priority')]


def vm_statistics(read, host):
    value = VmStatistics64()
    count = c.c_uint(c.sizeof(value)//4)
    code = read(host, 4, c.byref(value), c.byref(count))
    if code or count.value != c.sizeof(value)//4:
        raise ValueError('host statistics unavailable')
    return dict(pageSize=os.sysconf('SC_PAGE_SIZE'), freePages=value.free,
                activePages=value.active, inactivePages=value.inactive,
                compressedPages=value.compressed, pageins=value.pageins,
                pageouts=value.pageouts, swapins=value.swapins, swapouts=value.swapouts)

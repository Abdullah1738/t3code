"""Bounded Darwin argv reads; stdout contains argv vectors, never environment."""
import ctypes as c
import json
import os
import sys

MAX_PIDS = 160
MAX_BYTES = 262144
MAX_OUTPUT = 1048576


class BsdInfo(c.Structure):
    # proc_info.h, PROC_PIDTBSDINFO. Keep the name arrays in the ABI layout.
    _fields_ = [(name, c.c_uint32) for name in (
        'flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid', 'ruid', 'rgid',
        'svuid', 'svgid', 'reserved')]+[
        ('comm', c.c_char*16), ('name', c.c_char*32)]+[
        (name, c.c_uint32) for name in ('nfiles', 'pgid', 'jobc', 'tdev', 'tpgid')]+[
        ('nice', c.c_int32), ('startS', c.c_uint64), ('startUs', c.c_uint64)]


def decode_args(data):
    if not 5 <= len(data) <= MAX_BYTES:
        raise ValueError('argv size')
    argc = int.from_bytes(data[:4], sys.byteorder, signed=True)
    if not 1 <= argc <= 4096:
        raise ValueError('argc')
    end = data.index(b'\0', 4)
    executable = os.fsdecode(data[4:end])
    # XNU exec_extract_strings pads executable_path= to the target pointer
    # width; KERN_PROCARGS2 strips that 16-byte key and prepends argc. Native
    # reads below require LP64. Skipping all NULs would also skip empty argv[0].
    pos = 4 + ((end-4+1+7)//8)*8
    if pos >= len(data) or any(data[end+1:pos]):
        raise ValueError('argv alignment')
    argv = []
    for _ in range(argc):
        end = data.index(b'\0', pos)
        argv.append(os.fsdecode(data[pos:end]))
        pos = end+1
    return executable, argv


def native_reader():
    lib = c.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    lib.sysctl.argtypes = (c.POINTER(c.c_int), c.c_uint, c.c_void_p,
                          c.POINTER(c.c_size_t), c.c_void_p, c.c_size_t)
    lib.sysctl.restype = c.c_int
    lib.proc_pidinfo.argtypes = (c.c_int, c.c_int, c.c_uint64, c.c_void_p, c.c_int)
    lib.proc_pidinfo.restype = c.c_int

    def identity(pid):
        info = BsdInfo()
        if lib.proc_pidinfo(pid, 3, 0, c.byref(info), c.sizeof(info)) != c.sizeof(info):
            raise OSError(c.get_errno(), 'process identity unavailable')
        if not info.flags & 0x10:  # PROC_FLAG_LP64; other layouts fail closed.
            raise ValueError('unsupported process layout')
        return (info.pid, info.ppid, info.uid, info.startS, info.startUs)

    def read_data(pid):
        data, size = c.create_string_buffer(MAX_BYTES), c.c_size_t(MAX_BYTES)
        # CTL_KERN=1, KERN_PROCARGS2=49. One fixed-size read, no size retry.
        mib = (c.c_int*3)(1, 49, pid)
        if lib.sysctl(mib, 3, data, c.byref(size), None, 0):
            raise OSError(c.get_errno(), 'process argv unavailable')
        if size.value > MAX_BYTES:
            raise ValueError('argv size')
        return data.raw[:size.value]
    return lambda pid: read_process(pid, identity, read_data)


def read_process(pid, identity, read_data):
    before = identity(pid)
    data = read_data(pid)
    if before != identity(pid) or before[0] != pid:
        raise ValueError('process changed')
    executable, argv = decode_args(data)
    return dict(ppid=before[1], uid=before[2], startS=before[3],
                executable=executable, argv=argv)


def collect(pids, read):
    result, used = {}, 2
    for pid in pids[:MAX_PIDS]:
        try:
            value = read(pid)
            size = len(json.dumps({str(pid): value}, ensure_ascii=True).encode())+1
            if used+size <= MAX_OUTPUT:
                result[str(pid)] = value
                used += size
        except (OSError, ValueError, UnicodeError):
            continue
    return result


if __name__ == '__main__':
    result = {}
    if sys.platform == 'darwin':
        try:
            result = collect([int(p) for p in sys.argv[1:MAX_PIDS+1]], native_reader())
        except (OSError, ValueError, AttributeError):
            pass
    print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))

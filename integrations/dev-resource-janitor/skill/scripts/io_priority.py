"""Disk-only throttling for recursive maintenance, inherited by its children."""
import ctypes
import sys


def throttle_disk(lib=None):
    if sys.platform != 'darwin':
        return
    lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True) if lib is None else lib
    lib.setiopolicy_np.argtypes = (ctypes.c_int, ctypes.c_int, ctypes.c_int)
    lib.setiopolicy_np.restype = ctypes.c_int
    # sys/resource.h: IOPOL_TYPE_DISK=0, IOPOL_SCOPE_PROCESS=0, IOPOL_THROTTLE=3.
    if lib.setiopolicy_np(0, 0, 3):
        raise OSError(ctypes.get_errno(), 'cannot throttle maintenance disk I/O')

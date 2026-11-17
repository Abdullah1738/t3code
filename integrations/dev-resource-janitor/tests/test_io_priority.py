import importlib.util
from pathlib import Path
import sys
from unittest.mock import Mock, patch
from janitor_test_safety import JanitorTestCase

SCRIPTS=Path(__file__).resolve().parents[1]/'skill/scripts'
spec=importlib.util.spec_from_file_location('janitor_io_priority',SCRIPTS/'io_priority.py')
policy=importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class IoPriorityTests(JanitorTestCase):
    def test_darwin_calls_disk_process_throttle(self):
        lib=Mock()
        lib.setiopolicy_np.return_value=0
        with patch.object(policy.sys,'platform','darwin'):
            policy.throttle_disk(lib)
        lib.setiopolicy_np.assert_called_once_with(0,0,3)

    def test_failure_stops_instead_of_silently_scanning_at_normal_priority(self):
        lib=Mock()
        lib.setiopolicy_np.return_value=-1
        with patch.object(policy.sys,'platform','darwin'),self.assertRaises(OSError):
            policy.throttle_disk(lib)

    def test_linux_does_not_load_darwin_library(self):
        with patch.object(policy.sys,'platform','linux'),patch.object(policy.ctypes,'CDLL') as load:
            policy.throttle_disk()
        load.assert_not_called()

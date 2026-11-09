"""Run NowNow fixture tests offbox without macOS credential access."""
import sys
import types
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
if sys.platform != 'darwin':
    keychain=types.ModuleType('keychain')
    def unavailable(*args,**kwargs):
        raise AssertionError('Fixture tests must not access credentials')
    keychain.load=keychain.store=unavailable
    sys.modules['keychain']=keychain
package=types.ModuleType('test')
package.__path__=[str(Path(__file__).resolve().parent)]
sys.modules['test']=package
if __name__ == '__main__':
    suite=unittest.TestSuite(unittest.defaultTestLoader.discover('test', pattern=p) for p in ('test_*nownow*.py', 'test_food_capture_close.py', 'test_commerce_preorder*.py', 'test_commerce_journal.py', 'test_noon_visa_policy.py'))
    raise SystemExit(not unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful())

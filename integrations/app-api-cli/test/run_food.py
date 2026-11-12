"""Run Food fixture tests offbox without macOS credential access."""
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
suite=unittest.defaultTestLoader.discover('test',pattern='test_*food*.py')
raise SystemExit(not unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful())

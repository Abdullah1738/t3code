from pathlib import Path
import importlib.util
import tempfile
import unittest
import json
from unittest.mock import patch, Mock
spec = importlib.util.spec_from_file_location('overload_owned_suite', Path(__file__).with_name('suite.py'))
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)
class OwnedDirectories(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='overload-suite-test-')
        self.original = suite.DATA_ROOT
        suite.DATA_ROOT = Path(self.temporary.name) / 'data'
    def tearDown(self):
        suite.DATA_ROOT = self.original
        self.temporary.cleanup()
    def test_new_directory_and_previous_removed(self):
        first, proof = suite.reset_directory(3, 'A', None)
        self.assertTrue(proof['gone'])
        (Path(first['path']) / 'synthetic.fixture').write_text('fixture')
        second, removed = suite.reset_directory(4, 'B', first['path'])
        self.assertFalse(Path(first['path']).exists())
        self.assertTrue(removed['existedBefore'])
        self.assertTrue(removed['gone'])
        self.assertTrue(Path(second['path']).is_dir())
    def test_existing_target_never_reused(self):
        suite.reset_directory(3, 'A', None)
        with self.assertRaises(RuntimeError):
            suite.reset_directory(3, 'A', None)
    def test_invalid_directory_class_refused(self):
        for batch, arm in [(2, 'A'), (9, 'A'), (3, 'D'), (3, '../A'), ('3', 'A')]:
            with self.subTest(batch=batch, arm=arm), self.assertRaises(ValueError):
                suite.data_directory(batch, arm)
        outside = Path(self.temporary.name) / 'other'
        outside.mkdir()
        for path in [outside, suite.DATA_ROOT / '../other', suite.DATA_ROOT / '3-AA']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                suite.reset_directory(4, 'B', path)
        self.assertTrue(outside.exists())
    def test_symlink_cleanup_refused(self):
        suite.DATA_ROOT.mkdir()
        outside = Path(self.temporary.name) / 'outside'
        outside.mkdir()
        (suite.DATA_ROOT / '3-A').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            suite.reset_directory(4, 'B', suite.DATA_ROOT / '3-A')
        self.assertTrue(outside.exists())
    def test_root_symlink_is_refused_before_any_cleanup(self):
        outside = Path(self.temporary.name) / 'foreign'
        outside.mkdir()
        (outside / '3-A').mkdir()
        marker = outside / '3-A' / 'keep'
        marker.write_text('fixture')
        suite.DATA_ROOT.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            suite.reset_directory(4, 'B', suite.DATA_ROOT / '3-A')
        self.assertTrue(marker.exists())
class SetupCancellation(unittest.TestCase):
    def test_stop_before_setup_never_spawns(self):
        with patch.object(suite.subprocess, 'Popen') as spawn:
            with self.assertRaises(InterruptedError):
                suite.managed_run(['fixture-install'], Path('.'), lambda: True)
            spawn.assert_not_called()
    def test_stop_during_setup_terminates_the_captured_process_group(self):
        process = Mock(pid=987654)
        process.poll.side_effect = [None, None]
        with patch.object(suite.subprocess, 'Popen', return_value=process), patch.object(suite.os, 'killpg') as kill:
            stop = Mock(side_effect=[False, True])
            with self.assertRaises(InterruptedError):
                suite.managed_run(['fixture-install'], Path('.'), stop)
            kill.assert_called_once_with(987654, suite.signal.SIGTERM)
            process.wait.assert_called_once_with(timeout=5)
class CompletionEvidence(unittest.TestCase):
    def test_missing_truncated_and_join_failure_always_finish(self):
        for kind in ['missing', 'truncated', 'join']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(prefix='overload-completion-') as directory:
                root = Path(directory)
                (root / 'run').mkdir()
                if kind != 'missing':
                    (root / 'run/result.json').write_text('{' if kind == 'truncated' else '{}')
                with patch.object(suite, 'launch_links', side_effect=RuntimeError('fixture join failure')):
                    suite.finish_artifacts(root, 1)
                marker = json.loads((root / 'COMPLETE.json').read_text())
                self.assertEqual(marker['exitCode'], 1)
                self.assertEqual(marker['artifactError'] is not None, kind != 'missing')
if __name__ == '__main__':
    unittest.main()

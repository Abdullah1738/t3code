"""The ordinary and VM installers must stage the same importable server bundle."""
import ast
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class ServerBundle(unittest.TestCase):
    def test_vm_bundle_includes_logger_and_server_imports_without_repo_paths(self):
        server=Path(__file__).resolve().parents[3]/'server'
        tree=ast.parse((server/'home/vmtest/run.py').read_text())
        files=next(ast.literal_eval(node.value) for node in tree.body if isinstance(node,ast.Assign)
                   and any(isinstance(target,ast.Name) and target.id=='HOST_FILES' for target in node.targets))
        with tempfile.TemporaryDirectory() as tmp:
            for name in files: shutil.copyfile(server/name,Path(tmp)/Path(name).name)
            self.assertTrue((Path(tmp)/'toollog.py').is_file())
            subprocess.run([sys.executable,'-I','-c',
                            'import sys; sys.path.insert(0,sys.argv[1]); import boatd; assert callable(boatd.toollog.emit)',tmp],
                           check=True,capture_output=True,timeout=10)


if __name__=='__main__':unittest.main()

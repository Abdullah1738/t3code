"""Synthetic restic blobs only; production data is never opened here."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
import redact_backups
import redact_inspect
from redact_reader import BlobImage,sqlite_connection
import redact
import recall_cli
from redact_variant_fixtures import variants as selector_forms,NEEDLE as VARIANT_NEEDLE,assert_single_snapshot_refused

AVAILABLE=bool(os.environ.get('RECALL_RESTIC_READER')) and importlib.util.find_spec('apsw') is not None


@unittest.skipUnless(AVAILABLE,'build restic-reader and install APSW for diskless integration fixtures')
class ReaderTest(unittest.TestCase):
    def test_encoded_deleted_fts_variants_block_vfs_rewrite_and_prune(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'RESTIC_PASSWORD':'fixture-password'}):
            root=Path(tmp);repo=root/'repo';files=root/'files';files.mkdir();stage=root/'stage';stage.mkdir()
            needle=root/'needle';needle.write_bytes(VARIANT_NEEDLE);needle.chmod(0o600)
            for label,value in selector_forms().items():
                with contextlib.closing(sqlite3.connect(files/(label+'.db'))) as con:
                    con.execute("CREATE VIRTUAL TABLE episodic_text_fts USING fts5(value,content='',contentless_delete=1)")
                    con.execute('INSERT INTO episodic_text_fts(value) VALUES(?)',(value,))
                    con.execute("INSERT INTO episodic_text_fts(episodic_text_fts) VALUES('optimize')")
                    segments=list(con.execute('SELECT id,block FROM episodic_text_fts_data WHERE id>10'))
                    con.execute('DELETE FROM episodic_text_fts');con.commit();con.execute('VACUUM')
                    self.assertEqual(con.execute('SELECT count(*) FROM episodic_text_fts WHERE episodic_text_fts MATCH ?',(VARIANT_NEEDLE.decode(),)).fetchone()[0],0)
                    self.assertTrue(any(row in list(con.execute('SELECT id,block FROM episodic_text_fts_data WHERE id>10')) for row in segments))
            redact_backups.restic(repo,'init');redact_backups.restic(repo,'backup',str(files))
            before=redact_backups.restic(repo,'snapshots','--json',json_output=True);sid=before[0]['id']
            with patch.object(redact_inspect,'MAX_IMAGE_BYTES',1024):
                for node in redact_backups.nodes(repo,sid):
                    with self.subTest(form=Path(node['path']).stem):
                        try:result=redact_backups.inspect_dump(repo,sid,node['path'],VARIANT_NEEDLE,size=node['size'])
                        except redact.RedactionError:pass
                        else:self.assertGreater(result[0],0)
                original=redact_backups.restic
                with patch('redact_backups.restic',wraps=original) as calls,self.assertRaises(redact.RedactionError):
                    redact_backups.rewrite_repo(repo,None,VARIANT_NEEDLE,set(),dry_run=False)
                self.assertFalse(any(c.args[1] in ('rewrite','prune') for c in calls.call_args_list))
                output=io.StringIO();errors=io.StringIO()
                with contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors):
                    status=recall_cli.main(['redact-backups','--root',str(root),'--repository',str(repo),'--stage',str(stage),
                                          '--needle-file',str(needle),'--local-only','--yes'])
                self.assertNotEqual(status,0);self.assertFalse(json.loads(output.getvalue() or errors.getvalue())['verify'])
                self.assertFalse(VARIANT_NEEDLE.decode() in output.getvalue()+errors.getvalue())
                for label in ('unicode-lower','nested-stringified'):
                    with self.subTest(single_snapshot=label):
                        assert_single_snapshot_refused(self,root/('repo-'+label),files/(label+'.db'))
            self.assertEqual(redact_backups.restic(repo,'snapshots','--json',json_output=True),before)
            self.assertEqual(redact_backups.restic(repo,'list','locks').splitlines(),[])

    def test_seekable_sqlite_matches_and_preserves_clean(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'RESTIC_PASSWORD':'fixture-password'}):
            root=Path(tmp);repo=root/'repo';files=root/'files';files.mkdir()
            for label,value in (('clean','safe content'),('dirty','fakeprivateprefix98765')):
                with sqlite3.connect(files/(label+'.db')) as con:
                    con.execute('CREATE TABLE sample(value TEXT)');con.execute('INSERT INTO sample VALUES(?)',(value,))
            redact_backups.restic(repo,'init');redact_backups.restic(repo,'backup',str(files))
            sid=redact_backups.restic(repo,'snapshots','--json',json_output=True)[0]['id']
            with contextlib.closing(BlobImage(repo,sid,str(files/'clean.db'))) as image:
                with sqlite_connection(image) as con:
                    self.assertEqual(con.execute('SELECT value FROM sample').fetchone()[0],'safe content')
                    with self.assertRaises(Exception):con.execute("UPDATE sample SET value='bad'")
            with patch.object(redact_inspect,'MAX_IMAGE_BYTES',1024):
                result=redact_backups.rewrite_repo(repo,None,b'fakeprivateprefix98765',set(),dry_run=False)
            self.assertEqual(result['remainingAfter'],0)
            for snap in redact_backups.restic(repo,'snapshots','--json',json_output=True):
                self.assertEqual([n['path'] for n in redact_backups.nodes(repo,snap['id'])],[str(files/'clean.db')])
            self.assertEqual(redact_backups.restic(repo,'list','locks').splitlines(),[])

    def test_helper_closes_read_lock_after_parser_error(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'RESTIC_PASSWORD':'fixture-password'}):
            root=Path(tmp);repo=root/'repo';path=root/'invalid.db'
            path.write_bytes(b'SQLite format 3\0'+b'\0'*4096)
            redact_backups.restic(repo,'init');redact_backups.restic(repo,'backup',str(path))
            with patch.object(redact_inspect,'MAX_IMAGE_BYTES',1024),self.assertRaises(Exception):
                redact_backups.rewrite_repo(repo,None,b'fake-selector',set(),dry_run=False)
            self.assertEqual(redact_backups.restic(repo,'list','locks').splitlines(),[])

    def test_large_sqlite_does_not_use_deserialize(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'RESTIC_PASSWORD':'fixture-password'}):
            root=Path(tmp);repo=root/'repo';path=root/'large.db'
            with sqlite3.connect(path) as con:
                con.execute('PRAGMA secure_delete=ON')
                con.execute('CREATE TABLE sample(value BLOB)')
                for _ in range(9):con.execute('INSERT INTO sample VALUES(zeroblob(16777216))')
                con.commit();con.execute('VACUUM')
            self.assertGreater(path.stat().st_size,128<<20)
            redact_backups.restic(repo,'init');redact_backups.restic(repo,'backup',str(path))
            sid=redact_backups.restic(repo,'snapshots','--json',json_output=True)[0]['id']
            with patch.object(redact_inspect,'sqlite_hits',side_effect=AssertionError('whole image path used')):
                hits,container=redact_backups.inspect_dump(repo,sid,str(path),b'fake-selector',size=path.stat().st_size)
            self.assertEqual((hits,container),(0,True))
            self.assertEqual(redact_backups.restic(repo,'list','locks').splitlines(),[])

    def test_random_ranges_beyond_100gib_use_existing_encrypted_blobs(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'RESTIC_PASSWORD':'fixture-password'}):
            root=Path(tmp);repo=root/'repo';path=root/'chunk.bin'
            path.write_bytes(b'X'*(8<<20))
            redact_backups.restic(repo,'init');redact_backups.restic(repo,'backup',str(path))
            sid=redact_backups.restic(repo,'snapshots','--json',json_output=True)[0]['id']
            tree=redact_backups.restic(repo,'cat','tree',sid+':'+str(root),json_output=True)
            node=next(n for n in tree['nodes'] if n['name']==path.name)
            # Reuse real encrypted chunks as a large logical file: no100GiB allocation.
            logical=dict(node,size=node['size']*14000,content=node['content']*14000)
            with patch('redact_backups.restic',return_value={'nodes':[logical]}):
                with contextlib.closing(BlobImage(repo,sid,str(path))) as image:
                    self.assertGreater(len(image),100<<30)
                    self.assertEqual(image[(100<<30)+123:(100<<30)+155],b'X'*32)
                    self.assertEqual(image[len(image)-20:len(image)],b'X'*20)
            self.assertEqual(redact_backups.restic(repo,'list','locks').splitlines(),[])

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

AVAILABLE=bool(os.environ.get('RECALL_RESTIC_READER')) and importlib.util.find_spec('apsw') is not None


@unittest.skipUnless(AVAILABLE,'build restic-reader and install APSW for diskless integration fixtures')
class ReaderTest(unittest.TestCase):
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

"""Synthetic-only fixtures; also runnable with unittest on the host."""
import contextlib
import importlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import zlib

SRC = Path(__file__).resolve().parents[1]/'src'
sys.path.insert(0,str(SRC))
import build_text_fts
import redact
import redact_backups
import recall_cli
import redact_guard
from redact_lock import fence

TOKEN = 'fabricatedcredentialquartz98765'
SID = 'fixture-session'
ITEM = 'fixture-tool-item'


@contextlib.contextmanager
def connect(path):
    con=sqlite3.connect(path)
    try:
        with con:
            yield con
    finally:
        con.close()


class RedactTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root/'data').mkdir()
        (self.root/'logs').mkdir()
        self.needle = self.root/'needle'
        self.needle.write_text(TOKEN)
        self.needle.chmod(0o600)
        self.db = self.root/'data/memory.db'
        with connect(self.db) as con:
            con.executescript((SRC/'schema.sql').read_text())
            build_text_fts.setup(con)
            for turn, content, ctype in [('tool',TOKEN,'tool_result'),('text',TOKEN,'text'),('keep','unrelated row','text')]:
                con.execute('INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,content_type,metadata_json) VALUES(?,?,?,0,?,?,?,?)',
                    ('codex',SID,turn,'assistant',content,ctype,json.dumps({'call_id':ITEM}) if turn=='tool' else '{}'))
            con.commit()
        self.args = types.SimpleNamespace(root=str(self.root),session=None,item=None,needle_file=str(self.needle),reason='fixture',yes=True,dry_run=False)

    def tearDown(self):
        self.tmp.cleanup()

    def test_all_stores_fts_pages_and_output(self):
        log = self.root/'logs/recall-inject.jsonl'
        log.write_text(json.dumps({'note':TOKEN})+'\nkeep\n')
        log.chmod(0o640)
        raw = self.root/'data/opencode_raw.db'
        with connect(raw) as con:
            con.execute('CREATE TABLE raw_messages(id TEXT PRIMARY KEY,session_id TEXT,data_zlib BLOB,sha256 TEXT,raw_size INTEGER)')
            con.execute('INSERT INTO raw_messages VALUES(?,?,?,?,?)',('msg',SID,zlib.compress(json.dumps({'text':TOKEN}).encode()),'old-digest',9))
        catalog = self.root/'data/recall_catalog.db'
        with connect(catalog) as con:
            con.execute('CREATE TABLE sessions(session_id TEXT PRIMARY KEY,first_prompt TEXT)')
            con.execute('INSERT INTO sessions VALUES(?,?)',(SID,TOKEN))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = recall_cli.main(['redact','--root',str(self.root),'--needle-file',str(self.needle),'--reason','fixture','--yes'])
        self.assertEqual(rc,0,err.getvalue())
        result = json.loads(out.getvalue())
        self.assertTrue(result['verify'])
        self.assertNotIn(TOKEN,out.getvalue()+err.getvalue())
        with connect(self.db) as con:
            for fts in ('episodic_fts','episodic_text_fts'):
                self.assertEqual(con.execute(f'SELECT count(*) FROM {fts} WHERE {fts} MATCH ?', (TOKEN,)).fetchone()[0],0)
            self.assertEqual(con.execute("SELECT content FROM episodic_events WHERE turn_id='keep'").fetchone()[0],'unrelated row')
            self.assertTrue(con.execute("SELECT content FROM episodic_events WHERE turn_id='tool'").fetchone()[0].startswith('[redacted'))
            self.assertEqual(con.execute('PRAGMA freelist_count').fetchone()[0],0)
        for path in (self.root/'data').glob('*'):
            if path.is_file():
                self.assertEqual(redact.byte_hits(path,TOKEN.encode()),0)
        with connect(raw) as con:
            self.assertNotIn(TOKEN,zlib.decompress(con.execute('SELECT data_zlib FROM raw_messages').fetchone()[0]).decode())
        self.assertEqual(log.stat().st_mode & 0o777,0o640)
        self.assertEqual(log.read_text().splitlines()[1],'keep')

    def test_item_without_needle_and_dry_run(self):
        self.args.needle_file = None
        self.args.session, self.args.item = SID, ITEM
        self.args.dry_run = True
        before = self.db.read_bytes()
        result = redact.run(self.args)
        self.assertEqual(before,self.db.read_bytes())
        self.assertFalse(result['verify'])
        self.args.dry_run = False
        self.assertTrue(redact.run(self.args)['verify'])
        with connect(self.db) as con:
            self.assertEqual(con.execute("SELECT content FROM episodic_events WHERE turn_id='text'").fetchone()[0],TOKEN)

    def test_needle_forms_json_logs_and_compressed_archive(self):
        for fake in ('a"quote\\path', 'unicode-雪-token', 'token.with+punctuation/='):
            with self.subTest(form=fake):
                self.needle.write_text(fake)
                log=self.root/'logs/escaped.jsonl'
                log.write_text(json.dumps({'note':fake})+'\nkeep\n')
                result=redact.run(self.args)
                self.assertTrue(result['verify'])
                self.assertFalse(redact.contains(log.read_bytes(),fake.encode()))
        if shutil.which('zstd'):
            archive=self.root/'logs/transcript.jsonl.zst'
            archive.write_bytes(subprocess.run(['zstd','-q','-c'],input=(json.dumps({'note':fake})+'\nkeep\n').encode(),capture_output=True,check=True).stdout)
            result=redact.run(self.args)
            self.assertTrue(result['verify'])
            decoded=subprocess.run(['zstd','-dc',str(archive)],capture_output=True,check=True).stdout
            self.assertFalse(redact.contains(decoded,fake.encode()))
            self.assertIn(b'keep',decoded)

    def test_nested_stringified_json_forms(self):
        escaped=''.join('\\u%04x'%ord(c) for c in TOKEN)
        # Tool JSON may contain serialized JSON, through several transport layers.
        for depth in (0,1,2,4):
            for wrapper in ('json','log','stringified-log'):
                with self.subTest(depth=depth,wrapper=wrapper):
                    value='{"credential":"'+escaped+'"}'
                    for _ in range(depth):value=json.dumps({'tool_result':value})
                    encoded=value if wrapper=='json' else 'tool output: '+value
                    if wrapper=='stringified-log':encoded=json.dumps({'tool_result':encoded})
                    self.assertTrue(redact.contains(encoded,TOKEN.encode()))
                    path=self.root/'logs/nested.jsonl';path.write_text(encoded+'\n')
                    self.assertTrue(redact.run(self.args)['verify'])
                    self.assertFalse(redact.contains(path.read_bytes(),TOKEN.encode()))

    def test_stale_external_fts_and_hot_contentless_index(self):
        # Simulate the unsafe pre-upgrade trigger leaving an original token.
        with connect(self.db) as con:
            con.execute('DROP TRIGGER episodic_fts_update')
            con.execute("UPDATE episodic_events SET content='already rewritten' WHERE turn_id='text'")
            self.assertGreater(con.execute('SELECT count(*) FROM episodic_fts WHERE episodic_fts MATCH ?',(TOKEN,)).fetchone()[0],0)
        self.assertTrue(redact.run(self.args)['verify'])
        with connect(self.db) as con:
            self.assertEqual(con.execute('SELECT count(*) FROM episodic_fts WHERE episodic_fts MATCH ?',(TOKEN,)).fetchone()[0],0)
        hot=self.root/'data/recall_hot.db'
        with connect(hot) as con:
            con.execute('CREATE TABLE episodic_events(id INTEGER PRIMARY KEY,source TEXT,session_id TEXT,turn_id TEXT,timestamp INTEGER,speaker TEXT,content TEXT,content_type TEXT,model TEXT,tokens_used INTEGER,metadata_json TEXT,content_fts TEXT)')
            con.execute("INSERT INTO episodic_events VALUES(1,'codex',?,'hot',0,'user',?,'text',NULL,NULL,NULL,NULL)",(SID,TOKEN))
            con.execute("CREATE VIRTUAL TABLE episodic_fts USING fts5(content,content='',contentless_delete=1)")
            con.execute('INSERT INTO episodic_fts(rowid,content) VALUES(1,?)',(TOKEN,))
            con.commit()
            build_text_fts.setup(con)
            con.execute("INSERT INTO episodic_text_fts(rowid,content,source,session_id,speaker,ts) VALUES(1,?,'codex',?,'user',0)",(TOKEN,SID))
        self.assertTrue(redact.run(self.args)['verify'])
        with connect(hot) as con:
            for fts in ('episodic_fts','episodic_text_fts'):
                self.assertEqual(con.execute(f'SELECT count(*) FROM {fts} WHERE {fts} MATCH ?',(TOKEN,)).fetchone()[0],0)

    def test_item_tombstones_are_scoped_and_errors_never_quote_payloads(self):
        self.args.session,self.args.item,self.args.needle_file=SID,ITEM,None
        with connect(self.db) as con:
            con.execute('INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,content_type,metadata_json) VALUES(?,?,?,0,?,?,?,?)',
                ('codex','other-session','tool','assistant','keep other session','tool_result',json.dumps({'call_id':ITEM})))
        self.assertTrue(redact.run(self.args)['verify'])
        with connect(self.db) as con:
            content,meta=redact_guard.event(con,'codex','other-session','tool','keep other session',json.dumps({'call_id':ITEM}))
            self.assertEqual(content,'keep other session')
            self.assertEqual(con.execute("SELECT content FROM episodic_events WHERE session_id='other-session'").fetchone()[0],'keep other session')
        self.args.needle_file=str(self.needle)
        out,err=io.StringIO(),io.StringIO()
        with patch('redact.sweep',side_effect=RuntimeError(TOKEN)),contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
            code=recall_cli.main(['redact','--root',str(self.root),'--needle-file',str(self.needle),'--reason','fixture','--yes'])
        self.assertEqual(code,2)
        self.assertNotIn(TOKEN,out.getvalue()+err.getvalue())

    def test_hot_fulltext_beyond_excerpt_is_removed_by_cold_event_id(self):
        hot=self.root/'data/recall_hot.db'
        with connect(hot) as con:
            con.execute('CREATE TABLE episodic_events(id INTEGER PRIMARY KEY,source TEXT,session_id TEXT,turn_id TEXT,timestamp INTEGER,speaker TEXT,content TEXT,content_type TEXT,model TEXT,tokens_used INTEGER,metadata_json TEXT,content_fts TEXT)')
            con.execute("INSERT INTO episodic_events VALUES(2,'codex',?,'text',0,'assistant',?,'text',NULL,NULL,NULL,NULL)",(SID,'safe excerpt '*700))
            for fts in ('episodic_fts','episodic_text_fts'):
                if fts=='episodic_fts':
                    con.execute(f"CREATE VIRTUAL TABLE {fts} USING fts5(content,content='',contentless_delete=1)")
                    con.execute(f'INSERT INTO {fts}(rowid,content) VALUES(2,?)',('safe excerpt '*700+TOKEN,))
                else:
                    con.commit();build_text_fts.setup(con)
                    con.execute(f"INSERT INTO {fts}(rowid,content,source,session_id,speaker,ts) VALUES(2,?,'codex',?,'assistant',0)",('safe excerpt '*700+TOKEN,SID))
        def commit_then_fail(con):
            con.commit()
            raise redact.RedactionError('fixture cold checkpoint failure')
        with patch('redact.compact',side_effect=commit_then_fail),self.assertRaises(redact.RedactionError):
            redact.run(self.args)
        with connect(hot) as con:
            self.assertGreater(con.execute('SELECT count(*) FROM episodic_fts WHERE episodic_fts MATCH ?',(TOKEN,)).fetchone()[0],0)
        self.assertTrue(redact.run(self.args)['verify'])
        with connect(hot) as con:
            for fts in ('episodic_fts','episodic_text_fts'):
                self.assertEqual(con.execute(f'SELECT count(*) FROM {fts} WHERE {fts} MATCH ?',(TOKEN,)).fetchone()[0],0)

    def test_escaped_hot_selection_survives_cold_commit_failure(self):
        hot=self.root/'data/recall_hot.db'
        escaped=''.join('\\u%04x'%ord(c) for c in TOKEN)
        with connect(self.db) as con:
            con.execute("UPDATE episodic_events SET content=? WHERE turn_id='text'",('{"note":"'+escaped+'"}',))
        with connect(hot) as con:
            con.execute('CREATE TABLE episodic_events(id INTEGER PRIMARY KEY,source TEXT,session_id TEXT,turn_id TEXT,timestamp INTEGER,speaker TEXT,content TEXT,content_type TEXT,model TEXT,tokens_used INTEGER,metadata_json TEXT,content_fts TEXT)')
            con.execute("INSERT INTO episodic_events VALUES(2,'codex',?,'text',0,'assistant',?,'text',NULL,NULL,NULL,NULL)",(SID,'safe excerpt '*700))
            con.execute("CREATE VIRTUAL TABLE episodic_fts USING fts5(content,content='',contentless_delete=1)")
            con.execute('INSERT INTO episodic_fts(rowid,content) VALUES(2,?)',('safe excerpt '*700+escaped,))
            con.commit();build_text_fts.setup(con)
            con.execute("INSERT INTO episodic_text_fts(rowid,content,source,session_id,speaker,ts) VALUES(2,?,'codex',?,'assistant',0)",('safe excerpt '*700+escaped,SID))
        def commit_then_fail(con):
            con.commit()
            raise redact.RedactionError('fixture cold checkpoint failure')
        with patch('redact.compact',side_effect=commit_then_fail),self.assertRaises(redact.RedactionError):
            redact.run(self.args)
        with connect(self.db) as con:
            self.assertIn((2,),con.execute('SELECT event_id FROM recall_redacted_events').fetchall())
        self.assertTrue(redact.run(self.args)['verify'])
        with connect(hot) as con:
            query='"'+escaped+'"'
            for fts in ('episodic_fts','episodic_text_fts'):
                self.assertEqual(con.execute(f'SELECT count(*) FROM {fts} WHERE {fts} MATCH ?',(query,)).fetchone()[0],0)

    def test_intersecting_tombstone_identity_rolls_back_without_retaining_literal(self):
        with connect(self.db) as con:
            con.execute("UPDATE episodic_events SET turn_id=? WHERE turn_id='text'",(TOKEN,))
        with self.assertRaises(redact.RedactionError):
            redact.run(self.args)
        with connect(self.db) as con:
            self.assertFalse(con.execute("SELECT 1 FROM sqlite_master WHERE name='recall_redacted_ids'").fetchone())

    def test_generation_changes_before_a_committed_partial_failure(self):
        generation=self.root/'logs/state/redaction.generation'
        generation.parent.mkdir(parents=True);generation.write_text('before')
        def commit_then_fail(con):
            con.commit()
            raise redact.RedactionError('fixture checkpoint failure')
        with patch('redact.compact',side_effect=commit_then_fail),self.assertRaises(redact.RedactionError):
            redact.run(self.args)
        self.assertNotEqual(generation.read_text(),'before')
        with connect(self.db) as con:
            self.assertTrue(con.execute("SELECT content FROM episodic_events WHERE turn_id='tool'").fetchone()[0].startswith('[redacted'))

    def test_codex_identifier_free_raw_record_cannot_return_after_replay(self):
        home=self.root/'codex';source=home/'sessions/2026/10/31/rollout-fixture.jsonl';source.parent.mkdir(parents=True)
        meta={'type':'session_meta','payload':{'id':SID,'session_id':SID}}
        def msg(text):
            return {'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':text}]}}
        original=''.join(json.dumps(r)+'\n' for r in (meta,msg(TOKEN),msg('keep codex')))
        source.write_text(original)
        with patch.dict(os.environ,{'MEMORY_DB':str(self.db),'HARNESS_SEEDED_MANIFEST':str(self.root/'absent')}):
            import sync_codex
            sync_codex=importlib.reload(sync_codex)
            roots=[{'driver':'codex','instance':'fixture','root':str(home),'path':str(home),'exists':True}]
            def sync():
                worker=sync_codex.CodexSync(types.SimpleNamespace(deadline=0),roots=roots)
                try:
                    with contextlib.redirect_stdout(io.StringIO()):worker.run()
                finally:worker.mem.close()
            sync()
            source.write_text(original.replace(TOKEN,'removed'))
            self.assertTrue(redact.run(self.args)['verify'])
            # Both identical replay and an inserted earlier record must be safe:
            # the latter changes ordinal-derived projected turn ids.
            for earlier in (False,True):
                source.write_text(original.replace(json.dumps(meta)+'\n',
                    json.dumps(meta)+'\n'+(json.dumps(msg('earlier clean row'))+'\n' if earlier else '')))
                sync()
            with connect(self.db) as con:
                self.assertFalse(any(TOKEN.encode() in r[0] for r in con.execute('SELECT raw FROM native_capture_raw')))
                self.assertFalse(any(TOKEN in r[0] for r in con.execute('SELECT content FROM episodic_events')))

    def test_progress_reset_is_limited_to_affected_sources(self):
        import transcript_capture
        with connect(self.db) as con:
            transcript_capture.ensure_schema(con)
            for path,sid in (('/fixture/affected.jsonl',SID),('/fixture/unaffected.jsonl','other-session')):
                con.execute('INSERT INTO native_capture_files(path,logical,session_key,offset) VALUES(?,?,?,123)',(path,path,sid))
            con.execute('CREATE TABLE muse_sync_files(path TEXT PRIMARY KEY,session_id TEXT,offset INTEGER,size INTEGER,mtime_ns INTEGER,state_json TEXT,head_sha TEXT)')
            con.execute('CREATE TABLE opencode_sync_export_progress(session_id TEXT PRIMARY KEY,applied_seq INTEGER)')
            con.execute('CREATE TABLE opencode_sync_messages(msg_id TEXT PRIMARY KEY,session_id TEXT)')
            con.execute('CREATE TABLE opencode_sync_payloads(msg_id TEXT PRIMARY KEY,sha256 TEXT)')
            for path,sid in (('/fixture/affected-muse.jsonl',SID),('/fixture/unaffected-muse.jsonl','other-session')):
                con.execute('INSERT INTO muse_sync_files VALUES(?,?,123,123,123,?,?)',(path,sid,'{}','fingerprint'))
                con.execute('INSERT INTO opencode_sync_export_progress VALUES(?,123)',(sid,))
                con.execute('INSERT INTO opencode_sync_messages VALUES(?,?)',(sid,sid))
                con.execute('INSERT INTO opencode_sync_payloads VALUES(?,?)',(sid,'fingerprint'))
        self.assertTrue(redact.run(self.args)['verify'])
        with connect(self.db) as con:
            self.assertEqual(con.execute('SELECT retired FROM native_capture_files WHERE session_key=?',(SID,)).fetchone()[0],1)
            self.assertEqual(con.execute("SELECT retired,offset FROM native_capture_files WHERE session_key='other-session'").fetchone(),(0,123))
            self.assertEqual(con.execute('SELECT offset FROM muse_sync_files WHERE session_id=?',(SID,)).fetchone()[0],0)
            self.assertEqual(con.execute("SELECT offset FROM muse_sync_files WHERE session_id='other-session'").fetchone()[0],123)
            self.assertEqual(con.execute('SELECT * FROM opencode_sync_export_progress').fetchall(),[('other-session',123)])
            self.assertEqual(con.execute('SELECT * FROM opencode_sync_payloads').fetchall(),[('other-session','fingerprint')])
        self.assertEqual((Path(str(self.db)+'-wal').stat().st_size if Path(str(self.db)+'-wal').exists() else 0),0)

    def test_fence_refuses_interleaving_and_unsafe_file(self):
        with fence(self.root):
            with self.assertRaises(BlockingIOError):
                redact.run(self.args)
        self.needle.chmod(0o644)
        with self.assertRaises(redact.RedactionError):
            redact.run(self.args)

    def test_shorter_source_replayed_without_loss_and_stale_item_suppressed(self):
        # Same Claude path and UUIDs, shorter replacement; appended row was never
        # captured before maintenance. Neither EOF fast-forward nor old offsets work.
        home = self.root/'claude'
        source = home/'projects/repo/session.jsonl'
        source.parent.mkdir(parents=True)
        def rec(uid,text,tool=False):
            return {'uuid':uid,'sessionId':SID,'type':'assistant','message':{'role':'assistant','content':
                [{'type':'tool_result','tool_use_id':ITEM,'content':text}] if tool else [{'type':'text','text':text}]}}
        def write(records):
            source.write_text(''.join(json.dumps(r)+'\n' for r in records))
        with patch.dict(os.environ,{'MEMORY_DB':str(self.db),'HARNESS_SEEDED_MANIFEST':str(self.root/'absent')}):
            import sync_claude
            sync_claude = importlib.reload(sync_claude)
            roots=[{'driver':'claudeAgent','instance':'fixture','root':str(home),'path':str(home),'exists':True}]
            def sync():
                worker=sync_claude.ClaudeSync(types.SimpleNamespace(deadline=0),roots=roots)
                try:
                    with contextlib.redirect_stdout(io.StringIO()):
                        worker.run()
                finally:
                    worker.mem.close()
            write([rec('tool-uuid',TOKEN*10,True),rec('keep-uuid','keep this')])
            sync()
            write([rec('tool-uuid','[removed]',True),rec('keep-uuid','keep this'),rec('new-uuid','new content')])
            self.assertTrue(redact.run(self.args)['verify'])
            sync()
            with connect(self.db) as con:
                text=' '.join(r[0] for r in con.execute('SELECT content FROM episodic_events'))
                self.assertNotIn(TOKEN,text)
                self.assertIn('keep this',text)
                self.assertIn('new content',text)
            # A stale source copy can return later; identifiers suppress both
            # the raw journal and projections without retaining a needle rule.
            write([rec('tool-uuid',TOKEN*10,True),rec('keep-uuid','keep this'),rec('new-uuid','new content')])
            sync()
            with connect(self.db) as con:
                for row in con.execute('SELECT raw FROM native_capture_raw'):
                    self.assertNotIn(TOKEN.encode(),row[0])
                self.assertNotIn(TOKEN,' '.join(r[0] for r in con.execute('SELECT content FROM episodic_events')))


@unittest.skipUnless(shutil.which('restic'),'restic not installed')
class BackupTest(unittest.TestCase):
    def test_rewrite_two_snapshots_and_prune_removes_packs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); stage=root/'replica'; stage.mkdir(); repo=root/'repo'
            needle=root/'needle'; needle.write_text(TOKEN); needle.chmod(0o600)
            with patch.dict(os.environ,{'RESTIC_PASSWORD':'fixture-password'}):
                redact_backups.restic(repo,'init')
                dirty=stage/'tool.jsonl'; dirty.write_text(json.dumps({'content':TOKEN})+'\n')
                (stage/'keep.txt').write_text('keep')
                escaped=''.join('\\u%04x'%ord(c) for c in TOKEN)
                (stage/'escaped.jsonl').write_text('{"note":"'+escaped+'"}\n')
                (stage/'pretty.json').write_text('{\n  "note":"'+escaped+'"\n}\n')
                # Header classification must cover the whole filename class,
                # including the cold archive's legacy names and suffixless files.
                containers=('state.db','state.sqlite','state.sqlite3','state.db.pre-codex-import','state.bak','state')
                for name in containers:
                    with connect(stage/name) as con:
                        con.execute('CREATE TABLE raw_sessions(id TEXT PRIMARY KEY,row_json_zlib BLOB)')
                        con.execute('INSERT INTO raw_sessions VALUES(?,?)',('fixture',zlib.compress(json.dumps({'note':TOKEN}).encode())))
                redact_backups.restic(repo,'backup',str(stage))
                (stage/'second.txt').write_text('second')
                redact_backups.restic(repo,'backup',str(stage))
                args=types.SimpleNamespace(root=str(root),repository=str(repo),stage=str(stage),needle_file=str(needle),
                    paths_from=None,dry_run=False,yes=True,local_only=True)
                out,err=io.StringIO(),io.StringIO()
                with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
                    result=redact_backups.run(args)
                self.assertTrue(result['verify'])
                self.assertGreater(result['stores'][str(repo.resolve())]['packsRemoved'],0)
                self.assertNotIn(TOKEN,out.getvalue()+err.getvalue())
                snapshots=redact_backups.restic(repo,'snapshots','--json',json_output=True)
                self.assertGreaterEqual(len(snapshots),2)
                for snap in snapshots:
                    for node in redact_backups.nodes(repo,snap['id']):
                        if Path(node['path']).name in containers:
                            self.assertEqual(snap.get('tags'),['memory-live'])
                        else:
                            self.assertEqual(redact_backups.dump_hits(repo,snap['id'],node['path'],TOKEN.encode()),0)
                self.assertEqual((stage/'keep.txt').read_text(),'keep')

    def test_container_inspection_releases_restic_read_lock(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'RESTIC_PASSWORD':'fixture-password'}):
            root=Path(tmp);repo=root/'repo';db=root/'large.sqlite'
            with connect(db) as con:
                con.execute('CREATE TABLE fixture(payload BLOB)')
                con.execute('INSERT INTO fixture VALUES(?)',(b'x'*(2*1024*1024),))
            redact_backups.restic(repo,'init')
            redact_backups.restic(repo,'backup',str(db))
            snap=redact_backups.restic(repo,'snapshots','--json',json_output=True)[0]['id']
            self.assertEqual(redact_backups.inspect_dump(repo,snap,str(db),TOKEN.encode()),(0,True))
            self.assertEqual(redact_backups.restic(repo,'list','locks').splitlines(),[])

    def test_transcript_manifests_are_rebuilt_after_redaction(self):
        import transcript_backup_manifest as manifests
        with tempfile.TemporaryDirectory() as tmp:
            stage=Path(tmp);transcripts=stage/'files/transcripts';transcripts.mkdir(parents=True)
            raw=transcripts/'session.jsonl';raw.write_text(TOKEN+'\n')
            directory=stage/'files/transcript-manifest'
            old=Path(manifests.write(manifests.build(str(transcripts)),str(directory)))
            redact.redact_file(raw,TOKEN.encode(),'[redacted backup]')
            self.assertTrue(manifests.verify(json.loads(old.read_text()),str(transcripts)))
            current=redact_backups.refresh_manifests(stage)
            for manifest in (old,current):
                self.assertFalse(manifests.verify(json.loads(manifest.read_text()),str(transcripts)))

    def test_cold_archive_and_both_mirrors(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'RESTIC_PASSWORD':'fixture-password'}):
            root=Path(tmp).resolve(); stage=root/'replica';stage.mkdir()
            repo=root/'live'; cold=root/'cold';needle=root/'needle';needle.write_text(TOKEN);needle.chmod(0o600)
            dirty=stage/'old.jsonl';dirty.write_text(TOKEN+'\n')
            for archive in (repo,cold):
                redact_backups.restic(archive,'init')
                redact_backups.restic(archive,'backup',str(stage))
            args=types.SimpleNamespace(root=str(root),repository=str(repo),stage=str(stage),needle_file=str(needle),
                paths_from=None,dry_run=False,yes=True,local_only=False,cold_repository=str(cold),
                dropbox_destination='/fixture/live',cold_destination='/fixture/cold')
            calls=[]
            def checked_mirror(archive,destination):
                calls.append(destination)
                for snap in redact_backups.restic(archive,'snapshots','--json',json_output=True):
                    for node in redact_backups.nodes(archive,snap['id']):
                        self.assertEqual(redact_backups.dump_hits(archive,snap['id'],node['path'],TOKEN.encode()),0)
                return {'matchedBefore':1,'replaced':1,'remainingAfter':0}
            with patch('redact_backups.mirror',side_effect=checked_mirror):
                result=redact_backups.run(args)
            self.assertTrue(result['verify'])
            self.assertFalse(result['dropboxHistoryPurged'])
            self.assertIsNone(result['dropboxRetentionDays'])
            self.assertEqual(calls,['/fixture/live','/fixture/cold'])
            self.assertGreater(result['stores'][str(cold)]['packsRemoved'],0)


if __name__=='__main__':
    unittest.main()

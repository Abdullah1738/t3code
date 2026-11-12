"""Synthetic-only fixtures; also runnable with unittest on the host."""
import contextlib
import importlib
import gzip
import zipfile
import io
import json
import os
from pathlib import Path
import shutil
import struct
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
import redact_inspect
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

    def test_claude_record_tombstones_survive_block_reordering(self):
        home=self.root/'claude';source=home/'projects/repo/session.jsonl';source.parent.mkdir(parents=True)
        def record(blocks):
            return {'uuid':'stable-record','sessionId':SID,'type':'assistant','message':{'role':'assistant','content':blocks}}
        safe={'type':'text','text':'safe original block'}
        sensitive={'type':'text','text':TOKEN}
        with patch.dict(os.environ,{'MEMORY_DB':str(self.db),'HARNESS_SEEDED_MANIFEST':str(self.root/'absent')}):
            import sync_claude
            sync_claude=importlib.reload(sync_claude)
            roots=[{'driver':'claudeAgent','instance':'fixture','root':str(home),'path':str(home),'exists':True}]
            def sync():
                worker=sync_claude.ClaudeSync(types.SimpleNamespace(deadline=0),roots=roots)
                try:
                    with contextlib.redirect_stdout(io.StringIO()):worker.run()
                finally:worker.mem.close()
            source.write_text(json.dumps(record([safe,sensitive]))+'\n')
            sync()
            with connect(self.db) as con:
                con.execute("UPDATE episodic_events SET metadata_json=json_remove(metadata_json,'$.uuid') WHERE source='claude'")
            source.write_text(json.dumps(record([safe,{'type':'text','text':'removed'}]))+'\n')
            self.assertTrue(redact.run(self.args)['verify'])
            # UUID identifies the record independently of block positions/types.
            variants={
                'unchanged':[safe,sensitive],
                'prepend-text':[{'type':'text','text':'earlier'},safe,sensitive],
                'prepend-thinking':[{'type':'thinking','thinking':'earlier reasoning'},safe,sensitive],
                'prepend-tool':[{'type':'tool_use','id':'safe-call','name':'noop','input':{}},safe,sensitive],
                'reorder':[sensitive,safe],
            }
            unrelated=dict(record([{'type':'text','text':'unrelated record stays'}]),uuid='unrelated-record')
            for shape,blocks in variants.items():
                with self.subTest(shape=shape):
                    source.write_text(json.dumps(record(blocks))+'\n'+json.dumps(unrelated)+'\n')
                    sync()
                    with connect(self.db) as con:
                        self.assertFalse(any(TOKEN in r[0] for r in con.execute('SELECT content FROM episodic_events')))
                        self.assertFalse(any(TOKEN.encode() in r[0] for r in con.execute('SELECT raw FROM native_capture_raw')))
                        self.assertEqual(con.execute("SELECT content FROM episodic_events WHERE turn_id='unrelated-record:0'").fetchone()[0],'unrelated record stays')


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

    def test_preserve_clean_historical_containers(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'RESTIC_PASSWORD':'fixture-password'}):
            root=Path(tmp);repo=root/'repo';files=root/'files';files.mkdir()
            payload=(json.dumps({'text':'clean transcript'})+'\n').encode()
            dirty=(json.dumps({'text':TOKEN})+'\n').encode()
            for name,text in (('clean.db.pre-codex-import','clean value'),('dirty.sqlite',TOKEN)):
                with connect(files/name) as con:
                    con.execute('CREATE TABLE raw_sessions(id TEXT PRIMARY KEY,row_json_zlib BLOB)')
                    con.execute('INSERT INTO raw_sessions VALUES(?,?)',('fixture',zlib.compress(json.dumps({'text':text}).encode())))
            for label,data in (('clean',payload),('dirty',dirty)):
                (files/(label+'.jsonl.gz')).write_bytes(gzip.compress(data))
                with zipfile.ZipFile(files/(label+'.zip'),'w',compression=zipfile.ZIP_DEFLATED) as archive:
                    archive.writestr('transcript.jsonl',data)
                if shutil.which('zstd'):
                    (files/(label+'.jsonl.zst')).write_bytes(subprocess.run(['zstd','-q','-c'],input=data,capture_output=True,check=True).stdout)
            clean={str(p):p.read_bytes() for p in files.iterdir() if p.name.startswith('clean')}
            redact_backups.restic(repo,'init');redact_backups.restic(repo,'backup',str(files))
            # Explicit path hints are discovery hints, never proof of a match.
            result=redact_backups.rewrite_repo(repo,None,TOKEN.encode(),set(clean),dry_run=False)
            self.assertEqual(result['remainingAfter'],0)
            snapshots=redact_backups.restic(repo,'snapshots','--json',json_output=True)
            self.assertEqual(len(snapshots),1)
            actual={n['path'] for n in redact_backups.nodes(repo,snapshots[0]['id'])}
            self.assertEqual(actual,set(clean))
            for path,data in clean.items():
                self.assertEqual(redact_backups.restic(repo,'dump',snapshots[0]['id'],path),data)

    def test_inspection_budget_failure_preserves_snapshots_and_releases_lock(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'RESTIC_PASSWORD':'fixture-password'}):
            root=Path(tmp);repo=root/'repo';db=root/'large.zip'
            with zipfile.ZipFile(db,'w',compression=zipfile.ZIP_STORED) as archive:
                archive.writestr('clean.txt','clean'*1000)
            redact_backups.restic(repo,'init');redact_backups.restic(repo,'backup',str(db))
            before=redact_backups.restic(repo,'snapshots','--json',json_output=True)
            with patch.object(redact_inspect,'MAX_IMAGE_BYTES',1024),self.assertRaises(redact.RedactionError):
                redact_backups.rewrite_repo(repo,None,TOKEN.encode(),set(),dry_run=False)
            self.assertEqual(redact_backups.restic(repo,'snapshots','--json',json_output=True),before)
            self.assertEqual(redact_backups.restic(repo,'list','locks').splitlines(),[])

    def test_deleted_sqlite_payload_and_archive_metadata_are_matches(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'RESTIC_PASSWORD':'fixture-password'}):
            root=Path(tmp);repo=root/'repo';files=root/'files';files.mkdir()
            db=files/'deleted.db'
            with connect(db) as con:
                con.execute('PRAGMA secure_delete=OFF')
                con.execute('CREATE TABLE payload(data_zlib BLOB)')
                con.execute('INSERT INTO payload VALUES(?)',(zlib.compress(json.dumps({'text':TOKEN}).encode()),))
                con.execute('DELETE FROM payload')
            buffer=io.BytesIO()
            with gzip.GzipFile(filename=TOKEN,fileobj=buffer,mode='wb') as encoded:encoded.write(b'clean body')
            (files/'name.gz').write_bytes(buffer.getvalue())
            base=gzip.compress(b'clean body')
            escaped=''.join('\\u%04x'%ord(c) for c in TOKEN)
            for label,flag,value in (('comment',16,TOKEN.encode()),('extra',4,TOKEN.encode()),
                                     ('encoded-name',8,('padding'*2000+json.dumps({'text':escaped})).encode())):
                # JSON itself contains a serialized JSON value in this variant.
                if label=='encoded-name':value=('padding'*2000+'{"text":"'+escaped+'"}').encode()
                metadata=(len(value).to_bytes(2,'little')+value) if flag==4 else value+b'\0'
                (files/(label+'.gz')).write_bytes(base[:3]+bytes([flag])+base[4:10]+metadata+base[10:])
            with zipfile.ZipFile(files/'comment.zip','w') as archive:
                archive.writestr('clean.txt','clean body');archive.comment=TOKEN.encode()
            with zipfile.ZipFile(files/'member-comment.zip','w') as archive:
                member=zipfile.ZipInfo('clean.txt');member.comment=TOKEN.encode();archive.writestr(member,'clean body')
            for path in files.iterdir():
                with self.subTest(path=path.name),path.open('rb') as source:
                    self.assertGreater(redact_inspect.inspect_stream(source,TOKEN.encode())[0],0)
            redact_backups.restic(repo,'init');redact_backups.restic(repo,'backup',str(files))
            result=redact_backups.rewrite_repo(repo,None,TOKEN.encode(),set(),dry_run=False)
            self.assertEqual(result['remainingAfter'],0)
            for snap in redact_backups.restic(repo,'snapshots','--json',json_output=True):
                self.assertFalse(redact_backups.nodes(repo,snap['id']))

    def test_other_fts_names_are_inspected_semantically(self):
        with connect(':memory:') as con:
            con.execute("CREATE VIRTUAL TABLE custom_fts USING fts5(content,content='',contentless_delete=1)")
            con.execute('INSERT INTO custom_fts(content) VALUES(?)',(TOKEN[:-1]+'4 '+TOKEN,))
            con.commit();con.execute("INSERT INTO custom_fts(custom_fts) VALUES('optimize')");con.commit();con.execute('VACUUM')
            image=con.serialize()
        self.assertNotIn(TOKEN.encode(),image)
        self.assertGreater(redact_inspect.inspect_stream(io.BytesIO(image),TOKEN.encode())[0],0)

    def test_deleted_prefix_compressed_fts_terms_remain_visible(self):
        forms={
            'contentless-delete':("content='',contentless_delete=1",'DELETE FROM episodic_text_fts WHERE rowid=2'),
            'contentless-command':("content=''","INSERT INTO episodic_text_fts(episodic_text_fts,rowid,value) VALUES('delete',2,?)"),
            'ordinary':('', 'DELETE FROM episodic_text_fts WHERE rowid=2'),
            'external':("content='source_rows'","INSERT INTO episodic_text_fts(episodic_text_fts,rowid,value) VALUES('delete',2,?)"),
        }
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'RESTIC_PASSWORD':'fixture-password'}):
            root=Path(tmp);repo=root/'repo';dirty=[]
            for form,(options,deletion) in forms.items():
                path=root/(form+'.db');dirty.append(str(path))
                with connect(path) as con:
                    con.execute('CREATE TABLE source_rows(value TEXT)')
                    con.execute('CREATE VIRTUAL TABLE episodic_text_fts USING fts5(value'+(','+options if options else '')+')')
                    rows=[(1,TOKEN[:-1]+'4'),(2,TOKEN)]
                    con.executemany('INSERT INTO source_rows(rowid,value) VALUES(?,?)',rows)
                    con.executemany('INSERT INTO episodic_text_fts(rowid,value) VALUES(?,?)',rows)
                    con.execute("INSERT INTO episodic_text_fts(episodic_text_fts) VALUES('optimize')")
                    segments=list(con.execute('SELECT id,block FROM episodic_text_fts_data WHERE id>10'))
                    con.execute(deletion,(TOKEN,) if '?' in deletion else ())
                    con.execute('DELETE FROM source_rows WHERE rowid=2');con.commit();con.execute('VACUUM')
                    self.assertEqual(con.execute('SELECT count(*) FROM episodic_text_fts WHERE episodic_text_fts MATCH ?',(TOKEN,)).fetchone()[0],0)
                    self.assertTrue(any(row in list(con.execute('SELECT id,block FROM episodic_text_fts_data WHERE id>10')) for row in segments))
                image=path.read_bytes()
                with self.subTest(form=form):
                    if form=='contentless-delete':self.assertFalse(TOKEN.encode() in image)
                    self.assertGreater(redact_inspect.inspect_stream(io.BytesIO(image),TOKEN.encode())[0],0)
            clean=root/'clean.db'
            with connect(clean) as con:
                con.execute("CREATE VIRTUAL TABLE episodic_text_fts USING fts5(value,content='',contentless_delete=1)")
                con.executemany('INSERT INTO episodic_text_fts(rowid,value) VALUES(?,?)',[(1,'unrelatedprefix123'),(2,'unrelatedprefix456')])
                con.execute("INSERT INTO episodic_text_fts(episodic_text_fts) VALUES('optimize')")
                con.execute('DELETE FROM episodic_text_fts WHERE rowid=2');con.commit();con.execute('VACUUM')
            original=clean.read_bytes()
            self.assertEqual(redact_inspect.inspect_stream(io.BytesIO(original),TOKEN.encode()),(0,True))
            redact_backups.restic(repo,'init');redact_backups.restic(repo,'backup',*dirty,str(clean))
            result=redact_backups.rewrite_repo(repo,None,TOKEN.encode(),set(),dry_run=False)
            self.assertGreater(result['matchedBefore'],0);self.assertEqual(result['remainingAfter'],0)
            for snap in redact_backups.restic(repo,'snapshots','--json',json_output=True):
                self.assertEqual([n['path'] for n in redact_backups.nodes(repo,snap['id'])],[str(clean)])
                self.assertEqual(redact_backups.restic(repo,'dump',snap['id'],str(clean)),original)

    def test_physical_fts_substrings_and_repeated_words(self):
        with connect(':memory:') as con:
            con.execute("CREATE VIRTUAL TABLE episodic_text_fts USING fts5(value,content='',contentless_delete=1)")
            con.executemany('INSERT INTO episodic_text_fts(rowid,value) VALUES(?,?)',[(1,'xx'+TOKEN[:-1]+'4'),(2,'xx'+TOKEN)])
            con.execute("INSERT INTO episodic_text_fts(episodic_text_fts) VALUES('optimize')")
            con.execute('DELETE FROM episodic_text_fts WHERE rowid=2');con.commit();con.execute('VACUUM')
            self.assertEqual(con.execute('SELECT count(*) FROM episodic_text_fts WHERE episodic_text_fts MATCH ?',(TOKEN,)).fetchone()[0],0)
            image=con.serialize()
        self.assertFalse(TOKEN.encode() in image)
        self.assertGreater(redact_inspect.inspect_stream(io.BytesIO(image),TOKEN.encode())[0],0)
        for selector in (b'fixtureword fixtureword',b'fixtureword fixtureword fixtureword'):
            with connect(':memory:') as con:
                con.execute("CREATE VIRTUAL TABLE episodic_text_fts USING fts5(value,content='',contentless_delete=1)")
                con.execute("INSERT INTO episodic_text_fts(value) VALUES('fixtureword')")
                con.commit();con.execute('VACUUM');image=con.serialize()
            with self.subTest(occurrences=len(selector.split())),self.assertRaises(redact.RedactionError):
                redact_inspect.inspect_stream(io.BytesIO(image),selector)

    def test_nested_sidecars_and_unknown_free_bytes_fail_closed(self):
        for form in ('zip-name','zip-gzip-header','zip-zstd-header'):
            if form=='zip-zstd-header' and not shutil.which('zstd'):continue
            buffer=io.BytesIO()
            wal=b'\x37\x7f\x06\x82'+b'\0'*28+zlib.compress(TOKEN.encode())
            with zipfile.ZipFile(buffer,'w') as archive:
                if form=='zip-name':archive.writestr('state.db-wal',wal)
                elif form=='zip-gzip-header':archive.writestr('opaque.gz',gzip.compress(wal))
                else:archive.writestr('opaque.zst',subprocess.run(['zstd','-q','-c'],input=wal,capture_output=True,check=True).stdout)
            with self.subTest(form=form),self.assertRaises(redact.RedactionError):
                redact_inspect.inspect_stream(io.BytesIO(buffer.getvalue()),TOKEN.encode())
        with tempfile.TemporaryDirectory() as tmp:
            db=Path(tmp)/'unknown.db'
            with connect(db) as con:
                con.execute('PRAGMA secure_delete=OFF');con.execute('CREATE TABLE payload(value BLOB)')
                con.execute('INSERT INTO payload VALUES(?)',(b'unclassified leftover bytes',));con.execute('DELETE FROM payload')
            with db.open('rb') as source,self.assertRaises(redact.RedactionError):
                redact_inspect.inspect_stream(source,TOKEN.encode())

    def test_trailing_sqlite_and_later_compression_frames_fail_closed(self):
        with connect(':memory:') as con:
            con.execute('CREATE TABLE sample(value TEXT)');con.execute("INSERT INTO sample VALUES('clean')");con.commit()
            image=con.serialize()
        for suffix in (b'x',zlib.compress(TOKEN.encode()).ljust(4096,b'\0')):
            with self.subTest(kind='sqlite',suffix_bytes=len(suffix)),self.assertRaises(redact.RedactionError):
                redact_inspect.inspect_stream(io.BytesIO(image+suffix),TOKEN.encode())
        encoded=''.join('\\u%04x'%ord(c) for c in TOKEN)
        later=io.BytesIO()
        with gzip.GzipFile(filename='padding'*20000+'{"key":"'+encoded+'"}',fileobj=later,mode='wb') as zipped:zipped.write(b'clean')
        gzip_cases=(gzip.compress(b'clean')+later.getvalue(),gzip.compress(b'clean')+b'\0')
        for data in gzip_cases:
            with self.subTest(kind='gzip'),self.assertRaises(redact.RedactionError):
                redact_inspect.inspect_stream(io.BytesIO(data),TOKEN.encode())
        if shutil.which('zstd'):
            normal=subprocess.run(['zstd','-q','-c'],input=b'clean',capture_output=True,check=True).stdout
            payload=zlib.compress(TOKEN.encode())
            skippable=b'\x50\x2a\x4d\x18'+len(payload).to_bytes(4,'little')+payload
            for tail in (skippable,normal):
                with self.subTest(kind='zstd'),self.assertRaises(redact.RedactionError):
                    redact_inspect.inspect_stream(io.BytesIO(normal+tail),TOKEN.encode())

    def test_fresh_stage_sidecars_never_verify_clean(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'RESTIC_PASSWORD':'fixture-password'}):
            root=Path(tmp);repo=root/'repo';stage=root/'replica';stage.mkdir()
            (stage/'clean.txt').write_text('clean')
            redact_backups.restic(repo,'init');redact_backups.restic(repo,'backup',str(stage))
            args=types.SimpleNamespace(root=str(root),repository=str(repo),stage=str(stage),needle_file=str(root/'needle'),paths_from=None,dry_run=False,yes=True,local_only=True)
            Path(args.needle_file).write_text(TOKEN);Path(args.needle_file).chmod(0o600)
            original=redact_backups.restic
            def racing_backup(repository,*command,**kwargs):
                if command and command[0]=='backup':
                    (stage/'orphan.db-journal').write_bytes(b'\0'*32+zlib.compress(TOKEN.encode()))
                return original(repository,*command,**kwargs)
            with patch('redact_backups.restic',side_effect=racing_backup),self.assertRaises(redact.RedactionError):
                redact_backups.run(args)
            snapshots=original(repo,'snapshots','--json',json_output=True)
            self.assertTrue(any(n['path'].endswith('orphan.db-journal') for snap in snapshots for n in redact_backups.nodes(repo,snap['id'])))
            with self.assertRaises(redact.RedactionError):
                redact_backups.stage_sweep(stage,TOKEN.encode(),False)
            self.assertEqual(original(repo,'list','locks').splitlines(),[])

    def test_concatenated_zips_and_sidecar_case_forms_fail_closed(self):
        def archive(value):
            buffer=io.BytesIO()
            with zipfile.ZipFile(buffer,'w',compression=zipfile.ZIP_DEFLATED) as encoded:encoded.writestr('entry.txt',value)
            return buffer.getvalue()
        clean,dirty=archive('clean'),archive(TOKEN)
        for data in (dirty+clean,clean+dirty,clean+b'prefix'+dirty,clean+b'trailer'):
            with self.subTest(shape='concatenation'),self.assertRaises(redact.RedactionError):
                redact_inspect.inspect_stream(io.BytesIO(data),TOKEN.encode())
        for name in ('state.db-journal','state.db-JOURNAL','state.db-WAL','dir/State.Db-Journal/'):
            buffer=io.BytesIO()
            with zipfile.ZipFile(buffer,'w',compression=zipfile.ZIP_DEFLATED) as encoded:
                encoded.writestr(name,b'\0'*32+zlib.compress(TOKEN.encode()))
            with self.subTest(name=name),self.assertRaises(redact.RedactionError):
                redact_inspect.inspect_stream(io.BytesIO(buffer.getvalue()),TOKEN.encode())
        # Descriptors from a streaming ZIP writer are allowed when fully covered.
        class Nonseekable(io.BytesIO):
            def seek(self,*args):raise io.UnsupportedOperation()
        buffer=Nonseekable()
        with zipfile.ZipFile(buffer,'w',compression=zipfile.ZIP_DEFLATED) as encoded:
            encoded.writestr('clean.txt','clean')
        self.assertEqual(redact_inspect.inspect_stream(io.BytesIO(buffer.getvalue()),TOKEN.encode()),(0,True))

    def test_zip_actual_payload_and_separate_extra_fields(self):
        def archive(value,*,name='entry.txt',declared=None,tail=b'',local=b'',central=b''):
            name=name.encode();declared=value if declared is None else declared
            encoder=zlib.compressobj(wbits=-15);payload=encoder.compress(value)+encoder.flush()+tail
            crc=zlib.crc32(declared);size=len(declared)
            header=struct.pack('<4s5H3I2H',b'PK\x03\x04',20,0,8,0,0,crc,len(payload),size,len(name),len(local))
            body=header+name+local+payload
            directory=struct.pack('<4s6H3I5H2I',b'PK\x01\x02',20,20,0,8,0,0,crc,len(payload),size,len(name),len(central),0,0,0,0,0)+name+central
            return body+directory+struct.pack('<4s4H2IH',b'PK\x05\x06',0,0,1,1,len(directory),len(body),0)
        invalid={
            'truncated-output':archive(b'clean-prefix '+TOKEN.encode(),declared=b'clean-prefix '),
            'empty-directory-tail':archive(b'',name='empty/',tail=zlib.compress(TOKEN.encode())),
            'directory-hidden-output':archive(TOKEN.encode(),name='empty/',declared=b''),
            'malformed-local-extra':archive(b'clean',local=b'{"value":"'+TOKEN.encode()+b'"}'),
        }
        escaped=''.join('\\u%04x'%ord(c) for c in TOKEN)
        metadata={}
        for location in ('local','central','both'):
            for representation,value in (('literal',TOKEN.encode()),('escaped',('{"value":"'+escaped+'"}').encode()),
                                         ('nested',json.dumps(json.dumps({'value':TOKEN})).encode())):
                for quoted,name in ((False,'entry.txt'),(True,'"entry.txt')):
                    extra=b'\xfe\xca'+len(value).to_bytes(2,'little')+value
                    metadata[f'{location}-{representation}-{quoted}.zip']=archive(b'clean',name=name,
                        local=extra if location in ('local','both') else b'',central=extra if location in ('central','both') else b'')
        for shape,data in invalid.items():
            with self.subTest(shape=shape),self.assertRaises(redact.RedactionError):
                redact_inspect.inspect_stream(io.BytesIO(data),TOKEN.encode())
        for shape,data in metadata.items():
            with self.subTest(shape=shape):
                self.assertGreater(redact_inspect.inspect_stream(io.BytesIO(data),TOKEN.encode())[0],0)
        clean=archive(b'',name='empty/')
        self.assertEqual(redact_inspect.inspect_stream(io.BytesIO(clean),TOKEN.encode()),(0,True))
        for field in (0x7075,0x6375):
            for location in ('local','central'):
                # CRC32(entry-75.txt) contains a quote byte, independent of JSON.
                payload=b'\x01'+zlib.crc32(b'entry-75.txt').to_bytes(4,'little')+('{"value":"'+escaped+'"}').encode()
                extra=field.to_bytes(2,'little')+len(payload).to_bytes(2,'little')+payload
                shape=f'unicode-{field}-{location}.zip'
                metadata[shape]=archive(b'clean',name='entry-75.txt',**{location:extra})
                with self.subTest(shape=shape):
                    self.assertGreater(redact_inspect.inspect_stream(io.BytesIO(metadata[shape]),TOKEN.encode())[0],0)
        for prefix in (b'"',b'\0"\xff',b'"\\"',b'\x01\xa6\x22\x21\x26'):
            payload=prefix+('{"value":"'+escaped+'"}').encode()
            extra=b'\xfe\xca'+len(payload).to_bytes(2,'little')+payload
            data=archive(b'clean',local=extra)
            with self.subTest(binary_prefix=prefix.hex()):
                self.assertGreater(redact_inspect.inspect_stream(io.BytesIO(data),TOKEN.encode())[0],0)
        for size in (8192,1048576,1048699,2097275):
            data=archive(b'A'*size)
            with self.subTest(clean_size=size):
                self.assertEqual(redact_inspect.inspect_stream(io.BytesIO(data),TOKEN.encode()),(0,True))
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'RESTIC_PASSWORD':'fixture-password'}):
            root=Path(tmp);repo=root/'repo';files=root/'files';files.mkdir()
            redact_backups.restic(repo,'init')
            for shape,data in invalid.items():
                path=files/(shape+'.zip');path.write_bytes(data)
                redact_backups.restic(repo,'backup',str(path))
                before=redact_backups.restic(repo,'snapshots','--json',json_output=True)
                with self.subTest(snapshot=shape),self.assertRaises(redact.RedactionError):
                    redact_backups.rewrite_repo(repo,None,TOKEN.encode(),set(),dry_run=False)
                self.assertEqual(redact_backups.restic(repo,'snapshots','--json',json_output=True),before)
                self.assertEqual(redact_backups.restic(repo,'list','locks').splitlines(),[])
                redact_backups.restic(repo,'forget',*[s['id'] for s in before])
            for name,data in metadata.items():(files/name).write_bytes(data)
            path=files/'clean.zip';path.write_bytes(clean)
            redact_backups.restic(repo,'backup',*[str(files/name) for name in metadata],str(path))
            result=redact_backups.rewrite_repo(repo,None,TOKEN.encode(),set(),dry_run=False)
            self.assertEqual(result['remainingAfter'],0)
            for snap in redact_backups.restic(repo,'snapshots','--json',json_output=True):
                self.assertEqual([n['path'] for n in redact_backups.nodes(repo,snap['id'])],[str(path)])
                self.assertEqual(redact_backups.restic(repo,'dump',snap['id'],str(path)),clean)

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

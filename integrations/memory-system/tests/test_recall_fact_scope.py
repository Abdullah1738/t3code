"""Task provenance and CI identity regressions; all databases are fixtures."""
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from recall_rules import RuleIndex
from recall_local import preflight
from recall_engine import CheckEngine
from recall_fact_scope import normalized

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/fact_scope.json').read_text())
CWD = '/fixture/crpko-devops'


class FactScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        env = patch.dict(os.environ, RECALL_DECISION_LOG=str(self.root / 'decisions.jsonl'))
        env.start()
        self.addCleanup(env.stop)
        self.corpus = self.root / 'corpus.db'
        self.index = RuleIndex(self.root / 'rules.db')
        with closing(sqlite3.connect(self.corpus)) as con:
            con.executescript('''
                CREATE TABLE episodic_events(id INTEGER PRIMARY KEY, session_id TEXT, timestamp INTEGER,
                    speaker TEXT, content_type TEXT, content TEXT, metadata_json TEXT);
                CREATE TABLE thread_aliases(canonical_thread_id TEXT,native_id TEXT,agent_id TEXT);
            ''')

    def event(self, text, session='owner', metadata=None):
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.execute("INSERT INTO episodic_events(session_id,timestamp,speaker,content_type,content,metadata_json) "
                        "VALUES(?,1,'user','text',?,?)", (session, text, json.dumps({'cwd': CWD, **(metadata or {})})))

    def facts(self, text, session='other'):
        return self.index.search_facts([text], CWD, session_id=session)

    def check(self, text, session='other'):
        return preflight('mcp__t3_code__t3_thread_send', {'message': text}, CWD,
                         self.index.path, session_id=session)

    def test_delegated_native_session_and_all_four_pending_messages(self):
        self.event(FIXTURE['rule_4160'], 'native-writer')
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.execute('INSERT INTO thread_aliases VALUES(?,?,NULL)',
                        ('thread:delegated-task:3207-writer-replacement', 'native-writer'))
        self.index.import_transcripts(self.corpus)
        for card, message in FIXTURE['messages'].items():
            with self.subTest(card=card), patch('recall_messages.contradiction') as model:
                rules, decision = self.check(message)
                self.assertEqual([], rules)
                self.assertIsNone(decision)
                model.assert_not_called()

    def test_all_recorded_agent_authorship_forms(self):
        cases = [
            ('thread:delegated-task:writer', {}), ('owner:agent:child', {}),
            ('child', {'agent_id': 'child'}), ('child', {'sidechain': True}),
            ('child', {'is_subagent': True}), ('child', {'parentID': 'parent'}),
            ('child', {'root_session_id': 'parent', 'native_id': 'child'}),
            ('child', {'createdBy': 'assistant'}), ('child', {'origin': 'board'}),
            ('child', {'synthetic': True}),
        ]
        for i, (session, metadata) in enumerate(cases):
            self.event('Never use imported-brief-%s again.' % i, session, metadata)
        for prefix in ('You are the worker for a card', 'You are the reviewer for a card',
                       'You are an evaluator on the', 'You are a subagent'):
            self.event('# AGENTS.md instructions for project', prefix)
            self.event(prefix + ' on Robob.', prefix)
            self.event('Never use imported-brief again.', prefix)
        self.index.import_transcripts(self.corpus)
        with closing(sqlite3.connect(self.index.path)) as con:
            self.assertEqual(0, con.execute('SELECT count(*) FROM rules').fetchone()[0])

    def test_task_correction_is_bound_to_native_and_canonical_session(self):
        self.event('Use the clock proof. Do not add translation rows again.')
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.execute("INSERT INTO thread_aliases VALUES('thread:project:clock','owner',NULL)")
        self.index.import_transcripts(self.corpus)
        message = 'The clock proof needs translation rows.'
        self.assertTrue(self.facts(message, 'owner'))
        self.assertTrue(self.facts(message, 'thread:project:clock'))
        self.assertEqual([], self.facts(message))
        self.assertEqual([], self.facts(message, None))

    def test_durable_style_owner_rule_and_explicit_remember_cross_sessions(self):
        style = 'A revision reuses the existing pr-body.md/card-comment.md, not a new essay.'
        self.event(style)
        self.event('Never use Talabat again.')
        self.index.import_transcripts(self.corpus)
        self.assertTrue(self.facts('Write a new essay for pr-body.md and card-comment.md.'))
        self.assertTrue(self.facts('Use Talabat for dinner.'))
        self.index.remember('Use the clock proof.', scope=CWD, source_session='owner')
        self.assertTrue(self.facts('The clock proof is missing.'))
        self.assertEqual([], self.index.search_facts(['clock proof'], '/other', session_id='other'))

    def test_ci_identity_class(self):
        self.index.remember('PR1145 head 66cfd86f: Both CI checks SUCCESS.', scope=CWD, source_session='owner')
        for card in ('3231', '1717', '38', '677'):
            with self.subTest(card=card):
                rules, result = self.check(FIXTURE['messages'][card], 'owner')
                self.assertEqual([], rules)
                self.assertIsNone(result)
        for label, same, changed in (
            ('compact PR', 'PR1145', 'PR289'),
            ('hash PR', 'PR #1145', 'PR #289'),
            ('colon PR', 'PR:1145', 'PR:289'),
            ('equals PR', 'PR = 1145', 'PR = 289'),
            ('dash PR', 'PR-1145', 'PR-289'),
            ('long label', 'pull request #1145', 'pull request #289'),
            ('URL PR', 'https://github.com/org/repo/pull/1145', 'https://github.com/org/repo/pull/289'),
        ):
            with self.subTest(label=label):
                self.assertTrue(self.facts(same + ' head 66cfd86f: CI checks failed.', 'owner'))
                self.assertEqual([], self.facts(changed + ' head 66cfd86f: CI checks failed.', 'owner'))
        for head in ('72a10c19', '72a10c194cbb2e54a4cc389fe584c58caf7326d4'):
            self.assertEqual([], self.facts('PR1145 head ' + head + ' CI pending.', 'owner'))
        with patch('recall_messages.contradiction', return_value=({'1': .99}, 0)):
            rules, result = self.check('PR1145 head 66cfd86f CI checks failed.', 'owner')
            self.assertTrue(rules)
            self.assertEqual('deny', result['decision'])

    def test_ci_without_identity_and_compact_success_are_not_authority(self):
        self.index.remember('Both CIchecksSUCCESS.', scope=CWD)
        self.index.remember('PR1145: Both CI checks SUCCESS.', scope=CWD)
        self.index.remember('PR1145 head 66cfd86f green.', scope=CWD)
        self.assertEqual([], self.facts('PR1145 head 72a10c19 CI checks pending.'))

    def test_run_identity_and_short_full_sha(self):
        self.index.remember('Terraform run 42644775814: checks passed.', scope=CWD)
        self.assertTrue(self.facts('Terraform run 42644775814: checks failed.'))
        self.assertEqual([], self.facts('Terraform run 42644775808: checks pending.'))
        self.assertEqual([], self.facts('Terraform run 42644775814 and 42644775808: checks pending.'))
        self.index.remember('PR289 head 150be6a35d07f547ae30db79b419cf7da642b01e CI passed.', scope=CWD)
        self.assertTrue(self.facts('PR289 head 150be6a3 CI failed.'))

    def test_import_and_search_deduplicate_normalized_text(self):
        for text in ('Use PR1145 head 66cfd86f for the clock proof. Do not rewrite again.',
                     'USE PR289 head 150be6a3  for the clock proof. Do not rewrite again.'):
            self.event(text)
        self.index.import_transcripts(self.corpus)
        with closing(sqlite3.connect(self.index.path)) as con:
            self.assertEqual(1, con.execute('SELECT count(*) FROM rules').fetchone()[0])
            self.assertEqual(2, con.execute('SELECT count(*) FROM rule_sources').fetchone()[0])
        self.index.remember('Clock proof PR1145 has details.', scope=CWD)
        self.index.remember('CLOCK proof PR289 has  details.', scope=CWD)
        matches = self.facts('Clock proof details.')
        self.assertEqual(len(matches), len({normalized(r['text']) for r in matches}))

    def test_legacy_rederive_retires_briefs_collapses_duplicates_and_keeps_explicit(self):
        self.event(FIXTURE['rule_4160'], 'thread:delegated-task:writer')
        self.event('Never use Talabat again.')
        self.event('Never use Talabat again. ')
        explicit = self.index.remember('Clock proof remains valid.', scope=CWD)
        with closing(self.index._connect()) as con, con:
            for event, text, session in ((1, FIXTURE['rule_4160'], 'thread:delegated-task:writer'),
                                         (2, 'Never use Talabat again.', 'owner'),
                                         (3, 'Never use Talabat again. ', 'owner')):
                self.index._put(con, text, CWD, None, '', {
                    'key': str(event), 'citation': session + '#e' + str(event),
                    'provenance': 'owner_correction', 'priority': 95, 'session': session,
                    'event': event, 'path': str(self.corpus.resolve())})
            con.execute('INSERT INTO rule_import_progress VALUES(?,?,3,1)',
                        (str(self.corpus.resolve()), f'{self.corpus.stat().st_dev}:{self.corpus.stat().st_ino}'))
        before = self.corpus.read_bytes()
        stats = self.index.import_transcripts(self.corpus, max_rows=1)
        self.assertEqual(3, stats['cursor'])
        self.assertEqual([], self.facts(FIXTURE['messages']['2742']))
        self.index.import_transcripts(self.corpus)
        self.assertTrue(self.facts('Use Talabat again.'))
        self.assertEqual(before, self.corpus.read_bytes())
        self.assertEqual(0, self.index.import_transcripts(self.corpus)['rows'])
        self.assertEqual([explicit['id']], [r['id'] for r in self.facts('Clock proof remains valid.')])

    def test_engine_and_native_adapters_pass_the_concrete_session(self):
        self.event('Use the clock proof. Do not add translation rows again.')
        self.index.import_transcripts(self.corpus)
        with patch('recall_messages.contradiction', side_effect=lambda m, f: ({str(r['id']): .99 for r in f}, 0)):
            engine = CheckEngine(rules_path=self.index.path, classifier=lambda *_: None)
            body = dict(trigger='tool', tool='t3_thread_send', arguments={'message': 'clock proof translation rows'}, cwd=CWD)
            self.assertIsNone(engine.preflight({**body, 'session_id': 'other'})[2])
            self.assertEqual('deny', engine.preflight({**body, 'session_id': 'owner'})[2]['decision'])
        spec = importlib.util.spec_from_file_location('scope_hook', ROOT / 'hooks/recall_hook.py')
        hook = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hook)
        for harness, event in (('claude', {'session_id': 'owner'}),
                               ('codex', {'session_id': 'root', 'agent_id': 'owner'})):
            with self.subTest(harness=harness), patch('recall_local.preflight', return_value=([], None)) as call, \
                 patch.object(hook, 'config', return_value={'mode': 'on'}), patch.object(hook, 'log'):
                hook.handle(harness, {**event, 'hook_event_name': 'PreToolUse', 'tool_name': 't3_thread_send',
                                    'tool_input': {'message': 'clock proof'}, 'cwd': CWD})
                self.assertEqual('owner', call.call_args.kwargs['session_id'])

    def test_provenance_is_checked_for_every_paragraph_form(self):
        for prefix in ('', 'Writing instructions:\n\n', '# Instructions\n\n', 'Writing instructions:\n\n- '):
            self.event(prefix + 'A revision reuses the existing pr-body.md/card-comment.md, not a new essay.',
                       'thread:delegated-task:writer')
        self.index.import_transcripts(self.corpus)
        self.assertEqual([], self.facts('Write a new essay in pr-body.md.'))

    def test_session_boundary_on_tools_prompts_and_compaction(self):
        self.event('Use the current head; always push from main-dev, never main again.')
        self.event("Use the clock proof for Crpko when messaging Moni, do not say 'verified' again.")
        self.index.import_transcripts(self.corpus)
        engine = CheckEngine(rules_path=self.index.path)
        for session in ('other', None):
            for tool, arguments in (('shell', {'command': 'git push origin HEAD:main'}),
                                    ('send_message', {'recipient': 'Moni', 'text': 'The clock proof is verified.'})):
                with self.subTest(session=session, tool=tool):
                    rules, result = preflight(tool, arguments, CWD, self.index.path, session_id=session)
                    self.assertEqual([], rules)
                    self.assertIsNone(result)
            for trigger in ('first_prompt', 'compaction'):
                rules, _, result = engine.preflight(dict(trigger=trigger, session_id=session, cwd=CWD,
                                                       prompt='clock proof current head push main'))
                self.assertEqual([], rules)
                self.assertIsNone(result)
        rules, result = preflight('shell', {'command': 'git push origin HEAD:main'}, CWD,
                                  self.index.path, session_id='owner')
        self.assertTrue(rules)
        self.assertEqual('deny', result['decision'])

    def test_ci_outcome_state_matrix_on_every_entry_point(self):
        states = ('SUCCESS', 'successful', 'successfully', 'succeeded', 'succeeds', 'passed', 'passing',
                  'failed', 'failure', 'failing', 'green', 'red', 'pending', 'queued', 'running', 'ACTIVE',
                  'cancelled', 'canceled', 'timed_out', 'timed out', 'skipped', 'neutral', 'completed',
                  'in_progress', 'in progress', 'action_required', 'blocked', 'waiting', 'error')
        engine = CheckEngine(rules_path=self.index.path)
        for state in states:
            with self.subTest(state=state):
                self.index.remember('PR1145 head 66cfd86f: CI ' + state + '.', scope=CWD)
                message = 'PR289 head 150be6a3 CI checks pending.'
                self.assertEqual([], self.facts(message))
                for trigger in ('first_prompt', 'compaction', 'tool'):
                    body = dict(trigger=trigger, session_id='owner', cwd=CWD, prompt=message,
                                tool='send_message', arguments={'text': message})
                    self.assertEqual([], engine.preflight(body)[0])
        self.assertTrue(self.facts('PR1145 head 66cfd86f CI failed.'))

    def test_numeric_correction_retains_latest_text_and_citation(self):
        self.event('Use a 5 minute retry window. Do not use 10 minutes again.')
        latest = 'Use a 10 minute retry window. Do not use 5 minutes again.'
        self.event(latest)
        self.index.import_transcripts(self.corpus)
        facts = self.facts('The retry window is 5 minutes.', 'owner')
        self.assertEqual(1, len(facts))
        self.assertEqual(latest, facts[0]['text'])
        self.assertEqual('owner#e2', facts[0]['citation'])

    def test_replacing_corpus_retires_old_authority(self):
        self.event('Never use Talabat again.')
        self.index.import_transcripts(self.corpus)
        replacement = self.root / 'replacement.db'
        with closing(sqlite3.connect(self.corpus)) as source, closing(sqlite3.connect(replacement)) as dest:
            source.backup(dest)
            dest.execute("UPDATE episodic_events SET content='An unrelated task.'")
            dest.commit()
        replacement.replace(self.corpus)
        self.index.import_transcripts(self.corpus)
        self.assertEqual([], self.facts('Use Talabat again.'))

    def test_expired_budgets_during_alias_and_session_reads_are_bounded(self):
        self.event('Never use Talabat again.')
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.executemany('INSERT INTO thread_aliases VALUES(?,?,NULL)',
                            [('thread:project:' + str(i), 'native-' + str(i)) for i in range(1024)])
        self.assertEqual(0, self.index.import_transcripts(self.corpus, seconds=0, max_rows=0)['rows'])
        with patch('recall_rules.TranscriptContext', side_effect=sqlite3.OperationalError('interrupted')):
            self.assertEqual(0, self.index.import_transcripts(self.corpus)['rows'])
        with patch('recall_fact_scope.TranscriptContext.get', side_effect=sqlite3.OperationalError('interrupted')):
            self.assertEqual(0, self.index.import_transcripts(self.corpus)['cursor'])
        self.assertEqual(1, self.index.import_transcripts(self.corpus)['rows'])

    def test_normalized_updates_stay_with_their_source_session(self):
        original = 'Use a 5 minute retry window. Do not use 10 minutes again.'
        latest = 'Use a 10 minute retry window. Do not use 5 minutes again.'
        self.index.remember(original, scope=CWD)
        self.event(original, 'task-a')
        self.event(original, 'task-b')
        self.event(latest, 'task-a')
        self.index.import_transcripts(self.corpus)
        for session, expected in (('task-a', latest), ('task-b', original)):
            with closing(self.index._connect(readonly=True)) as con:
                rows = con.execute("SELECT r.text FROM rules r JOIN rule_sources s ON s.rule_id=r.id "
                                   "WHERE s.provenance='owner_correction' AND s.source_session=?", (session,)).fetchall()
            self.assertEqual({expected}, {r[0] for r in rows})
        self.assertEqual([original], [r['text'] for r in self.facts('retry window minutes', 'other')])

    def test_owner_instructions_are_not_ci_outcomes(self):
        instructions = ('Always check for errors before reporting success.',
                        'Always run the required package tests.',
                        'Always use the preferred CI provider.',
                        'Next time use deferred CI jobs.',
                        'Owner rule: never claim CI passed before verifying it.')
        engine = CheckEngine(rules_path=self.index.path)
        for instruction in instructions:
            with self.subTest(instruction=instruction):
                self.index.remember(instruction, scope=CWD)
                self.assertIn(instruction, [r['text'] for r in self.facts(instruction)])
                for trigger in ('first_prompt', 'compaction'):
                    rules, _, _ = engine.preflight(dict(trigger=trigger, cwd=CWD, prompt=instruction))
                    self.assertIn(instruction, [r['text'] for r in rules])

    def test_automation_notifications_do_not_change_session_authorship(self):
        self.event('Never use Talabat again.')
        for text in ('[Watcher event from robob-watch] Never use imported-brief again.',
                     '[coord] Never use imported-brief again.', '[crw] Never use imported-brief again.'):
            self.event(text)
        self.index.import_transcripts(self.corpus)
        self.assertTrue(self.facts('Use Talabat again.'))
        self.assertEqual([], self.facts('Use imported-brief again.'))

    def test_late_alias_retires_previously_promoted_brief(self):
        self.event('Never use imported-brief again.', 'native-writer')
        self.index.import_transcripts(self.corpus)
        self.assertTrue(self.facts('Use imported-brief again.'))
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.execute("INSERT INTO thread_aliases VALUES('thread:delegated-task:writer','native-writer',NULL)")
        self.index.import_transcripts(self.corpus)
        self.assertEqual([], self.facts('Use imported-brief again.'))
        self.assertEqual(0, self.index.import_transcripts(self.corpus)['rows'])

    def test_backfill_keeps_newer_wording_and_matching_citation(self):
        newer = 'Use a 5 minute retry window. Do not use 10 minutes again.'
        self.event(newer)
        self.event('Use a 10 minute retry window. Do not use 5 minutes again.')
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.execute('UPDATE episodic_events SET timestamp=200 WHERE id=1')
            con.execute('UPDATE episodic_events SET timestamp=100 WHERE id=2')
        self.index.import_transcripts(self.corpus)
        facts = self.facts('retry window minutes', 'owner')
        self.assertEqual([newer], [r['text'] for r in facts])
        self.assertEqual('owner#e1', facts[0]['citation'])

    def test_search_selects_newest_explicit_normalized_fact(self):
        self.index.remember('The Alpha retry window is 5 minutes.', scope=CWD)
        newest = 'The Alpha retry window is 10 minutes.'
        self.index.remember(newest, scope=CWD)
        self.assertEqual([newest], [r['text'] for r in self.facts(newest)])

    def test_durable_project_family_scope_is_searchable(self):
        rule = 'Owner rule: for Crpko, a revision reuses pr-body.md/card-comment.md, not a new essay.'
        self.event(rule)
        self.index.import_transcripts(self.corpus)
        self.assertTrue(self.facts('Write a new essay in pr-body.md.'))
        self.assertEqual([], self.index.search_facts(['Write a new essay in pr-body.md.'], '/fixture/other'))

    def test_provenance_after_wrapper_cleanup(self):
        for tag in ('system-reminder', 'recall', 'skill_content', 'environment_context'):
            self.event(f'<{tag}>Context only.</{tag}>\nNever use imported-brief again.', 'native-writer')
        self.event("[Channel guidance]\n[End of channel guidance. The owner's message follows.]\n"
                   'Never use imported-brief again.', 'native-writer')
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.execute("INSERT INTO thread_aliases VALUES('thread:delegated-task:writer','native-writer',NULL)")
        self.index.import_transcripts(self.corpus)
        self.assertEqual([], self.facts('Use imported-brief again.'))

    def test_recovery_aliases_share_task_scope_without_ambiguous_aliases(self):
        self.event('Use the clock proof. Do not add translation rows again.', 'native-a')
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.executemany('INSERT INTO thread_aliases VALUES(?,?,NULL)',
                            [('thread:project:clock', 'native-a'), ('thread:project:clock', 'native-b')])
        self.index.import_transcripts(self.corpus)
        for session in ('native-a', 'native-b', 'thread:project:clock'):
            self.assertTrue(self.facts('clock proof translation rows', session))
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.execute("INSERT INTO thread_aliases VALUES('thread:project:other','native-b',NULL)")
        self.index.import_transcripts(self.corpus)
        self.assertEqual([], self.facts('clock proof translation rows', 'native-b'))

    def test_duplicate_frequency_does_not_hide_durable_rules(self):
        for i in range(50):
            self.event('Never use Talabat again.', 'owner-' + str(i))
        self.index.import_transcripts(self.corpus)
        self.assertEqual(1, len(self.facts('Use Talabat again.')))
        with patch('recall_messages.contradiction', side_effect=lambda m, f: ({str(r['id']): .99 for r in f}, 0)):
            self.assertEqual('deny', self.check('Use Talabat again.')[1]['decision'])

    def test_prompt_and_compaction_choose_one_newest_representative(self):
        older = 'The Alpha retry window is 5 minutes.'
        newer = 'The Alpha retry window is 10 minutes.'
        self.index.remember(older, scope=CWD)
        self.index.remember(newer, scope=CWD)
        engine = CheckEngine(rules_path=self.index.path)
        for trigger in ('first_prompt', 'compaction'):
            result = engine.check(dict(trigger=trigger, cwd=CWD, prompt='Alpha retry window'))
            self.assertIn(newer, result['note'])
            self.assertNotIn(older, result['note'])

    def test_standing_directive_prefix_class(self):
        for prefix in ('- ', '* ', '1. ', '12. ', '[Abdullah] ', 'Please ', 'Actually, ', 'No, '):
            with self.subTest(prefix=prefix):
                self.event(prefix + 'Never use Talabat again.')
        self.index.import_transcripts(self.corpus)
        self.assertTrue(self.facts('Use Talabat again.'))
        with closing(self.index._connect(readonly=True)) as con:
            for row in con.execute('SELECT * FROM rules'):
                record = self.index._record(con, row)
                from recall_rules import fact_applies
                self.assertTrue(fact_applies(record, 'Use Talabat again.', 'other'), record['text'])

    def test_bounded_rederive_keeps_valid_rules_until_atomic_publish(self):
        self.event('Never use imported-brief again.', 'native-writer')
        self.event('Never use Talabat again.')
        self.index.import_transcripts(self.corpus)
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.execute("INSERT INTO thread_aliases VALUES('thread:delegated-task:writer','native-writer',NULL)")
        self.index.import_transcripts(self.corpus, max_rows=1)
        self.assertTrue(self.facts('Use Talabat again.'))
        self.index.import_transcripts(self.corpus, max_rows=1)
        self.assertTrue(self.facts('Use Talabat again.'))
        self.assertEqual([], self.facts('Use imported-brief again.'))

    def test_recovered_aliases_share_authorship_across_capture_sources(self):
        self.event('You are the worker for a card on Robob.', 'native-a')
        self.event('Never use imported-brief again.', 'native-b')
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.execute("ALTER TABLE episodic_events ADD COLUMN source TEXT DEFAULT 'claude'")
            con.execute("UPDATE episodic_events SET source='codex' WHERE session_id='native-b'")
            con.execute('ALTER TABLE thread_aliases ADD COLUMN driver TEXT')
            con.executemany('INSERT INTO thread_aliases VALUES(?,?,NULL,?)',
                            [('thread:project:board', 'native-a', 'claudeAgent'),
                             ('thread:project:board', 'native-b', 'codex')])
        self.index.import_transcripts(self.corpus)
        self.assertEqual([], self.facts('Use imported-brief again.'))

    def test_mixed_standing_instruction_does_not_carry_ci_claim(self):
        policy = 'Owner rule: always run the required package tests.'
        self.event(policy + ' Both CIchecksSUCCESS.')
        self.index.import_transcripts(self.corpus)
        message = 'PR558 head ef3fee74 run 42819961468 checks pending. Run required package tests.'
        facts = self.facts(message)
        self.assertEqual([policy], [r['text'] for r in facts])
        with patch('recall_messages.contradiction', side_effect=lambda m, f: ({str(r['id']): 0 for r in f}, 0)) as model:
            self.assertEqual('allow', self.check(message)[1]['decision'])
            self.assertNotIn('SUCCESS', str(model.call_args.args[1]))
        engine = CheckEngine(rules_path=self.index.path)
        for trigger in ('first_prompt', 'compaction'):
            rules, _, _ = engine.preflight(dict(trigger=trigger, cwd=CWD, prompt=message))
            self.assertEqual([policy], [r['text'] for r in rules])

    def test_mixed_revision_style_survives_named_old_ci(self):
        style = 'A revision reuses the existing pr-body.md/card-comment.md, not a new essay.'
        self.index.remember(style + ' PR1145 head 66cfd86f: Both CI checks SUCCESS.', scope=CWD)
        message = FIXTURE['messages']['3231']
        facts = self.facts(message)
        self.assertEqual([style], [r['text'] for r in facts])
        self.assertEqual(style, facts[0]['triggers']['text'])

    def test_missing_identity_dimension_cannot_override_named_new_run(self):
        self.index.remember('PR1145 head 66cfd86f: Both CI checks SUCCESS.', scope=CWD)
        self.assertEqual([], self.facts('PR1145 head 66cfd86f run 42819961468 checks pending.'))
        self.assertTrue(self.facts('PR1145 head 66cfd86f checks failed.'))

    def test_lookup_uses_one_snapshot_across_replay_publication(self):
        self.event('Never use imported-brief again.', 'native-writer')
        self.event('Never use Talabat again.')
        self.index.import_transcripts(self.corpus)
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.execute("INSERT INTO thread_aliases VALUES('thread:delegated-task:writer','native-writer',NULL)")
        original = self.index._record
        published = False
        def publish_between_reads(con, row):
            nonlocal published
            if not published:
                published = True
                self.index.import_transcripts(self.corpus)
            return original(con, row)
        with patch.object(self.index, '_record', side_effect=publish_between_reads):
            self.assertTrue(self.facts('Use Talabat again.'))
        self.assertTrue(published)

    def test_publication_expiry_preserves_old_rules_and_retries_next_tick(self):
        for text in ('Never use Talabat again.', 'Never use imported-brief again.',
                     'Owner rule: always use the clock proof.'):
            self.event(text)
        self.index.import_transcripts(self.corpus)
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.execute("INSERT INTO thread_aliases VALUES('thread:project:other','other',NULL)")
        self.index.import_transcripts(self.corpus, max_rows=2)
        clock = [0]
        original = self.index._put
        def expire_after_one(*args):
            result = original(*args)
            clock[0] = 2
            return result
        with patch('recall_rules.time.monotonic', side_effect=lambda: clock[0]), \
             patch.object(self.index, '_put', side_effect=expire_after_one) as put:
            stats = self.index.import_transcripts(self.corpus, max_rows=1, seconds=1)
        self.assertEqual(1, put.call_count)
        self.assertFalse(stats['complete'])
        self.assertEqual(1, stats['imported'])
        self.assertTrue(self.facts('Use Talabat again.'))
        with patch.object(self.index, '_put', side_effect=AssertionError('compiled pages must not be repeated')):
            self.assertTrue(self.index.import_transcripts(self.corpus)['complete'])
        with closing(self.index._connect(readonly=True)) as con:
            self.assertEqual(0, con.execute('SELECT count(*) FROM rule_transcript_staging').fetchone()[0])

    def test_filtered_ci_does_not_leave_derived_branch_constraints(self):
        policy = 'Owner rule: always run the required package tests.'
        self.index.remember(policy + ' PR1145 head 66cfd86f CI checks SUCCESS; always push from main-dev, never main.', scope=CWD)
        rules, result = preflight('shell', {'command': 'git push origin HEAD:main'}, CWD, self.index.path)
        # The independently standing branch instruction is retained and remains a rule.
        self.assertTrue(rules)
        self.assertEqual('deny', result['decision'])
        other = RuleIndex(self.root / 'other.db')
        other.remember(policy + ' PR1145 head 66cfd86f CI checks SUCCESS, always push from main-dev, never main.', scope=CWD)
        rules, result = preflight('shell', {'command': 'git push origin HEAD:main'}, CWD, other.path)
        self.assertIsNone(result)
        self.assertEqual([[]], [r['constraints'] for r in rules])

    def test_replay_preserves_paragraph_order_within_one_event(self):
        first = 'Use a 5 minute retry window. Do not use 10 minutes again.'
        last = 'Use a 10 minute retry window. Do not use 5 minutes again.'
        self.event(first + '\n\n' + last, 'owner-a')
        self.event(last + '\n\n' + first, 'owner-b')
        self.index.import_transcripts(self.corpus)
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.execute("INSERT INTO thread_aliases VALUES('thread:project:other','other',NULL)")
        self.index.import_transcripts(self.corpus)
        self.assertEqual([last], [r['text'] for r in self.facts('retry window minutes', 'owner-a')])
        self.assertEqual([first], [r['text'] for r in self.facts('retry window minutes', 'owner-b')])

    def test_late_board_opening_retires_peer_authority_without_alias_change(self):
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.executemany('INSERT INTO thread_aliases VALUES(?,?,NULL)',
                            [('thread:project:board', 'native-a'), ('thread:project:board', 'native-b')])
        self.event('Never use imported-brief again.', 'native-b')
        self.index.import_transcripts(self.corpus)
        self.assertTrue(self.facts('Use imported-brief again.'))
        self.event('You are the worker for a card on Robob.', 'native-a')
        self.index.import_transcripts(self.corpus)
        self.assertEqual([], self.facts('Use imported-brief again.'))
        self.event('Never use another-brief again.', 'native-b')
        self.index.import_transcripts(self.corpus)
        self.assertEqual([], self.facts('Use another-brief again.'))

    def test_conditional_ci_policy_class(self):
        policies = (
            'Owner rule: when writing PR comments, never claim CI passed before verifying it.',
            'Only publish after CI checks have passed.',
            'If CI checks are red, do not merge.',
            'Unless CI checks passed, do not publish.',
            'CI checks must pass before publishing.',
            'Always record CI success after verifying the run.',
        )
        engine = CheckEngine(rules_path=self.index.path)
        for policy in policies:
            with self.subTest(policy=policy):
                self.index.remember(policy, scope=CWD)
                self.assertIn(policy, [r['text'] for r in self.facts(policy)])
                for trigger in ('first_prompt', 'compaction'):
                    self.assertIn(policy, [r['text'] for r in engine.preflight(dict(trigger=trigger, cwd=CWD, prompt=policy))[0]])

    def test_numbered_mixed_policy_keeps_only_instruction(self):
        for prefix in ('1. ', '12. ', '- ', '* ', '[Abdullah] '):
            self.event(prefix + 'Owner rule: always run the required package tests. Both CIchecksSUCCESS.')
        self.index.import_transcripts(self.corpus)
        facts = self.facts('Run required package tests; PR558 head ef3fee74 checks pending.')
        self.assertTrue(facts)
        self.assertTrue(all('required package tests' in r['text'] and 'SUCCESS' not in r['text'] for r in facts))

    def test_large_replay_preparation_advances_under_repeated_small_budgets(self):
        def label(i):
            return 'entity' + ''.join(chr(97 + n) for n in (i // 676, i // 26 % 26, i % 26))
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.executemany("INSERT INTO episodic_events(session_id,timestamp,speaker,content_type,content,metadata_json) "
                            "VALUES('owner',1,'user','text',?,?)",
                            [('Never use ' + label(i) + ' again.', json.dumps({'cwd': CWD})) for i in range(2000)])
        self.event('Never use imported-brief again.', 'native-writer')
        self.index.import_transcripts(self.corpus, max_rows=5000, seconds=60)
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.execute("INSERT INTO thread_aliases VALUES('thread:delegated-task:writer','native-writer',NULL)")
        self.event('Never use extra-proof again.')
        clock = [0]
        original = self.index._put
        def bounded_work(*args):
            result = original(*args)
            clock[0] += .001
            return result
        with patch('recall_rules.time.monotonic', side_effect=lambda: clock[0]), \
             patch.object(self.index, '_put', side_effect=bounded_work):
            for _ in range(6):
                clock[0] = 0
                stats = self.index.import_transcripts(self.corpus, max_rows=5000, seconds=.5)
                if stats['cursor'] == 2002:
                    break
            self.assertEqual(2002, stats['cursor'])
            self.assertEqual([], self.facts('Use imported-brief again.'))
            self.assertTrue(self.facts('Use extra-proof again.'))

    def test_late_session_role_metadata_class_retires_peer_briefs(self):
        roles = ({'is_subagent': True}, {'parent_id': 'parent'}, {'parentID': 'parent'},
                 {'agent_id': 'child'}, {'sidechain': True},
                 {'root_session_id': 'parent', 'native_id': 'child'},
                 {'origin': 'board'}, {'origin': 'delegated-task'}, {'origin': 'subagent'},
                 {'title': 'Subagent: write final text'})
        with closing(sqlite3.connect(self.corpus)) as con, con:
            con.executemany('INSERT INTO thread_aliases VALUES(?,?,NULL)',
                            [('thread:project:role-' + str(i), 'native-' + peer + str(i))
                             for i in range(len(roles)) for peer in ('a', 'b')])
        for i in range(len(roles)):
            self.event('Never use imported-brief again.', 'native-b' + str(i))
        self.index.import_transcripts(self.corpus)
        for i, metadata in enumerate(roles):
            self.event('Task started.', 'native-a' + str(i), metadata)
        self.index.import_transcripts(self.corpus)
        self.assertEqual([], self.facts('Use imported-brief again.'))

    def test_per_turn_agent_metadata_does_not_retire_real_owner_rules(self):
        self.event('Never use Talabat again.')
        self.index.import_transcripts(self.corpus)
        for metadata in ({'createdBy': 'assistant'}, {'synthetic': True}, {'origin': 'watcher'}):
            self.event('Never use imported-brief again.', metadata=metadata)
        self.index.import_transcripts(self.corpus)
        self.assertTrue(self.facts('Use Talabat again.'))
        self.assertEqual([], self.facts('Use imported-brief again.'))

    def test_temporal_ci_reports_are_not_conditional_instructions(self):
        for fact in ('After CI passed, we merged.', 'When CI was green, the branch shipped.',
                     'Once CI succeeded, we published.', 'After CI passed, we never claimed it.'):
            self.index.remember(fact, scope=CWD)
        self.assertEqual([], self.facts('PR558 head ef3fee74 checks pending.'))

    def test_schema_upgrade_resumes_every_partial_column_table_state(self):
        self.event('Never use Talabat again.')
        for has_column in (False, True):
            for has_table in (False, True):
                with self.subTest(column=has_column, table=has_table):
                    path = self.root / f'partial-{has_column}-{has_table}.db'
                    with closing(sqlite3.connect(self.index.path)) as source, closing(sqlite3.connect(path)) as dest:
                        source.backup(dest)
                        if not has_column:
                            dest.execute('ALTER TABLE rule_sources DROP COLUMN generation')
                        if not has_table:
                            dest.execute('DROP TABLE rule_transcript_generations')
                        dest.commit()
                    index = RuleIndex(path)
                    self.assertTrue(index.import_transcripts(self.corpus)['complete'])
                    self.assertTrue(index.search_facts(['Use Talabat again.'], CWD, session_id='other'))
                    self.assertEqual(0, index.import_transcripts(self.corpus)['rows'])

    def test_nownow_cleanup_safeguard_reaches_checker_despite_incidental_ids_and_states(self):
        skill = self.root / 'noon/SKILL.md'
        skill.parent.mkdir()
        skill.write_text(FIXTURE['rule_4255'])
        self.index.import_files([skill])
        message = ('NowNow cleanup returned an uncertain delete and failed readback. '
                   'I will resend the delete through the app to clear the cart.')
        with patch('recall_messages.contradiction', side_effect=lambda m, f: ({str(r['id']): .99 for r in f}, 0)) as model:
            rules, result = self.check(message)
        self.assertEqual([FIXTURE['rule_4255']], [r['text'] for r in rules])
        model.assert_called_once()
        self.assertEqual('deny', result['decision'])

    def test_identifiers_do_not_turn_non_ci_facts_into_ci_outcomes(self):
        from recall_fact_scope import comparison_text
        identifiers = ('commit 1afee3e483', 'PR #4', 'flow 686c475e-a777-4f41-97fc-7dbdd2510c70',
                       'product P5997551102819847A', 'reference 42819961468')
        for identity in identifiers:
            for state in ('ACTIVE', 'blocked', 'failed', 'completed', 'pending'):
                fact = f'NowNow cleanup {identity} is {state}. Never resend an uncertain delete through the app.'
                with self.subTest(identity=identity, state=state):
                    self.assertEqual(fact, comparison_text(fact, 'Resend the uncertain NowNow delete through the app.'))

    def test_identifier_bearing_ci_policies_reach_checker_for_same_pr(self):
        cases = (
            ('PR compact', 'Never merge PR1145 unless CI checks passed.'),
            ('PR hash', 'Never claim CI passed for PR #1145 without verifying it.'),
            ('PR long label', 'Owner rule: when writing pull request #1145 comments, never claim CI passed before verifying it.'),
            ('head', 'Never claim CI passed for head 66cfd86f without verifying it.'),
            ('run', 'Never claim CI passed for run 42644775814 without verifying it.'),
            ('CI requirement', 'PR1145 CI checks must pass before publishing.'),
            ('conditional', 'If PR1145 CI checks are red, do not merge.'),
            ('owner prefix', 'Owner rule: run CI checks for PR1145 before publishing.'),
            ('next time prefix', 'Next time verify CI checks passed for PR1145 before publishing.'),
            ('from now on prefix', 'From now on check CI passed for PR1145 before publishing.'),
            ('remember prefix', 'Remember this next time: verify CI passed for PR1145 before publishing.'),
            ('conditional hold', 'Unless CI checks passed, hold the merge.'),
            ('conditional stop', 'If CI checks are red, stop.'),
            ('conditional keep', 'Until CI checks are green, keep the PR open.'),
            ('conditional polite', 'If PR1145 CI checks are red, please stop.'),
            ('run ID command', 'Only run 42644775814 for PR1145 unless CI checks passed.'),
            ('check ID command', 'Never check 42644775814 for PR1145 without verifying CI passed.'),
        )
        message = 'Merge PR1145 head 66cfd86f while CI checks for run 42644775814 are pending, and claim CI passed.'
        for i, (label, policy) in enumerate(cases):
            with self.subTest(label=label):
                index = RuleIndex(self.root / f'policy-{i}.db')
                index.remember(policy, scope=CWD, source_session='owner')
                with patch('recall_messages.contradiction', side_effect=lambda m, f: ({str(r['id']): .99 for r in f}, 0)) as model:
                    rules, result = preflight('t3_thread_send', {'message': message}, CWD, index.path, session_id='other')
                self.assertEqual([policy], [r['text'] for r in rules])
                model.assert_called_once()
                self.assertEqual('deny', result['decision'])
                engine = CheckEngine(rules_path=index.path)
                for trigger in ('first_prompt', 'compaction'):
                    records = engine.preflight(dict(trigger=trigger, cwd=CWD, prompt=message))[0]
                    self.assertEqual([policy], [r['text'] for r in records])

    def test_identifier_bearing_policy_does_not_exempt_an_adjacent_stale_ci_result(self):
        from recall_fact_scope import comparison_text
        policy = 'Never merge PR1145 unless CI checks passed.'
        fact = policy + ' PR1145 head 66cfd86f: Both CI checks SUCCESS.'
        self.assertEqual(policy, comparison_text(fact, FIXTURE['messages']['3231']))

    def test_ci_shorthand_separator_and_pr_label_class(self):
        from recall_fact_scope import comparison_text
        labels = ('PR1145', 'PR #1145', 'PR:1145', 'PR=1145', 'PR-1145',
                  'pull request #1145', 'https://github.com/org/repo/pull/1145')
        separators = (' ', ': ', '= ', ' - ', ' — ', ' is ', ' was ', ': is ', ': was ')
        changed = 'PR1145 head 72a10c19 CI checks pending.'
        matching = 'PR1145 head 66cfd86f CI checks failed.'
        for label in labels:
            for separator in separators:
                for head in ('66cfd86f', '`66cfd86f`'):
                    fact = label + ' head ' + head + separator + 'green.'
                    with self.subTest(label=label, separator=separator, head=head):
                        self.assertEqual('', comparison_text(fact, changed))
                        self.assertEqual(fact, comparison_text(fact, matching))
        for predicate in ('has passed', 'had failed', 'did pass', 'will pass', 'has been green'):
            fact = 'PR1145 head 66cfd86f ' + predicate + '.'
            with self.subTest(predicate=predicate):
                self.assertEqual('', comparison_text(fact, changed))
                self.assertEqual(fact, comparison_text(fact, matching))

    def test_temporal_and_hedged_ci_reports_do_not_become_policies(self):
        facts = ('Until yesterday PR1145 head 66cfd86f CI was green.',
                 'If I remember correctly, PR1145 head 66cfd86f CI passed.',
                 "Unless I'm mistaken, PR1145 head 66cfd86f CI passed.",
                 'When we last checked, PR1145 head 66cfd86f CI passed.',
                 'After CI passed for PR1145 head 66cfd86f, we merged.',
                 'Once CI succeeded for PR1145 head 66cfd86f, we published.',
                 'Only PR1145 head 66cfd86f has green CI checks.',
                 'Never before had CI passed for PR1145 head 66cfd86f.',
                 'PR1145 head 66cfd86f: green.', 'PR1145 head 66cfd86f is green.')
        changed = 'PR1145 head 72a10c19 CI checks pending.'
        matching = 'PR1145 head 66cfd86f CI checks failed.'
        for i, fact in enumerate(facts):
            with self.subTest(fact=fact):
                index = RuleIndex(self.root / f'result-{i}.db')
                index.remember(fact, scope=CWD)
                with patch('recall_messages.contradiction', side_effect=lambda m, f: ({str(r['id']): .99 for r in f}, 0)) as model:
                    self.assertEqual(([], None), preflight('t3_thread_send', {'message': changed}, CWD, index.path))
                    model.assert_not_called()
                    rules, result = preflight('t3_thread_send', {'message': matching}, CWD, index.path)
                    self.assertEqual([fact], [r['text'] for r in rules])
                    self.assertEqual('deny', result['decision'])
                engine = CheckEngine(rules_path=index.path)
                for trigger in ('first_prompt', 'compaction'):
                    self.assertEqual([], engine.preflight(dict(trigger=trigger, cwd=CWD, prompt=changed))[0])

    def test_ci_subject_number_and_result_state_class(self):
        from recall_fact_scope import comparison_text
        for subject in ('CI', 'CIcheck', 'CIchecks', 'check', 'checks', 'workflow', 'workflows', 'run', 'runs'):
            for state in ('passed', 'failed', 'green', 'red', 'pending', 'queued', 'running', 'cancelled', 'SUCCESS'):
                fact = f'PR1145 head 66cfd86f: {subject} {state}.'
                with self.subTest(subject=subject, state=state):
                    self.assertEqual('', comparison_text(fact, 'PR1145 head 72a10c19 checks pending.'))
                    self.assertEqual(fact, comparison_text(fact, 'PR1145 head 66cfd86f checks failed.'))

    def test_instruction_verbs_and_descriptive_prefixes_are_distinct(self):
        from recall_fact_scope import comparison_text
        for prefix in ('Always', 'Never', 'Only'):
            for description in ('before had PR1145 head 66cfd86f CI passed.',
                                'PR1145 head 66cfd86f had green CI checks.'):
                fact = prefix + ' ' + description
                with self.subTest(fact=fact):
                    self.assertEqual('', comparison_text(fact, 'PR1145 head 72a10c19 checks pending.'))
        for verb in ('check', 'run', 'use', 'verify', 'wait', 'claim', 'say', 'report', 'mark', 'keep',
                     'reuse', 'avoid', 'ensure', 'require', 'confirm', 'inspect', 'test', 'prefer',
                     'retain', 'review', 'send', 'push', 'deploy', 'merge', 'publish', 'record', 'write', 'stop', 'hold'):
            for prefix in ('Never ', 'If CI checks are red, ', 'If CI checks are red, please ',
                           'Unless CI checks passed, ', 'Until CI checks are green, '):
                policy = prefix + verb + ' PR1145 before CI checks passed.'
                with self.subTest(prefix=prefix, verb=verb):
                    self.assertEqual(policy, comparison_text(policy, 'PR1145 head 72a10c19 checks pending.'))

    def test_named_run_or_check_result_is_not_an_imperative(self):
        from recall_fact_scope import comparison_text
        changed = 'PR1145 head 72a10c19 run 42644775808 checks pending.'
        matching = 'PR1145 head 66cfd86f run 42644775814 checks failed.'
        for noun in ('run', 'check'):
            for reference in ('42644775814', '#42644775814', 'id: 42644775814', '`42644775814`'):
                for prefix in ('Only ', 'If I remember correctly, '):
                    for state in ('passed', 'failed', 'succeeded', 'is green', 'was red', 'SUCCESS', 'pending',
                                  'queued', 'running', 'active', 'cancelled', 'timed_out', 'skipped', 'neutral',
                                  'completed', 'in_progress', 'action_required', 'blocked', 'waiting', 'error',
                                  'has passed', 'had failed', 'did pass', 'will pass', 'has been green'):
                        fact = f'{prefix}{noun} {reference} for PR1145 head 66cfd86f {state}.'
                        with self.subTest(noun=noun, reference=reference, prefix=prefix, state=state):
                            self.assertEqual('', comparison_text(fact, changed))
                            self.assertEqual(fact, comparison_text(fact, matching))
        for i, fact in enumerate(('Only run 42644775814 for PR1145 head 66cfd86f passed.',
                                  'If I remember correctly, run 42644775814 for PR1145 head 66cfd86f passed.')):
            with self.subTest(fact=fact):
                index = RuleIndex(self.root / f'noun-run-{i}.db')
                index.remember(fact, scope=CWD)
                with patch('recall_messages.contradiction', side_effect=lambda m, f: ({str(r['id']): .99 for r in f}, 0)) as model:
                    self.assertEqual(([], None), preflight('t3_thread_send', {'message': changed}, CWD, index.path))
                    model.assert_not_called()
                    self.assertEqual('deny', preflight('t3_thread_send', {'message': matching}, CWD, index.path)[1]['decision'])
                engine = CheckEngine(rules_path=index.path)
                for trigger in ('first_prompt', 'compaction'):
                    self.assertEqual([], engine.preflight(dict(trigger=trigger, cwd=CWD, prompt=changed))[0])

    def test_markdown_ci_outcomes_keep_strict_identity_matching(self):
        from recall_fact_scope import comparison_text
        wrappers = (('', ''), ('`', '`'), ('``', '``'), ('**', '**'), ('__', '__'),
                    ('*', '*'), ('_', '_'), ('***', '***'), ('**`', '`**'))
        changed = 'PR1145 head 72a10c19 CI checks pending.'
        matching = 'PR1145 head 66cfd86f CI checks failed.'
        for start, end in wrappers:
            for position in ('pr', 'head', 'state', 'whole'):
                fields = {'pr': 'PR1145', 'head': '66cfd86f', 'state': 'green'}
                if position != 'whole':
                    fields[position] = start + fields[position] + end
                fact = f"{fields['pr']} head {fields['head']} is {fields['state']}."
                if position == 'whole':
                    fact = start + fact + end
                with self.subTest(wrapper=(start, end), position=position):
                    self.assertEqual('', comparison_text(fact, changed))
                    self.assertEqual(fact, comparison_text(fact, matching))
                    self.assertEqual('', comparison_text(fact, 'PR289 head 66cfd86f CI checks failed.'))
                    self.assertEqual('', comparison_text(fact, matching + ' Run 42819961468 is pending.'))
        facts = ('`PR1145` head `66cfd86f` is green.', 'PR1145 head 66cfd86f: **green**.')
        for i, fact in enumerate(facts):
            index = RuleIndex(self.root / f'markdown-result-{i}.db')
            index.remember(fact, scope=CWD)
            with patch('recall_messages.contradiction', side_effect=lambda m, f: ({str(r['id']): .99 for r in f}, 0)) as model:
                self.assertEqual(([], None), preflight('t3_thread_send', {'message': changed}, CWD, index.path))
                model.assert_not_called()
                rules, result = preflight('t3_thread_send', {'message': matching}, CWD, index.path)
                self.assertEqual([fact], [r['text'] for r in rules])
                self.assertEqual('deny', result['decision'])
            engine = CheckEngine(rules_path=index.path)
            for trigger in ('first_prompt', 'compaction'):
                self.assertEqual([], engine.preflight(dict(trigger=trigger, cwd=CWD, prompt=changed))[0])
                self.assertEqual([fact], [r['text'] for r in engine.preflight(dict(trigger=trigger, cwd=CWD, prompt=matching))[0]])

    def test_ci_prohibitions_and_conditionals_do_not_depend_on_a_verb_list(self):
        from recall_fact_scope import comparison_text
        policies = ('Never approve PR1145 unless CI checks passed.',
                    'Never bypass verification for PR1145 while CI checks are pending.',
                    'Only retry PR1145 after CI checks passed.',
                    'Do not approve PR1145 unless CI checks passed.',
                    "Don't bypass verification for PR1145 while CI checks are pending.",
                    'Must not approve PR1145 unless CI checks passed.',
                    'Should not approve PR1145 unless CI checks passed.',
                    'Cannot approve PR1145 unless CI checks passed.',
                    'No approval for PR1145 unless CI checks passed.')
        message = 'Approve PR1145, bypass verification and retry while CI checks are pending.'
        for i, policy in enumerate(policies):
            with self.subTest(policy=policy):
                index = RuleIndex(self.root / f'ordinary-policy-{i}.db')
                index.remember(policy, scope=CWD, source_session='owner')
                with patch('recall_messages.contradiction', side_effect=lambda m, f: ({str(r['id']): .99 for r in f}, 0)) as model:
                    rules, result = preflight('t3_thread_send', {'message': message}, CWD, index.path, session_id='other')
                    self.assertEqual([policy], [r['text'] for r in rules])
                    self.assertEqual('deny', result['decision'])
                    model.assert_called_once()
                engine = CheckEngine(rules_path=index.path)
                for trigger in ('first_prompt', 'compaction'):
                    self.assertEqual([policy], [r['text'] for r in engine.preflight(dict(trigger=trigger, cwd=CWD, prompt=message))[0]])
        for verb in ('approve', 'bypass', 'retry', 'commit', 'rebase', 'squash', 'enable', 'disable', 'revoke', 'reauthorize'):
            for prefix, suffix in (('Never ', ' unless CI checks passed.'),
                                   ('Do not ', ' while CI checks are pending.'),
                                   ('Only ', ' after CI checks passed.'),
                                   ('Must not ', ' unless CI checks passed.'),
                                   ('Should not ', ' while CI checks are pending.'),
                                   ('Cannot ', ' until CI checks passed.'),
                                   ('If CI checks are pending, ', '.'),
                                   ('Unless CI checks passed, please ', '.'),
                                   ('Owner rule: ', ' only after CI checks passed.')):
                policy = prefix + verb + ' PR1145' + suffix
                with self.subTest(verb=verb, prefix=prefix):
                    self.assertEqual(policy, comparison_text(policy, message))

    def test_negative_ci_outcomes_are_reports_for_each_subject(self):
        from recall_fact_scope import comparison_text
        changed = 'PR1145 head 72a10c19 CI checks pending.'
        matching = 'PR1145 head 66cfd86f CI checks failed.'
        for subject in ('CI checks', 'check', 'checks', 'workflow', 'workflows', 'run', 'runs'):
            for predicate in ('passed', 'is green', 'was green', 'has passed'):
                fact = f'No {subject} {predicate} for PR1145 head 66cfd86f.'
                with self.subTest(subject=subject, predicate=predicate):
                    self.assertEqual('', comparison_text(fact, changed))
                    self.assertEqual(fact, comparison_text(fact, matching))
        index = RuleIndex(self.root / 'negative-result.db')
        index.remember('No runs passed for PR1145 head 66cfd86f.', scope=CWD)
        with patch('recall_messages.contradiction', side_effect=lambda m, f: ({str(r['id']): .99 for r in f}, 0)) as model:
            self.assertEqual(([], None), preflight('t3_thread_send', {'message': changed}, CWD, index.path))
            model.assert_not_called()
            self.assertEqual('deny', preflight('t3_thread_send', {'message': matching}, CWD, index.path)[1]['decision'])
        engine = CheckEngine(rules_path=index.path)
        for trigger in ('first_prompt', 'compaction'):
            self.assertEqual([], engine.preflight(dict(trigger=trigger, cwd=CWD, prompt=changed))[0])

    def test_no_prohibitions_survive_list_and_address_prefixes(self):
        from recall_fact_scope import comparison_text
        message = 'Approve PR1145 while CI checks are pending.'
        prefixes = ('', '- ', '* ', '1. ', '12. ', '[Abdullah] ', '1. [Abdullah] ',
                    'Please ', 'Actually, ', '- Please ', '1. Actually, ')
        for i, prefix in enumerate(prefixes):
            policy = prefix + 'No approval for PR1145 unless CI checks passed.'
            with self.subTest(prefix=prefix):
                index = RuleIndex(self.root / f'no-policy-{i}.db')
                index.remember(policy, scope=CWD)
                self.assertEqual(policy, comparison_text(policy, message))
                with patch('recall_messages.contradiction', side_effect=lambda m, f: ({str(r['id']): .99 for r in f}, 0)):
                    self.assertEqual('deny', preflight('t3_thread_send', {'message': message}, CWD, index.path)[1]['decision'])
                engine = CheckEngine(rules_path=index.path)
                for trigger in ('first_prompt', 'compaction'):
                    self.assertEqual([policy], [r['text'] for r in engine.preflight(dict(trigger=trigger, cwd=CWD, prompt=message))[0]])
        for verb in ('run', 'check'):
            policy = f'Never {verb} failed tests for PR1145 unless CI checks passed.'
            self.assertEqual(policy, comparison_text(policy, message))

    def test_no_policies_survive_removal_of_a_stale_ci_sentence(self):
        from recall_fact_scope import comparison_text
        message = 'Approve PR1145 head 72a10c19 while CI checks are pending.'
        prefixes = (('', ''), ('- ', ''), ('* ', ''), ('1. ', ''), ('12. ', ''),
                    ('[Abdullah] ', '[Abdullah] '), ('1. [Abdullah] ', '[Abdullah] '),
                    ('Please ', 'Please '), ('Actually, ', 'Actually, '),
                    ('- Please ', 'Please '), ('1. Actually, ', 'Actually, '))
        outcomes = (' PR1145 head 66cfd86f: CI checks passed.',
                    '\n`PR1145` head `66cfd86f` is **green**.', ' Both CIchecksSUCCESS.')
        for i, (prefix, retained) in enumerate(prefixes):
            for j, outcome in enumerate(outcomes):
                policy = 'No approval for PR1145 unless CI checks passed.'
                fact, expected = prefix + policy + outcome, retained + policy
                with self.subTest(prefix=prefix, outcome=outcome):
                    self.assertEqual(expected, comparison_text(fact, message))
                    index = RuleIndex(self.root / f'mixed-no-policy-{i}-{j}.db')
                    index.remember(fact, scope=CWD)
                    with patch('recall_messages.contradiction', side_effect=lambda m, f: ({str(r['id']): .99 for r in f}, 0)) as model:
                        rules, result = preflight('t3_thread_send', {'message': message}, CWD, index.path)
                        self.assertEqual([expected], [r['text'] for r in rules])
                        self.assertEqual('deny', result['decision'])
                        model.assert_called_once()
                    engine = CheckEngine(rules_path=index.path)
                    for trigger in ('first_prompt', 'compaction'):
                        self.assertEqual([expected], [r['text'] for r in engine.preflight(dict(trigger=trigger, cwd=CWD, prompt=message))[0]])


if __name__ == '__main__':
    unittest.main()

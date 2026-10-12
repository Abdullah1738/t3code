import copy
import hashlib
import multiprocessing as mp
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

import talabat_submit_journal as j


def review():
    now = time.time()
    return {'version':1, 'bindings':{k:hashlib.sha256(('synthetic-'+k).encode()).hexdigest() for k in j.BINDINGS},
            'currency':'AED','payable_minor':3014,'observed_at':now-1,'expires_at':now+60}


def child_consume(root, value, output):
    j.ROOT = Path(root)
    try:
        output.put(j.consume(value,j.review_digest(value))['state'])
    except j.TalabatError as error:
        output.put(str(error))


def child_crash_after_consume(root, value):
    j.ROOT = Path(root)
    j.consume(value, j.review_digest(value))
    os._exit(23)  # no finalizers, parent readback must still find the fence


class JournalTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)/'journal'
        self.patch=patch.object(j,'ROOT',self.root); self.patch.start()
        self.addCleanup(self.temp.cleanup); self.addCleanup(self.patch.stop)

    def consume(self, value=None):
        value=value or review()
        return j.consume(value,j.review_digest(value))

    def test_durable_consumption_before_any_send(self):
        out=self.consume()
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            self.assertEqual(db.execute('SELECT state FROM attempts').fetchall(),[('MAY_HAVE_SENT',)])
        self.assertEqual(out['state'],'MAY_HAVE_SENT')
        self.assertEqual((self.root/'journal.sqlite').stat().st_mode & 0o777,0o600)
        self.assertEqual(self.root.stat().st_mode & 0o777,0o700)

    def test_same_account_new_cart_and_quote_cannot_retry(self):
        self.consume()
        value=review(); value['bindings']['cart']='f'*64; value['payable_minor']=3020
        with self.assertRaisesRegex(j.TalabatError,'ALREADY_FENCED'): self.consume(value)

    def test_crash_after_consumption_cannot_retry(self):
        ctx=mp.get_context('spawn'); value=review()
        p=ctx.Process(target=child_crash_after_consume,args=(str(self.root),value)); p.start(); p.join(10)
        if p.is_alive():
            p.terminate(); p.join(); self.fail('synthetic child exceeded timeout')
        self.assertEqual(p.exitcode,23)
        with self.assertRaisesRegex(j.TalabatError,'ALREADY_FENCED'): self.consume(value)

    def test_concurrent_processes_only_one_consumes(self):
        ctx=mp.get_context('spawn'); output=ctx.Queue(); value=review()
        children=[ctx.Process(target=child_consume,args=(str(self.root),value,output)) for _ in range(3)]
        try:
            for child in children: child.start()
            for child in children:
                child.join(10); self.assertFalse(child.is_alive()); self.assertEqual(child.exitcode,0)
            results=[output.get(timeout=2) for _ in children]
            self.assertEqual(results.count('MAY_HAVE_SENT'),1,results)
        finally:
            for child in children:
                if child.is_alive(): child.terminate(); child.join()
            output.close(); output.join_thread()

    def test_bad_approval_no_journal(self):
        with self.assertRaisesRegex(j.TalabatError,'NOT_APPROVED'): j.consume(review(),'f'*64)
        self.assertFalse(self.root.exists())

    def test_expired_future_and_bool_money_denied(self):
        for mutate in ('expired','future','bool','ttl'):
            value=review()
            if mutate=='expired': value.update(observed_at=time.time()-100,expires_at=time.time()-1)
            elif mutate=='future': value.update(observed_at=time.time()+10,expires_at=time.time()+60)
            elif mutate=='bool': value['payable_minor']=True
            else: value['expires_at']=value['observed_at']+121
            with self.subTest(mutate=mutate),self.assertRaises(j.TalabatError): self.consume(value)
        self.assertFalse(self.root.exists())

    def test_only_hash_bindings_no_arbitrary_fields(self):
        value=review(); value['bindings']['card']='private-token'
        with self.assertRaises(j.TalabatError): j.review_digest(value)
        value=review(); value['address']='private street'
        with self.assertRaises(j.TalabatError): j.review_digest(value)

    def test_observations_never_release_fence(self):
        self.assertIn('PAYMENT_PENDING', j.STATES)
        self.assertNotIn('PAID', j.STATES)
        consumed=self.consume()
        for state in j.STATES:
            self.assertFalse(j.record_observation(consumed['operation'],state,'e'*64)['retry_allowed'])
        with self.assertRaisesRegex(j.TalabatError,'ALREADY_FENCED'): self.consume()
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            self.assertEqual(db.execute('SELECT state FROM attempts').fetchone()[0],'MAY_HAVE_SENT')
            self.assertEqual(db.execute('SELECT count(*) FROM observations').fetchone()[0],len(j.STATES))

    def test_unknown_or_free_text_observation_denied(self):
        with self.assertRaises(j.TalabatError): j.record_observation('0'*36,'private-error','e'*64)
        with self.assertRaisesRegex(j.TalabatError,'OPERATION_UNKNOWN'):
            j.record_observation('0'*36,'RESPONSE_RECEIVED','e'*64)

    def test_symlink_directory_database_and_permissive_mode_denied(self):
        other=Path(self.temp.name)/'other'; other.mkdir(mode=0o700)
        self.root.symlink_to(other)
        with self.assertRaises(j.TalabatError): self.consume()
        self.root.unlink(); self.root.mkdir(mode=0o700)
        path=self.root/'journal.sqlite'; target=other/'db'; target.touch(mode=0o600); path.symlink_to(target)
        with self.assertRaises(j.TalabatError): self.consume()
        path.unlink(); path.touch(mode=0o644)
        with self.assertRaises(j.TalabatError): self.consume()

    def test_storage_failure_cannot_return_permission(self):
        with patch.object(j.os,'fsync',side_effect=OSError('private path')):
            with self.assertRaisesRegex(j.TalabatError,'JOURNAL_UNAVAILABLE'): self.consume()
        # COMMIT happened before directory sync failed: it is still spent.
        with self.assertRaisesRegex(j.TalabatError,'ALREADY_FENCED'): self.consume()

    def test_first_use_syncs_parent_entry_as_well_as_database_directory(self):
        synced = []
        original = j.os.fsync
        def sync(fd):
            info = os.fstat(fd)
            synced.append((info.st_dev, info.st_ino))
            original(fd)
        with patch.object(j.os, 'fsync', side_effect=sync): self.consume()
        for path in (self.root, self.root.parent):
            info = path.stat()
            self.assertIn((info.st_dev, info.st_ino), synced)

    def test_missing_state_parent_is_not_silently_recreated(self):
        missing = Path(self.temp.name)/'missing-parent'
        with patch.object(j, 'ROOT', missing/'journal'):
            with self.assertRaises(j.TalabatError): self.consume()
        self.assertFalse(missing.exists())

    def test_corrupt_database_fails_closed_without_reset(self):
        self.root.mkdir(mode=0o700)
        path=self.root/'journal.sqlite'; path.write_bytes(b'corrupt synthetic db'); path.chmod(0o600)
        with self.assertRaisesRegex(j.TalabatError,'JOURNAL_UNAVAILABLE'): self.consume()
        self.assertEqual(path.read_bytes(),b'corrupt synthetic db')

    def test_hardlinked_database_denied(self):
        self.consume(); path=self.root/'journal.sqlite'
        os.link(path,self.root/'copy')
        with self.assertRaisesRegex(j.TalabatError,'UNSAFE_PATH'): self.consume()

    def test_expiry_rechecked_inside_exclusive_transaction(self):
        value=review()
        with patch.object(j.time,'time',side_effect=[value['observed_at']+1,value['expires_at']+1]):
            with self.assertRaisesRegex(j.TalabatError,'STALE'): self.consume(value)
        # Nothing was consumed; rolled-back first-use DDL must not become an
        # unrecoverable pseudo-attempt. A genuinely fresh review can be consumed.
        self.assertEqual(self.consume()['state'],'MAY_HAVE_SENT')

    def test_digest_changes_for_each_binding(self):
        value=review(); before=j.review_digest(value)
        for key in j.BINDINGS:
            altered=copy.deepcopy(value); altered['bindings'][key]='f'*64
            self.assertNotEqual(j.review_digest(altered),before)


if __name__=='__main__': unittest.main()

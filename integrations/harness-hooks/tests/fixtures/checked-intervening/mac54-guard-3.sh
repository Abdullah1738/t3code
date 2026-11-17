cat >> integrations/mac-logging/tests/test_deep_probe.py <<'PY'

    def test_budget_and_stop_truncation_preserve_probe_escalation(self):
        for cutoff in (0, 1, 7, 14.999, 30, 59.999):
            for stopped in (False, True):
                with self.subTest(cutoff=cutoff, stopped=stopped):
                    root = self.roots([('truncated-%s-%s'%(cutoff, stopped), 1)])[0]
                    key = str(root/'0000')
                    cache = {key: dict(partial=True, probeTimeouts=2, lastProbeS=30, lastTimeoutS=30)}
                    self.clock[0] = 0
                    def interrupted(command, **kwargs):
                        self.clock[0] += cutoff
                        raise subprocess.TimeoutExpired(command, cutoff)
                    jobs.big_root_inventory(root, interrupted, 1000 if stopped else cutoff,
                                            cache, deep=True, max_batches=1)
                    self.assertGreaterEqual(jobs.inventory_probe_allowance(cache[key], []), 60)
                    self.assertFalse(jobs.inventory_has_timeout(cache[key]))
                    self.assertNotIn('bytes', cache[key])

    def test_interrupted_batch_keeps_bytes_without_learning_timeout_as_success_cost(self):
        root = self.roots([('batch-timing', 128)])[0]
        first, second = str(root/'0000'), str(root/'0001')
        for prior in (None, 1000):
            with self.subTest(prior=prior):
                self.clock[0] = 0
                cache = {str(p): dict(bytes=2048, at=self.now-90000, partial=False,
                                     **({'elapsedMs': prior} if prior is not None else {}))
                         for p in root.iterdir()}
                def interrupted(command, **kwargs):
                    self.clock[0] += kwargs['timeout']
                    raise subprocess.TimeoutExpired(command, kwargs['timeout'], output='1\t'+first+'\n')
                jobs.big_root_inventory(root, interrupted, 1000, cache, deep=True, max_batches=1)
                self.assertEqual(cache[first]['bytes'], 1024)
                self.assertFalse(cache[first]['partial'])
                self.assertEqual(cache[first].get('elapsedMs'), prior)
                self.assertEqual(cache[second]['bytes'], 2048)
                self.assertTrue(cache[second]['partial'])
                self.assertEqual(jobs.inventory_probe_allowance({}, [v['elapsedMs'] for v in cache.values()
                    if jobs.number(v.get('elapsedMs'))]), 15)

    def test_timeout_with_every_batch_row_keeps_totals_and_counts_timeout(self):
        root = self.roots([('all-rows', 128)])[0]
        cache = {}
        metrics = dict(timeouts=0, secondsInTimeouts=0)
        def interrupted(command, **kwargs):
            self.clock[0] += kwargs['timeout']
            raise subprocess.TimeoutExpired(command, kwargs['timeout'],
                output=''.join('1\t'+key+'\n' for key in command[2:]))
        total, status, children = jobs.big_root_inventory(root, interrupted, 1000, cache,
            deep=True, max_batches=1, metrics=metrics)
        self.assertEqual(total, 128*1024)
        self.assertFalse(status['partial'])
        self.assertEqual(len(children), 128)
        self.assertEqual(metrics['timeouts'], 1)
        self.assertEqual(metrics['secondsInTimeouts'], 60)
        self.assertTrue(all('elapsedMs' not in v for v in cache.values()))
        event = [r for r in self.rows('disk.inventory.source') if r['props'].get('failure') == 'timeout'][-1]
        self.assertEqual(event['props']['allowanceS'], 60)
PY
PYTHONDONTWRITEBYTECODE=1 python3 -I -m unittest discover -s integrations/mac-logging/tests -p test_deep_probe.py -k test_budget_and_stop -v
PYTHONDONTWRITEBYTECODE=1 python3 -I -m unittest discover -s integrations/mac-logging/tests -p test_deep_probe.py -k test_interrupted_batch -v
PYTHONDONTWRITEBYTECODE=1 python3 -I -m unittest discover -s integrations/mac-logging/tests -p test_deep_probe.py -k test_timeout_with_every -v
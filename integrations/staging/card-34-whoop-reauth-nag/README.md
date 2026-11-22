# WHOOP reauth reminder and pending-error rollup

The health vault lives outside this repository. Adjacent patches preserve its source and synthetic test deltas. The shared helper at integrations/robob-watch/toollog.py is byte-identical to the candidate vault and runner copies.

Apply vault patches only in a private copy with patch -F0 -p1, checking the pinned bases below. Run the synthetic suites before an evaluator performs hash/backup/atomic file swaps. No watcher or listener restart is needed. No auth state, tokens, databases, logs or health records belong in this mirror.

A rolling 24-hour claim under TokenLock limits owner-only Telegram notices, including across midnight and concurrent processes. reminderSent means durable CLI queue acceptance. An uncertain attempt consumes the throttle. Expired notices persist their original key/text before sending and retry that identical payload after the throttle until queue acceptance; only acceptance completes the notice. A successful sync clears the episode and any unsent notice while preserving the throttle.

Only failed whoop-sync sync.run rows with reason=refresh_rejected AND reauthPending=true are excluded from errorCount/errorRate/topErrors. Legacy unmarked rows and real sync errors remain errors. Raw kind counts, authFailures and failure streaks retain failures.

Bases and candidates (SHA-256):
- whoop/whoop.py: 57ee154f507601ae7966a87f957cb816cf42896b03c8e2d6cb1f3c568e989b3c -> 645f654d3370d8223eca925312a6f12507b8df8cd8f81f4455aeec349e6c1f5a
- toollog.py: 8e036db6d4a0be7ceacae3af6098734ffedd9afd2ae4d6125214f4640e7f0ce4 -> 55e4422bda8f8fad4e2f7a2ece46536fd03f9ec0bcc4cd57cc83f87cd7de6b36
- toollog_rollup.py: 185bd9028d5d462987abe5039f0c04325d42379c24b328356574a7560497a3e6 -> 3cec2d9ccecc55218dc8ab9cbef3ba63b66de81b83646a97ec2d4fd04ab83c29
- test_whoop_reauth.py: 7a2ae0a7764cba00f1a79e633ce6342364cbe58628e37f3e94aa5e55f2f5b470 -> 319df0a4a8259fdc702f78992dd6b40a8511a2e76192c09795790c35cfe02a09
- test_toollog.py: b96e8690ebb363f330d84881483deb9e1a475ddd13272969d06df93bef685c6e -> 28da990dae8f09193a9419cbe2ce4d3321a1af1b5eb88074f69cce439288a5d7
- test_whoop_reminder.py: None -> 8baf519ed6906e1207b88127c185c5640258af98bfda215d793acd5383272238

Tests: HEALTH_VAULT_TEST_COPY=1 /usr/bin/python3 -B -m unittest -v test_whoop_reauth test_toollog test_error_detail test_whoop_reminder

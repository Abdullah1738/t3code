mkdir -p tmp/card-2708/sol-fence-17de2968 && python3 - <<'PY'
from pathlib import Path
import shutil
source=Path('/Users/ardud/checkouts/registry-2708-sol-fence/tmp/sol-fence-review')
target=Path('tmp/card-2708/sol-fence-17de2968')
for p in source.iterdir():
    if p.is_file():
        shutil.copy2(p,target/p.name)
(target/'review.md').write_text('''# Card 2708 Sol review: OVR floor fence

PR https://github.com/Equicom-Crypto/registry/pull/61
Exact reviewed head 17de2968aba3ce42ed93495d54a7a29c225e370e
Tree 1c6f58977a00f6661cc116336452ad355b016486
Previous clear head 80543ef73b73e05045965ac12c7b05af93d8e026
Broker reference 44cd8af8109deadd759913c486e1f68b05d16a4c (PR240)

One P2 acceptance finding: REGTL-054's NULL branch is not the required attribute_type check. transactional_store.go:165-171 uses max_version = :max AND #deleted = :deleted for both M and NULL, with an AttributeValueMemberNULL. override_floor_freshness_test.go:151-154 enforces that expression. The exact Broker requirement and evaluator steer require max_version equality AND attribute_type(deleted_item, :null_type), with :null_type a DynamoDB S containing NULL. Update the branch, the emitted-request assertion and fake condition evaluator. Preserve the independent floor failure on the first delete at unchanged maximum, same-SEND rebuild, and commit then LSO before ack. No evidence is claimed that equality with NULL itself accepts stale data.

REGTL-052 maps to TestREGTLOverrideFloorFreshness/same_maximum_with_changed_deletion.
REGTL-053 maps to TestREGTLOverrideFloorFreshness/advanced_floor.
REGTL-054's interleaving and acknowledgement ordering exist in TestREGTLOverrideNullFloorFirstDelete, but its NULL emitted request is inconsistent with the merged contract.
All three assert same-SEND retry and delayed ack until Kafka commit and stable offsets. M floor request pins the exact map from strong read. No-floor request asserts attribute_not_exists(pk). Retry bounds and source/live-obligation checks remain.

Fresh checks from an isolated ovnfs checkout, offbox steps all exit 0:
- go test ./... -count=1
- go test -race ./internal/publisher/... ./internal/kafka/... -count=1
- go vet ./...
- go build ./...
Hosted CI 42466744877 / verify job 128687909240 is successful at the exact head.

Scratch overlay probe: offbox run --include tmp/sol-fence-review/probe.py --pull tmp/sol-fence-review -- python3 tmp/sol-fence-review/probe.py
The baseline focused tests exit 0. The following mutants exit 1 through assertions, not compilation failures:
- version-only floor (052 mixed read fails, 053 exact request fails)
- attribute_exists(pk) floor (052 and 053 fail)
- attribute_exists(pk) AND deleted_item equality (053 exact transaction assertion fails, including max_version weakening alone)
- NULL test assertion changed to require Broker's attribute_type expression (fails at emitted request line 67)
Probe orchestration exits 0 because each mutant failed as expected. Full outputs and overlays adjacent. Absolute paths in overlay JSON refer to the remote scratch directory at execution; probe.py regenerates them from cwd.

Independent supporting Sol review, xhigh/default tier, agrees with the one acceptance finding and finds no additional runtime defect in the three-file delta. Own supporting checkout removed.
Quint skipped: wiki sol-quint explicitly excludes reviewers/review chains.

Nonblocking worker note: map REGTL-052/053/054 in PR body and cite Broker44cd8af8; current PR body still describes #3057 as pending. Reviewer left body unchanged.
No source/PR edit, commit, push, merge, deploy or live service acceptance. Prior instrument anchor and exact numeric alias fixes are unchanged from the previously reviewed head.

Verdict not submitted yet.
''')
PY
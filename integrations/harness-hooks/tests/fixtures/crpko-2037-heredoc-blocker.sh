cat > tmp/hc041-f03/BLOCKER.md <<'EOF'
# HC-041-F03 scope blocker

Base: f49cc1d3a9bddfd4692e0fbeddd8918d9cf6db6e (origin/native-v1, 9 Nov 2026).
Checkout: /Volumes/ExternalSSD/board-wt/crpko-integration-harness-HC-041-F03
Dependency PR #494 merged as daf757af8fd83232227c7fbc578ccc36a19c2d42; ancestor check passes.
F04 #2039 is todo, no merged PR: six leverage members stay out; 11 candidate members remain.
All required picks are recorded in the card and local HC-041/cards/decisions.json.

## Required scope change

The owned files are the cohort, its documentation, its tests and one policy line.
No existing production owner ledger or authority-grant artifact exists for these rows.

- src/harness/completion/exceptions.py:67 has an empty TRUSTED_OWNER_FILES.
- docs/completion/exceptions.md:131-135 explicitly says each new owner file must
  land with its SHA256 trust line in the same PR; F01 added list format only.
- authority_loader.py:317-335 reads AuthorityGrants from a separate artifact.
  The cohort schema forbids adding a grants member, and a Markdown document is
  not a JSON AuthorityGrants artifact.
- authority_loader.py:330 validates the owner source section's closure bytes,
  but does not consult TRUSTED_OWNER_FILES or validate the recorded answer.
  Thus using only this existing route-grant path does not meet this card's
  stronger trust/answer admission rule, including the missing-answer regression.
- authority_loader.py:623-624 supports observation phase only. A startup premise
  might be a required fixture on an observation entry; this probe alone does
  not rule that representation out. No startup response is invented.
- authority_loader.py:637-639 requires a concrete HTTP status. There is no
  no-intent/no-send disposition branch for the answered TC-4094 handling.
  Setting active=false only yields dormant, not an approved no-intent decision.

## Reproduction

Command (exit 0):
PYTHONPATH=src:tests /Users/ardud/CrpkoArchitectureBroker/tmp/crpko-integration-harness/.venv/bin/python tmp/hc041-f03/probe.py

This uses Scenario's real XLSX capture, catalog and load_dispositions/resolve path;
it constructs no CasePlan and changes no source or environment.
Output:
trusted_owner_files: []
normal: resolved ()
prepare: unresolved ('source API/phase binding unsupported or mismatched',)
no-response: unresolved ('response authority requires an exact HTTP status',)

The normal control resolves even though the independent trust set is empty;
the source exists and is bound, which is weaker than the card's trust rule.

Separately, WorkbookParser.parse_bound on the checked-in Backoffice workbook
captures TC-4094 at row 37 with Objective / Preconditions / Request /
Expected Response / Expected State Change. build_case yields expected_status=None,
request_format='prose', request_problem='Request cell is prose, not a request;
cannot tell what to send'. No status was assigned to this non-test row.

## Proposed prerequisite and amended files

Preserve every existing owner answer and the 900-line data PR ceiling.
Before the route data PR, implement and review trusted exact-answer admission
and counted no-intent/no-send handling through the real loader/planning path.
The data PR then also needs an exact owner-decision ledger, a separate JSON
AuthorityGrants artifact, and that ledger's reviewed digest line in exceptions.py.
Suggested additional data files: workbooks/owner-decisions/HC041-R01.md and
workbooks/authority-grants/HC041-R01.json (names require amended ownership).
Do not reuse the historical provider approval or bypass trust in tests.

Quint skipped: this investigation changes no state machine or concurrency.
No tracked changes, commits, PR, full suite or hosted CI; implementation is
blocked before coding by the owned-file restriction and unsupported disposition.
No environment writes, Linear operations or messages to people.
EOF
git status --short
cat tmp/hc041-f03/probe.log
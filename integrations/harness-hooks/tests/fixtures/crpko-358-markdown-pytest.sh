cat > docs/completion/fail-list.md <<'EOF'
# Complete failure lists and local drafts

These offline commands retain every observed product violation and the full campaign
membership. A valid violation can coexist with missing obligations: it remains a
finding and its row remains in the closure appendix. A trusted service failure is
valid evidence, rather than a reason to require a 100% pass rate.

```sh
uv run python scripts/completion_fail_list.py build --report evidence --score score.json --output list-1
uv run python scripts/completion_fail_list.py drafts --report evidence --approval approval.json --output drafts-1
```

Both commands have `--help`. Exit 0 means the local output meets its gate, 1 means
build published an explicitly incomplete list (including pending retries), and 2
means invalid input, changed evidence, missing authorization or an output conflict.
Output directories must be new. A failed publication is never resumed or overwritten;
retain the partial directory for inspection and use another directory after recovery.

## Input directory and schemas

All records use `schema_version: completion-v1`, frozen strict schemas and canonical
SHA256 hashes. Unknown fields, duplicate JSON keys and wildcard approvals are refused.
Use the Python record constructors below to generate JSON, rather than inventing fields.

- `report.json`: `CompletionReport` from the declared-run reducer.
- `reduction.json`: `ReductionInput` from `harness.completion.fail_list`. It contains
  the exact `CampaignManifest`, `selections: [AttemptSelection]`, and `supersessions`.
  Optional `historical_owner`, `reached_milestones`, and `transform_dispositions`
  supply the existing exception verifier's authority inputs. Original workbook and
  source files must remain available at their bound paths. No approval trust anchor
  is added by these commands.
- The immutable `runs/` and captured artifacts live beneath this same directory.
  Build and drafts replay seals, qualification, exception decisions and governing
  selection through `reduce_campaign`. A hand-written status table cannot replace
  a reducer report. Missing and corrupt evidence fail closed.
- `sample.json`: exact `ReviewSample` produced by the review command. The score's
  sample digest must match, and policy, first judgments, adjudication, owner review
  and known-wrong findings are replayed through `score_judgments`. An accepted
  policy file must remain available. A sample never certifies population accuracy.
- `causes.json` (optional): `GroupingInput` from `scripts.completion_fail_list`, with
  `assignments: [{finding_sha256, cause}]`. Obtain finding hashes with
  `record_digest(finding)` over the default build. `CauseHypothesis` names service,
  route, phase, hypothesis, source, evidence, and confidence (`hypothesis` or
  `established`). Its source must belong to the finding's exact sources, evidence
  must be nonempty and drawn from that observation, and phase must match.
  Established identical source/service/route/phase/hypothesis combinations group
  together while retaining each member's distinct evidence. Uncertain or absent
  causes stay separate. No route, root cause or ticket is inferred from old labels.

The pure APIs are `collect_findings`, `group_findings`, `build_fail_list`,
`retry_selection`, `attach_retry`, `approval_digest`, `validate_fail_list_approval`
and `render_drafts` in `harness.completion.fail_list`. They consume reducer records;
the CLI additionally verifies them against their actual sealed publications.

## One declared retry

Build writes `fail-list.json`, `score.json`, `retry-request.json` and
`approval-digest.txt`. The list contains each exact RowKey (including catalog and
workbook hashes), obligation, observation, source/cell references, attempt and seal
hashes, governing identity, groups, closure issues and review. There is no automatic
Linear ticket linkage. Original obligations and explicit typed exceptions remain in
the full embedded report; missing obligations and cleanup cannot disappear from the
denominator.

`RetryRequest` selects exact structured rows, original attempts and obligation IDs
with one execution per member. It is a request only. It grants no provider, spend,
mutation or execution authority. The campaign runner must obtain operation approval
separately. Never split sheet/case identities on an unescaped separator.

After that authorized retry, retain the first `fail-list.json` as
`retry-baseline.json` in the evidence directory. Replace `report.json`,
`reduction.json` and `sample.json` with the newly reduced and reviewed records; pass
the new score to build with another output directory. Both old and new sealed runs
must remain available. Exactly one new attempt per selected member is supported;
additional retries or incompatible campaigns require separate review, not a
latest-timestamp choice. The original failure stays in the list even when an
explicit adjudication selects a passing retry.

A matching valid failure is reproducibility evidence only. Conflicting valid
fail/pass outcomes stay unresolved until the reducer accepts an exact, source-bound
`Supersession`. Even matching attempts still need an explicit governor to close
reduction. Adjudication does not clear missing observations or unsafe cleanup.

## Exact owner approval and local output

Copy the completed build's `fail-list.json` and `score.json` into the evidence
input directory. The digest binds the complete canonical report, every group and
member, old/new attempt/source mapping, retry lineage and the review policy/sample
and judgments. Changing any of those requires a fresh build and owner approval.
Build itself needs no fail-list approval.

`FailureListApproval` has `digest`, `approved_by: Abdullah`, nonnegative
`approved_at_ms`, and `origin: SourceRef`. The origin is a local file containing
exactly the approval record **without** its `origin` field. Its bytes must match
the source SHA256; its ID and anchor identify the exact decision, with no wildcard.
For example, prepare that decision file for Abdullah to approve, then construct
`FailureListApproval` with its hash and exact anchor. A label saying “approved”
or an approval for all future reports is insufficient.

Drafts replays the directory and compares its exact result with the stored list.
It requires zero unapproved closure gaps, complete required review, one resolved
retry per selected failure and the exact approval. It writes `drafts.json` and
`ticket-drafts.md`, with every individual row, evidence/source references and retry
lineage. Neither command imports a network client, executes a retry, searches or
creates Linear issues, posts to GitHub, or changes an environment. Later external
actions require their own authorization.

This is a foundation capability with an empty historical member manifest: zero live
row gain is claimed. Unsupported observer predicates, unqualified controls, missing
provider evidence, held rows and incomplete restoration stay unresolved under their
owning completion components. This change does not qualify those components or
close the full campaign gate by itself.
EOF
PYTHONPATH=src:tests /Users/ardud/CrpkoArchitectureBroker/tmp/crpko-integration-harness/.venv/bin/python -m pytest -q tests/test_completion_fail_list.py
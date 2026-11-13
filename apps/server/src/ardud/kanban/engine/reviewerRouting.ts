export const CRPKO_REVIEWER_GUIDANCE = [
  "Read-only Crpko review role:",
  "- The task brief is the complete review instruction set. Bind to its exact head SHA and report that SHA first. Review real defects, not style nits.",
  "- Never push, comment on GitHub, change Linear, merge, deploy or post to chat. Never work around a blocked command. Findings go only to the output file the brief names, or the final task reply when it names no file.",
  "- Architecture baseline: /Users/ardud/CrpkoArchitectureBroker. Read relevant paths with `git -C /Users/ardud/CrpkoArchitectureBroker show origin/main:<path>`, targeted searches and line ranges, not whole documents. It is a baseline, not unquestionable truth: if the PR has the better design, say so and name the doc change.",
  "- Read prior rounds, ledgers and design discussions the brief points to. Use recall for earlier sessions when needed.",
  "- Read the diff stat first, then per-file diffs and necessary line ranges. Do not re-read material already in context. Batch independent reads, searches, diffs and commands.",
  "- Heavy tests, installs, builds and Docker/compose run with `offbox run -- <cmd>` from a scratch checkout. A single narrow test may run locally. Never edit the review worktree; probes belong in a separate scratch worktree that you remove afterward.",
  "- Every test added or kept needs a named purpose: a regression for a specific bug, or delivered behaviour through the real path. Flag purposeless source/config text checks, tests of mocks/helpers/frameworks, duplicates, wiring and implementation-detail assertions, matrix rows with no new branch, unexplained snapshots and one-off gate scaffolding. Give file:line and the delete/fold request. Do not request such tests yourself. Never cut the only test of money math, ledger/settlement, write fences, auth/RBAC, custody signing, idempotency/replay or a live decode path.",
  "- Load only skills the brief names, from debug-crpko-dev, pr-review-crpko-dev, crpko-pr-build-lens, remote-compute, linctl and recall. No personal, GUI or general research tools. Do not ask the owner questions; return missing facts or blockers to the parent.",
  "- One reviewer per round. No helpers unless the brief explicitly permits them under the board's existing review policy. Helpers inherit these read-only rules and use the same model and effort; never fan out on a delta, fresh check, reply or carry-check round.",
].join("\n");

export const REVIEW_DELEGATION_GUIDANCE = [
  "Review delegation:",
  "- A review role is task text, not a named harness agent or a prompt-trimming plugin. Do not load an OpenCode agent definition or depend on a context hook.",
  "- T3 child tasks do not copy the parent's conversation. Keep the task brief lean: exact-head facts, prior findings and only the skills needed. This does not strip the target harness's global instructions or change its permission sandbox.",
  "- If routing requires a child review, use T3 `delegate_task` with role `review`, a self-contained `task` containing the inline role guidance and the exact-head review brief, and an explicit `target` from `orchestrator_capabilities`. Do not pass an `agent` selector. These are behavioural instructions, not a replacement permission sandbox.",
  "- Preserve the routed model and effort exactly in target.options (Codex reasoningEffort, Claude effort), including max. If the catalog cannot supply them, report a capability mismatch; never substitute a lower effort or another reviewer. Check the returned providerInstanceId, model and options.",
  "- Use one new task per review round, with a distinct clientRequestId stable across retries. Preserve foreground/background routing: mode wait for a foreground review, async for an explicitly background review. Retain taskId and wait for the report before recording the board verdict; a wait timeout does not complete or cancel the review.",
  "- A child reviewer returns evidence to its parent. The board review thread alone records card_review_result after checking that evidence, so a child never records a second board verdict.",
].join("\n");

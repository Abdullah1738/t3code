// Operations records for the Lanes, Work, Rules, Roles, Timeline and Portfolio
// tabs, from the same Crpko state as `data.ts` (Sat 17 Oct 2026, ~08:33 UTC):
// the coord.db copy (events, claims, deliveries), the import dry run, crw.db,
// STANDING-RULES and the lane roster. Lane threads and models are the dry run's.
//
// Real: lane threads and models, work items and their stages (coord events and
// crw PRs), review records and criticality calls named in coord events, rule
// quotes marked `owner`, rule acks (coord deliveries), rule use counts (coord
// mentions in the 24h before 08:33), tf:dev and arch:broker holds, rule 104's
// activation (STANDING-RULES §104), the 4 Oct 15:35Z restart and how nine of
// the lanes that answered control 1008 recovered from it.
//
// Fixture-made (marked `// made` where it matters): context token counts, the
// dates of the retired master bindings, the routing table and the one
// re-routed draft, the field-change attribution events, the pending model
// change, the rule change requests and audit findings, pool capacities for the
// observed pools, run-out times, the portfolio draw shares, the recovery
// members' last-activity time and the resume rate (the recovery brief's default).

import * as DateTime from "effect/DateTime";

import {
  AT,
  CREATED,
  CRPKO,
  FIXTURE_NOW,
  JUNO,
  ROLE_ARCH,
  ROLE_MASTER,
  SUB,
  github,
  lanes as baseLanes,
  masterActor,
} from "./data.ts";

const OPUS = "opus/claude-opus-5-5";
const HAIKU = "opus/cc/claude-haiku-5-5";
const SOL = "opus/cx/gpt-6.1-sol";
const ASTRA = "opus/gpt-6-astra";

const model = (name: string) => ({
  instanceId: "opencode",
  model: name,
  options: [{ id: "variant", value: "xhigh" }],
});

const laneActor = (name: string) => ({ _tag: "lane", laneId: `lane-${name}` });
const ownerActor = { _tag: "owner" };
const ownerApp = { _tag: "owner-app", surface: "web", sessionId: null };
const masterProvenance = {
  _tag: "agent",
  threadId: "ardud-control:thread:9d5f1360-1e79-423d-b1ce-1087fcb78eff",
  roleId: ROLE_MASTER,
};
const coord = { _tag: "import", source: "coord" };

/** Seconds since epoch (coord.db) to ISO. */
const unix = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

// --- Lanes: lead role, thread, current item, context ----------------------

interface LaneDetail {
  readonly model: string;
  readonly thread: string | null;
  readonly item?: string;
  /** made: token counts. `successions` counts real context resets. */
  readonly context?: { readonly prompt: number; readonly successions: number };
}

const OPUS_LIMIT = 1_000_000;
const HAIKU_LIMIT = 400_000;

export const laneDetails: Record<string, LaneDetail> = {
  "cell-tc": {
    model: OPUS,
    thread: "ardud-control:thread:4beaff4e-2ee2-448c-a5a4-e8218057ef0c",
    item: "CRP-13343",
    context: { prompt: 431_000, successions: 0 },
  },
  "cell-tc2": { model: HAIKU, thread: "mcp:c020d6b6-e23e-47e0-94dd-880ee74eb361" },
  "cell-tc3": {
    model: HAIKU,
    thread: "ardud-control:thread:80d9a73d-8b2f-4305-a506-43e68678c140",
    item: "CRP-13161",
    context: { prompt: 118_000, successions: 0 },
  },
  "cell-pbdraft": {
    model: HAIKU,
    thread: "ardud-control:thread:9c33be30-ee8b-494b-9658-ce0269091524",
  },
  "cell-risk": {
    model: OPUS,
    thread: "ardud-control:thread:37a1e4ff-cf41-4d2b-a010-9106865337ac",
    item: "risk68-r4",
    context: { prompt: 212_000, successions: 1 },
  },
  "cell-risk2": {
    model: HAIKU,
    thread: "ardud-control:thread:0532aee0-38f7-461f-9b3b-e51d0ec25d12",
  },
  "cell-risk3": {
    model: HAIKU,
    thread: "ardud-control:thread:11329bb6-1531-4239-8795-bae9ce690b5f",
  },
  "cell-risk4": {
    model: HAIKU,
    thread: "ardud-control:thread:28c41a40-3401-4597-baab-de3718027533",
  },
  "cell-risk5": {
    model: HAIKU,
    thread: "ardud-control:thread:2847790d-b393-495f-ba37-cabc5691384e",
    item: "CRP-13361",
    context: { prompt: 96_000, successions: 1 },
  },
  "cell-risk6": {
    model: HAIKU,
    thread: "ardud-control:thread:4e21beda-7879-4e00-bde5-c1ae315814fc",
    context: { prompt: 41_000, successions: 1 },
  },
  "cell-risk7": {
    model: HAIKU,
    thread: "ardud-control:thread:f9bb7f2f-2efa-491b-acf6-0548e154aa66",
  },
  "cell-bal": {
    model: OPUS,
    thread: "ardud-control:thread:d0cd9262-61c3-44fc-b3fd-f0b163857f67",
    item: "CRP-13198",
    context: { prompt: 655_000, successions: 0 },
  },
  "cell-custody": {
    model: HAIKU,
    thread: "mcp:0fb1c559-92b2-4e5a-a6fa-14ea065e2bf8",
    item: "CRP-13326",
  },
  "cell-money": {
    model: HAIKU,
    thread: "ardud-control:thread:8be65821-fd6b-4b10-a9e3-b0626e7a6a7b",
    item: "CRP-13154",
    context: { prompt: 172_000, successions: 0 },
  },
  "cell-edge": {
    model: HAIKU,
    thread: "mcp:d58d973a-6db0-4a96-bc2d-9209cb5a12af",
    item: "CRP-13322",
  },
  "cell-bo": {
    model: OPUS,
    thread: "ardud-control:thread:eaa2eb13-a3d5-490f-8bff-cf9b456eae95",
    item: "CRP-13298",
  },
  "cell-md": { model: HAIKU, thread: "mcp:5465c5c1-6767-4abb-8ac6-136bc9c8fadf" },
  "cell-ws": { model: HAIKU, thread: "mcp:38c9b692-30bb-4190-9844-b5c9bb1485e8" },
  "cell-edge2": {
    model: HAIKU,
    thread: "ardud-control:thread:8fd424af-e04d-41bf-956b-64f78ebdab19",
  },
  "cell-rpt": { model: HAIKU, thread: "mcp:797a5793-8045-48b1-87d6-94cbb67aebe1" },
  arch: {
    model: OPUS,
    thread: "mcp:03976a70-2de6-4d4e-bc6d-46f1a5319d0e",
    context: { prompt: 508_000, successions: 0 },
  },
  "arch-author": { model: OPUS, thread: null },
  "arch-drafter": { model: HAIKU, thread: "mcp:520b97eb-50f5-48d5-bcba-48437b2d5f0a" },
  "cell-arch-sites": { model: OPUS, thread: "mcp:b138f1a5-1357-4086-b96a-0af203f355fb" },
  "cell-video": { model: OPUS, thread: "mcp:c221bd5b-d045-4d4d-8425-59080cddb23c" },
  "cell-devops": {
    model: OPUS,
    thread: "mcp:aecee02f-2a8e-4a46-88bf-1ea89dca6db0",
    item: "kafka-d2",
  },
  "cell-devops2": {
    model: OPUS,
    thread: "mcp:7b0f80bc-6fc6-4ab2-a065-a73877d962cd",
    item: "CRP-13358",
    context: { prompt: 377_000, successions: 0 },
  },
  "cell-kafka": {
    model: OPUS,
    thread: "ardud-control:thread:fe692810-9837-4fca-8324-04dfc0fe490a",
    item: "kafka-fix",
    context: { prompt: 289_000, successions: 0 },
  },
  "cell-triage": {
    model: HAIKU,
    thread: "ardud-control:thread:80e12c86-203f-458a-806a-6c7fc19a6393",
  },
  "cell-bofe": {
    model: HAIKU,
    thread: "ardud-control:thread:c2488813-e77b-4e41-a1b4-656771774673",
  },
  "cell-fe12198": {
    model: OPUS,
    thread: "ardud-control:thread:79dd1ba0-1778-4ef1-8d5b-883a64612d65",
  },
  "cell-harness": {
    model: HAIKU,
    thread: "ardud-control:thread:c93c559f-4842-4340-8ad7-9ca422742395",
  },
  "cell-e2e": {
    model: HAIKU,
    thread: "ardud-control:thread:8d6eb791-4ba2-43f6-aa5f-dd8abdf9698a",
  },
  "cell-fab-svc": {
    model: OPUS,
    thread: "ardud-control:thread:2a655900-2fdd-475a-9d2f-5c4586358a35",
    context: { prompt: 264_000, successions: 0 },
  },
  "cell-fab-devops": {
    model: OPUS,
    thread: "ardud-control:thread:e3af2175-6023-45da-ad0f-1cc5caabf30c",
    item: "CRP-12715",
  },
  "cell-fab-tc": {
    model: OPUS,
    thread: "ardud-control:thread:dc5aaf3d-01ca-45bc-9a81-ec4f6820054b",
    context: { prompt: 84_000, successions: 0 },
  },
  observe: { model: HAIKU, thread: "mcp:445e9d9c-7d15-4d5d-a505-b994eaab7836" },
};

export const laneLimit = (detail: LaneDetail) =>
  detail.model === HAIKU ? HAIKU_LIMIT : OPUS_LIMIT;

/** Lane `name` is led by role `crpko-<name>` (arch keeps `crpko-arch`). */
export const laneRoleId = (name: string) => `crpko-${name}`;

// --- Roles and bindings -----------------------------------------------------

const role = (
  id: string,
  kind: string,
  name: string,
  description: string,
  modelName: string,
  laneName: string | null,
  extra: { writesPublicText?: boolean; pending?: string } = {},
) => ({
  id,
  missionId: CRPKO,
  kind,
  name,
  description,
  modelSelection: model(modelName),
  pendingModelSelection: extra.pending ? model(extra.pending) : null,
  laneId: laneName ? `lane-${laneName}` : null,
  writesPublicText: extra.writesPublicText ?? false,
  lockedFields: [],
  createdAt: CREATED,
  updatedAt: FIXTURE_NOW,
});

const RISK6 = "cell-risk6";

export const roles = [
  role(
    ROLE_MASTER,
    "master",
    "Crpko master",
    "Runs the mission: plans, calls, deploy order, drafts.",
    OPUS,
    null,
    {
      writesPublicText: true,
    },
  ),
  role(
    "crpko-reviewer-sol",
    "reviewer",
    "Sol reviewer",
    "Every PR round (rule 88/89); splits the diff across read-only subagents (rule 99).",
    SOL,
    null,
  ),
  role(
    "crpko-final-astra",
    "final-reviewer",
    "Astra final",
    "Final CLEAR at exact head for XL or 10/10 critical PRs (rule 89).",
    ASTRA,
    null,
  ),
  ...Object.entries(laneDetails).map(([name, detail]) =>
    role(
      laneRoleId(name),
      "lane-lead",
      name,
      `Leads lane ${name}.`,
      detail.model,
      name,
      // made: the owner asked for Opus on cell-risk6 for the #68 r4 fix packets; applies next turn.
      name === RISK6 ? { pending: OPUS } : {},
    ),
  ),
];

const binding = (
  id: string,
  roleId: string,
  threadId: string,
  reason: string,
  boundAt: string,
  endedAt: string | null,
  observedModel: string | null,
  handoffNote: string | null = null,
) => ({ id, roleId, threadId, reason, handoffNote, observedModel, boundAt, endedAt });

/** made: the dates; the thread ids are the dry run's retired master threads. */
const MASTER_HISTORY = [
  ["ses_f023742e", AT("09:10", 3)],
  ["ses_d1817250", AT("21:40", 4)],
  ["ses_95a01956", AT("13:05", 6)],
  ["ses_0d67c996", AT("02:20", 8)],
  ["ses_1f82d73d", AT("18:55", 9)],
  ["ses_e3089c00", AT("11:30", 11)],
  ["ses_92a9263b", AT("07:45", 13)],
  ["ses_0882e368", AT("21:25", 14)],
] as const;

export const bindings = [
  ...MASTER_HISTORY.map(([thread, ended], index) =>
    binding(
      `binding-master-${index + 1}`,
      ROLE_MASTER,
      thread,
      index === 0 ? "initial" : "succession",
      index === 0 ? AT("08:00", 3) : MASTER_HISTORY[index - 1]![1],
      ended,
      OPUS,
      index === 0 ? null : "Context handoff: MASTER-STATE.md is current.",
    ),
  ),
  binding(
    "binding-master-9",
    ROLE_MASTER,
    masterProvenance.threadId,
    "succession",
    MASTER_HISTORY[MASTER_HISTORY.length - 1]![1],
    null,
    OPUS,
    "Context handoff: MASTER-STATE.md is current.",
  ),
  // Real retired thread; made: the switch date.
  binding(
    "binding-cell-money-old",
    laneRoleId("cell-money"),
    "mcp:271cfc0f",
    "import",
    CREATED,
    AT("11:20", 12),
    HAIKU,
  ),
  binding(
    "binding-cell-money",
    laneRoleId("cell-money"),
    laneDetails["cell-money"]!.thread!,
    "succession",
    AT("11:20", 12),
    null,
    HAIKU,
    "Rewards lane: CRP-13154 handoff; old thread hit its context limit.",
  ),
  ...Object.entries(laneDetails)
    .filter(([name, detail]) => detail.thread !== null && name !== "cell-money")
    .map(([name, detail]) =>
      binding(
        `binding-${name}`,
        laneRoleId(name),
        detail.thread!,
        "import",
        CREATED,
        null,
        detail.model,
      ),
    ),
];

// --- Review policy ----------------------------------------------------------

export const reviewPolicy = {
  missionId: CRPKO,
  version: 3,
  stages: [
    { id: "stage-sol", label: "Sol review", roleId: "crpko-reviewer-sol" },
    { id: "stage-astra-final", label: "Astra final at exact head", roleId: "crpko-final-astra" },
    { id: "stage-rule-7", label: "Rule-7 exact-head merge", roleId: ROLE_MASTER },
  ],
  ladders: [
    {
      id: "ladder-normal",
      name: "Normal",
      appliesTo: "normal",
      condition: null,
      stageIds: ["stage-sol", "stage-rule-7"],
    },
    {
      id: "ladder-critical",
      name: "XL or 10/10 critical",
      appliesTo: "critical",
      condition: "additions + deletions >= 1500, or named 10/10 critical by the master",
      stageIds: ["stage-sol", "stage-astra-final", "stage-rule-7"],
    },
  ],
  commonRules: [
    "No round cap; each round returns tight fix packets a Haiku worker can run (rule 99).",
    "Ignore anything pedantic; fix until CLEAR (rule 19).",
    "Sol findings stay internal; no public text from Sol (rule 90).",
  ],
  guide: {
    text: "Critical means 10/10: irreversible real-fund or key movement, custody signing or broadcast, ledger settlement math, privileged IAM/OIDC/deploy authorization. XL is additions plus deletions of 1500 or more. Ask the master when unsure.",
    hardTriggers: [
      { _tag: "changed-lines", atLeast: 1500 },
      // made: the path patterns stand in for the categories above.
      { _tag: "path", pattern: "custody-transfer/**/signing/**" },
      { _tag: "label", label: "critical" },
    ],
    version: 2,
    authoredBy: masterActor,
    updatedAt: AT("18:30", 14),
  },
  judgedBy: "master",
  lockedFields: [],
  updatedAt: AT("07:58", 16),
};

const pr = (repository: string, number: number) => ({ repository, number });

export const verdicts = [
  {
    id: "verdict-risk-68",
    missionId: CRPKO,
    pullRequest: pr("risk-liquidation-latest", 68),
    critical: true,
    reason: "Account-State V2 bootstrap, replay and recovery; XL. Needs an Astra final.",
    guideVersion: 2,
    source: "hard-trigger",
    decidedBy: masterActor,
    supersedesId: null,
    createdAt: AT("20:38", 13),
  },
  {
    id: "verdict-tc-274",
    missionId: CRPKO,
    pullRequest: pr("trading-core", 274),
    critical: false,
    reason: "Under 1500 lines and nothing live; Sol only.",
    guideVersion: 2,
    source: "guide",
    decidedBy: masterActor,
    supersedesId: null,
    createdAt: AT("07:10"),
  },
  {
    id: "verdict-devops-777",
    missionId: CRPKO,
    pullRequest: pr("crpko-devops", 777),
    critical: false,
    reason: "Adds an intake reject reason column; no IAM or deploy authorization change.",
    guideVersion: 2,
    source: "guide",
    decidedBy: masterActor,
    supersedesId: null,
    createdAt: AT("06:40"),
  },
];

const review = (
  id: string,
  repository: string,
  number: number,
  headSha: string,
  verdict: string,
  findings: number,
  severeFindings: number,
  createdAt: string,
  stageId = "stage-sol",
  roleId = "crpko-reviewer-sol",
  modelName = SOL,
) => ({
  id,
  missionId: CRPKO,
  pullRequest: pr(repository, number),
  stageId,
  headSha,
  roleId,
  model: modelName,
  verdict,
  findings,
  severeFindings,
  links: [github(repository, number)],
  createdAt,
});

export const reviews = [
  review(
    "review-risk-68-r4",
    "risk-liquidation-latest",
    68,
    "61025638",
    "findings",
    19,
    0,
    AT("07:56"),
  ),
  review("review-devops-726-r8", "crpko-devops", 726, "de321d6c2", "findings", 4, 0, AT("07:58")),
  review("review-devops-777-r2", "crpko-devops", 777, "83cb0f11c", "clear", 0, 0, AT("07:55")),
  review(
    "review-risk-68-r3",
    "risk-liquidation-latest",
    68,
    "4ee9ec11",
    "findings",
    24,
    2,
    AT("02:23", 15),
  ),
];

// --- Pools and holds --------------------------------------------------------

const pool = (
  id: string,
  name: string,
  unit: string,
  capacity: number,
  scope: unknown,
  kind: string,
  backend: string,
  enforcement: string,
  usage: {
    used: number;
    window?: string;
    resetsAt?: string;
    runOutAt?: string | null;
    sampledAt: string;
  },
) => ({
  id,
  name,
  unit,
  capacity,
  scope,
  kind,
  backend,
  enforcement,
  usage: {
    used: usage.used,
    window: usage.window ?? null,
    resetsAt: usage.resetsAt ?? null,
    runOutAt: usage.runOutAt ?? null,
    sampledAt: usage.sampledAt,
  },
  priority: [CRPKO, JUNO],
  lockedFields: [],
  createdAt: CREATED,
  updatedAt: usage.sampledAt,
});

const mission = { _tag: "mission", missionId: CRPKO };

export const pools = [
  // Usable 20 of 30 accounts at 08:16; made: the run-out projection.
  pool(
    "pool-claude",
    "Claude",
    "account",
    30,
    { _tag: "global" },
    "observed",
    "9router",
    "advisory",
    {
      used: 10,
      window: "5h",
      runOutAt: AT("12:40"),
      sampledAt: AT("08:16"),
    },
  ),
  pool(
    "pool-codex-reviews",
    "Codex reviews",
    "account",
    6,
    { _tag: "global" },
    "observed",
    "9router",
    "advisory",
    {
      used: 5,
      window: "5h",
      runOutAt: AT("09:05"),
      sampledAt: AT("08:16"),
    },
  ),
  pool("pool-offbox", "Offbox", "USD", 500, { _tag: "global" }, "budget", "offbox", "enforced", {
    used: 61.69,
    window: "month",
    sampledAt: FIXTURE_NOW,
  }),
  pool(
    "pool-dev-env",
    "Dev env (tf:dev)",
    "lease",
    1,
    mission,
    "lease",
    "coord-claim",
    "enforced",
    {
      used: 0,
      sampledAt: FIXTURE_NOW,
    },
  ),
  pool(
    "pool-arch-broker",
    "Architecture broker (arch:broker)",
    "lease",
    1,
    mission,
    "lease",
    "coord-claim",
    "enforced",
    {
      used: 1,
      sampledAt: FIXTURE_NOW,
    },
  ),
];

export const holds = [
  {
    id: "hold-arch-broker-48",
    poolId: "pool-arch-broker",
    missionId: CRPKO,
    holder: laneActor("arch"),
    amount: 1,
    purpose: "arch queue (342 close, 334, 324+8518 next)",
    fence: 48,
    status: "active",
    leaseExpiresAt: "2026-10-17T18:01:14.000Z",
    takenAt: "2026-10-16T06:39:52.000Z",
    releasedAt: null,
    releaseNote: null,
    createdAt: "2026-10-16T06:39:52.000Z",
  },
  {
    id: "hold-tf-dev-87",
    poolId: "pool-dev-env",
    missionId: CRPKO,
    holder: laneActor("cell-devops"),
    amount: 1,
    purpose: "(d) apply saved plan 39013497569 at 88328acdc, run 39015351901",
    fence: 87,
    status: "released",
    leaseExpiresAt: null,
    takenAt: AT("07:54"),
    releasedAt: unix(1792224473),
    releaseNote: "(d) partial: the copy-pause SSM doc failed; 76 of 77 applied.",
    createdAt: AT("07:54"),
  },
];

// --- Work items -------------------------------------------------------------

const work = (
  id: string,
  subMissionId: string,
  laneName: string | null,
  title: string,
  kind: string,
  stage: string,
  at: string,
  extra: {
    milestoneId?: string;
    heldBy?: unknown;
    blockedBy?: ReadonlyArray<unknown>;
    dependsOn?: ReadonlyArray<string>;
    pullRequest?: [string, number];
    facts?: { mergedAtHead?: string; deployedReadback?: string; exercised?: string };
  } = {},
) => ({
  id,
  missionId: CRPKO,
  subMissionId,
  laneId: laneName ? `lane-${laneName}` : null,
  milestoneId: extra.milestoneId ?? null,
  title,
  kind,
  stage,
  heldBy: "heldBy" in extra ? extra.heldBy : laneName ? laneActor(laneName) : null,
  blockedBy: extra.blockedBy ?? [],
  dependsOn: extra.dependsOn ?? [],
  pullRequest: extra.pullRequest ? pr(...extra.pullRequest) : null,
  links: extra.pullRequest ? [github(...extra.pullRequest)] : [],
  facts: {
    mergedAtHead: extra.facts?.mergedAtHead ?? null,
    deployedReadback: extra.facts?.deployedReadback ?? null,
    exercised: extra.facts?.exercised ?? null,
  },
  createdAt: at,
  updatedAt: at,
});

const reviewPool = { _tag: "system", component: "review-pool" };
const codexPool = { kind: "pool", id: "pool-codex-reviews", label: "Codex reviews: 1 of 6 usable" };

export const workItems = [
  work("codec-v4", SUB.wave, "cell-tc", "Codec v4 flip", "deploy", "done", AT("17:49", 16), {
    milestoneId: "ms-codec-v4",
    heldBy: null,
    facts: {
      mergedAtHead: "trading-core main-dev",
      deployedReadback: "Codec v4 on dev",
      exercised: "Accepted Fri 16 Oct 17:49",
    },
  }),
  work(
    "risk68-r4",
    SUB.wave,
    "cell-risk",
    "risk#68 r4: 19 findings on 5 workers",
    "pr",
    "review",
    AT("07:56"),
    {
      milestoneId: "ms-positions-risk",
      pullRequest: ["risk-liquidation-latest", 68],
    },
  ),
  work(
    "risk68-final",
    SUB.wave,
    "cell-risk",
    "risk#68 Sol r5 and Astra final",
    "pr",
    "review",
    AT("07:56"),
    {
      milestoneId: "ms-positions-risk",
      heldBy: reviewPool,
      blockedBy: [codexPool],
      dependsOn: ["risk68-r4"],
      pullRequest: ["risk-liquidation-latest", 68],
    },
  ),
  work(
    "CRP-13328-deploy",
    SUB.wave,
    "cell-risk",
    "CRP-13328 Risk startup fix deploy",
    "deploy",
    "deploy",
    AT("06:12"),
    {
      milestoneId: "ms-positions-risk",
      heldBy: masterActor,
      dependsOn: ["risk68-final"],
    },
  ),
  work(
    "risk-release",
    SUB.wave,
    "cell-risk",
    "Risk release with #68",
    "deploy",
    "merge",
    AT("06:12"),
    {
      milestoneId: "ms-positions-risk",
      heldBy: masterActor,
      dependsOn: ["CRP-13328-deploy"],
    },
  ),
  work(
    "CRP-13361",
    SUB.wave,
    "cell-risk5",
    "Risk outbox set-aside prefix (arch 292, OUT-034)",
    "ticket",
    "ticket",
    AT("07:30"),
  ),
  work("CRP-13316", SUB.wave, "cell-tc", "TC#274 CRP-13316 part 2", "pr", "deploy", AT("07:10"), {
    milestoneId: "ms-tc-risk-merges",
    heldBy: masterActor,
    pullRequest: ["trading-core", 274],
    facts: { mergedAtHead: "79887b3a" },
  }),
  work(
    "CRP-13343",
    SUB.wave,
    "cell-tc",
    "trading-core#276 v2 bonus lot writes (part 1)",
    "pr",
    "pr",
    AT("07:10"),
    {
      milestoneId: "ms-tc-risk-merges",
      pullRequest: ["trading-core", 276],
    },
  ),
  work(
    "CRP-13161",
    SUB.wave,
    "cell-tc3",
    "trading-core#277 pure position-updated v2 builder",
    "pr",
    "review",
    AT("08:11"),
    {
      heldBy: reviewPool,
      pullRequest: ["trading-core", 277],
    },
  ),
  work(
    "CRP-13322",
    SUB.wave,
    "cell-edge",
    "edge-api#350 Fireblocks webhook keys from JWKS",
    "pr",
    "review",
    AT("08:19"),
    {
      heldBy: reviewPool,
      pullRequest: ["edge-api", 350],
    },
  ),
  work(
    "CRP-13326",
    SUB.wave,
    "cell-custody",
    "custody-transfer#71 gate on the withdrawal block",
    "pr",
    "review",
    AT("07:38"),
    {
      heldBy: reviewPool,
      blockedBy: [codexPool],
      pullRequest: ["custody-transfer", 71],
    },
  ),
  work(
    "CRP-13154",
    SUB.wave,
    "cell-money",
    "rewards#225 freeze the bonus expiry horizon",
    "pr",
    "pr",
    AT("08:12"),
    {
      pullRequest: ["rewards", 225],
    },
  ),
  work(
    "CRP-13198",
    SUB.wave,
    "cell-bal",
    "crpko-devops#773 bonus balance topic priority lane",
    "pr",
    "review",
    AT("08:20"),
    {
      milestoneId: "ms-balance-steps",
      dependsOn: ["ingestor-dev2"],
      pullRequest: ["crpko-devops", 773],
    },
  ),
  work(
    "CRP-13298",
    SUB.wave,
    "cell-bo",
    "Backoffice dev.3 (BO#338)",
    "deploy",
    "exercised",
    AT("07:16"),
    {
      facts: {
        mergedAtHead: "769acbc3",
        deployedReadback: "Deploy 39010205287: digest 1bfdc53f = SSM v74 = 4 TDs, readyz 200",
      },
    },
  ),
  work(
    "kafka-fix",
    SUB.releases,
    "cell-kafka",
    "Copy-pause SSM doc: approval_ref to approvalRef",
    "pr",
    "pr",
    AT("08:11"),
    {
      milestoneId: "ms-kafka-phase-2",
    },
  ),
  work(
    "kafka-d2",
    SUB.releases,
    "cell-devops",
    "Kafka apply (d2)",
    "deploy",
    "deploy",
    AT("08:09"),
    {
      milestoneId: "ms-kafka-phase-2",
      heldBy: masterActor,
      dependsOn: ["kafka-fix"],
    },
  ),
  work(
    "CRP-13215",
    SUB.releases,
    "cell-kafka",
    "Kafka capacity r004 with the publisher edit",
    "ticket",
    "ticket",
    AT("18:40", 15),
    {
      heldBy: ownerActor,
      blockedBy: [{ kind: "ask", id: "ask-kafka-capacity-r004", label: "Kafka capacity r004" }],
    },
  ),
  work(
    "CRP-13358",
    SUB.releases,
    "cell-devops2",
    "Ingestor startup query fix",
    "pr",
    "pr",
    AT("06:52"),
  ),
  work(
    "ingestor-dev2",
    SUB.releases,
    "cell-devops2",
    "Ingestor release dev.2",
    "deploy",
    "deploy",
    AT("06:52"),
    {
      milestoneId: "ms-balance-steps",
      heldBy: masterActor,
      dependsOn: ["CRP-13358"],
    },
  ),
  work(
    "CRP-13349",
    SUB.releases,
    "cell-devops2",
    "crpko-devops#777 intake reject reason",
    "pr",
    "merge",
    AT("07:56"),
    {
      heldBy: masterActor,
      pullRequest: ["crpko-devops", 777],
    },
  ),
  work(
    "CRP-12715",
    SUB.factory,
    "cell-fab-devops",
    "crpko-devops#726 node secret policy via import blocks",
    "pr",
    "review",
    AT("07:58"),
    {
      pullRequest: ["crpko-devops", 726],
    },
  ),
  work(
    "CRP-12480-q6",
    SUB.wave,
    "cell-fab-svc",
    "CRP-12480 Q6: duplicate campaign codes",
    "ticket",
    "ticket",
    AT("07:55"),
    {
      heldBy: { _tag: "role", roleId: ROLE_ARCH },
    },
  ),
  work(
    "CRP-13304",
    SUB.support,
    null,
    "Backoffice frontend cherry-pick",
    "ticket",
    "ticket",
    AT("05:40"),
    {
      heldBy: { _tag: "person", name: "Dylan" },
    },
  ),
];

// --- Rules ------------------------------------------------------------------

const ack = (name: string, at: string) => ({ actor: laneActor(name), version: 1, at });

const rule = (
  id: string,
  number: number,
  title: string,
  quote: string,
  masterReading: string,
  quotedAt: string,
  extra: {
    scopeLanes?: ReadonlyArray<string>;
    scopeSubMissions?: ReadonlyArray<string>;
    activation?: string;
    status?: string;
    acks?: ReadonlyArray<unknown>;
    applied?: number;
    lastReliedAt?: string;
    updatedAt?: string;
    provenance?: unknown;
  } = {},
) => ({
  id,
  missionId: CRPKO,
  number,
  title,
  quote,
  quotedAt,
  provenance: extra.provenance ?? { _tag: "import", source: "STANDING-RULES" },
  masterReading,
  scope: {
    subMissionIds: extra.scopeSubMissions ?? [],
    roleKinds: [],
    laneIds: (extra.scopeLanes ?? []).map((name) => `lane-${name}`),
  },
  activation: extra.activation ?? "",
  status: extra.status ?? "active",
  version: 1,
  acks: extra.acks ?? [],
  appliedCount: extra.applied ?? 0,
  brokenCount: 0,
  lastReliedAt: extra.lastReliedAt ?? null,
  lockedFields: [],
  createdAt: quotedAt,
  updatedAt: extra.updatedAt ?? quotedAt,
});

const RULE_104_LANES = [
  "cell-bo",
  "cell-devops2",
  "cell-fab-devops",
  "cell-fab-svc",
  "cell-fab-tc",
];
const RULE_105_LANES = [
  "arch",
  "cell-custody",
  "cell-devops2",
  "cell-edge",
  "cell-fab-devops",
  "cell-fab-svc",
  "cell-fab-tc",
  "cell-triage",
];

/**
 * Crpko standing rules. Quotes are the owner's words where STANDING-RULES
 * kept them; rules 10, 26 and 98 quote the rule text (no owner original).
 * `applied` is coord mentions in the 24h before 08:33.
 */
export const rules = [
  rule(
    "rule-7",
    7,
    "Admin-bypass merge on an exact-head CLEAR",
    "Yes authorised",
    "`--admin --match-head-commit` only on an exact-head fresh CLEAR with green CI and no holds.",
    AT("10:00", 6),
    { applied: 149, lastReliedAt: unix(1792225585) },
  ),
  rule(
    "rule-10",
    10,
    "Every session runs Opus",
    "Every session runs opus/claude-opus-5-5 xhigh. Astra (opus/gpt-6-astra xhigh) is for PR reviews only. Don't switch models to save usage. Slow down or queue the work.",
    "Amended by 72, 96 and 98: Haiku writes code under Opus leads.",
    AT("12:00", 4),
  ),
  rule(
    "rule-18",
    18,
    "Architecture video: no environment sizing specifics",
    "The video should not go into specifics on sizing for any of the environments",
    "Retired: the video is done.",
    AT("05:35", 8),
    { status: "retired", updatedAt: AT("20:27", 14) },
  ),
  rule(
    "rule-19",
    19,
    "Our own PRs: review loop, then merge and deploy",
    "These were made by us. Review them with Astro. Ignore anything pedantic. Work until Astro clears and then merge and deploy. These are our PRs. Why would we have review threads?",
    "Our lanes' PRs loop on review until CLEAR, merge by rule 7, deploy and read back. No owner approval threads.",
    AT("05:35", 8),
  ),
  rule(
    "rule-26",
    26,
    "Astra usage is plentiful",
    "Astra usage is plentiful; raise review concurrency as needed",
    "Retired: rule 88 moved reviews to Sol.",
    AT("16:10", 8),
    { status: "retired", updatedAt: AT("20:27", 14) },
  ),
  rule(
    "rule-89",
    89,
    "Reviews on Sol unless critical or XL",
    "Yes move all astra work to 6.1 Sol unless it is 10/10 critical or a xl sized change",
    "Sol reviews everything. XL (1500+ lines) or master-named 10/10 critical PRs need an Astra final CLEAR at exact head.",
    AT("18:18", 14),
    { applied: 7, lastReliedAt: unix(1792212555) },
  ),
  rule(
    "rule-98",
    98,
    "Haiku lanes under Opus leads",
    "Lanes move to Haiku under Opus leads.",
    "cell-tc leads tc2, tc3 and pbdraft; cell-risk leads risk2 and risk3; cell-bo leads cell-bofe; cell-devops leads devops2, kafka and bal; the master leads the rest.",
    AT("19:39", 15),
    {
      scopeLanes: [
        "cell-tc",
        "cell-tc2",
        "cell-tc3",
        "cell-pbdraft",
        "cell-risk",
        "cell-risk2",
        "cell-risk3",
        "cell-bo",
        "cell-bofe",
      ],
      applied: 3,
      lastReliedAt: AT("12:40", 16),
    },
  ),
  rule(
    "rule-99",
    99,
    "No review round cap",
    "Remove the review cap, and look to adjust the review prompt to return tight packets of work back instead of just findings and also for review agents to take advantage of sub agents and to try to find all findings in one sitting, rather than a select few",
    "No round cap. Each round returns tight fix packets and uses read-only subagents by area.",
    AT("07:55", 16),
    { applied: 17, lastReliedAt: AT("16:57", 16) },
  ),
  rule(
    "rule-103",
    103,
    "Owner questions never default",
    "Always wait for my answer. If a master can't decide wait on it. Anything the answer blocks should wait on it, and anything it doesn't and all other lanes should continue freely",
    "Owner questions have no default or deadline; only the branch the answer blocks waits, everything else continues; a 'default X if no answer' blocker is not a go.",
    AT("01:04"),
    { applied: 6, lastReliedAt: unix(1792211264) },
  ),
  rule(
    "rule-104",
    104,
    "PR factories ramp up",
    "Are we finding that we have a lot of spare usage with Haiku? If so, maybe we ramp up those PR factory lanes significantly. We don't even have to send them for reviews right away; we can wait until there's a reset and then hammer out a bunch of reviews in parallel. i mean significantly",
    "Factories ramp to 10 Haiku workers and 25 open PRs each. Non-Monday PRs are review-queued; Sol fires at the Codex reset.",
    AT("05:15"),
    {
      scopeLanes: RULE_104_LANES,
      activation: "Until Claude usable drops under 6 or the big accounts pass ~90% weekly",
      acks: [
        ack("cell-fab-svc", unix(1792222471)),
        ack("cell-bo", unix(1792222484)),
        ack("cell-fab-tc", unix(1792222732)),
        ack("cell-fab-devops", unix(1792223430)),
        ack("cell-devops2", unix(1792223716)),
      ],
      applied: 2,
      lastReliedAt: unix(1792225517),
      updatedAt: AT("07:34"),
    },
  ),
  rule(
    "rule-105",
    105,
    "Withdrawal-failure tickets go to service leads",
    "mobile app, web app should always be assigned to jashwanth (web) / furqan (mobile) never us. Also, anything to do with that custody withdrawal failure change you mentioned, assign those to the leads of the projects. Apart from DevOps, of course. That has to be us. But for projects like WS Gateway, Custody Transfer, and Edge API, you can assign those to the devs directly.",
    "DF-251 withdrawal-failure tickets go to the service leads and devs; only CRP-13349 DevOps stays ours.",
    AT("07:37"),
    {
      scopeLanes: RULE_105_LANES,
      acks: [
        ack("cell-triage", unix(1792222679)),
        ack("cell-custody", unix(1792222688)),
        ack("cell-edge", unix(1792222689)),
        ack("cell-fab-svc", unix(1792222729)),
        ack("cell-fab-tc", unix(1792222732)),
        ack("cell-fab-devops", unix(1792223430)),
        ack("cell-devops2", unix(1792223716)),
        ack("arch", unix(1792223773)),
      ],
      applied: 1,
      lastReliedAt: unix(1792222666),
    },
  ),
];

/** made: the requests' wording; the rules and outcomes they point at are real. */
export const changeRequests = [
  {
    id: "rcr-rule-10-haiku",
    ruleId: "rule-10",
    missionId: CRPKO,
    request:
      "Rewrite rule 10 so it matches 72, 96 and 98: Haiku writes code under Opus leads, Opus commands.",
    provenance: masterProvenance,
    status: "open",
    proposedQuote: null,
    proposedScope: null,
    masterResponse: null,
    forkId: null,
    createdAt: AT("08:28"),
    resolvedAt: null,
  },
  {
    id: "rcr-rule-19-sol",
    ruleId: "rule-19",
    missionId: CRPKO,
    request: "Reviews run on Sol now, not Astra (rule 88). Say Sol in the reading.",
    provenance: ownerApp,
    status: "applied",
    proposedQuote: null,
    proposedScope: null,
    masterResponse: "Reading updated; the quote stays your words.",
    forkId: null,
    createdAt: AT("17:25", 14),
    resolvedAt: AT("17:40", 14),
  },
  {
    id: "rcr-rule-99-p3",
    ruleId: "rule-99",
    missionId: CRPKO,
    request: "Skip the next Sol round when every finding left is a fixture-only P3.",
    provenance: {
      _tag: "agent",
      threadId: laneDetails["cell-fab-devops"]!.thread,
      roleId: laneRoleId("cell-fab-devops"),
    },
    status: "declined",
    proposedQuote: null,
    proposedScope: null,
    masterResponse:
      "No: rule 99 has no round cap and rule 19 says work until CLEAR. Fix the four P3s in one packet.",
    forkId: null,
    createdAt: AT("07:59"),
    resolvedAt: AT("08:01"),
  },
];

/** made: findings; they point at real overlaps between the rules above. */
export const audit = [
  {
    id: "audit-rule-10-stale",
    kind: "stale",
    ruleIds: ["rule-10", "rule-98"],
    note: "Rule 10 still says every session runs Opus; 72, 96 and 98 moved code to Haiku under Opus leads.",
    foundBy: { _tag: "system", component: "scribe" },
    at: AT("08:27"),
  },
  {
    id: "audit-rule-19-astra",
    kind: "conflict",
    ruleIds: ["rule-19", "rule-89"],
    note: "Rule 19's quote says review with Astra; rule 89 sends all review to Sol except XL or critical.",
    foundBy: { _tag: "system", component: "scribe" },
    at: AT("08:27"),
  },
];

/** made: a scribe rule suggestion that lands in the master's inbox. */
export const ruleSuggestions = [
  {
    id: "suggestion-rule-10-fold",
    missionId: CRPKO,
    targetKind: "rule",
    target: { kind: "rule", id: "rule-10", label: "Rule 10" },
    title: "Fold rule 10 into rule 98",
    before: "Every session runs opus/claude-opus-5-5 xhigh.",
    after: "Opus leads command; Haiku writes code under them (rules 72, 96, 98).",
    diffText:
      "- Every session runs opus/claude-opus-5-5 xhigh.\n+ Opus leads command; Haiku writes code under them (rules 72, 96, 98).",
    why: "Three later rules amend it; lanes quote the old text when asking for Opus.",
    evidence: [{ kind: "rule", id: "rule-98", label: "Rule 98" }],
    author: "scribe",
    acceptor: "master",
    status: "open",
    dismissReason: null,
    outcome: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: AT("08:27"),
  },
];

// --- Approval routing -------------------------------------------------------

/** made: the table. Version 1 is the cutover (everything to the owner). */
export const routing = {
  missionId: CRPKO,
  version: 2,
  draftRules: [
    { id: "route-draft-github", match: { _tag: "channel", channel: "github" }, approver: "owner" },
    { id: "route-draft-cliq", match: { _tag: "channel", channel: "cliq" }, approver: "master" },
  ],
  approvalRules: [
    { id: "route-approval-merge", match: { _tag: "kind", kind: "merge" }, approver: "owner" },
    {
      id: "route-approval-crpko-devops",
      match: { _tag: "repo", repository: "crpko-devops" },
      approver: "master",
    },
  ],
  updatedAt: AT("12:00", 16),
};

/** Routing at the time each record was created; table v1 before 16 Oct 12:00. */
export const routingV1 = {
  ...routing,
  version: 1,
  draftRules: routing.draftRules.filter((rule) => rule.id === "route-draft-github"),
  approvalRules: routing.approvalRules.filter((rule) => rule.id === "route-approval-merge"),
  updatedAt: AT("06:00", 16),
};

/** made: one pending draft the master moved to its own inbox. */
export const reroutes = [
  {
    kind: "draft",
    id: "draft-dylan-bo-334",
    approver: "master",
    reason: "backoffice-core#334 conflicts with main-dev; I'll resend once Dylan rebases.",
    at: AT("08:21"),
  },
];

// --- Recovery ---------------------------------------------------------------

/** 4 Oct, to the second. */
const t = (time: string) => `2026-10-04T${time}.000Z`;

const member = (
  name: string,
  action: string,
  why: string,
  state: string,
  settledAt: string | null,
  lostChildren: ReadonlyArray<unknown> = [],
  holds: ReadonlyArray<string> = [],
) => ({
  roleId: laneRoleId(name),
  laneId: `lane-${name}`,
  threadId: laneDetails[name]?.thread ?? `lane-${name}`,
  cutRunId: null,
  lastActivityAt: t("15:34:00"), // made
  lostChildren,
  holds,
  action,
  why,
  state,
  settledAt,
});

const child = (title: string, sessionId: string | null, lastStatus: string, doing: string) => ({
  title,
  sessionId,
  kind: "native-subagent",
  lastStatus,
  doing,
});

/** The T3 server restart of Sun 4 Oct ~15:35Z and nine of the lanes' replies to control 1008. */
export const recoveryIncidents = [
  {
    id: "recovery-2026-10-04",
    cause: "server-restart",
    detectedAt: t("15:41:48"),
    window: { from: t("15:35:00"), to: t("15:37:00") },
    missionIds: [CRPKO],
    members: [
      member("cell-tc2", "resume", "Four children cancelled mid-round.", "resumed", t("15:44:19"), [
        child("#148 CRP-12053 r1 fix", null, "cancelled", "r1 fix worker"),
        child("CRP-11575 r1 fix", null, "cancelled", "r1 fix worker"),
        child("#94 CRP-9766 r1 fix", null, "cancelled", "r1 fix worker"),
        child("#143 CRP-11431 Astra r4", null, "cancelled", "Astra r4 at 9ecf77f"),
      ]),
      member(
        "cell-md",
        "resume",
        "Three children cut off; resumed by session id.",
        "resumed",
        t("16:08:06"),
        [
          child("TC#151 r2 Astra", "ses_ef883193", "cancelled", "Astra r2 at e29fa89"),
          child("mdm#27 r1 fixer", "ses_ef8fbf8f0ffd", "cancelled", "r1 fixer at 067dad4"),
          child("mdm#23 r3 fixer", "ses_ef8fbf8eff", "cancelled", "r3 fixer at 92556dc"),
        ],
      ),
      member(
        "cell-devops2",
        "resume",
        "Nine cancelled children relaunched fresh.",
        "resumed",
        t("15:43:49"),
        [
          child("Astra 11348 r1", null, "cancelled", "Astra r1"),
          child("12082 fix", null, "cancelled", "fix worker"),
          child("12075 fix", null, "cancelled", "fix worker"),
          child("12014 fix", null, "cancelled", "fix worker"),
          child("11378 implementation", null, "cancelled", "implementer"),
          child("11285 implementation", null, "cancelled", "implementer"),
          child("12062 implementation", null, "cancelled", "implementer"),
          child("12083 implementation", null, "cancelled", "implementer"),
          child("12091 implementation", null, "cancelled", "implementer"),
        ],
      ),
      member(
        "cell-bo",
        "resume",
        "#259 r1 fix worker resumed in its own session.",
        "resumed",
        t("15:57:26"),
        [child("#259 CRP-11428 r1 fix", null, "cancelled", "r1 fix worker at 74859307")],
      ),
      member(
        "cell-tc",
        "skip",
        "TC#150 fix worker had finished its edits; verified and committed e731643d instead.",
        "decided",
        t("15:47:34"),
        [child("TC#150 r1 fix", "ses_ef8f8981", "cancelled", "r1 fix worker, edits complete")],
      ),
      member(
        "cell-ws",
        "skip",
        "Both R6 findings were declined as pedantic; nothing to relaunch.",
        "decided",
        t("15:42:05"),
        [child("devops#561 r6 fix", null, "cancelled", "r6 fix worker")],
      ),
      member(
        "arch",
        "reconcile-first",
        "Holds arch:broker fence 7; check the claim before resuming.",
        "decided",
        t("15:45:52"),
        [],
        ["hold-arch-broker-7"],
      ),
      member("cell-risk", "notice-only", "No children were running.", "decided", t("15:43:49")),
      member("cell-edge", "notice-only", "No children were running.", "decided", t("15:43:44")),
    ],
    resumesPerMinute: 4, // made
    status: "cleared",
  },
];

// --- Timeline seed ----------------------------------------------------------

type SeedEvent = {
  readonly id: string;
  readonly kind: string;
  readonly actor: unknown;
  readonly provenance: unknown;
  readonly summary: string;
  readonly subject: { kind: string; id: string; label?: string } | null;
  readonly causedBy: string | null;
  readonly payload: unknown;
  readonly at: string;
};

const ev = (
  id: string,
  kind: string,
  actor: unknown,
  summary: string,
  subject: SeedEvent["subject"],
  at: string,
  extra: { causedBy?: string; payload?: unknown; provenance?: unknown } = {},
): SeedEvent => ({
  id,
  kind,
  actor,
  provenance:
    extra.provenance ??
    (actor === ownerActor ? ownerApp : actor === masterActor ? masterProvenance : coord),
  summary,
  subject,
  causedBy: extra.causedBy ?? null,
  payload: extra.payload ?? null,
  at,
});

const subRef = (id: string) => ({ kind: "sub-mission", id });
const changed = (...fields: string[]) => ({ changed: fields });

/**
 * Mission events before 08:33, oldest first. Ids `ev-<coord seq>` are real
 * coord events; `ev-made-*` are fixture-made attribution events.
 */
export const events: ReadonlyArray<SeedEvent> = [
  ev(
    "ev-1008",
    "recovery.detected",
    masterActor,
    "T3 server restarted ~15:35Z and cancelled in-flight background children.",
    { kind: "mission", id: CRPKO },
    t("15:41:48"),
    {
      payload: { incidentId: "recovery-2026-10-04" },
    },
  ),
  ev(
    "ev-1045",
    "recovery.resumed",
    laneActor("cell-money"),
    "cell-money: three cancelled children resumed in their own sessions.",
    { kind: "lane", id: "lane-cell-money" },
    t("16:16:24"),
    {
      causedBy: "ev-1008",
      payload: { incidentId: "recovery-2026-10-04" },
    },
  ),
  ev(
    "ev-made-mission-share",
    "mission.updated",
    ownerActor,
    "Guaranteed share set to 70%.",
    { kind: "mission", id: CRPKO },
    AT("09:00", 10),
    {
      payload: changed("guaranteedShare", "tier"),
    },
  ),
  ev(
    "ev-made-mission-borrow",
    "mission.updated",
    masterActor,
    "Borrow ceiling raised to 90% while Juno is paused.",
    { kind: "mission", id: CRPKO },
    AT("21:30", 14),
    {
      payload: changed("borrowCeiling"),
    },
  ),
  ev(
    "ev-made-portfolio",
    "portfolio.reordered",
    ownerActor,
    "Portfolio order: Crpko engineering, then Juno intents.",
    null,
    AT("09:00", 10),
    {
      payload: { order: [CRPKO, JUNO] },
    },
  ),
  ev(
    "ev-made-role-models",
    "role.model-changed",
    masterActor,
    "Lanes under Opus leads move to Haiku (rule 98).",
    { kind: "role", id: laneRoleId("cell-tc2") },
    AT("21:25", 15),
    {
      payload: changed("modelSelection"),
    },
  ),
  ev(
    "ev-made-routing-1",
    "routing.updated",
    masterActor,
    "Cutover routing: every draft and crw merge approval goes to you.",
    { kind: "mission", id: CRPKO },
    AT("06:00", 16),
    {
      payload: { changed: ["rules", "route-draft-github", "route-approval-merge"], version: 1 },
    },
  ),
  ev(
    "ev-made-routing-2",
    "routing.updated",
    ownerActor,
    "crpko-devops approvals and Cliq drafts go to the master.",
    { kind: "mission", id: CRPKO },
    AT("12:00", 16),
    {
      payload: {
        changed: ["rules", "route-approval-crpko-devops", "route-draft-cliq"],
        version: 2,
      },
    },
  ),
  ev(
    "ev-9830",
    "role.succession",
    laneActor("cell-risk"),
    "cell-risk context reset at ~825K prompt; lane state saved first.",
    { kind: "lane", id: "lane-cell-risk" },
    unix(1792201869),
    {
      payload: { contextReset: true, promptTokens: 825_000 },
    },
  ),
  ev(
    "ev-9794",
    "role.succession",
    laneActor("cell-risk5"),
    "cell-risk5 checkpoint at ~417K prompt; resume note written.",
    { kind: "lane", id: "lane-cell-risk5" },
    unix(1792199775),
    {
      payload: { contextReset: true, promptTokens: 417_000 },
    },
  ),
  ev(
    "ev-9890",
    "role.succession",
    laneActor("cell-risk6"),
    "cell-risk6 context full after R3-14 (i); resume note written.",
    { kind: "lane", id: "lane-cell-risk6" },
    unix(1792204384),
    {
      payload: { contextReset: true },
    },
  ),
  ev(
    "ev-made-intended-wave",
    "sub-mission.updated",
    masterActor,
    "Intended share for the architecture wave set to 55%.",
    subRef(SUB.wave),
    AT("05:00"),
    {
      payload: changed("intendedEffort"),
    },
  ),
  ev(
    "ev-made-intended-upkeep",
    "sub-mission.updated",
    masterActor,
    "Intended share for architecture upkeep set to 10%.",
    subRef(SUB.upkeep),
    AT("05:00"),
    {
      payload: changed("intendedEffort"),
    },
  ),
  ev(
    "ev-made-intended-releases",
    "sub-mission.updated",
    ownerActor,
    "Intended share for releases set to 15%.",
    subRef(SUB.releases),
    AT("06:10"),
    {
      payload: changed("intendedEffort"),
    },
  ),
  ev(
    "ev-made-intended-support",
    "sub-mission.updated",
    masterActor,
    "Intended share for dev support set to 8%.",
    subRef(SUB.support),
    AT("05:00"),
    {
      payload: changed("intendedEffort"),
    },
  ),
  ev(
    "ev-made-intended-e2e",
    "sub-mission.updated",
    masterActor,
    "Intended share for the e2e harness set to 4%.",
    subRef(SUB.e2e),
    AT("05:00"),
    {
      payload: changed("intendedEffort"),
    },
  ),
  ev(
    "ev-made-intended-observe",
    "sub-mission.updated",
    masterActor,
    "Intended share for observability set to 3%.",
    subRef(SUB.observe),
    AT("05:00"),
    {
      payload: changed("intendedEffort"),
    },
  ),
  ev(
    "ev-10120",
    "criticality.recorded",
    masterActor,
    "TC#274 is not critical: under 1500 lines and nothing live.",
    { kind: "criticality-verdict", id: "verdict-tc-274" },
    unix(1792221024),
  ),
  ev(
    "ev-10134",
    "lane.updated",
    masterActor,
    "CRP-13361 (arch 292 code to-do) goes to cell-risk5; cell-risk2 stays on lane C.",
    { kind: "lane", id: "lane-cell-risk5" },
    unix(1792222245),
    {
      payload: { changed: ["currentItemId"] },
    },
  ),
  ev(
    "ev-10136",
    "rule.created",
    masterActor,
    "Owner rule 104: factories ramp to 10 Haiku workers / 25 open PRs each.",
    { kind: "rule", id: "rule-104", label: "Rule 104" },
    unix(1792222451),
  ),
  ev(
    "ev-10136-lane",
    "lane.created",
    masterActor,
    "New lane cell-fab-tc for the 37 TC drift tickets.",
    { kind: "lane", id: "lane-cell-fab-tc" },
    unix(1792222451),
    {
      causedBy: "ev-10136",
    },
  ),
  ev(
    "ev-10141",
    "rule.created",
    masterActor,
    "Rule 105: DF-251 withdrawal-failure tickets go to service leads and devs.",
    { kind: "rule", id: "rule-105", label: "Rule 105" },
    unix(1792222666),
  ),
  ev(
    "ev-10142",
    "rule.applied",
    laneActor("cell-custody"),
    "cell-custody dropped CRP-13357 from its queue under rule 105.",
    { kind: "rule", id: "rule-105", label: "Rule 105" },
    unix(1792222688),
    {
      causedBy: "ev-10141",
    },
  ),
  ev(
    "ev-10163",
    "pool.hold-taken",
    laneActor("cell-devops"),
    "tf:dev fence 87 for the (d) apply of saved plan 39013497569.",
    { kind: "pool-hold", id: "hold-tf-dev-87" },
    unix(1792223662),
  ),
  ev(
    "ev-10167",
    "review.recorded",
    laneActor("cell-devops2"),
    "crpko-devops#777 CLEAR at Sol r2 (head 83cb0f11c).",
    { kind: "review", id: "review-devops-777-r2" },
    unix(1792223736),
  ),
  ev(
    "ev-10169",
    "review.recorded",
    laneActor("cell-risk"),
    "risk#68 round 4 at 61025638: 19 P2 findings; fix packets go to risk lanes.",
    { kind: "review", id: "review-risk-68-r4" },
    unix(1792223789),
  ),
  ev(
    "ev-10172",
    "review.recorded",
    laneActor("cell-fab-devops"),
    "crpko-devops#726 Sol r8 at de321d6c2: 4 P3, fixture-only.",
    { kind: "review", id: "review-devops-726-r8" },
    unix(1792223890),
  ),
  ev(
    "ev-made-guide",
    "review-policy.updated",
    ownerActor,
    "Common rule added: Sol findings stay internal (rule 90).",
    { kind: "review-policy", id: CRPKO },
    AT("07:58", 16),
    {
      payload: changed("commonRules"),
    },
  ),
  ev(
    "ev-10180",
    "pool.hold-released",
    laneActor("cell-devops"),
    "tf:dev fence 87 released: (d) partial, the copy-pause SSM doc failed.",
    { kind: "pool-hold", id: "hold-tf-dev-87" },
    unix(1792224473),
    {
      causedBy: "ev-10163",
    },
  ),
  ev(
    "ev-made-pool-codex",
    "pool.updated",
    masterActor,
    "Codex reviews capacity set to 6 accounts.",
    { kind: "pool", id: "pool-codex-reviews" },
    AT("06:30"),
    {
      payload: changed("capacity"),
    },
  ),
  ev(
    "ev-made-pool-offbox",
    "pool.updated",
    ownerActor,
    "Offbox budget set to $500 a month.",
    { kind: "pool", id: "pool-offbox" },
    AT("09:00", 14),
    {
      payload: changed("capacity"),
    },
  ),
  ev(
    "ev-made-pending-model",
    "role.model-changed",
    ownerActor,
    "cell-risk6 moves to Opus next turn for the #68 r4 fix packets.",
    { kind: "role", id: laneRoleId(RISK6) },
    AT("08:05"),
    {
      payload: { changed: ["pendingModelSelection"] },
    },
  ),
  ev(
    "ev-made-factory-share",
    "sub-mission.updated",
    ownerActor,
    "Intended share for the PR factory set to 5%.",
    subRef(SUB.factory),
    AT("07:40"),
    {
      payload: changed("intendedEffort"),
    },
  ),
  ev(
    "ev-made-reroute",
    "record.rerouted",
    masterActor,
    "Dylan's backoffice-core#334 draft moved to the master: the PR conflicts with main-dev.",
    { kind: "draft", id: "draft-dylan-bo-334" },
    AT("08:21"),
    {
      payload: { from: "owner", to: "master" },
    },
  ),
  ev(
    "ev-10212",
    "rule.applied",
    masterActor,
    "Usage 08:26Z: factories run per rule 104; leads up to 4 parallel Haiku workers.",
    { kind: "rule", id: "rule-104", label: "Rule 104" },
    unix(1792225517),
    {
      causedBy: "ev-10136",
    },
  ),
];

// --- Portfolio --------------------------------------------------------------

/** made: per-pool draw shares; Juno is paused and draws nothing. */
export const portfolioDraws: Record<string, ReadonlyArray<{ poolId: string; share: number }>> = {
  [CRPKO]: [
    { poolId: "pool-claude", share: 1 },
    { poolId: "pool-codex-reviews", share: 1 },
    { poolId: "pool-offbox", share: 0.92 },
  ],
  [JUNO]: [{ poolId: "pool-offbox", share: 0.08 }],
};

export const portfolioOrder = [CRPKO, JUNO];

/** The roster lanes with their lead role, thread, current item and context gauge. */
export const lanes = baseLanes.map((lane) => {
  const detail = laneDetails[lane.name];
  if (!detail) return lane;
  return {
    ...lane,
    leadRoleId: laneRoleId(lane.name),
    threadId: detail.thread,
    currentItemId: detail.item ?? null,
    context: detail.context
      ? {
          promptTokens: detail.context.prompt,
          limitTokens: laneLimit(detail),
          successions: detail.context.successions,
        }
      : null,
  };
});

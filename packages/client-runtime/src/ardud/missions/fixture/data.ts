// Fixture records for the Missions screens, taken from the real Crpko
// coordinator state on Sat 17 Oct 2026 (~08:33 UTC): coord events, the 08:05
// owner update, the lane roster and the PR backlog. Lane names, tickets, PRs and
// decisions are real. Thread ids are left out on purpose.
//
// Fixture-made values (no live source yet): the owner's intended effort shares,
// the mission's usage share, the knock, and the drafted heads-up text. Measured
// effort is each sub-mission's share of coord events in the 24h before 08:33.
//
// Everything here is plain encoded data; `index.ts` decodes it through the
// contract schemas, so a contract change that breaks the fixture fails fast.

const AT = (time: string, day = 17) => `2026-10-${day}T${time}:00.000Z`;

export const FIXTURE_NOW = AT("08:33");
export const OWNER_LAST_LOOKED_AT = AT("05:06");
const MONDAY = "2026-10-19T05:00:00.000Z";
const CREATED = AT("00:00", 2);

const CRPKO = "crpko-engineering";
const JUNO = "juno-intents";

const ROLE_MASTER = "crpko-master";
const ROLE_ARCH = "crpko-arch";

export const SUB = {
  wave: "crpko-arch-wave",
  upkeep: "crpko-arch-upkeep",
  releases: "crpko-releases",
  support: "crpko-dev-support",
  e2e: "crpko-e2e-harness",
  factory: "crpko-pr-factory",
  observe: "crpko-observability",
  junoDeposits: "juno-deposits",
  junoWithdrawals: "juno-withdrawals",
} as const;

export const missions = [
  {
    id: CRPKO,
    slug: "crpko",
    title: "Crpko engineering",
    goal: "Land the Crpko architecture wave (core trading, positions v2, codec v4, risk) for Monday 19 Oct and keep dev healthy while it lands.",
    status: "active",
    tier: "P0",
    weight: 3,
    guaranteedShare: 0.7,
    borrowCeiling: 0.9,
    projectId: null,
    masterRoleId: ROLE_MASTER,
    focusSubMissionId: null,
    health: "amber",
    lockedFields: [],
    createdAt: CREATED,
    updatedAt: FIXTURE_NOW,
  },
  {
    id: JUNO,
    slug: "juno",
    title: "Juno intents",
    goal: "Keep Juno Intents mainnet deposits and withdrawals moving.",
    status: "paused",
    tier: "P2",
    weight: 1,
    guaranteedShare: 0.05,
    borrowCeiling: 0.15,
    projectId: null,
    masterRoleId: null,
    focusSubMissionId: null,
    health: "unknown",
    lockedFields: [],
    createdAt: AT("09:00", 8),
    updatedAt: AT("19:30", 14),
  },
];

const subMission = (
  id: string,
  missionId: string,
  order: number,
  title: string,
  intent: string,
  health: string,
  intendedEffort: number | null,
  actualEffort: number | null,
  fillIdleCapacity = false,
  status = "active",
) => ({
  id,
  missionId,
  title,
  intent,
  order,
  fillIdleCapacity,
  status,
  coordinatorRoleId: missionId === CRPKO ? ROLE_MASTER : null,
  intendedEffort,
  actualEffort,
  health,
  lockedFields: [],
  createdAt: CREATED,
  updatedAt: FIXTURE_NOW,
});

// Measured shares: coord events per sub-mission's lanes, 16 Oct 08:33 to 17 Oct
// 08:33 UTC (1,223 lane events, master excluded).
export const subMissions = [
  subMission(
    SUB.wave,
    CRPKO,
    0,
    "Architecture wave delivery",
    "Monday 19 Oct milestone: core trading, positions v2, codec v4, risk.",
    "amber",
    0.55,
    0.738,
  ),
  subMission(
    SUB.upkeep,
    CRPKO,
    1,
    "Architecture upkeep",
    "Author and drafter packets, drift audits, rulings on doc-silent questions.",
    "green",
    0.1,
    0.058,
  ),
  subMission(
    SUB.releases,
    CRPKO,
    2,
    "Releases and dev environment",
    "Deploys, Terraform and DDL, the ClickHouse rebuild, Kafka.",
    "amber",
    0.15,
    0.09,
  ),
  subMission(
    SUB.support,
    CRPKO,
    3,
    "Dev support and human QA triage",
    "Human QA triage queue, external devs' questions, reviews of their PRs.",
    "amber",
    0.08,
    0.004,
  ),
  subMission(
    SUB.e2e,
    CRPKO,
    4,
    "Live e2e and harness",
    "Live e2e scenarios and harness bulk runs. Takes what higher sub-missions leave.",
    "unknown",
    0.04,
    0.012,
    true,
  ),
  subMission(
    SUB.factory,
    CRPKO,
    5,
    "PR factory",
    "Haiku backlog PRs built ahead of review windows (rule 102). Takes what higher sub-missions leave.",
    "green",
    0.05,
    0.074,
    true,
  ),
  subMission(
    SUB.observe,
    CRPKO,
    6,
    "Observability",
    "Observe sweeps: alarms, errors, drift between live and expected.",
    "green",
    0.03,
    0.024,
  ),
  subMission(
    SUB.junoDeposits,
    JUNO,
    0,
    "Stuck deposits",
    "Find and settle stuck mainnet deposits.",
    "unknown",
    null,
    null,
    false,
    "paused",
  ),
  subMission(
    SUB.junoWithdrawals,
    JUNO,
    1,
    "Withdrawals",
    "Watch withdrawals through to settlement.",
    "unknown",
    null,
    null,
    false,
    "paused",
  ),
];

const milestone = (
  id: string,
  subMissionId: string,
  title: string,
  status: string,
  statusNote: string | null,
) => ({
  id,
  missionId: CRPKO,
  subMissionId,
  title,
  targetAt: MONDAY,
  status,
  statusNote,
  itemIds: [],
  createdAt: AT("12:00", 15),
  updatedAt: FIXTURE_NOW,
});

// Rule 93: the Monday target, as of the 08:05 owner update.
export const milestones = [
  milestone("ms-codec-v4", SUB.wave, "Codec v4 flip", "done", "Accepted Fri 16 Oct 17:49."),
  milestone(
    "ms-positions-risk",
    SUB.wave,
    "Positions v2 + Risk stack #68",
    "at-risk",
    "#68 needs its fourth main review and a final. Full positions v2 cutover is about 30 Oct to 5 Nov.",
  ),
  milestone(
    "ms-clickhouse-saturday",
    SUB.releases,
    "ClickHouse Saturday",
    "at-risk",
    "Partial: DF-83 done; the table-move tool (#735) waits for the next freeze.",
  ),
  milestone(
    "ms-balance-steps",
    SUB.wave,
    "Balance steps",
    "at-risk",
    "Nothing live yet: the seal fix rides the ingestor release, which rolled back; crpko-devops#773 is gated.",
  ),
  milestone(
    "ms-tc-risk-merges",
    SUB.wave,
    "TC and Risk merges, flags off",
    "on-track",
    "#276 needs a rebase.",
  ),
  milestone(
    "ms-kafka-phase-2",
    SUB.releases,
    "Kafka Phase 2",
    "on-track",
    "After the copy-pause parameter fix and a follow-up apply on a named go.",
  ),
];

const lane = (
  name: string,
  subMissionId: string,
  status: string,
  purpose: string,
  evidence: string,
  at: string,
  statusReason: string | null = null,
  missionId = CRPKO,
) => ({
  id: `lane-${name}`,
  missionId,
  subMissionId,
  name,
  purpose,
  status,
  statusReason,
  leadRoleId: null,
  threadId: null,
  currentItemId: null,
  lastEvidence: { summary: evidence, at, messageId: null, links: [] },
  context: null,
  lastActiveAt: at,
  createdAt: CREATED,
  updatedAt: at,
});

export const lanes = [
  // 1 Architecture wave delivery
  lane(
    "cell-tc",
    SUB.wave,
    "working",
    "Trading Core lead",
    "CRP-11367 D2 decided; fab-tc wave 1 (10 tickets) is a go",
    AT("08:29"),
  ),
  lane(
    "cell-tc2",
    SUB.wave,
    "working",
    "Trading Core (Haiku, lead cell-tc)",
    "TC#234 CRP-13156 cause fix pushed",
    AT("08:02"),
  ),
  lane(
    "cell-tc3",
    SUB.wave,
    "working",
    "Trading Core pbv2 gate 8 (Haiku)",
    "TC#277 (CRP-13161 PR A) Sol r1 dispatched",
    AT("08:26"),
  ),
  lane(
    "cell-pbdraft",
    SUB.wave,
    "working",
    "First-version draft PRs, positions and bonuses backlog",
    "CRP-11367 D2 red commit and gate-input commit",
    AT("08:33"),
  ),
  lane(
    "cell-risk",
    SUB.wave,
    "working",
    "Risk lead",
    "#68 r4: 19 findings split into 7 packets",
    AT("08:22"),
  ),
  lane(
    "cell-risk2",
    SUB.wave,
    "working",
    "Risk (Haiku, lead cell-risk)",
    "R3-18 routine rows; stays on lane C",
    AT("07:23"),
  ),
  lane(
    "cell-risk3",
    SUB.wave,
    "working",
    "Risk (Haiku, lead cell-risk)",
    "R3-01 done on r3-d; took (ii-b) from cell-risk6",
    AT("06:25"),
  ),
  lane(
    "cell-risk4",
    SUB.wave,
    "idle",
    "Risk",
    "CRP-13346 done (risk#134 merged)",
    AT("07:52"),
    "No new work assigned",
  ),
  lane(
    "cell-risk5",
    SUB.wave,
    "working",
    "Risk",
    "CRP-13361 due-scan set-aside prefix (OUT-034)",
    AT("08:09"),
  ),
  lane(
    "cell-risk6",
    SUB.wave,
    "stuck",
    "Risk",
    "Stood down from risk68-r2-d; no edits since",
    AT("07:52"),
    "Waiting on an assignment since about 05:55",
  ),
  lane(
    "cell-risk7",
    SUB.wave,
    "idle",
    "Risk hedge venue fee (CRP-12203)",
    "Lane F closed, standing by",
    AT("07:07"),
    "Standing by",
  ),
  lane(
    "cell-bal",
    SUB.wave,
    "working",
    "Balance rollout",
    "crpko-devops#773 R5-1 fixed, Sol r6 running",
    AT("08:20"),
  ),
  lane(
    "cell-custody",
    SUB.wave,
    "working",
    "Custody transfer",
    "custody-transfer#71 CRP-13326 fix inside Lifecycle 3.2",
    AT("08:10"),
  ),
  lane(
    "cell-money",
    SUB.wave,
    "working",
    "Rewards",
    "CRP-13154 E: option (b), EXP-001 check on the scan path",
    AT("08:13"),
  ),
  lane(
    "cell-edge",
    SUB.wave,
    "waiting",
    "Edge API",
    "edge-api#350 slices 1-3 pushed, offbox green",
    AT("08:19"),
    "Review queued for edge-api#350",
  ),
  lane(
    "cell-bo",
    SUB.wave,
    "working",
    "Backoffice lead",
    "CRP-12480 workbook fix list",
    AT("08:20"),
  ),
  lane(
    "cell-md",
    SUB.wave,
    "idle",
    "Market data and venue router",
    "No ticket in flight",
    AT("21:20", 15),
    "Nothing in flight",
  ),
  lane(
    "cell-ws",
    SUB.wave,
    "parked",
    "ws-gateway",
    "CRP-12707 closed after slot 8",
    AT("15:47", 16),
    "Parked on the CRP-12336 backlog hold",
  ),
  lane(
    "cell-edge2",
    SUB.wave,
    "idle",
    "Edge API (second lane)",
    "Deferred request, nothing in flight",
    AT("07:53", 15),
    "Nothing in flight",
  ),
  lane(
    "cell-rpt",
    SUB.wave,
    "idle",
    "Reporting",
    "Misrouted ask returned",
    AT("14:59", 16),
    "Nothing in flight",
  ),
  // 2 Architecture upkeep
  lane(
    "arch",
    SUB.upkeep,
    "working",
    "Architecture rulings",
    "arch 292 landed: Risk outbox set-aside prefix (OUT-034)",
    AT("07:23"),
  ),
  lane(
    "arch-author",
    SUB.upkeep,
    "idle",
    "Architecture author",
    "Site deploy v119 done",
    AT("06:39", 16),
    "Idle until the next packet",
  ),
  lane(
    "arch-drafter",
    SUB.upkeep,
    "idle",
    "Architecture drafter (Haiku)",
    "Packet delivered",
    AT("01:13"),
    "Idle until the next packet",
  ),
  lane(
    "cell-arch-sites",
    SUB.upkeep,
    "parked",
    "Code book v2 (per-service internals)",
    "Void GO",
    AT("19:16", 11),
    "Waits a go",
  ),
  lane(
    "cell-video",
    SUB.upkeep,
    "parked",
    "Architecture video",
    "Final architecture video delivered",
    AT("22:35", 16),
    "Delivered",
  ),
  // 3 Releases and dev environment
  lane(
    "cell-devops",
    SUB.releases,
    "waiting",
    "Terraform and DDL (lead)",
    "(c2) plan-only gate accepted",
    AT("08:20"),
    "(d2) apply needs a named go",
  ),
  lane(
    "cell-devops2",
    SUB.releases,
    "working",
    "ClickHouse and ingestor releases",
    "CRP-13358 ingestor startup query fix",
    AT("07:55"),
  ),
  lane(
    "cell-kafka",
    SUB.releases,
    "working",
    "Kafka tiering",
    "crpko-devops#778 copy-pause parameter fix, Sol r1",
    AT("08:21"),
  ),
  // 4 Dev support and human QA triage
  lane(
    "cell-triage",
    SUB.support,
    "stuck",
    "Human QA triage (Linear Triage project), 30-minute sweeps",
    "Last sweep",
    AT("14:59", 16),
    "No sweep since Fri 16 Oct 14:59",
  ),
  lane(
    "cell-bofe",
    SUB.support,
    "parked",
    "Backoffice frontend cherry-pick",
    "Parked by the master",
    AT("11:11", 16),
    "Until CRP-13304 (Dylan) and a go",
  ),
  lane(
    "cell-fe12198",
    SUB.support,
    "idle",
    "Frontend support",
    "CRP-12198 delivered",
    AT("19:16", 13),
    "Waiting for an assignment",
  ),
  // 5 Live e2e and harness
  lane(
    "cell-harness",
    SUB.e2e,
    "parked",
    "Integration harness (19,771 cases)",
    "Parked for priority work",
    AT("21:22", 15),
    "Parked for priority work",
  ),
  lane(
    "cell-e2e",
    SUB.e2e,
    "idle",
    "Live e2e (182 scenarios)",
    "DF-50 closed, SPOT-05 PASS",
    AT("18:42", 16),
    "Nothing open",
  ),
  // 6 PR factory
  lane(
    "cell-fab-svc",
    SUB.factory,
    "working",
    "Service PR factory",
    "CRP-12487 worker starting; VRA#35 review queued",
    AT("08:30"),
  ),
  lane(
    "cell-fab-devops",
    SUB.factory,
    "working",
    "crpko-devops PR factory",
    "crpko-devops#770 Sol r8",
    AT("07:59"),
  ),
  lane(
    "cell-fab-tc",
    SUB.factory,
    "working",
    "Trading Core drift tickets (37 unowned)",
    "Wave 1: 10 of 28 buildable tickets",
    AT("07:49"),
  ),
  // 7 Observability
  lane(
    "observe",
    SUB.observe,
    "working",
    "Observe sweeps",
    "Sweep 08:20: NOT_SINGLETON 7 errors on one account; the new Sev2 Kafka alarm is the known partial apply",
    AT("08:24"),
  ),
  // Juno intents
  lane(
    "intents-ops",
    SUB.junoDeposits,
    "parked",
    "Stuck deposit sweeps",
    "Mission paused",
    AT("19:30", 14),
    "Mission paused",
    JUNO,
  ),
  lane(
    "intents-watch",
    SUB.junoWithdrawals,
    "parked",
    "Withdrawal watch",
    "Mission paused",
    AT("19:30", 14),
    "Mission paused",
    JUNO,
  ),
];

const masterActor = { _tag: "role", roleId: ROLE_MASTER };

export const asks = [
  {
    id: "ask-kafka-capacity-r004",
    missionId: CRPKO,
    subMissionId: SUB.releases,
    askedBy: masterActor,
    question:
      "Stamp the next Kafka capacity revision (r004) with the CRP-13215 publisher edit folded in?",
    context:
      "The registry publisher edit for risk-liquidation (evt.trading.order.updated.v1) changes topic_registry_digest, so Kafka Cluster §2 needs a new approved capacity revision. The master deferred it on 15 Oct and folded it into the next revision. It is needed before the dev ACL authorizer is turned on. Not needed for Monday.",
    options: [
      {
        id: "stamp-now",
        label: "Stamp r004 now",
        detail: "CRP-13215 and DF-252 ride r004; the authorizer can be turned on after.",
      },
      {
        id: "hold",
        label: "Hold until the authorizer turn-on",
        detail: "Nothing changes on dev; CRP-13215 stays in Backlog.",
      },
    ],
    recommendation: {
      optionId: "hold",
      reason: "Not needed for Monday, and one stamp at the authorizer turn-on covers both edits.",
    },
    blocks: [{ kind: "work-item", id: "CRP-13215", label: "CRP-13215" }],
    costOfWaiting:
      "Only CRP-13215 waits. The dev ACL authorizer stays off until a revision is stamped.",
    urgency: "normal",
    status: "open",
    answer: null,
    createdAt: AT("18:40", 15),
    updatedAt: AT("18:40", 15),
  },
];

export const drafts = [
  {
    id: "draft-pavan-risk-124",
    missionId: CRPKO,
    audience: "Pavan",
    channel: "github",
    target: { kind: "pull-request", label: "risk#124", url: null, ref: "risk#124" },
    text: "Heads-up: risk#131 (CRP-13313) merged at 02:12 UTC and changed four files your draft #124 also changes. Please rebase #124 on main-dev before your next push so the overlap shows up early.",
    approvedText: null,
    writerRoleId: ROLE_MASTER,
    source: { kind: "master", ref: null },
    appliedNoteIds: [],
    status: "pending",
    rewriteNote: null,
    decidedBy: null,
    decidedAt: null,
    sentAt: null,
    createdAt: AT("08:05"),
  },
];

/** Drafts, approvals and knocks carry no sub-mission in the contract; the fixture files them here. */
export const recordSubMission: Record<string, string> = {
  "draft-pavan-risk-124": SUB.support,
  "knock-batch-fix": SUB.wave,
};

export const knocks = [
  {
    id: "knock-batch-fix",
    missionId: CRPKO,
    fromThreadId: "fixture-thread-batch-fix",
    fromTitle: "Batch-fix Crpko tickets in parallel",
    path: "thread-send",
    summary:
      "Wants to tell the Crpko master it can pick up CRP-13207 (Trading Core, no progress) outside the mission.",
    body: "CRP-13207 has had no progress in the mission. I can take it in this thread if the master releases it.",
    status: "pending",
    forwardedText: null,
    forwardedTo: null,
    decidedAt: null,
    createdAt: AT("08:12"),
  },
];

export const suggestions = [
  {
    id: "suggestion-triage-sweeps",
    missionId: CRPKO,
    targetKind: "schedule",
    target: { kind: "lane", id: "lane-cell-triage", label: "cell-triage" },
    title: "Restart cell-triage's 30-minute sweeps",
    before: { everyMinutes: 30, running: false },
    after: { everyMinutes: 30, running: true },
    diffText: "- sweeps: stopped (last Fri 16 Oct 14:59)\n+ sweeps: every 30 min",
    why: "Human QA triage has not been checked since Friday afternoon; the 08:05 update says so too.",
    evidence: [{ kind: "lane", id: "lane-cell-triage", label: "cell-triage" }],
    author: "scribe",
    acceptor: "master",
    status: "open",
    dismissReason: null,
    outcome: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: AT("08:30"),
  },
];

const fyiNote = (
  id: string,
  subMissionId: string,
  summary: string,
  at: string,
  severity: string,
) => ({
  id,
  missionId: CRPKO,
  subMissionId,
  laneId: null,
  type: "owner-must-know",
  summary,
  sources: [],
  basis: "observed",
  severity,
  confidence: 0.9,
  author: "scribe",
  citation: "unchecked",
  evidence: "matched",
  evidenceLinks: [],
  replacesNoteId: null,
  ackedBy: [],
  createdAt: at,
});

export const notes = [
  fyiNote(
    "note-risk-monday",
    SUB.wave,
    "Positions v2 + Risk #68 is still at risk for Monday. Full positions v2 cutover is about 30 Oct to 5 Nov.",
    AT("08:05"),
    "high",
  ),
  fyiNote(
    "note-ingestor-rollback",
    SUB.releases,
    "The ClickHouse ingestor release rolled back in 13 minutes (startup query too big). No data damage. Fix is CRP-13358.",
    AT("06:52"),
    "medium",
  ),
  fyiNote(
    "note-terraform-partial",
    SUB.releases,
    "Terraform apply landed 76 of 77 rows; the Kafka copy-pause doc refused its parameter name. One-line fix in crpko-devops#778.",
    AT("08:09"),
    "low",
  ),
];

const call = (
  id: string,
  subMissionId: string,
  title: string,
  decision: string,
  reason: string,
  at: string,
  alternatives: string[] = [],
) => ({
  id,
  missionId: CRPKO,
  subMissionId,
  decidedBy: masterActor,
  title,
  decision,
  reason,
  alternatives,
  reversible: true,
  subject: null,
  ownerReaction: null,
  createdAt: at,
});

// Master decisions since the owner last looked (05:06, when he answered DF-255).
export const calls = [
  call(
    "call-10211",
    SUB.wave,
    "risk#68 r4 runs on five parallel workers",
    "Up to 5 Haiku workers on file-disjoint pairs, the lead integrates, then one Sol r5 and an Astra final.",
    "Monday-critical, and 20 of 30 Claude accounts are usable.",
    AT("08:25"),
  ),
  call(
    "call-10194",
    SUB.wave,
    "CRP-12480 cut to three items",
    "Duplicate codes and Content-Type go to arch; the whitespace trim only if arch adds a rule.",
    "Keeps the Backoffice fix inside what the docs decide.",
    AT("08:13"),
  ),
  call(
    "call-10181",
    SUB.releases,
    "Fix the Kafka doc, then re-plan",
    "cell-kafka fixes approvalRef, then a plan-only (c2) and a (d2) apply on a named go.",
    "A plan-only pass first keeps the second apply honest.",
    AT("08:09"),
    ["Scoped apply of the failed rows"],
  ),
  call(
    "call-10158",
    SUB.factory,
    "trading-core#114 moves to the PR factory",
    "cell-fab-tc owns CRP-11432 after wave 1; CRP-12786, 12748 and 12790 stay on hold until #114 resolves.",
    "Stale since 4 Oct and conflicting with main-dev.",
    AT("07:52"),
  ),
  call(
    "call-10108",
    SUB.releases,
    "Accept the ingestor rollback",
    "The fix goes to cell-devops2 as CRP-13358; dev.2 needs a fresh go.",
    "The rollback was clean with no data damage, so the Saturday chain continues.",
    AT("06:52"),
  ),
  call(
    "call-10060",
    SUB.wave,
    "Trading Core order for CRP-13348",
    "P0 first, then CRP-13161 PR B, CRP-13287 PR2, then CRP-13348 G1 to G5.",
    "CRP-13161 PR B builds on the P0 decorator.",
    AT("06:00"),
  ),
];

const holder = {
  master: { actor: masterActor, label: "master" },
  arch: { actor: { _tag: "role", roleId: ROLE_ARCH }, label: "arch" },
  devops2: { actor: { _tag: "lane", laneId: "lane-cell-devops2" }, label: "cell-devops2" },
  reviews: { actor: { _tag: "system", component: "review-pool" }, label: "Codex reviews" },
  dylan: { actor: { _tag: "person", name: "Dylan" }, label: "Dylan" },
};

const item = (id: string, label: string, kind = "work-item") => ({ kind, id, label });

/** Blockers that do not depend on owner records. Owner blockers derive from open asks and drafts. */
export const heldItems = [
  {
    holder: holder.reviews,
    item: item("risk68-final", "risk#68 Sol r5 and Astra final (1 of 6 Codex accounts usable)"),
  },
  {
    holder: holder.master,
    item: item("CRP-13328-deploy", "CRP-13328 Risk startup fix: deploy needs a named go"),
  },
  { holder: holder.master, item: item("kafka-d2", "Kafka apply (d2): needs a named go") },
  {
    holder: holder.master,
    item: item("ingestor-dev2", "Ingestor release dev.2: needs a fresh go after CRP-13358"),
  },
  {
    holder: holder.master,
    item: item("lane-cell-risk6", "cell-risk6: needs an assignment", "lane"),
  },
  {
    holder: holder.arch,
    item: item(
      "bo-contract-gaps",
      "Backoffice contract gaps: Content-Type, workspace fields, KYC flags",
    ),
  },
  { holder: holder.arch, item: item("CRP-12480-q6", "CRP-12480 Q6: duplicate campaign codes") },
  { holder: holder.arch, item: item("CRP-12487-rules", "CRP-12487: three CMS format rules") },
  {
    holder: holder.arch,
    item: item("CRP-13338-q2q3", "CRP-13338 Q2 and Q3: codec and net-zero bump"),
  },
  {
    holder: holder.devops2,
    item: item("CRP-13358", "CRP-13358 ingestor startup query fix (balance seal fix rides it)"),
  },
  {
    holder: holder.dylan,
    item: item("CRP-13304", "CRP-13304: Backoffice frontend cherry-pick waits on it"),
  },
];

export const criticalPath = [
  item("risk68-r4", "risk#68 r4: 19 findings on 5 workers"),
  item("risk68-final", "risk#68 Sol r5 and Astra final"),
  item("CRP-13328-deploy", "CRP-13328 Risk startup fix deploy"),
  item("risk-release", "Risk release with #68"),
];

const feedItem = (
  kind: string,
  summary: string,
  at: string,
  ref: { kind: string; id: string; label: string } | null = null,
) => ({ kind, summary, ref, at });

export const feed = [
  feedItem(
    "note",
    "Drafted a heads-up to Pavan about risk#124. It waits for your approval.",
    AT("08:05"),
    {
      kind: "draft",
      id: "draft-pavan-risk-124",
      label: "Heads-up to Pavan",
    },
  ),
  feedItem(
    "decided",
    "risk#68 r4 runs on up to five parallel workers, then Sol r5 and an Astra final.",
    AT("08:25"),
    {
      kind: "call",
      id: "call-10211",
      label: "risk#68 r4",
    },
  ),
  feedItem(
    "blocked",
    "Terraform apply landed 76 of 77 rows; the Kafka copy-pause doc refused its parameter name. Fix PR crpko-devops#778.",
    AT("08:07"),
  ),
  feedItem(
    "decided",
    "Rule 105: withdrawal-failure tickets go to service leads and devs; CRP-13349 stays with the mission.",
    AT("07:37"),
  ),
  feedItem(
    "decided",
    "Rule 104: PR factories ramp to 10 helper workers and 25 open PRs each; new lane cell-fab-tc.",
    AT("07:34"),
  ),
  feedItem(
    "shipped",
    "Backoffice release docs119-dev.3 is live and verified: campaign create refuses bad fields.",
    AT("07:30"),
  ),
  feedItem("shipped", "Kafka tiering merged: crpko-devops#748 and #750.", AT("07:15")),
  feedItem(
    "shipped",
    "trading-core#274 (CRP-13316 p2) and #275 (CRP-13342 p1) merged, flags off.",
    AT("07:09"),
  ),
  feedItem("shipped", "risk#134 (CRP-13346) merged.", AT("06:43")),
  feedItem(
    "shipped",
    "venue-router-adapters#33 (CRP-13318) and #34 (CRP-13337) merged.",
    AT("06:42"),
  ),
  feedItem(
    "blocked",
    "Ingestor release rolled back in 13 minutes: the startup query is too big for ~7k partitions. No data damage.",
    AT("06:20"),
  ),
  feedItem("shipped", "compliance-kyc#294 (CRP-13334) merged.", AT("05:58")),
  feedItem(
    "milestone",
    "ClickHouse freeze finished clean: closed-positions tables rebuilt, 0 diffs on 3 servers, ingest paused about 5 minutes.",
    AT("05:31"),
  ),
  feedItem(
    "shipped",
    "backoffice-core#338 (CRP-13298) and rewards#223 (CRP-13072) merged.",
    AT("04:45"),
  ),
  feedItem("shipped", "crpko-devops#775 (CRP-12685): hourly ingestor gap check.", AT("04:32")),
  feedItem("shipped", "risk#131 (CRP-13313) merged.", AT("02:12")),
  feedItem("shipped", "risk#132 (CRP-13328) merged; not deployed until a named go.", AT("01:42")),
  feedItem("milestone", "Codec v4 flip accepted.", AT("17:49", 16)),
];

export const bottomLines: Record<string, { text: string; at: string }> = {
  [CRPKO]: {
    text: "Codec v4 is done. Risk #68 is the Monday risk: 19 review findings are on five workers, then two final reviews on one usable Codex account. The ingestor release rolled back (fix CRP-13358) and the Kafka apply needs one more pass.",
    at: FIXTURE_NOW,
  },
  [JUNO]: {
    text: "Paused. Nothing runs here until you resume it.",
    at: AT("19:30", 14),
  },
};

export const usageShares: Record<string, number | null> = {
  [CRPKO]: 0.94,
  [JUNO]: null,
};

const room = (
  id: string,
  kind: string,
  title: string,
  lastSeq: number,
  lastMessageAt: string,
  messagesPerHour: number,
  actionableShare: number,
  subMissionId: string | null = null,
) => ({
  id,
  missionId: CRPKO,
  subMissionId,
  kind,
  title,
  workItemId: null,
  archived: false,
  lastSeq,
  lastMessageAt,
  noise: { messagesPerHour, actionableShare, wastedWakes: 0 },
  createdAt: CREATED,
});

// The five coord channels, with their real last 24h rate and actionable share.
export const rooms = [
  room("room-delivery", "sub-mission", "delivery", 10219, AT("08:33"), 59.4, 0.55, SUB.wave),
  room("room-arch", "arch", "arch", 10205, AT("08:22"), 1.9, 0.78, SUB.upkeep),
  room("room-release", "release", "release", 10155, AT("07:51"), 0.6, 0.71, SUB.releases),
  room("room-control", "control", "control", 10212, AT("08:25"), 0.9, 0.95),
  room("room-observe", "custom", "observe", 10210, AT("08:24"), 1.4, 0.21, SUB.observe),
];

/** Messages since the owner last looked, per room (coord events after 05:06 UTC). */
export const roomUnread: Record<string, number> = {
  "room-delivery": 180,
  "room-arch": 6,
  "room-release": 4,
  "room-control": 3,
  "room-observe": 4,
};

export const ownerLastLookedAt: Record<string, string | null> = {
  [CRPKO]: OWNER_LAST_LOOKED_AT,
  [JUNO]: AT("19:30", 14),
};

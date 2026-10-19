import type { ApplyResult, ImportDiff } from "./apply.ts";
import { ENROLMENT_KIND, ENROLMENT_SOURCE, type EnrolmentDiff } from "./enrol.ts";
import type { ImportPlan } from "./mapping.ts";

/** Plain-text dry-run / apply report: source counts, count checks, diff, warnings. */

const pad = (text: string | number, width: number) => String(text).padEnd(width);
const padLeft = (text: string | number, width: number) => String(text).padStart(width);

interface Check {
  readonly name: string;
  readonly expected: number;
  readonly actual: number;
}

export const countChecks = (plan: ImportPlan): ReadonlyArray<Check> => {
  const c = plan.counts;
  const r = plan.router;
  const core = plan.core;
  const threadLanes = core.lanes.filter(
    (l) => !l.id.includes(":lane:backfill:") && !l.id.includes(":lane:retired:"),
  );
  return [
    { name: "coord channels -> rooms", expected: c.coordChannels, actual: r.rooms.length },
    { name: "coord events -> messages", expected: c.coordEvents, actual: r.messages.length },
    {
      name: "coord deliveries -> message recipients",
      expected: c.coordDeliveries,
      actual: r.messages.reduce((n, m) => n + m.message.to.length, 0),
    },
    {
      name: "coord members -> subscriptions",
      expected: c.coordMembers,
      actual: r.subscriptions.length,
    },
    { name: "STANDING-RULES rules -> rules", expected: c.rules, actual: core.rules.length },
    {
      name: "DEFERRED rows -> deferred work items",
      expected: c.deferred,
      actual: core.workItems.length,
    },
    {
      name: "LANE-ROSTER sections 8+9 -> parked/retired lanes",
      expected: c.rosterRecovered + c.rosterRetired,
      actual: core.lanes.length - threadLanes.length,
    },
    {
      name: "crw awaiting + holds -> approvals",
      expected: c.crwAwaiting + c.crwHolds,
      actual: core.approvals.length,
    },
  ];
};

const tally = <T>(items: ReadonlyArray<T>, key: (item: T) => string) => {
  const out = new Map<string, number>();
  for (const item of items) out.set(key(item), (out.get(key(item)) ?? 0) + 1);
  return [...out.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
};

export const renderReport = (input: {
  readonly plan: ImportPlan;
  readonly diff: ImportDiff;
  readonly mode: "dry-run" | "apply";
  readonly paths: Readonly<Record<string, string | null>>;
  readonly against: string;
  readonly applied?: ApplyResult;
}): string => {
  const { plan, diff } = input;
  const out: Array<string> = [];
  const c = plan.counts;
  out.push(
    `Missions coord import ${input.mode === "dry-run" ? "DRY RUN (nothing written)" : "APPLY"}`,
  );
  out.push(`mission ${plan.missionId}, sources as of ${plan.asOf}`);
  out.push(`diffed against: ${input.against}`);
  out.push("");
  out.push("Sources");
  for (const [k, v] of Object.entries(input.paths))
    out.push(`  ${pad(k, 12)} ${v ?? "(not given)"}`);
  out.push("");
  out.push("Source counts");
  out.push(
    `  coord.db: ${c.coordActors} actors, ${c.coordChannels} channels, ${c.coordMembers} members, ` +
      `${c.coordEvents} events, ${c.coordDeliveries} deliveries (${c.coordUnacked} not acked)`,
  );
  out.push(`  STANDING-RULES.md: ${c.rules} rules`);
  out.push(`  DEFERRED.md: ${c.deferred} register rows`);
  out.push(`  lane-pulse.json: ${c.lanePulseActors} actors`);
  out.push(
    `  LANE-ROSTER.md: ${c.rosterServices} service rows, ${c.rosterRecovered} backfill lanes, ${c.rosterRetired} retired lanes`,
  );
  out.push(`  crw.db: ${c.crwAwaiting} Awaiting Decision threads, ${c.crwHolds} holds`);
  out.push("");
  out.push("Count checks");
  for (const check of countChecks(plan)) {
    const ok = check.expected === check.actual;
    out.push(
      `  ${ok ? "ok  " : "FAIL"} ${pad(check.name, 48)} ${padLeft(check.expected, 6)} -> ${padLeft(check.actual, 6)}`,
    );
  }
  out.push("");
  out.push("Records (planned)");
  const core = plan.core;
  out.push(`  roles: ${tally(core.roles, (r) => r.kind)}`);
  out.push(
    `  role models: ${tally(core.roles, (r) => `${r.modelSelection.model}${r.modelSelection.options?.length ? `#${r.modelSelection.options[0]!.value}` : ""}`)}`,
  );
  out.push(`  role bindings: ${core.bindings.length}`);
  out.push(`  lanes: ${tally(core.lanes, (l) => l.status)}`);
  out.push(
    `  rules: ${tally(core.rules, (r) => r.status)}; from archive ${core.rules.filter((r) => r.provenance._tag === "import" && r.provenance.source === "STANDING-RULES-ARCHIVE.md").length}`,
  );
  out.push(`  deferred work items: ${tally(core.workItems, (w) => w.deferral?.status ?? "none")}`);
  out.push(`  approvals: ${tally(core.approvals, (a) => `${a.requestedBy}/${a.status}`)}`);
  out.push(
    `  approval routing: ${(core.mission.approvalRouting ?? []).map((r) => `${r.match._tag} -> ${r.approver}`).join(", ") || "none (owner)"}`,
  );
  out.push(
    `  review pools: ${
      plan.policy.pools
        .map((p) => `${p.poolId} (${p.kind}, ${p.backend}, capacity ${p.capacity} ${p.unit})`)
        .join(", ") || "none (not requested: pass --review-pool lease|budget)"
    }`,
  );
  out.push(`  rooms: ${tally(plan.router.rooms, (r) => r.kind)}`);
  out.push(`  messages: ${tally(plan.router.messages, (m) => m.message.kind)}`);
  out.push(
    `  messages with body: ${plan.router.messages.filter((m) => m.body !== null).length}, ` +
      `summaries cut to 400 chars: ${plan.router.messages.filter((m) => m.body !== null && m.message.summary.endsWith("…")).length}`,
  );
  out.push(`  subscriptions: ${tally(plan.router.subscriptions, (s) => s.mode)}`);
  out.push(`  read positions: ${plan.router.readPositions.length}`);
  out.push(
    `  coord enrolments: ${plan.enrolments.enrol.length} actors, ${plan.enrolments.enrol.filter((e) => e.threadId === null).length} without a thread`,
  );
  out.push("");
  out.push("Diff against target");
  out.push(
    `  ${pad("kind", 16)} ${padLeft("planned", 8)} ${padLeft("create", 8)} ${padLeft("same", 8)} ${padLeft("differs", 8)} ${padLeft("close", 6)}`,
  );
  for (const k of diff.kinds) {
    out.push(
      `  ${pad(k.kind, 16)} ${padLeft(k.planned, 8)} ${padLeft(k.create, 8)} ${padLeft(k.unchanged, 8)} ${padLeft(k.differs, 8)} ${padLeft(k.close, 6)}`,
    );
  }
  if (!diff.routerAvailable) out.push("  (router parts not diffed: no router sink)");
  const differs = diff.kinds.filter((k) => k.differIds.length > 0);
  for (const k of differs)
    out.push(
      `  ${k.kind} differs (kept as is): ${k.differIds.slice(0, 10).join(", ")}${k.differIds.length > 10 ? ", ..." : ""}`,
    );
  if (input.applied !== undefined) {
    out.push("");
    out.push(
      `Applied: ${input.applied.commits} commits, closed ${input.applied.closed} stale approvals`,
    );
    for (const [k, n] of Object.entries(input.applied.created)) out.push(`  created ${k}: ${n}`);
  }
  out.push("");
  out.push(
    `Coord enrolments (${plan.enrolments.enrol.length}; principal coord:<actor>, import provenance ${ENROLMENT_SOURCE})`,
  );
  const enrolDiff = diff.kinds.find(
    (k): k is EnrolmentDiff => k.kind === ENROLMENT_KIND && "createIds" in k,
  );
  const enrolling = new Set(enrolDiff?.createIds ?? []);
  const keptOut = new Set(enrolDiff?.differIds ?? []);
  const label = (actor: string) =>
    enrolDiff === undefined
      ? "planned"
      : enrolling.has(actor)
        ? "enrol"
        : keptOut.has(actor)
          ? "removed"
          : "same";
  for (const e of plan.enrolments.enrol) {
    out.push(
      `  ${pad(label(e.actor), 8)} ${pad(e.actor, 20)} ${e.threadId ?? `(${e.kind} actor, no thread)`}`,
    );
  }
  if (keptOut.size > 0) out.push("  removed: the owner or master dropped it since; left out");
  out.push("");
  out.push("Approvals");
  for (const a of core.approvals) {
    out.push(`  ${pad(a.status, 13)} ${a.title}${a.staleReason ? ` (${a.staleReason})` : ""}`);
  }
  out.push("");
  out.push("Lanes");
  for (const l of core.lanes) {
    const role = core.roles.find((r) => r.id === l.leadRoleId);
    out.push(
      `  ${pad(l.status, 8)} ${pad(l.name, 52)} ${role ? role.modelSelection.model : "-"}${l.threadId ? ` ${l.threadId}` : ""}`,
    );
  }
  out.push("");
  out.push(`Warnings (${plan.warnings.length})`);
  for (const w of plan.warnings) out.push(`  ${w}`);
  return `${out.join("\n")}\n`;
};

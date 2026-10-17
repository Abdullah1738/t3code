/**
 * Owner reports built from mission data: the 4h update and the daily summary.
 *
 * Pure code over records, notes and events; no model call. The text keeps the
 * shape of today's hand-written reports so the owner reads the same thing: the
 * 4h update matches an `OWNER-UPDATES.md` section, the daily matches the daily
 * writer's cards (brief, then `<!-- DETAIL -->`, then the reconciled detail).
 * Each report carries the items it left open; the next one closes them out.
 */
import type {
  Approval,
  Ask,
  Call,
  Lane,
  MissionActor,
  Milestone,
  Mission,
  MissionEvent,
  Note,
  SubMission,
  Suggestion,
  WorkItem,
} from "@t3tools/contracts";

import { currentNotes, rankFyi } from "./notes.ts";

export type ReportKind = "update" | "daily";

/** Something a report left open, by record ref `kind:id`. */
export interface OpenItem {
  readonly ref: string;
  readonly label: string;
  readonly since: string;
}

export interface ReportUsage {
  readonly batches: number;
  readonly notes: number;
  readonly verified: number;
  readonly failed: number;
  readonly citationPassRate: number | null;
  readonly mismatch: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ReportInput {
  readonly kind: ReportKind;
  readonly from: string;
  readonly to: string;
  readonly mission: Mission;
  readonly subMissions: ReadonlyArray<SubMission>;
  readonly milestones: ReadonlyArray<Milestone>;
  readonly lanes: ReadonlyArray<Lane>;
  readonly asks: ReadonlyArray<Ask>;
  readonly calls: ReadonlyArray<Call>;
  readonly approvals: ReadonlyArray<Approval>;
  readonly workItems: ReadonlyArray<WorkItem>;
  readonly notes: ReadonlyArray<Note>;
  readonly suggestions: ReadonlyArray<Suggestion>;
  /** Mission events; only those inside the window are used. */
  readonly events: ReadonlyArray<MissionEvent>;
  /** Items the previous report of the same kind left open. */
  readonly previous: { readonly coversTo: string; readonly open: ReadonlyArray<OpenItem> } | null;
  /** Daily only: the 4h updates this summary covers. */
  readonly updates: ReadonlyArray<{
    readonly coversTo: string;
    readonly open: ReadonlyArray<OpenItem>;
  }>;
  /** The editor's bottom line, used when it was written inside the window. */
  readonly bottomLine: { readonly text: string; readonly at: string } | null;
  readonly usage: ReportUsage | null;
}

export interface BuiltReport {
  readonly kind: ReportKind;
  readonly coversFrom: string;
  readonly coversTo: string;
  readonly text: string;
  readonly open: ReadonlyArray<OpenItem>;
}

// --- small helpers ---------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const hhmm = (iso: string) => iso.slice(11, 16);
const dayLabel = (iso: string) =>
  `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? iso.slice(5, 7)}`;
const ms = (iso: string) => Date.parse(iso);
const inWindow = (iso: string | null, from: string, to: string) =>
  iso !== null && ms(iso) > ms(from) && ms(iso) <= ms(to);

/** Wait age like `45m`, `3h`, `2d 4h`. */
export const age = (sinceIso: string, nowIso: string): string => {
  const minutes = Math.max(0, Math.floor((ms(nowIso) - ms(sinceIso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
};

const sentence = (text: string) => {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return /[.!?:]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** One "Left hanging" line; the label is bold and ends with a colon, so drop its own full stop. */
const hangingLine = (input: ReportInput, item: OpenItem) =>
  `- **${item.label.trim().replace(/[.:]+$/, "")}:** ${resolveOpenItem(input, item)}`;

const isOwnerProvenance = (provenance: { readonly _tag: string } | null | undefined) =>
  provenance?._tag === "owner-app" || provenance?._tag === "owner-imessage";

const SHIPPED_STAGES = new Set(["readback", "exercised", "done"]);
const isShipped = (item: WorkItem) =>
  SHIPPED_STAGES.has(item.stage) ||
  item.facts.deployedReadback !== null ||
  item.facts.exercised !== null;
const isBlocked = (item: WorkItem) => item.stage !== "done" && item.blockedBy.length > 0;

// --- shared views ----------------------------------------------------------

interface Views {
  readonly input: ReportInput;
  readonly laneName: (laneId: string | null) => string;
  readonly actorLabel: (actor: MissionActor | null) => string;
  readonly windowNotes: ReadonlyArray<Note>;
  readonly current: ReadonlyArray<Note>;
}

const views = (input: ReportInput): Views => {
  const lanes = new Map(input.lanes.map((lane) => [lane.id as string, lane]));
  const laneName = (laneId: string | null) =>
    laneId === null ? "Mission" : (lanes.get(laneId)?.name ?? laneId);
  const actorLabel = (actor: MissionActor | null): string => {
    if (actor === null) return "nobody";
    switch (actor._tag) {
      case "owner":
        return "you";
      case "lane":
        return laneName(actor.laneId);
      case "role":
        return actor.roleId;
      case "thread":
        return "a thread";
      case "system":
        return actor.component;
      case "person":
        return actor.name;
    }
  };
  const verified = input.notes.filter((note) => note.citation === "verified");
  return {
    input,
    laneName,
    actorLabel,
    windowNotes: verified.filter((note) => inWindow(note.createdAt, input.from, input.to)),
    current: currentNotes(verified),
  };
};

const noteLine = (v: Views, note: Note) =>
  `- **${v.laneName(note.laneId)}:** ${sentence(note.summary)}${
    note.basis === "claimed" && note.type === "claim-of-done" ? " (the lane's claim)" : ""
  }`;

const ownerDecisions = (v: Views): ReadonlyArray<string> => {
  const { input } = v;
  const lines: Array<{ at: string; line: string }> = [];
  for (const ask of input.asks) {
    const answer = ask.answer;
    if (answer === null || !isOwnerProvenance(answer.provenance)) continue;
    if (!inWindow(answer.answeredAt, input.from, input.to)) continue;
    const option = ask.options.find((candidate) => candidate.id === answer.optionId);
    const said = [option?.label, answer.text.trim()].filter(Boolean).join(": ");
    lines.push({
      at: answer.answeredAt,
      line: `- ${sentence(ask.question)} ${sentence(said || "Answered")}`,
    });
  }
  for (const call of input.calls) {
    if (call.decidedBy._tag !== "owner" || !inWindow(call.createdAt, input.from, input.to))
      continue;
    lines.push({ at: call.createdAt, line: `- ${call.title}: ${sentence(call.decision)}` });
  }
  for (const suggestion of input.suggestions) {
    if (!isOwnerProvenance(suggestion.decidedBy)) continue;
    if (!inWindow(suggestion.decidedAt, input.from, input.to)) continue;
    lines.push({
      at: suggestion.decidedAt ?? input.to,
      line: `- Suggestion "${suggestion.title}": ${suggestion.status}.`,
    });
  }
  return lines.toSorted((a, b) => a.at.localeCompare(b.at)).map((entry) => entry.line);
};

interface Waiting {
  readonly since: string;
  readonly ref: string;
  readonly label: string;
  readonly line: string;
}

/** What waits on the owner: open asks, pending approvals, owner-routed suggestions. */
const waitingOnOwner = (v: Views): ReadonlyArray<Waiting> => {
  const { input } = v;
  const out: Array<Waiting> = [];
  for (const ask of input.asks) {
    if (ask.status !== "open") continue;
    const recommendation = ask.recommendation
      ? (ask.options.find((option) => option.id === ask.recommendation?.optionId)?.label ?? null)
      : null;
    out.push({
      since: ask.createdAt,
      ref: `ask:${ask.id}`,
      label: ask.question,
      line: `- **${ask.question}** Waiting ${age(ask.createdAt, input.to)}${
        ask.blocks.length > 0 ? `, holds ${ask.blocks.length} item(s)` : ""
      }${ask.urgency === "p0" ? ", urgent" : ""}.${
        recommendation ? ` Recommended: ${recommendation}.` : ""
      }`,
    });
  }
  for (const approval of input.approvals) {
    if (approval.status !== "pending") continue;
    out.push({
      since: approval.createdAt,
      ref: `approval:${approval.id}`,
      label: approval.title,
      line: `- **Approve ${approval.kind}: ${approval.title}** Waiting ${age(approval.createdAt, input.to)}.`,
    });
  }
  for (const suggestion of input.suggestions) {
    if (suggestion.status !== "open" || suggestion.acceptor !== "owner") continue;
    if (suggestion.missionId !== null && suggestion.missionId !== input.mission.id) continue;
    out.push({
      since: suggestion.createdAt,
      ref: `suggestion:${suggestion.id}`,
      label: suggestion.title,
      line: `- **Suggestion: ${suggestion.title}** Waiting ${age(suggestion.createdAt, input.to)}.`,
    });
  }
  return out.toSorted((a, b) => a.since.localeCompare(b.since));
};

/** Items the next report must close out. */
const openItems = (v: Views): ReadonlyArray<OpenItem> => {
  const { input } = v;
  const items: Array<OpenItem> = waitingOnOwner(v).map(({ ref, label, since }) => ({
    ref,
    label,
    since,
  }));
  for (const note of v.current) {
    if (
      note.type !== "blocker" &&
      note.type !== "owner-must-know" &&
      note.evidence !== "mismatch"
    ) {
      continue;
    }
    if (note.ackedBy.some((actor) => actor._tag === "owner")) continue;
    items.push({
      ref: `note:${note.id}`,
      label: `${v.laneName(note.laneId)}: ${note.summary}`,
      since: note.createdAt,
    });
  }
  for (const item of input.workItems) {
    if (!isBlocked(item)) continue;
    items.push({ ref: `work-item:${item.id}`, label: item.title, since: item.updatedAt });
  }
  for (const milestone of input.milestones) {
    if (milestone.status !== "at-risk") continue;
    items.push({
      ref: `milestone:${milestone.id}`,
      label: milestone.title,
      since: milestone.updatedAt,
    });
  }
  return items;
};

/** How a previously open item ended up, from the current records. */
export const resolveOpenItem = (input: ReportInput, item: OpenItem): string => {
  const separator = item.ref.indexOf(":");
  const kind = item.ref.slice(0, separator);
  const id = item.ref.slice(separator + 1);
  const waited = `waiting ${age(item.since, input.to)}`;
  switch (kind) {
    case "ask": {
      const ask = input.asks.find((candidate) => candidate.id === id);
      if (!ask) return "**Gone from the records.**";
      if (ask.status === "answered") {
        const said = ask.answer?.text.trim();
        return said ? `**Done.** Answered: ${sentence(said)}` : "**Done.** Answered.";
      }
      if (ask.status === "open") return `**Still open** (${waited}).`;
      return `**Dropped** (${ask.status}).`;
    }
    case "approval": {
      const approval = input.approvals.find((candidate) => candidate.id === id);
      if (!approval) return "**Gone from the records.**";
      if (approval.status === "pending") return `**Still open** (${waited}).`;
      if (approval.status === "stale-closed") {
        return `**Dropped** (closed as stale${approval.staleReason ? `: ${approval.staleReason}` : ""}).`;
      }
      return `**Done.** ${approval.status === "approved" ? "Approved" : "Rejected"}.`;
    }
    case "suggestion": {
      const suggestion = input.suggestions.find((candidate) => candidate.id === id);
      if (!suggestion) return "**Gone from the records.**";
      if (suggestion.status === "open") return `**Still open** (${waited}).`;
      return `**Done.** ${suggestion.status[0]?.toUpperCase()}${suggestion.status.slice(1)}.`;
    }
    case "note": {
      const note = input.notes.find((candidate) => candidate.id === id);
      if (!note) return "**Gone from the records.**";
      const newer = input.notes.find(
        (candidate) => candidate.replacesNoteId === id && candidate.citation === "verified",
      );
      if (newer) return `**Updated.** ${sentence(newer.summary)}`;
      if (note.ackedBy.some((actor) => actor._tag === "owner"))
        return "**Done.** You marked it seen.";
      return `**Still open** (${waited}).`;
    }
    case "work-item": {
      const work = input.workItems.find((candidate) => candidate.id === id);
      if (!work) return "**Gone from the records.**";
      if (isShipped(work)) return `**Done.** Now at ${work.stage}.`;
      if (work.blockedBy.length === 0) return `**Moving.** Unblocked, now at ${work.stage}.`;
      return `**Still blocked** (${waited}, at ${work.stage}).`;
    }
    case "milestone": {
      const milestone = input.milestones.find((candidate) => candidate.id === id);
      if (!milestone) return "**Gone from the records.**";
      if (milestone.status === "done") return "**Done.**";
      if (milestone.status === "missed") return "**Missed.**";
      if (milestone.status === "at-risk") return `**Still at risk** (${waited}).`;
      return `**Back ${milestone.status}.**`;
    }
    default:
      return "**Unknown item.**";
  }
};

const laneLines = (v: Views, notes: ReadonlyArray<Note>): ReadonlyArray<string> => {
  const { input } = v;
  const order = new Map(input.subMissions.map((sub) => [sub.id as string, sub.order]));
  const lanes = input.lanes
    .filter((lane) => lane.status !== "retired")
    .toSorted(
      (a, b) =>
        (order.get(a.subMissionId ?? "") ?? 1e9) - (order.get(b.subMissionId ?? "") ?? 1e9) ||
        a.name.localeCompare(b.name),
    );
  return lanes.map((lane) => {
    const status =
      lane.statusReason && lane.status !== "working"
        ? `${lane.status} (${lane.statusReason.trim()})`
        : lane.status;
    const latest = notes
      .filter((note) => note.laneId === lane.id)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (latest) return `- **${lane.name}:** ${status}. ${sentence(latest.summary)}`;
    if (lane.lastEvidence && inWindow(lane.lastEvidence.at, input.from, input.to)) {
      return `- **${lane.name}:** ${status}. ${sentence(lane.lastEvidence.summary)}`;
    }
    return `- **${lane.name}:** ${status}. No change since ${hhmm(input.from)}.`;
  });
};

const shippedLines = (v: Views) =>
  v.input.workItems
    .filter((item) => isShipped(item) && inWindow(item.updatedAt, v.input.from, v.input.to))
    .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .map(
      (item) =>
        `- ${hhmm(item.updatedAt)} ${item.title} (${v.laneName(item.laneId)}, ${item.stage}).`,
    );

const mergedLines = (v: Views) =>
  v.input.workItems
    .filter(
      (item) =>
        !isShipped(item) &&
        item.facts.mergedAtHead !== null &&
        inWindow(item.updatedAt, v.input.from, v.input.to),
    )
    .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .map((item) => `- ${hhmm(item.updatedAt)} ${item.title} (${v.laneName(item.laneId)}).`);

const mismatchLines = (v: Views) =>
  v.windowNotes
    .filter((note) => note.evidence === "mismatch")
    .map((note) => {
      const links = note.evidenceLinks.map((link) => link.label).join(", ");
      return `- **${v.laneName(note.laneId)}:** says "${note.sources[0]?.quote.trim() ?? note.summary}" but ${
        links ? `the record shows otherwise (${links})` : "the record shows otherwise"
      }.`;
    });

const usageLines = (input: ReportInput): ReadonlyArray<string> => {
  const usage = input.usage;
  if (usage === null) return ["- Scribe: no batches in this window."];
  const rate =
    usage.citationPassRate === null ? "n/a" : `${Math.round(usage.citationPassRate * 100)}%`;
  return [
    `- Scribe: ${usage.notes} notes from ${usage.batches} batches, citation pass rate ${rate}, ${usage.mismatch} claim mismatches.`,
    `- Scribe tokens: ${usage.inputTokens} in, ${usage.outputTokens} out.`,
  ];
};

const waitingOnOthers = (v: Views): string => {
  const held = new Map<string, Array<string>>();
  for (const item of v.input.workItems) {
    if (!isBlocked(item)) continue;
    const holder = v.actorLabel(item.heldBy);
    held.set(holder, [...(held.get(holder) ?? []), item.title]);
  }
  if (held.size === 0) return "nothing.";
  return `${[...held.entries()].map(([holder, titles]) => `${holder} (${titles.join("; ")})`).join(", ")}.`;
};

const bottomLine = (v: Views, waiting: number, shipped: number, decisions: number): string => {
  const { input } = v;
  if (input.bottomLine && inWindow(input.bottomLine.at, input.from, input.to)) {
    return sentence(input.bottomLine.text);
  }
  const blocked = input.workItems.filter(isBlocked).length;
  const parts = [
    shipped > 0 ? `${shipped} shipped` : "nothing shipped",
    `${decisions} of your decisions recorded`,
    waiting > 0 ? `${waiting} waiting on you` : "nothing waiting on you",
    blocked > 0 ? `${blocked} blocked` : "nothing blocked",
  ];
  const top = rankFyi(v.windowNotes, { limit: 1 })[0];
  return `${sentence(parts.join(", ").replace(/^./, (c) => c.toUpperCase()))}${
    top ? ` Most important note: ${sentence(top.summary)}` : ""
  }`;
};

const section = (title: string, lines: ReadonlyArray<string>, empty: string) =>
  [`**${title}**${lines.length === 0 ? ` ${empty}` : ""}`, ...lines].join("\n");

// --- 4h update -------------------------------------------------------------

/** One `OWNER-UPDATES.md` section, newest-first file format. */
export const buildUpdate = (input: ReportInput): BuiltReport => {
  const v = views(input);
  const since = hhmm(input.from);
  const decisions = ownerDecisions(v);
  const shipped = shippedLines(v);
  const merged = mergedLines(v);
  const waiting = waitingOnOwner(v);
  const mismatches = mismatchLines(v);
  const worth = rankFyi(v.windowNotes, { limit: 8 }).map((note) => noteLine(v, note));
  const hanging = (input.previous?.open ?? []).map((item) => hangingLine(input, item));
  const failedCitations = input.notes.filter(
    (note) => note.citation === "failed" && inWindow(note.createdAt, input.from, input.to),
  ).length;

  const blocks = [
    `### ${input.to.slice(0, 10)} ${hhmm(input.to)} UTC`,
    `_Covers ${since} to ${hhmm(input.to)} UTC (${dayLabel(input.to)}). Sources: ${input.mission.title} mission records, scribe notes (citation-checked) and the mission event log._`,
    `**Short version:** ${bottomLine(v, waiting.length, shipped.length, decisions.length)}`,
    section(`Your decisions since ${since}:`, decisions, "None."),
    section(`Shipped since ${since}:`, shipped, "Nothing."),
    section(`Merged since ${since} (${merged.length}):`, merged, "Nothing."),
    section("Worth knowing (from the lanes):", worth, "Nothing new."),
    section(
      input.previous ? `Left hanging from ${hhmm(input.previous.coversTo)}:` : "Left hanging:",
      hanging,
      input.previous ? "Nothing was left open." : "First update, nothing to close out.",
    ),
    section(
      "Needs you:",
      waiting.map((entry) => entry.line),
      "Nothing.",
    ),
    section("Every lane:", laneLines(v, v.windowNotes), "No lanes."),
    section(
      "Doesn't add up:",
      [
        ...mismatches,
        ...(failedCitations > 0
          ? [`- ${failedCitations} scribe note(s) failed their citation check and were left out.`]
          : []),
      ],
      "Nothing.",
    ),
    ["#### Usage", ...usageLines(input)].join("\n"),
    `Waiting on you: ${waiting.length === 0 ? "nothing." : `${waiting.length} item(s), oldest ${age(waiting[0]!.since, input.to)}.`}\nWaiting on others: ${waitingOnOthers(v)}`,
  ];
  return {
    kind: "update",
    coversFrom: input.from,
    coversTo: input.to,
    text: `${blocks.join("\n\n")}\n`,
    open: openItems(v),
  };
};

// --- daily summary ---------------------------------------------------------

/** The daily summary: brief cards, `<!-- DETAIL -->`, then the reconciled detail. */
export const buildDaily = (input: ReportInput): BuiltReport => {
  const v = views(input);
  const waiting = waitingOnOwner(v);
  const shipped = shippedLines(v);
  const decisions = ownerDecisions(v);
  const card = (title: string, lines: ReadonlyArray<string>, empty: string) =>
    [`## ${title}`, "", ...(lines.length === 0 ? [empty] : lines)].join("\n");

  const decide = input.asks
    .filter((ask) => ask.status === "open")
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((ask) => {
      const options = ask.options
        .map((option) => `${option.label}${option.detail ? ` (${option.detail})` : ""}`)
        .join("; ");
      const pick = ask.recommendation
        ? `Recommended: ${
            ask.options.find((option) => option.id === ask.recommendation?.optionId)?.label ??
            "no pick"
          }, ${ask.recommendation.reason.trim()}.`
        : "";
      return [
        `- **${ask.question}**`,
        options ? ` Options: ${options}.` : "",
        pick ? ` ${pick}` : "",
        ` Holds ${ask.blocks.length} item(s) since ${hhmm(ask.createdAt)}Z.`,
        " Answer in the mission inbox.",
      ].join("");
    });

  const youAsked = input.events
    .filter(
      (event) => isOwnerProvenance(event.provenance) && inWindow(event.at, input.from, input.to),
    )
    .map((event) => `- ${hhmm(event.at)}Z ${sentence(event.summary)}`);

  const direction = [
    ...input.calls
      .filter(
        (call) =>
          call.decidedBy._tag !== "owner" &&
          call.ownerReaction === null &&
          inWindow(call.createdAt, input.from, input.to),
      )
      .map(
        (call) =>
          `- ${call.title}: ${sentence(call.decision)} Why: ${sentence(call.reason)} ${
            call.reversible ? "Reversible." : "Hard to reverse."
          }`,
      ),
    ...v.windowNotes.filter((note) => note.type === "deviation").map((note) => noteLine(v, note)),
  ].slice(0, 5);

  const blockers = [
    ...input.workItems
      .filter(isBlocked)
      .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map(
        (item) =>
          `- **${item.title}:** held by ${v.actorLabel(item.heldBy)} since ${hhmm(item.updatedAt)}Z; waits on ${item.blockedBy
            .map((ref) => ref.label ?? `${ref.kind} ${ref.id}`)
            .join(", ")}.`,
      ),
    ...v.current
      .filter((note) => note.type === "blocker" && inWindow(note.createdAt, input.from, input.to))
      .map((note) => noteLine(v, note)),
  ].slice(0, 6);

  const shown = new Set(
    v.windowNotes
      .filter((note) => note.type === "blocker" || note.type === "deviation")
      .map((n) => n.id),
  );
  const worth = rankFyi(
    v.windowNotes.filter((note) => !shown.has(note.id) && note.severity !== "low"),
    { limit: 8 },
  ).map((note) => noteLine(v, note));
  const ignore = v.windowNotes
    .filter((note) => note.severity === "low" && note.type !== "owner-must-know")
    .slice(0, 8)
    .map((note) => noteLine(v, note));

  const targets = input.milestones
    .filter((milestone) => milestone.status !== "done")
    .toSorted((a, b) => (a.targetAt ?? "~").localeCompare(b.targetAt ?? "~"))
    .map(
      (milestone) =>
        `- **${milestone.title}:** ${milestone.status}${
          milestone.targetAt
            ? `, due ${dayLabel(milestone.targetAt)} ${hhmm(milestone.targetAt)}Z`
            : ""
        }.${milestone.statusNote ? ` ${sentence(milestone.statusNote)}` : ""}`,
    );

  const behind = input.updates.map((update) => hhmm(update.coversTo));
  const hangingSeen = new Map<string, OpenItem>();
  for (const update of input.updates) {
    for (const item of update.open) hangingSeen.set(item.ref, item);
  }
  const hanging = [...hangingSeen.values()].map((item) => hangingLine(input, item));
  const failedCitations = input.notes.filter(
    (note) => note.citation === "failed" && inWindow(note.createdAt, input.from, input.to),
  ).length;

  const brief = [
    `# ${input.mission.title}: daily summary, ${dayLabel(input.to)}`,
    `_Covers ${dayLabel(input.from)} ${hhmm(input.from)}Z to ${dayLabel(input.to)} ${hhmm(input.to)}Z._`,
    card("Bottom line", [bottomLine(v, waiting.length, shipped.length, decisions.length)], ""),
    card("Decide", decide, "Nothing needs your decision today."),
    card("You asked", youAsked, "Nothing new from you in this window."),
    card("Direction check", direction, "No calls to revisit."),
    card("Blocking the swarm", blockers, "Nothing is blocked."),
    card("Worth knowing", worth, "Nothing else stood out."),
    // Shareable: what shipped, without internal lane names.
    card(
      "Shareable progress",
      input.workItems
        .filter((item) => isShipped(item) && inWindow(item.updatedAt, input.from, input.to))
        .slice(0, 8)
        .map((item) => `- ${sentence(item.title)}`),
      "Nothing shipped in this window.",
    ),
    card("Targets", targets, "No open milestones."),
    card("Safe to ignore", ignore, "Nothing."),
  ];
  const detail = [
    card("Every lane, whole day", laneLines(v, v.windowNotes), "No lanes."),
    card("Left hanging and how it ended", hanging, "Nothing was left open."),
    card(
      "Scorecards, deferred, usage",
      [
        ...usageLines(input),
        `- Behind this summary: ${behind.length === 0 ? "no 4h updates" : `${behind.length} update(s) at ${behind.join(", ")} UTC`}.`,
      ],
      "",
    ),
    card(
      "Doesn't add up",
      [
        ...mismatchLines(v),
        ...(failedCitations > 0
          ? [`- ${failedCitations} scribe note(s) failed their citation check and were left out.`]
          : []),
      ],
      "Nothing.",
    ),
  ];
  return {
    kind: "daily",
    coversFrom: input.from,
    coversTo: input.to,
    text: `${brief.join("\n\n")}\n\n<!-- DETAIL -->\n\n${detail.join("\n\n")}\n`,
    open: openItems(v),
  };
};

export const buildReport = (input: ReportInput): BuiltReport =>
  input.kind === "daily" ? buildDaily(input) : buildUpdate(input);

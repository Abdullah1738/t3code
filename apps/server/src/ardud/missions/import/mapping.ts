import {
  ApprovalId,
  LaneId,
  MissionId,
  RoleBindingId,
  RuleId,
  SubscriptionId,
  ThreadId,
  WorkItemId,
  type Approval,
  type Lane,
  type Mission,
  type MissionActor,
  type MissionLink,
  type MissionMessage,
  type MissionMessageKind,
  type MissionProvenance,
  type ReadPosition,
  type Role,
  type RoleBinding,
  type Room,
  type RoomKind,
  type Rule,
  type Subscription,
  type WorkItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  coordBodyText,
  HAIKU_XHIGH,
  isLaneActor,
  laneIdFor,
  listSummary,
  messageIdFor,
  missionActorFor,
  OPUS_XHIGH,
  roleIdFor,
  roomIdFor,
  SPECIAL_ROLES,
} from "./coordIds.ts";
import type { CoordActorRow, CrwAwaiting, ImportSources } from "./readers.ts";
import { firstDate } from "./sources.ts";

/**
 * Turns the coord-era sources into mission records. Pure and deterministic:
 * the same sources give the same records (times come from the sources, never
 * from the clock), which is what makes a re-run a no-op.
 */

export interface MessageWithBody {
  readonly message: MissionMessage;
  readonly body: string | null;
}

/** Records the router owns (rooms, messages, subscriptions, read positions). */
export interface RouterImport {
  readonly rooms: ReadonlyArray<Room>;
  readonly messages: ReadonlyArray<MessageWithBody>;
  readonly subscriptions: ReadonlyArray<Subscription>;
  readonly readPositions: ReadonlyArray<ReadPosition>;
}

/** Records the core store owns. */
export interface CoreImport {
  readonly mission: Mission;
  readonly roles: ReadonlyArray<Role>;
  readonly bindings: ReadonlyArray<RoleBinding>;
  readonly lanes: ReadonlyArray<Lane>;
  readonly rules: ReadonlyArray<Rule>;
  readonly workItems: ReadonlyArray<WorkItem>;
  readonly approvals: ReadonlyArray<Approval>;
}

export interface SourceCounts {
  readonly coordActors: number;
  readonly coordChannels: number;
  readonly coordMembers: number;
  readonly coordEvents: number;
  readonly coordDeliveries: number;
  readonly coordUnacked: number;
  readonly rules: number;
  readonly deferred: number;
  readonly lanePulseActors: number;
  readonly rosterServices: number;
  readonly rosterRecovered: number;
  readonly rosterRetired: number;
  readonly crwAwaiting: number;
  readonly crwHolds: number;
}

export interface ImportPlan {
  readonly missionId: MissionId;
  /** Snapshot time: the newest coord event or crw sync, used where a source has no time. */
  readonly asOf: string;
  readonly core: CoreImport;
  readonly router: RouterImport;
  readonly counts: SourceCounts;
  readonly warnings: ReadonlyArray<string>;
}

export interface ImportOptions {
  readonly missionId: string;
  readonly missionTitle?: string;
}

const iso = (unixSeconds: number) => DateTime.formatIso(DateTime.makeUnsafe(unixSeconds * 1000));

const importedFrom = (source: string): MissionProvenance => ({ _tag: "import", source });

const EVENT_KINDS: ReadonlyArray<MissionMessageKind> = [
  "request",
  "decision",
  "status",
  "evidence",
  "blocker",
  "control",
];
const isMessageKind = (kind: string): kind is MissionMessageKind =>
  (EVENT_KINDS as ReadonlyArray<string>).includes(kind);

const ROOM_KINDS: Readonly<Record<string, RoomKind>> = {
  control: "control",
  release: "release",
  arch: "arch",
};

/** Subscriptions default like the router's: a wake member wakes on actionable kinds. */
const WAKE_ON: ReadonlyArray<MissionMessageKind> = ["request", "blocker", "control"];

const TITLE_MAX = 120;
const firstLine = (text: string, fallback: string) => {
  const line = text.split("\n")[0]!.trim();
  if (line.length === 0) return fallback;
  return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`;
};

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/ses_[a-z0-9]+/gi, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "") || "lane";

const PR_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const TICKET_RE = /^CRP-(\d+)$/i;
const DEFERRED_RE = /^DF-\d+$/;

/** Links for a coord work id: a ticket key or a full `owner/repo#n` pull request. */
export const workLinks = (workId: string | null): Array<MissionLink> => {
  if (workId === null) return [];
  const pr = PR_RE.exec(workId);
  if (pr !== null) {
    return [
      {
        kind: "pull-request",
        label: workId,
        url: `https://github.com/${pr[1]}/${pr[2]}/pull/${pr[3]}`,
        ref: workId,
      },
    ];
  }
  const ticket = TICKET_RE.exec(workId);
  if (ticket !== null) {
    const key = `CRP-${ticket[1]}`;
    return [{ kind: "ticket", label: key, url: null, ref: key }];
  }
  return [];
};

const prLink = (prKey: string, url: string | null): MissionLink => ({
  kind: "pull-request",
  label: prKey,
  url,
  ref: prKey,
});

// crw's own notion of a finished ticket (lib/review.mjs FINISHED).
const FINISHED_TICKETS = new Set([
  "PR Merged",
  "Canceled",
  "Duplicate",
  "QA Manual Verified",
  "QA Manual Failed",
  "QA Automated Tested",
]);

/** Approval id the crw adapter uses for one review decision: `<mission>:approval:crw:<pr>@<head12>`. */
export const crwApprovalId = (missionId: string, prKey: string, headSha: string | null): string =>
  `${missionId}:approval:crw:${prKey}${headSha ? `@${headSha.slice(0, 12)}` : ""}`;

/**
 * Why an Awaiting Decision thread is stale, or null while it still needs the
 * owner. Mirrors crw's ticketsAway: open PR, repo not excluded, and every live
 * linked ticket still with us.
 */
export const awaitingStaleReason = (
  a: CrwAwaiting,
  config: {
    readonly excludedRepos: ReadonlyArray<string>;
    readonly activeStates: ReadonlyArray<string>;
  },
): string | null => {
  if (a.state !== "OPEN") return `PR is ${a.state.toLowerCase()}`;
  const repo = a.prKey.split("#")[0]!;
  if (config.excludedRepos.includes(repo)) return "repo excluded from crw (excluded_repos)";
  const open = a.tickets.filter((t) => !FINISHED_TICKETS.has(t.state));
  const live = open.length > 0 ? open : a.tickets;
  if (live.length === 0) return "no open linked Linear ticket (closed, merged or unlinked)";
  const away = live.filter((t) => !config.activeStates.includes(t.state));
  if (away.length > 0)
    return `ticket not with us: ${away.map((t) => `${t.id} ${t.state}`).join(", ")}`;
  return null;
};

export const buildImportPlan = (sources: ImportSources, options: ImportOptions): ImportPlan => {
  const m = MissionId.make(options.missionId);
  const warnings: Array<string> = [...sources.rules.warnings, ...sources.deferred.warnings];
  const { coord, pulse, roster } = sources;

  const newestEvent = coord.events.reduce((max, e) => Math.max(max, e.created_at), 0);
  const asOfSeconds = Math.max(newestEvent, sources.crw?.syncedAt ?? 0);
  const asOf = asOfSeconds > 0 ? iso(asOfSeconds) : "1970-01-01T00:00:00.000Z";
  const firstChannel = coord.channels.reduce((min, c) => Math.min(min, c.created_at), asOfSeconds);
  const missionCreatedAt = iso(firstChannel);

  const actorRows = new Map<string, CoordActorRow>(coord.actors.map((a) => [a.id, a]));
  const actorOf = (id: string): MissionActor => missionActorFor(m, actorRows.get(id), id);

  // ---- lanes and roles --------------------------------------------------
  const haiku = new Set(pulse.haiku);
  const serviceOf = new Map<string, { service: string; state: string }>();
  for (const s of roster.services)
    for (const a of s.actors) if (!serviceOf.has(a)) serviceOf.set(a, s);

  const lastSent = new Map<string, number>();
  for (const e of coord.events)
    lastSent.set(e.sender, Math.max(lastSent.get(e.sender) ?? 0, e.created_at));

  const laneActors = new Set<string>();
  for (const a of coord.actors) if (a.kind === "thread" && isLaneActor(a.id)) laneActors.add(a.id);
  for (const a of [...pulse.haiku, ...pulse.opus, ...Object.keys(pulse.active)]) {
    if (isLaneActor(a) && (actorRows.get(a)?.kind ?? "thread") === "thread") laneActors.add(a);
  }
  for (const s of Object.keys(SPECIAL_ROLES) as Array<keyof typeof SPECIAL_ROLES>) {
    // arch-author shares the arch thread; its lane exists only when coord knows the author.
    const lane = SPECIAL_ROLES[s].laneActor;
    if (lane !== null && actorRows.has(s)) laneActors.add(lane);
  }

  const lanes: Array<Lane> = [];
  const roles: Array<Role> = [];
  const bindings: Array<RoleBinding> = [];

  const bind = (roleId: Role["id"], actor: string) => {
    const row = actorRows.get(actor);
    if (row?.thread_id == null) return;
    const boundAt = iso(row.updated_at);
    bindings.push({
      id: RoleBindingId.make(`${roleId}@${row.thread_id}@${boundAt}`),
      roleId,
      threadId: ThreadId.make(row.thread_id),
      reason: "import",
      handoffNote: null,
      observedModel: null,
      boundAt,
      endedAt: null,
    });
  };

  for (const actor of [...laneActors].sort()) {
    const laneId = laneIdFor(m, actor);
    const roleId = roleIdFor(m, actor);
    const row = actorRows.get(actor);
    const service = serviceOf.get(actor);
    const active = pulse.active[actor];
    const standby = active?.startsWith("STANDBY") ?? false;
    const created =
      row === undefined
        ? asOf
        : iso(Math.min(row.updated_at, lastSent.get(actor) ?? row.updated_at));
    const sent = lastSent.get(actor);
    lanes.push({
      id: laneId,
      missionId: m,
      subMissionId: null,
      name: service === undefined ? actor : `${actor} (${service.service})`,
      purpose:
        active ??
        (service === undefined ? `coord actor ${actor}` : `${service.service}: ${service.state}`),
      status: active === undefined ? "idle" : standby ? "waiting" : "working",
      statusReason: standby ? active! : null,
      leadRoleId: roleId,
      threadId: row?.thread_id == null ? null : ThreadId.make(row.thread_id),
      currentItemId: null,
      lastEvidence: null,
      context: null,
      lastActiveAt: sent === undefined ? null : iso(sent),
      createdAt: created,
      updatedAt: asOf,
    });
    if (row === undefined)
      warnings.push(`lane-pulse lists ${actor}, which coord.db does not know; lane has no thread`);
    roles.push({
      id: roleId,
      missionId: m,
      kind: "lane-lead",
      name: actor,
      description: `Lead of lane ${actor}${service === undefined ? "" : ` (${service.service})`}, imported from coord.`,
      modelSelection: haiku.has(actor) ? HAIKU_XHIGH : OPUS_XHIGH,
      pendingModelSelection: null,
      laneId,
      writesPublicText: true,
      lockedFields: [],
      createdAt: created,
      updatedAt: asOf,
    });
    bind(roleId, actor);
  }

  for (const actor of Object.keys(SPECIAL_ROLES) as Array<keyof typeof SPECIAL_ROLES>) {
    const spec = SPECIAL_ROLES[actor];
    const row = actorRows.get(actor);
    if (row === undefined && actor !== "master") continue;
    const roleId = roleIdFor(m, actor);
    roles.push({
      id: roleId,
      missionId: m,
      kind: spec.kind,
      name: spec.name,
      description:
        actor === "master"
          ? "Owns priorities, product decisions and the critical path. One per mission."
          : `Imported coord actor ${actor}.`,
      modelSelection: haiku.has(actor) ? HAIKU_XHIGH : OPUS_XHIGH,
      pendingModelSelection: null,
      laneId: spec.laneActor === null ? null : laneIdFor(m, spec.laneActor),
      writesPublicText: true,
      lockedFields: [],
      createdAt: row === undefined ? missionCreatedAt : iso(row.updated_at),
      updatedAt: asOf,
    });
    bind(roleId, actor);
  }

  const rosterLane = (
    group: "backfill" | "retired",
    r: { lane: string; started: string; owner: string; state: string; line: number },
  ): Lane => {
    const at = firstDate(r.started) ?? asOf;
    return {
      id: LaneId.make(`${m}:lane:${group}:${slug(r.lane)}`),
      missionId: m,
      subMissionId: null,
      name: firstLine(r.lane, `Roster line ${r.line}`),
      purpose: group === "backfill" ? r.started : `Retired ${r.started}`,
      status: group === "backfill" ? "parked" : "retired",
      statusReason:
        group === "backfill"
          ? [r.owner && `Owner today: ${r.owner}.`, r.state && `State at backfill: ${r.state}`]
              .filter(Boolean)
              .join(" ") || null
          : r.state || null,
      leadRoleId: null,
      threadId: null,
      currentItemId: null,
      lastEvidence: null,
      context: null,
      lastActiveAt: null,
      createdAt: at,
      updatedAt: asOf,
    };
  };
  const seenLane = new Set(lanes.map((l) => l.id));
  for (const [group, list] of [
    ["backfill", roster.recovered],
    ["retired", roster.retired],
  ] as const) {
    for (const r of list) {
      const lane = rosterLane(group, r);
      if (seenLane.has(lane.id)) {
        warnings.push(
          `LANE-ROSTER.md:${r.line} lane "${lane.name}" duplicates ${lane.id}; skipped`,
        );
        continue;
      }
      seenLane.add(lane.id);
      lanes.push(lane);
    }
  }

  // ---- rooms, messages, subscriptions, read positions --------------------
  const deferredIds = new Set(sources.deferred.items.map((d) => d.id));
  const lastByChannel = new Map<string, { seq: number; at: number }>();
  for (const e of coord.events) lastByChannel.set(e.channel_id, { seq: e.seq, at: e.created_at });

  const rooms: Array<Room> = coord.channels.map((c) => {
    const last = lastByChannel.get(c.id);
    return {
      id: roomIdFor(m, c.id),
      missionId: m,
      subMissionId: null,
      kind: ROOM_KINDS[c.id] ?? "custom",
      title: c.purpose ? `${c.id}: ${c.purpose}` : c.id,
      workItemId: null,
      archived: c.status !== "open",
      lastSeq: last?.seq ?? 0,
      lastMessageAt: last === undefined ? null : iso(last.at),
      noise: null,
      createdAt: iso(c.created_at),
    };
  });
  const channelIds = new Set(coord.channels.map((c) => c.id));

  const recipients = new Map<number, Array<string>>();
  for (const d of coord.deliveries) {
    const list = recipients.get(d.event_seq);
    if (list === undefined) recipients.set(d.event_seq, [d.recipient]);
    else list.push(d.recipient);
  }

  const messages: Array<MessageWithBody> = [];
  for (const e of coord.events) {
    if (!isMessageKind(e.kind)) {
      warnings.push(`coord event ${e.seq} has kind ${e.kind}; skipped`);
      continue;
    }
    if (!channelIds.has(e.channel_id)) {
      warnings.push(`coord event ${e.seq} is on unknown channel ${e.channel_id}; skipped`);
      continue;
    }
    const body = coordBodyText(e.summary, e.body_json);
    messages.push({
      message: {
        id: messageIdFor(m, e.seq),
        missionId: m,
        roomId: roomIdFor(m, e.channel_id),
        seq: e.seq,
        kind: e.kind,
        author: actorOf(e.sender),
        provenance: importedFrom("coord.db"),
        to: (recipients.get(e.seq) ?? []).map(actorOf),
        summary: listSummary(e.summary).text,
        hasBody: body !== null,
        key: e.event_key,
        workItemId:
          e.work_id !== null && DEFERRED_RE.test(e.work_id) && deferredIds.has(e.work_id)
            ? WorkItemId.make(`${m}:deferred:${e.work_id}`)
            : null,
        links: workLinks(e.work_id),
        receipt: null,
        isCorrection: false,
        createdAt: iso(e.created_at),
        coord: {
          channel: e.channel_id,
          sender: e.sender,
          bodyHash: e.body_hash,
          workId: e.work_id,
          environment: e.environment,
          expectedRevision: e.expected_revision,
          authorityRef: e.authority_ref,
          replyTo: e.reply_to,
        },
      },
      body,
    });
  }

  const subscriptions: Array<Subscription> = coord.members
    .filter((mb) => channelIds.has(mb.channel_id))
    .map((mb) => {
      const row = actorRows.get(mb.actor_id);
      // Pull-only process actors (crw) never get rung, whatever the member row says.
      const wake = mb.wake === 1 && row?.kind === "thread";
      const channel = coord.channels.find((c) => c.id === mb.channel_id)!;
      return {
        id: SubscriptionId.make(`${roomIdFor(m, mb.channel_id)}:sub:${mb.actor_id}`),
        roomId: roomIdFor(m, mb.channel_id),
        subscriber: actorOf(mb.actor_id),
        mode: wake ? "wake" : "read",
        wakeOn: wake ? [...WAKE_ON] : [],
        createdAt: iso(channel.created_at),
      };
    });

  // Read position = cumulative ack: the highest seq with every earlier delivery acked.
  const channelOfSeq = new Map(coord.events.map((e) => [e.seq, e.channel_id]));
  const eventAt = new Map(coord.events.map((e) => [e.seq, e.created_at]));
  const perReader = new Map<
    string,
    { channel: string; reader: string; seq: number; at: number; blocked: boolean }
  >();
  let unacked = 0;
  for (const d of coord.deliveries) {
    if (d.status !== "acked") unacked++;
    const channel = channelOfSeq.get(d.event_seq);
    if (channel === undefined) continue;
    const key = `${channel}\u0000${d.recipient}`;
    const cur = perReader.get(key) ?? {
      channel,
      reader: d.recipient,
      seq: 0,
      at: 0,
      blocked: false,
    };
    if (!cur.blocked) {
      if (d.status === "acked") {
        cur.seq = d.event_seq;
        cur.at = Math.max(cur.at, d.acked_at ?? eventAt.get(d.event_seq) ?? 0);
      } else {
        cur.blocked = true;
      }
    }
    perReader.set(key, cur);
  }
  const readPositions: Array<ReadPosition> = [...perReader.values()]
    .filter((p) => p.seq > 0)
    .map((p) => ({
      roomId: roomIdFor(m, p.channel),
      reader: actorOf(p.reader),
      seq: p.seq,
      updatedAt: iso(p.at),
    }));

  // ---- rules ------------------------------------------------------------
  const rules: Array<Rule> = sources.rules.rules.map((r) => {
    const quotedAt = r.quotedAt ?? missionCreatedAt;
    return {
      id: RuleId.make(`${m}:rule:${r.number}`),
      missionId: m,
      number: r.number,
      title: r.title,
      quote: r.quote,
      quotedAt,
      provenance: importedFrom(r.source),
      masterReading: r.masterReading,
      scope: { subMissionIds: [], roleKinds: [], laneIds: [] },
      activation: "",
      status: r.status,
      version: 1,
      acks: [],
      appliedCount: 0,
      brokenCount: 0,
      lastReliedAt: null,
      lockedFields: [],
      createdAt: quotedAt,
      updatedAt: quotedAt,
    };
  });

  // ---- deferred register -> work items ------------------------------------
  const workItems: Array<WorkItem> = sources.deferred.items.map((d) => {
    const at = firstDate(d.deferredBy) ?? firstDate(d.what) ?? asOf;
    const finished = d.status === "done" || d.status === "closed";
    return {
      id: WorkItemId.make(`${m}:deferred:${d.id}`),
      missionId: m,
      subMissionId: null,
      laneId: null,
      milestoneId: null,
      title: `${d.id}: ${firstLine(d.what, "(no description)")}`,
      kind: "other",
      stage: finished ? "done" : "ticket",
      heldBy: null,
      blockedBy: [],
      dependsOn: [],
      pullRequest: null,
      links: [],
      facts: { mergedAtHead: null, deployedReadback: null, exercised: null },
      createdAt: at,
      updatedAt: at,
      deferral: {
        registerId: d.id,
        status: d.status,
        what: d.what,
        deferredBy: d.deferredBy,
        why: d.why,
        trigger: d.trigger,
        source: d.source,
        notes: [...d.notes],
      },
    };
  });

  // ---- crw approvals -----------------------------------------------------
  const approvals: Array<Approval> = [];
  if (sources.crw !== null) {
    const crw = sources.crw;
    const decidedAt = iso(crw.syncedAt || asOfSeconds);
    for (const a of crw.awaiting) {
      const stale = awaitingStaleReason(a, crw.config);
      const tickets = a.tickets.map((t) => `${t.id} ${t.state}`).join(", ") || "none";
      approvals.push({
        // Same id the crw adapter opens (`<pr>@<head12>`), so its later open of this head
        // settles as already open instead of creating a duplicate.
        id: ApprovalId.make(crwApprovalId(m, a.prKey, a.headSha)),
        missionId: m,
        kind: "other",
        title: `Review decision: ${a.prKey} ${firstLine(a.title, "")}`.trim(),
        detail: [
          `crw review thread is Awaiting Decision${a.awaitingSince === null ? "" : ` since ${iso(a.awaitingSince)}`}.`,
          `Author ${a.author ?? "unknown"}, head ${a.headSha ?? "unknown"}, tickets: ${tickets}.`,
          "Approve by replying Approved in the review thread.",
        ].join("\n"),
        requestedBy: "crw",
        links: [prLink(a.prKey, a.url)],
        status: stale === null ? "pending" : "stale-closed",
        staleReason: stale,
        decidedBy: stale === null ? null : importedFrom("crw.db"),
        decidedAt: stale === null ? null : decidedAt,
        createdAt: a.awaitingSince === null ? decidedAt : iso(a.awaitingSince),
      });
    }
    for (const h of crw.holds) {
      const open = h.state === "OPEN";
      approvals.push({
        id: ApprovalId.make(`${m}:approval:crw-hold:${h.prKey}`),
        missionId: m,
        kind: "merge",
        title: `Lift crw hold: ${h.prKey}${h.title ? ` ${firstLine(h.title, "")}` : ""}`.trim(),
        detail: `crw hold reason: ${h.reason}\nLift with crw release ${h.prKey}.`,
        requestedBy: "crw",
        links: [prLink(h.prKey, h.url)],
        status: open ? "pending" : "stale-closed",
        staleReason: open ? null : `PR is ${(h.state ?? "unknown").toLowerCase()}`,
        decidedBy: open ? null : importedFrom("crw.db"),
        decidedAt: open ? null : decidedAt,
        createdAt: iso(h.createdAt),
      });
    }
  }

  const mission: Mission = {
    id: m,
    slug: m,
    title: options.missionTitle ?? "Crpko",
    goal: "Imported from coord: the Crpko delivery lanes, their rooms, rules and deferred work.",
    status: "active",
    tier: "P0",
    weight: 1,
    guaranteedShare: 0,
    borrowCeiling: 1,
    projectId: null,
    masterRoleId: roleIdFor(m, "master"),
    focusSubMissionId: null,
    health: "unknown",
    lockedFields: [],
    createdAt: missionCreatedAt,
    updatedAt: missionCreatedAt,
  };

  return {
    missionId: m,
    asOf,
    core: { mission, roles, bindings, lanes, rules, workItems, approvals },
    router: { rooms, messages, subscriptions, readPositions },
    counts: {
      coordActors: coord.actors.length,
      coordChannels: coord.channels.length,
      coordMembers: coord.members.length,
      coordEvents: coord.events.length,
      coordDeliveries: coord.deliveries.length,
      coordUnacked: unacked,
      rules: sources.rules.rules.length,
      deferred: sources.deferred.items.length,
      lanePulseActors: new Set([...pulse.haiku, ...pulse.opus, ...Object.keys(pulse.active)]).size,
      rosterServices: roster.services.length,
      rosterRecovered: roster.recovered.length,
      rosterRetired: roster.retired.length,
      crwAwaiting: sources.crw?.awaiting.length ?? 0,
      crwHolds: sources.crw?.holds.length ?? 0,
    },
    warnings,
  };
};

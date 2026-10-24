/**
 * The editor pass: an hourly Opus read over the scribe's notes and the mission
 * state. Opus writes the overview bottom line, ranks the FYI notes, picks the
 * "since you last looked" feed and turns scribe candidates into a few
 * suggestions. Code builds what Opus reads and checks everything it writes:
 * only known note ids and record refs survive, suggestions need evidence, are
 * deduped against open and dismissed ones, capped per run and routed to the
 * acceptor by target kind. Suggestions never apply themselves.
 *
 * Pure and type-import only: the proof scripts import it directly.
 */
import type {
  Approval,
  Ask,
  Call,
  Lane,
  Milestone,
  Mission,
  MissionLink,
  MissionRecordKind,
  MissionRecordRef,
  Note,
  Role,
  Rule,
  Suggestion,
  SuggestionTargetKind,
  WorkItem,
} from "@t3tools/contracts";

import type { ScribeCandidate } from "./batch.ts";
import { currentNotes, fyiScore, stableHash } from "./notes.ts";

export const EDITOR_LIMITS = {
  bottomLineWords: 80,
  fyi: 12,
  feed: 15,
  /** New suggestions one pass may open. */
  suggestions: 3,
  /** Open owner-routed suggestions allowed at once; more wait for the next pass. */
  ownerOpen: 5,
  notes: 80,
  candidates: 30,
} as const;

/**
 * Whose inbox a suggestion lands in, by what it changes (plan 1.7 as amended
 * 17 Oct): the master decides its control surface, the owner decides draft
 * notes and rules (his words). Asks has the final say when it stores the
 * suggestion: one about the master's own role goes to the owner as well.
 */
export const ACCEPTOR: Record<SuggestionTargetKind, "owner" | "master"> = {
  rule: "owner",
  "draft-note": "owner",
  "role-model": "master",
  "review-policy": "master",
  "criticality-guide": "master",
  pool: "master",
  schedule: "master",
  "sub-mission-order": "master",
  role: "master",
  lane: "master",
  layout: "owner",
};

/** The record kind a suggestion may point at, per target kind. */
const TARGET_RECORD: Record<SuggestionTargetKind, MissionRecordKind | null> = {
  rule: "rule",
  "role-model": "role",
  role: "role",
  "review-policy": "review-policy",
  "criticality-guide": null,
  pool: "pool",
  schedule: null,
  "sub-mission-order": "mission",
  lane: "lane",
  "draft-note": "draft-note",
  layout: "view-layout",
};

const TARGET_KINDS = new Set(Object.keys(ACCEPTOR));
const FEED_KINDS = new Set(["shipped", "decided", "blocked", "note", "milestone"]);

// --- what the editor reads -------------------------------------------------

export interface EditorItem {
  /** Record ref as `kind:id`. */
  readonly ref: string;
  readonly label: string;
  readonly at: string;
}

export interface EditorNoteView {
  readonly id: string;
  readonly lane: string;
  readonly type: string;
  readonly severity: string;
  readonly confidence: number;
  readonly basis: string;
  readonly evidence: string;
  readonly summary: string;
  readonly quote: string;
  readonly at: string;
}

export interface EditorCandidateView {
  readonly id: string;
  readonly lane: string;
  /** Where the quote sits, as `<threadId>#<event>`. */
  readonly source: string;
  readonly targetKind: string;
  readonly title: string;
  readonly proposal: string;
  readonly why: string;
  readonly quote: string;
}

export interface EditorSuggestionView {
  readonly id: string;
  readonly targetKind: string;
  readonly target: string | null;
  readonly title: string;
  readonly status: string;
  readonly dismissReason: string | null;
}

export interface EditorInput {
  readonly missionId: string;
  readonly missionTitle: string;
  readonly goal: string;
  readonly now: string;
  readonly since: string;
  readonly previousBottomLine: string | null;
  readonly lanes: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly statusReason: string | null;
  }>;
  readonly waitingOnOwner: ReadonlyArray<EditorItem>;
  readonly blocked: ReadonlyArray<EditorItem>;
  readonly shipped: ReadonlyArray<EditorItem>;
  readonly decided: ReadonlyArray<EditorItem>;
  readonly milestones: ReadonlyArray<EditorItem>;
  readonly notes: ReadonlyArray<EditorNoteView>;
  readonly candidates: ReadonlyArray<EditorCandidateView>;
  readonly suggestions: ReadonlyArray<EditorSuggestionView>;
  /** Records a suggestion may target (rules, roles, lanes, the mission itself). */
  readonly targets: ReadonlyArray<EditorItem>;
  readonly ownerOpenSuggestions: number;
  readonly limits: typeof EDITOR_LIMITS;
}

export interface EditorSource {
  readonly mission: Mission;
  readonly now: string;
  readonly since: string;
  readonly previousBottomLine: string | null;
  readonly lanes: ReadonlyArray<Lane>;
  readonly asks: ReadonlyArray<Ask>;
  readonly approvals: ReadonlyArray<Approval>;
  readonly calls: ReadonlyArray<Call>;
  readonly workItems: ReadonlyArray<WorkItem>;
  readonly milestones: ReadonlyArray<Milestone>;
  readonly notes: ReadonlyArray<Note>;
  /** Open, citation-verified scribe candidates. */
  readonly candidates: ReadonlyArray<ScribeCandidate>;
  readonly suggestions: ReadonlyArray<Suggestion>;
  readonly rules: ReadonlyArray<Rule>;
  readonly roles: ReadonlyArray<Role>;
}

const ms = (iso: string) => Date.parse(iso);
const after = (iso: string | null, since: string) => iso !== null && ms(iso) > ms(since);
const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();
const clip = (text: string, max: number) => {
  const line = oneLine(text);
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

const SHIPPED_STAGES = new Set(["readback", "exercised", "done"]);

export const buildEditorInput = (source: EditorSource): EditorInput => {
  const { mission, since } = source;
  const laneName = new Map(source.lanes.map((lane) => [lane.id as string, lane.name]));
  const nameOf = (laneId: string | null) =>
    laneId === null ? "Mission" : (laneName.get(laneId) ?? laneId);

  const waitingOnOwner: EditorItem[] = [
    ...source.asks
      .filter((ask) => ask.status === "open")
      .map((ask) => ({ ref: `ask:${ask.id}`, label: ask.question, at: ask.createdAt })),
    ...source.approvals
      .filter((approval) => approval.status === "pending")
      .map((approval) => ({
        ref: `approval:${approval.id}`,
        label: `Approve ${approval.kind}: ${approval.title}`,
        at: approval.createdAt,
      })),
  ].toSorted((a, b) => a.at.localeCompare(b.at));

  // A note the owner or the master acked was handled; shown again, the editor resurfaces it.
  const masterRoles = new Set<string>([
    ...(mission.masterRoleId === null ? [] : [mission.masterRoleId]),
    ...source.roles.filter((role) => role.kind === "master").map((role) => role.id),
  ]);
  const handled = (note: Note) =>
    note.ackedBy.some(
      (actor) => actor._tag === "owner" || (actor._tag === "role" && masterRoles.has(actor.roleId)),
    );
  const notes = currentNotes(source.notes)
    .filter(
      (note) => note.citation === "verified" && after(note.createdAt, since) && !handled(note),
    )
    .toSorted((a, b) => fyiScore(b) - fyiScore(a) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, EDITOR_LIMITS.notes)
    .map((note) => ({
      id: note.id,
      lane: nameOf(note.laneId),
      type: note.type,
      severity: note.severity,
      confidence: note.confidence,
      basis: note.basis,
      evidence: note.evidence,
      summary: note.summary,
      quote: clip(note.sources[0]?.quote ?? "", 300),
      at: note.createdAt,
    }));

  const suggestions = source.suggestions.filter(
    (suggestion) => suggestion.status === "open" || suggestion.status === "dismissed",
  );

  return {
    missionId: mission.id,
    missionTitle: mission.title,
    goal: mission.goal,
    now: source.now,
    since,
    previousBottomLine: source.previousBottomLine,
    lanes: source.lanes
      .filter((lane) => lane.status !== "retired")
      .map((lane) => ({
        id: lane.id,
        name: lane.name,
        status: lane.status,
        statusReason: lane.statusReason,
      })),
    waitingOnOwner,
    blocked: source.workItems
      .filter((item) => item.stage !== "done" && item.blockedBy.length > 0)
      .map((item) => ({ ref: `work-item:${item.id}`, label: item.title, at: item.updatedAt })),
    shipped: source.workItems
      .filter((item) => SHIPPED_STAGES.has(item.stage) && after(item.updatedAt, since))
      .map((item) => ({ ref: `work-item:${item.id}`, label: item.title, at: item.updatedAt })),
    decided: source.calls
      .filter((call) => after(call.createdAt, since))
      .map((call) => ({
        ref: `call:${call.id}`,
        label: `${call.title}: ${call.decision}`,
        at: call.createdAt,
      })),
    milestones: source.milestones
      .filter((milestone) => milestone.status !== "done")
      .map((milestone) => ({
        ref: `milestone:${milestone.id}`,
        label: `${milestone.title} (${milestone.status}${milestone.targetAt ? `, due ${milestone.targetAt.slice(0, 10)}` : ""})`,
        at: milestone.updatedAt,
      })),
    notes,
    candidates: source.candidates
      .filter((candidate) => candidate.citation === "verified")
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, EDITOR_LIMITS.candidates)
      .map((candidate) => ({
        id: candidate.id,
        lane: nameOf(candidate.laneId),
        source: `${candidate.threadId}#${candidate.event}`,
        targetKind: candidate.targetKind,
        title: candidate.title,
        proposal: candidate.proposal,
        why: candidate.why,
        quote: clip(candidate.quote, 300),
      })),
    suggestions: suggestions.map((suggestion) => ({
      id: suggestion.id,
      targetKind: suggestion.targetKind,
      target:
        suggestion.target === null ? null : `${suggestion.target.kind}:${suggestion.target.id}`,
      title: suggestion.title,
      status: suggestion.status,
      dismissReason: suggestion.dismissReason,
    })),
    targets: [
      {
        ref: `mission:${mission.id}`,
        label: `Mission order: ${mission.title}`,
        at: mission.updatedAt,
      },
      ...source.rules
        .filter((rule) => rule.status === "active")
        .map((rule) => ({
          ref: `rule:${rule.id}`,
          label: `Rule ${rule.number ?? rule.id}: ${rule.title}`,
          at: rule.updatedAt,
        })),
      ...source.roles.map((role) => ({
        ref: `role:${role.id}`,
        label: `${role.name} (${role.kind})`,
        at: role.updatedAt,
      })),
      ...source.lanes
        .filter((lane) => lane.status !== "retired")
        .map((lane) => ({
          ref: `lane:${lane.id}`,
          label: `Lane ${lane.name}`,
          at: lane.updatedAt,
        })),
    ],
    ownerOpenSuggestions: suggestions.filter(
      (suggestion) => suggestion.status === "open" && suggestion.acceptor === "owner",
    ).length,
    limits: EDITOR_LIMITS,
  };
};

// --- what the editor writes ------------------------------------------------

export interface EditorFeedItem {
  readonly kind: "shipped" | "decided" | "blocked" | "note" | "milestone";
  readonly summary: string;
  readonly ref: MissionRecordRef | null;
  readonly at: string;
}

export interface EditorSuggestionDraft {
  readonly id: string;
  readonly targetKind: SuggestionTargetKind;
  readonly target: MissionRecordRef | null;
  readonly title: string;
  readonly after: { readonly change: string };
  readonly diffText: string;
  readonly why: string;
  readonly evidence: ReadonlyArray<MissionRecordRef | MissionLink>;
  readonly acceptor: "owner" | "master";
  readonly candidateIds: ReadonlyArray<string>;
}

export interface EditorPlan {
  readonly bottomLine: string | null;
  readonly fyiOrder: ReadonlyArray<string>;
  readonly feed: ReadonlyArray<EditorFeedItem>;
  readonly suggestions: ReadonlyArray<EditorSuggestionDraft>;
  readonly droppedCandidates: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
  /** What code refused, so the run summary can say why. */
  readonly rejected: ReadonlyArray<string>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const parseRef = (value: unknown): { kind: string; id: string } | null => {
  const text = asString(value);
  const at = text.indexOf(":");
  if (at <= 0 || at === text.length - 1) return null;
  return { kind: text.slice(0, at), id: text.slice(at + 1) };
};

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word.length > 2),
  );

/** Same target and mostly the same words: a repeat of an earlier suggestion. */
const similarTitle = (a: string, b: string) => {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return oneLine(a).toLowerCase() === oneLine(b).toLowerCase();
  let shared = 0;
  for (const word of wa) if (wb.has(word)) shared += 1;
  return shared / Math.min(wa.size, wb.size) >= 0.6;
};

const clipWords = (text: string, max: number) => {
  const parts = oneLine(text).split(" ");
  return parts.length <= max ? parts.join(" ") : `${parts.slice(0, max).join(" ")}…`;
};

export const editorSuggestionId = (input: {
  readonly missionId: string;
  readonly targetKind: string;
  readonly target: string | null;
  readonly title: string;
}) =>
  `sugg-${stableHash(
    [
      input.missionId,
      input.targetKind,
      input.target ?? "",
      oneLine(input.title).toLowerCase(),
    ].join("\n"),
  )}`;

/**
 * Check the editor's reply against what it was shown. Anything that points at
 * a note, record or candidate it wasn't shown is dropped, never stored.
 */
export const checkEditorOutput = (raw: unknown, input: EditorInput): EditorPlan => {
  const reply = asRecord(raw);
  const rejected: string[] = [];

  const bottom = asString(reply.bottomLine);
  const bottomLine = bottom === "" ? null : clipWords(bottom, EDITOR_LIMITS.bottomLineWords + 20);
  if (bottomLine === null) rejected.push("bottom line missing");

  const noteIds = new Set(input.notes.map((note) => note.id));
  const fyiOrder: string[] = [];
  for (const value of asArray(reply.fyiOrder)) {
    const id = asString(value);
    if (!noteIds.has(id)) {
      rejected.push(`fyi: unknown note ${id || "(blank)"}`);
      continue;
    }
    if (!fyiOrder.includes(id) && fyiOrder.length < EDITOR_LIMITS.fyi) fyiOrder.push(id);
  }

  const itemTimes = new Map<string, string>();
  for (const note of input.notes) itemTimes.set(`note:${note.id}`, note.at);
  for (const list of [
    input.shipped,
    input.decided,
    input.blocked,
    input.milestones,
    input.waitingOnOwner,
  ]) {
    for (const item of list) itemTimes.set(item.ref, item.at);
  }
  const feed: EditorFeedItem[] = [];
  const feedRefs = new Set<string>();
  for (const value of asArray(reply.feed)) {
    const item = asRecord(value);
    const kind = asString(item.kind);
    const summary = asString(item.summary);
    const refText = asString(item.ref);
    const ref = parseRef(refText);
    if (!FEED_KINDS.has(kind) || summary === "" || ref === null || !itemTimes.has(refText)) {
      rejected.push(`feed: ${refText || summary || "(blank)"} not shown to the editor`);
      continue;
    }
    if (feedRefs.has(refText) || feed.length >= EDITOR_LIMITS.feed) continue;
    feedRefs.add(refText);
    feed.push({
      kind: kind as EditorFeedItem["kind"],
      summary: clip(summary, 400),
      ref: { kind: ref.kind as MissionRecordKind, id: ref.id },
      at: itemTimes.get(refText) ?? input.now,
    });
  }
  feed.sort((a, b) => b.at.localeCompare(a.at));

  const candidates = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const targetRefs = new Set(input.targets.map((item) => item.ref));
  const dropped = new Map<string, string>();
  const used = new Set<string>();
  const suggestions: EditorSuggestionDraft[] = [];
  let ownerOpen = input.ownerOpenSuggestions;

  for (const value of asArray(reply.suggestions)) {
    const item = asRecord(value);
    const targetKind = asString(item.targetKind);
    const title = clip(asString(item.title), 200);
    const change = asString(item.change);
    const why = asString(item.why);
    if (!TARGET_KINDS.has(targetKind) || title === "" || change === "" || why === "") {
      rejected.push(`suggestion: ${title || "(untitled)"} is missing target kind, change or why`);
      continue;
    }
    const kind = targetKind as SuggestionTargetKind;
    const parsedTarget = parseRef(item.target);
    // A target must be a record the editor was shown, of the kind this change touches;
    // anything else becomes a targetless suggestion (e.g. a new rule).
    const target =
      parsedTarget !== null &&
      parsedTarget.kind === TARGET_RECORD[kind] &&
      targetRefs.has(`${parsedTarget.kind}:${parsedTarget.id}`)
        ? { kind: parsedTarget.kind as MissionRecordKind, id: parsedTarget.id }
        : null;
    const targetText = target === null ? null : `${target.kind}:${target.id}`;

    const fromCandidates = asArray(item.fromCandidates)
      .map(asString)
      .filter((id) => candidates.has(id) && !used.has(id));
    const fromNotes = asArray(item.evidenceNoteIds)
      .map(asString)
      .filter((id) => noteIds.has(id));
    if (fromCandidates.length === 0 && fromNotes.length === 0) {
      rejected.push(`suggestion: ${title} cites no candidate or note it was shown`);
      continue;
    }

    const repeat = [
      ...input.suggestions.map((s) => ({ ...s, source: s.status })),
      ...suggestions.map((s) => ({
        targetKind: s.targetKind as string,
        target: s.target === null ? null : `${s.target.kind}:${s.target.id}`,
        title: s.title,
        source: "this pass",
      })),
    ].find(
      (other) =>
        other.targetKind === kind &&
        other.target === targetText &&
        similarTitle(other.title, title),
    );
    if (repeat !== undefined) {
      rejected.push(`suggestion: ${title} repeats a ${repeat.source} suggestion`);
      for (const id of fromCandidates) dropped.set(id, `repeats a ${repeat.source} suggestion`);
      continue;
    }
    if (suggestions.length >= EDITOR_LIMITS.suggestions) {
      rejected.push(`suggestion: ${title} over the per-pass cap`);
      continue;
    }
    const acceptor = ACCEPTOR[kind];
    if (acceptor === "owner" && ownerOpen >= EDITOR_LIMITS.ownerOpen) {
      rejected.push(`suggestion: ${title} waits, owner already has ${ownerOpen} open`);
      continue;
    }
    if (acceptor === "owner") ownerOpen += 1;

    for (const id of fromCandidates) used.add(id);
    const evidence: Array<MissionRecordRef | MissionLink> = [
      ...fromNotes.map((id) => ({ kind: "note" as const, id })),
      ...fromCandidates.map((id) => ({
        kind: "transcript" as const,
        label: clip(candidates.get(id)?.quote ?? id, 200),
        url: null,
        ref: candidates.get(id)?.source ?? id,
      })),
    ];
    suggestions.push({
      id: editorSuggestionId({
        missionId: input.missionId,
        targetKind: kind,
        target: targetText,
        title,
      }),
      targetKind: kind,
      target,
      title,
      after: { change },
      diffText: asString(item.diffText) || change,
      why,
      evidence,
      acceptor,
      candidateIds: fromCandidates,
    });
  }

  for (const value of asArray(reply.dropCandidates)) {
    const item = asRecord(value);
    const id = asString(item.id);
    if (!candidates.has(id) || used.has(id)) continue;
    dropped.set(id, asString(item.reason) || "editor dropped it");
  }

  return {
    bottomLine,
    fyiOrder,
    feed,
    suggestions,
    droppedCandidates: [...dropped].map(([id, reason]) => ({ id, reason })),
    rejected,
  };
};

// --- what the editor leaves behind -------------------------------------------

/** The stored result of the last editor pass (kept in the scribe's editor table). */
export interface EditorState {
  readonly bottomLine: string | null;
  /** When the bottom line was written; a pass that failed to write one keeps the old one. */
  readonly bottomLineAt: string | null;
  readonly fyiOrder: ReadonlyArray<string>;
  readonly feed: ReadonlyArray<EditorFeedItem>;
  readonly since: string | null;
  readonly model: string | null;
  readonly rejected: ReadonlyArray<string>;
}

/** Read a stored editor payload defensively; older or partial rows read as empty fields. */
export const readEditorState = (payload: unknown): EditorState => {
  const value = asRecord(payload);
  const bottom = asString(value.bottomLine);
  const feed: EditorFeedItem[] = [];
  for (const raw of asArray(value.feed)) {
    const item = asRecord(raw);
    const ref = asRecord(item.ref);
    const kind = asString(item.kind);
    if (!FEED_KINDS.has(kind) || asString(item.summary) === "") continue;
    feed.push({
      kind: kind as EditorFeedItem["kind"],
      summary: asString(item.summary),
      ref:
        asString(ref.kind) === "" || asString(ref.id) === ""
          ? null
          : { kind: asString(ref.kind) as MissionRecordKind, id: asString(ref.id) },
      at: asString(item.at),
    });
  }
  const text = (field: unknown) => (asString(field) === "" ? null : asString(field));
  return {
    bottomLine: bottom === "" ? null : bottom,
    bottomLineAt: text(value.bottomLineAt),
    fyiOrder: asArray(value.fyiOrder)
      .map(asString)
      .filter((id) => id !== ""),
    feed,
    since: text(value.since),
    model: text(value.model),
    rejected: asArray(value.rejected)
      .map(asString)
      .filter((line) => line !== ""),
  };
};

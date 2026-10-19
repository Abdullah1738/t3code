import {
  MissionError,
  type MissionActor,
  type MissionErrorCode,
  type MissionEventKind,
  type MissionProvenance,
  type MissionRecordRef,
  type OwnerRequestId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

/**
 * An event a transition wants appended. The store assigns id, seq and time,
 * and commits it in the same transaction as the record.
 */
export interface MissionEventDraft {
  readonly kind: MissionEventKind;
  readonly actor: MissionActor;
  readonly provenance: MissionProvenance;
  readonly summary: string;
  readonly subject: MissionRecordRef | null;
  readonly payload: unknown;
}

/** The record a command produced plus the events that explain it. */
export interface Transition<R> {
  readonly record: R;
  readonly events: ReadonlyArray<MissionEventDraft>;
}

export type Outcome<A> = Result.Result<A, MissionError>;

export const refuse = (code: MissionErrorCode, detail: string): Outcome<never> =>
  Result.fail(new MissionError({ code, detail }));

export const ok = <A>(value: A): Outcome<A> => Result.succeed(value);

const SUMMARY_LIMIT = 400;

/** Event summaries are bounded by the contract; keep them on one line too. */
export const clipSummary = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length === 0) return "(empty)";
  return line.length <= SUMMARY_LIMIT ? line : `${line.slice(0, SUMMARY_LIMIT - 1)}…`;
};

export const recordKey = (ref: Pick<MissionRecordRef, "kind" | "id">): string =>
  `${ref.kind}:${ref.id}`;

export const sameRef = (
  left: Pick<MissionRecordRef, "kind" | "id">,
  right: Pick<MissionRecordRef, "kind" | "id">,
): boolean => left.kind === right.kind && left.id === right.id;

export const dedupeRefs = (refs: ReadonlyArray<MissionRecordRef>): MissionRecordRef[] => {
  const seen = new Set<string>();
  const out: MissionRecordRef[] = [];
  for (const ref of refs) {
    const key = recordKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
};

/** The actor a provenance speaks for, used on events. */
export const actorOf = (provenance: MissionProvenance): MissionActor => {
  switch (provenance._tag) {
    case "owner-app":
    case "owner-imessage":
      return { _tag: "owner" };
    case "agent":
      return provenance.roleId === null
        ? { _tag: "thread", threadId: provenance.threadId }
        : { _tag: "role", roleId: provenance.roleId };
    case "system":
      return { _tag: "system", component: provenance.component };
    case "import":
      return { _tag: "system", component: `import:${provenance.source}` };
  }
};

export const sameActor = (left: MissionActor, right: MissionActor): boolean => {
  switch (left._tag) {
    case "owner":
      return right._tag === "owner";
    case "role":
      return right._tag === "role" && right.roleId === left.roleId;
    case "lane":
      return right._tag === "lane" && right.laneId === left.laneId;
    case "thread":
      return right._tag === "thread" && right.threadId === left.threadId;
    case "system":
      return right._tag === "system" && right.component === left.component;
    case "person":
      return right._tag === "person" && right.name === left.name;
  }
};

/**
 * Who is issuing a command. `provenance` comes from the transport, never from
 * input; `actors` are every identity the caller holds in the mission (its
 * thread, roles and lanes, or `owner`).
 */
export interface MissionCaller {
  readonly provenance: MissionProvenance;
  readonly actors: ReadonlyArray<MissionActor>;
}

export const callerIsOwner = (caller: MissionCaller): boolean =>
  caller.provenance._tag === "owner-app" || caller.provenance._tag === "owner-imessage";

export const callerActsAs = (caller: MissionCaller, actor: MissionActor): boolean =>
  (actor._tag === "owner" && callerIsOwner(caller)) ||
  caller.actors.some((held) => sameActor(held, actor));

/** Adds an owner request to a record's spent ones (decided an earlier epoch). */
export const spendCondition = (
  spent: ReadonlyArray<OwnerRequestId> | undefined,
  requestId: OwnerRequestId,
): ReadonlyArray<OwnerRequestId> =>
  (spent ?? []).includes(requestId) ? (spent ?? []) : [...(spent ?? []), requestId];

/** Lowercase, fold Unicode, drop punctuation and repeated spaces (for matching, never storage). */
export const normalizeText = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

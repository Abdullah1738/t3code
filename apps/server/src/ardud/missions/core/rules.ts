import {
  isOwnerProvenance,
  MissionError,
  type MissionProvenance,
  type MissionRecordRef,
} from "@t3tools/contracts";

/**
 * Write rules shared by every core mutation.
 *
 * - The owner overrides everything, locks included.
 * - A locked field is owner only for everyone else, the server included.
 * - Owner-only fields (tier, weight, shares, mission status, focus, sub-mission
 *   pause) refuse agents. Server components (`system`) and imports may set them;
 *   they are not agents acting on their own judgement.
 */

/** Virtual mission field: once locked, only the owner reorders sub-missions. */
export const SUB_MISSION_ORDER_FIELD = "subMissionOrder";

/** Never lockable: identity and bookkeeping. */
const UNLOCKABLE_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "missionId",
  "createdAt",
  "updatedAt",
  "lockedFields",
]);

/** Fields that never count as a change when comparing two versions. */
const BOOKKEEPING_FIELDS: ReadonlySet<string> = new Set(["updatedAt", "lockedFields"]);

export const isAgentProvenance = (provenance: MissionProvenance): boolean =>
  provenance._tag === "agent";

export const sameValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!sameValue(a[key], b[key])) return false;
  }
  return true;
};

/** Top-level fields whose values differ, ignoring bookkeeping. */
export const changedFields = (before: object, after: object): ReadonlyArray<string> => {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => !BOOKKEEPING_FIELDS.has(key) && !sameValue(a[key], b[key]));
};

export interface WriteCheck {
  readonly provenance: MissionProvenance;
  readonly ref: MissionRecordRef;
  readonly lockedFields: ReadonlyArray<string> | undefined;
  readonly changed: ReadonlyArray<string>;
  /** Fields agents may never change on this record. */
  readonly ownerOnly?: ReadonlyArray<string>;
}

const describe = (ref: MissionRecordRef) => `${ref.kind} ${ref.label ?? ref.id}`;

/** `null` when the write may go ahead. */
export const checkWrite = (check: WriteCheck): MissionError | null => {
  if (isOwnerProvenance(check.provenance)) return null;
  const locked = check.changed.filter((field) => check.lockedFields?.includes(field) ?? false);
  if (locked.length > 0) {
    return new MissionError({
      code: "locked",
      detail: `The owner locked ${locked.join(", ")} on ${describe(check.ref)}.`,
    });
  }
  if (isAgentProvenance(check.provenance)) {
    const ownerOnly = check.changed.filter((field) => check.ownerOnly?.includes(field) ?? false);
    if (ownerOnly.length > 0) {
      return new MissionError({
        code: "forbidden",
        detail: `Only the owner changes ${ownerOnly.join(", ")} on ${describe(check.ref)}.`,
      });
    }
  }
  return null;
};

/** Rejects anything but owner provenance. */
export const requireOwner = (provenance: MissionProvenance, action: string): MissionError | null =>
  isOwnerProvenance(provenance)
    ? null
    : new MissionError({ code: "forbidden", detail: `Only the owner can ${action}.` });

/** Rejects agents; the owner, server components and imports pass. */
export const refuseAgents = (provenance: MissionProvenance, action: string): MissionError | null =>
  isAgentProvenance(provenance)
    ? new MissionError({ code: "forbidden", detail: `Only the owner can ${action}.` })
    : null;

/** Whether `field` may be locked on a record shaped like `record`. */
export const isLockableField = (kind: string, record: object, field: string): boolean => {
  if (UNLOCKABLE_FIELDS.has(field)) return false;
  if (kind === "mission" && field === SUB_MISSION_ORDER_FIELD) return true;
  return Object.hasOwn(record, field);
};

export const withLock = (
  lockedFields: ReadonlyArray<string> | undefined,
  field: string,
  locked: boolean,
): ReadonlyArray<string> => {
  const current = lockedFields ?? [];
  if (locked) return current.includes(field) ? current : [...current, field];
  return current.filter((entry) => entry !== field);
};

import { isOwnerProvenance, MissionError, type MissionProvenance } from "@t3tools/contracts";

/**
 * Write rules shared by core mutations.
 *
 * Owner rule (17 Oct 2026): nothing is owner only and nothing is locked. The
 * mission's master may change anything the owner can, through the same
 * service methods; each change is a timeline event with actor and provenance
 * so the owner sees who changed what. `lockedFields` stays on records for
 * compatibility and nothing refuses on it.
 *
 * What stays the owner's is about who he is, not what may be controlled:
 * marking a mission seen (his last look) and, in asks, answering asks
 * addressed to him.
 */

/** Fields that never count as a change when comparing two versions. */
const BOOKKEEPING_FIELDS: ReadonlySet<string> = new Set(["updatedAt", "lockedFields"]);

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

/** Rejects anything but owner provenance. For acts that are the owner's by definition. */
export const requireOwner = (provenance: MissionProvenance, action: string): MissionError | null =>
  isOwnerProvenance(provenance)
    ? null
    : new MissionError({ code: "forbidden", detail: `Only the owner can ${action}.` });

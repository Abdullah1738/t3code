import type { MissionActor, MissionRecordRef } from "@t3tools/contracts";

import type { FieldChange, MissionTimelineEvent } from "./source.ts";
import { actorLabel } from "./viewModel.ts";

// Who changed what, read from the event log. Nothing in Missions is locked:
// the owner and the master change the same fields through the same methods,
// and the screens say who changed a value last.

type ChangeEvent = Pick<
  MissionTimelineEvent,
  "id" | "seq" | "actor" | "subject" | "payload" | "at"
>;

/** Field names an event says it changed (`payload.changed`, the core write convention). */
export function changedFields(payload: unknown): ReadonlyArray<string> {
  if (typeof payload !== "object" || payload === null || !("changed" in payload)) return [];
  const changed = (payload as { readonly changed: unknown }).changed;
  return Array.isArray(changed) ? changed.filter((f): f is string => typeof f === "string") : [];
}

const changeKey = (ref: Pick<MissionRecordRef, "kind" | "id">, field: string) =>
  `${ref.kind}:${ref.id}:${field}`;

/** The newest change per record field. Events can come in any order; `seq` decides. */
export function latestFieldChanges(events: ReadonlyArray<ChangeEvent>): FieldChange[] {
  const latest = new Map<string, { seq: number; change: FieldChange }>();
  for (const event of events) {
    if (event.subject === null) continue;
    for (const field of changedFields(event.payload)) {
      const key = changeKey(event.subject, field);
      const seen = latest.get(key);
      if (seen && seen.seq >= event.seq) continue;
      latest.set(key, {
        seq: event.seq,
        change: {
          ref: { kind: event.subject.kind, id: event.subject.id },
          field,
          actor: event.actor,
          eventId: event.id,
          at: event.at,
        },
      });
    }
  }
  return [...latest.values()].map((entry) => entry.change);
}

/** Indexes changes for repeated lookups on one screen. */
export function changeIndex(
  changes: ReadonlyArray<FieldChange>,
): (ref: Pick<MissionRecordRef, "kind" | "id">, field: string) => FieldChange | null {
  const byKey = new Map(changes.map((change) => [changeKey(change.ref, change.field), change]));
  return (ref, field) => byKey.get(changeKey(ref, field)) ?? null;
}

/** Newest change among several fields of one record (e.g. any field of a rule). */
export function newestChange(
  changes: ReadonlyArray<FieldChange>,
  ref: Pick<MissionRecordRef, "kind" | "id">,
  fields?: ReadonlyArray<string>,
): FieldChange | null {
  let newest: FieldChange | null = null;
  for (const change of changes) {
    if (change.ref.kind !== ref.kind || change.ref.id !== ref.id) continue;
    if (fields && !fields.includes(change.field)) continue;
    if (!newest || change.at > newest.at) newest = change;
  }
  return newest;
}

/** "you", "master", a lane or a person: who made the change. */
export function changedBy(
  change: Pick<FieldChange, "actor"> | null,
  masterRoleId: string | null,
): string | null {
  return change ? actorLabel(change.actor, masterRoleId) : null;
}

/** "last changed by you", or `null` when nothing in the log touched the field. */
export function lastChangedLine(
  change: Pick<FieldChange, "actor"> | null,
  masterRoleId: string | null,
): string | null {
  const who = changedBy(change, masterRoleId);
  return who === null ? null : `last changed by ${who}`;
}

export function isOwnerChange(change: { readonly actor: MissionActor } | null): boolean {
  return change?.actor._tag === "owner";
}

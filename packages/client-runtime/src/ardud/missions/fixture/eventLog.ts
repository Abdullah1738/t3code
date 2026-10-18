import type { MissionProvenance, MissionRecordRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { MissionTimelineEvent } from "../source.ts";
import { CRPKO } from "./data.ts";
import { events as seedEvents } from "./opsData.ts";
import { TimelineEventSeed } from "./schemas.ts";
import { clampSummary } from "./util.ts";

const decodeEvents = Schema.decodeUnknownSync(Schema.Array(TimelineEventSeed));
const decodeEvent = Schema.decodeUnknownSync(TimelineEventSeed);

export interface RecordEventInput {
  readonly missionId: string;
  readonly kind: MissionTimelineEvent["kind"];
  readonly subject: MissionRecordRef | null;
  readonly summary: string;
  readonly payload?: unknown;
  readonly causedBy?: string | null;
}

export interface EventLog {
  /** Every event, in `seq` order. */
  readonly all: () => ReadonlyArray<MissionTimelineEvent>;
  /** Appends an event by the owner (the fixture is the owner's client). */
  readonly record: (input: RecordEventInput) => MissionTimelineEvent;
}

/**
 * The fixture's event log: the seeded Crpko events (sorted by time and
 * numbered), then one event per change made through the fixture source.
 */
export function createEventLog(options: {
  readonly nowIso: () => string;
  readonly provenance: () => MissionProvenance;
}): EventLog {
  const seeded = [...seedEvents]
    .sort((left, right) => left.at.localeCompare(right.at))
    .map((event, index) => ({ ...event, missionId: CRPKO, seq: index + 1 }));
  const events: MissionTimelineEvent[] = [...decodeEvents(seeded)];
  let seq = events.length;

  return {
    all: () => events,
    record(input) {
      seq += 1;
      const event: MissionTimelineEvent = decodeEvent({
        id: `ev-local-${seq}`,
        missionId: input.missionId,
        seq,
        kind: input.kind,
        actor: { _tag: "owner" },
        provenance: options.provenance(),
        summary: clampSummary(input.summary),
        subject: input.subject,
        causedBy: input.causedBy ?? null,
        payload: input.payload ?? null,
        at: options.nowIso(),
      });
      events.push(event);
      return event;
    },
  };
}

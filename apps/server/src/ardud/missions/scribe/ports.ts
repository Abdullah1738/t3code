/**
 * The slice of core's mission store the scribe needs. Core owns the record
 * table and the event log; until its foundation lands this port stands in
 * for it, and the memory layer below backs the tests. Once core is merged
 * the live layer is a thin adapter over its typed upsert/append API.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type {
  MissionActor,
  MissionEvent,
  MissionEventKind,
  MissionProvenance,
  MissionRecord,
  MissionRecordRef,
} from "@t3tools/contracts";
import type { MissionError } from "@t3tools/contracts";

export type MissionRecordTag = MissionRecord["_tag"];
export type RecordOf<K extends MissionRecordTag> = Extract<MissionRecord, { _tag: K }>["record"];

/** An event to append with a record write; the store assigns id, seq and time. */
export interface MissionEventDraft {
  readonly kind: MissionEventKind;
  readonly actor: MissionActor;
  readonly provenance: MissionProvenance;
  readonly summary: string;
  readonly subject: MissionRecordRef | null;
  readonly payload: unknown;
}

export interface RecordFilter {
  readonly missionId?: string;
}

export class MissionRecords extends Context.Service<
  MissionRecords,
  {
    readonly get: <K extends MissionRecordTag>(
      kind: K,
      id: string,
    ) => Effect.Effect<RecordOf<K> | null, MissionError>;
    readonly list: <K extends MissionRecordTag>(
      kind: K,
      filter: RecordFilter,
    ) => Effect.Effect<ReadonlyArray<RecordOf<K>>, MissionError>;
    /** Writes the record and appends its events in one transaction. */
    readonly upsert: (
      record: MissionRecord,
      events: ReadonlyArray<MissionEventDraft>,
    ) => Effect.Effect<ReadonlyArray<MissionEvent>, MissionError>;
    readonly eventsSince: (
      missionId: string,
      seq: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<MissionEvent>, MissionError>;
  }
>()("t3/ardud/missions/scribe/ports/MissionRecords") {}

const missionOf = (record: MissionRecord): string | null => {
  const value = (record.record as { readonly missionId?: unknown }).missionId;
  return typeof value === "string" ? value : null;
};

/** In-memory store for tests and dry runs; `now` stamps appended events. */
export const memoryLayer = (now: () => string) =>
  Layer.effect(
    MissionRecords,
    Effect.gen(function* () {
      const records = yield* Ref.make(new Map<string, MissionRecord>());
      const log = yield* Ref.make<ReadonlyArray<MissionEvent>>([]);
      const key = (kind: string, id: string) => `${kind}|${id}`;

      const get = <K extends MissionRecordTag>(kind: K, id: string) =>
        Ref.get(records).pipe(
          Effect.map((map) => (map.get(key(kind, id))?.record ?? null) as RecordOf<K> | null),
        );

      const list = <K extends MissionRecordTag>(kind: K, filter: RecordFilter) =>
        Ref.get(records).pipe(
          Effect.map(
            (map) =>
              [...map.values()]
                .filter((record) => record._tag === kind)
                .filter(
                  (record) =>
                    filter.missionId === undefined || missionOf(record) === filter.missionId,
                )
                .map((record) => record.record) as unknown as ReadonlyArray<RecordOf<K>>,
          ),
        );

      const upsert = (record: MissionRecord, drafts: ReadonlyArray<MissionEventDraft>) =>
        Effect.gen(function* () {
          const id = (record.record as { readonly id: string }).id;
          yield* Ref.update(records, (map) => new Map(map).set(key(record._tag, id), record));
          const missionId = missionOf(record) ?? "";
          return yield* Ref.modify(log, (events) => {
            let seq = events.filter((event) => event.missionId === missionId).length;
            const added = drafts.map((draft) => {
              seq += 1;
              return {
                id: `evt-${events.length + seq}`,
                missionId,
                seq,
                kind: draft.kind,
                actor: draft.actor,
                provenance: draft.provenance,
                summary: draft.summary,
                subject: draft.subject,
                causedBy: null,
                payload: draft.payload ?? null,
                at: now(),
              } as unknown as MissionEvent;
            });
            return [added, [...events, ...added]] as const;
          });
        });

      const eventsSince = (missionId: string, seq: number, limit: number) =>
        Ref.get(log).pipe(
          Effect.map((events) =>
            events
              .filter((event) => event.missionId === missionId && event.seq > seq)
              .slice(0, limit),
          ),
        );

      return MissionRecords.of({ get, list, upsert, eventsSince });
    }),
  );

import type { MissionRecord } from "@t3tools/contracts";

/** Record kinds the generic record table holds. Events live in their own log. */
export type MissionStoreKind = Exclude<MissionRecord["_tag"], "event">;
export type MissionStoreRecord = Exclude<MissionRecord, { readonly _tag: "event" }>;
export type MissionRecordOf<K extends MissionStoreKind> = Extract<
  MissionRecord,
  { readonly _tag: K }
>["record"];

/**
 * Query columns for one stored record.
 *
 * `missionId` is `undefined` for records with no mission field (role bindings,
 * pools); those take the committing mission. `status` is the record's status,
 * or the closest filterable state: a note's type, a work item's stage, a
 * review's verdict, a room's archived flag, a draft note's active flag.
 * `updatedAt` is the latest timestamp the record carries.
 */
export interface MissionRecordIndex {
  readonly id: string;
  readonly missionId: string | null | undefined;
  readonly subMissionId: string | null;
  readonly status: string | null;
  readonly updatedAt: string;
}

export const indexRecord = (entry: MissionStoreRecord): MissionRecordIndex => {
  switch (entry._tag) {
    case "mission": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.id,
        subMissionId: null,
        status: r.status,
        updatedAt: r.updatedAt,
      };
    }
    case "sub-mission": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: r.id,
        status: r.status,
        updatedAt: r.updatedAt,
      };
    }
    case "milestone": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: r.subMissionId,
        status: r.status,
        updatedAt: r.updatedAt,
      };
    }
    case "lane": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: r.subMissionId,
        status: r.status,
        updatedAt: r.updatedAt,
      };
    }
    case "role": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: null,
        status: r.kind,
        updatedAt: r.updatedAt,
      };
    }
    case "role-binding": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: undefined,
        subMissionId: null,
        status: r.endedAt === null ? "bound" : "ended",
        updatedAt: r.endedAt ?? r.boundAt,
      };
    }
    case "room": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: r.subMissionId,
        status: r.archived ? "archived" : "active",
        updatedAt: r.lastMessageAt ?? r.createdAt,
      };
    }
    case "message": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: null,
        status: r.kind,
        updatedAt: r.createdAt,
      };
    }
    case "ask": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: r.subMissionId,
        status: r.status,
        updatedAt: r.updatedAt,
      };
    }
    case "call": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: r.subMissionId,
        status: null,
        updatedAt: r.createdAt,
      };
    }
    case "note": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: r.subMissionId,
        status: r.type,
        updatedAt: r.createdAt,
      };
    }
    case "rule": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: null,
        status: r.status,
        updatedAt: r.updatedAt,
      };
    }
    case "rule-change-request": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: null,
        status: r.status,
        updatedAt: r.resolvedAt ?? r.createdAt,
      };
    }
    case "suggestion": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: null,
        status: r.status,
        updatedAt: r.decidedAt ?? r.createdAt,
      };
    }
    case "draft": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: null,
        status: r.status,
        updatedAt: r.sentAt ?? r.decidedAt ?? r.createdAt,
      };
    }
    case "draft-note": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: null,
        status: r.active ? "active" : "inactive",
        updatedAt: r.updatedAt,
      };
    }
    case "knock": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: null,
        status: r.status,
        updatedAt: r.decidedAt ?? r.createdAt,
      };
    }
    case "approval": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: null,
        status: r.status,
        updatedAt: r.decidedAt ?? r.createdAt,
      };
    }
    case "pool": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: undefined,
        subMissionId: null,
        status: null,
        updatedAt: r.updatedAt,
      };
    }
    case "pool-hold": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: null,
        status: r.status,
        updatedAt: r.releasedAt ?? r.createdAt,
      };
    }
    case "review-policy": {
      // One policy per mission, keyed by the mission id.
      const r = entry.record;
      return {
        id: r.missionId,
        missionId: r.missionId,
        subMissionId: null,
        status: null,
        updatedAt: r.updatedAt,
      };
    }
    case "criticality-verdict": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: null,
        status: null,
        updatedAt: r.createdAt,
      };
    }
    case "review": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: null,
        status: r.verdict,
        updatedAt: r.createdAt,
      };
    }
    case "work-item": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: r.subMissionId,
        status: r.stage,
        updatedAt: r.updatedAt,
      };
    }
    case "fork": {
      const r = entry.record;
      return {
        id: r.id,
        missionId: r.missionId,
        subMissionId: null,
        status: r.status,
        updatedAt: r.closedAt ?? r.createdAt,
      };
    }
  }
};

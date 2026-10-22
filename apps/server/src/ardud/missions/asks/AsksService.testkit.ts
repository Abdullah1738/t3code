// Shared fixtures for missions asks tests (service and MCP tools).
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  LaneId,
  MissionError,
  MissionId,
  ProviderInstanceId,
  RoleBindingId,
  RoleId,
  ThreadId,
  MissionMessageId,
  WorkItemId,
  type Ask,
  type InboxComment,
  type Lane,
  type Mission,
  type MissionMessage,
  type MissionProvenance,
  type MissionRecordRef,
  type PostMessageInput,
  type Role,
  type RoleBinding,
  type RoleKind,
  type WorkItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import { AttachTargets } from "../core/attachTargets.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as AsksService from "./AsksService.ts";
import * as Inbound from "./inbound.ts";
import * as Ports from "./ports.ts";
import type { InboundMessage } from "./provenance.ts";

export const at = "2026-10-17T08:00:00.000Z";
export const missionId = MissionId.make("m-1");
export const masterThread = ThreadId.make("t-master");
export const laneThread = ThreadId.make("t-lane");
export const writerThread = ThreadId.make("t-writer");
export const strayThread = ThreadId.make("t-stray");

export const ownerApp: MissionProvenance = { _tag: "owner-app", surface: "web", sessionId: "s-1" };
export const agent = (threadId: ThreadId): MissionProvenance => ({
  _tag: "agent",
  threadId,
  roleId: null,
});
export const governor: MissionProvenance = { _tag: "system", component: "governor" };

export const mission: Mission = {
  id: missionId,
  slug: "m-1",
  title: "Mission one",
  goal: "Ship it",
  status: "active",
  tier: "P1",
  weight: 1,
  guaranteedShare: 0.2,
  borrowCeiling: 0.5,
  projectId: null,
  masterRoleId: RoleId.make("role-master"),
  focusSubMissionId: null,
  health: "unknown",
  lockedFields: [],
  createdAt: at,
  updatedAt: at,
};

export const role = (id: string, kind: RoleKind, laneId: LaneId | null = null): Role => ({
  id: RoleId.make(id),
  missionId,
  kind,
  name: id,
  description: "",
  modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "opus" },
  pendingModelSelection: null,
  laneId,
  writesPublicText: true,
  lockedFields: [],
  createdAt: at,
  updatedAt: at,
});

export const binding = (id: string, roleId: string, threadId: ThreadId): RoleBinding => ({
  id: RoleBindingId.make(id),
  roleId: RoleId.make(roleId),
  threadId,
  reason: "initial",
  handoffNote: null,
  observedModel: null,
  boundAt: at,
  endedAt: null,
});

export const lane: Lane = {
  id: LaneId.make("lane-api"),
  missionId,
  subMissionId: null,
  name: "API",
  purpose: "",
  status: "working",
  statusReason: null,
  leadRoleId: null,
  threadId: laneThread,
  currentItemId: null,
  lastEvidence: null,
  context: null,
  lastActiveAt: null,
  createdAt: at,
  updatedAt: at,
};

export const item = (id: string): WorkItem => ({
  id: WorkItemId.make(id),
  missionId,
  subMissionId: null,
  laneId: lane.id,
  milestoneId: null,
  title: `Item ${id}`,
  kind: "ticket",
  stage: "pr",
  heldBy: null,
  blockedBy: [],
  dependsOn: [],
  pullRequest: null,
  links: [],
  facts: { mergedAtHead: null, deployedReadback: null, exercised: null },
  createdAt: at,
  updatedAt: at,
});

/** An answer signal the service handed the router. */
export interface Signal {
  readonly ask: Ask;
  readonly released: ReadonlyArray<MissionRecordRef>;
  readonly comments?: ReadonlyArray<InboxComment>;
}

/** A room post the service handed the router. */
export interface RoomPost {
  readonly input: PostMessageInput;
  readonly provenance: MissionProvenance;
}

/** A message the owner typed. Push into the harness inbox once the record exists. */
export const typedInbound = (
  id: string,
  text: string,
  receivedAt: number,
  chat: InboundMessage["chat"] = "owner",
): InboundMessage => ({ id, chat, text, typed: true, receivedAt });

/** `inbound` is read on every lookup, so tests may push replies after opening a record. */
export const harness = (inbound: ReadonlyArray<InboundMessage> = []) => {
  const signals: Signal[] = [];
  const posts: RoomPost[] = [];
  const signalsLayer = Layer.succeed(
    Ports.AsksSignals,
    Ports.AsksSignals.of({
      askResolved: ({ ask, released, comments }) =>
        Effect.sync(
          () =>
            void signals.push({ ask, released, ...(comments === undefined ? {} : { comments }) }),
        ),
    }),
  );
  const rooms = Layer.succeed(
    Ports.AsksRooms,
    Ports.AsksRooms.of({
      post: (input, provenance) =>
        Effect.sync((): MissionMessage => {
          posts.push({ input, provenance });
          return {
            id: MissionMessageId.make(`msg-${posts.length}`),
            missionId: input.missionId,
            roomId: input.roomId,
            seq: posts.length,
            kind: input.kind,
            author: { _tag: "system", component: "test" },
            provenance,
            to: input.to ?? [],
            summary: input.summary,
            hasBody: input.body !== undefined,
            key: input.key ?? null,
            workItemId: input.workItemId ?? null,
            links: input.links ?? [],
            receipt: null,
            isCorrection: false,
            createdAt: at,
          };
        }),
    }),
  );
  const lookup = Layer.succeed(
    Inbound.InboundLookup,
    Inbound.InboundLookup.of({
      find: (id) => Effect.succeed(inbound.find((message) => message.id === id) ?? null),
    }),
  );
  // The threads that exist, by the component that created them; a test adds the ones it attaches.
  const threadCreators = new Map<ThreadId, string | null>();
  const targets = Layer.succeed(
    AttachTargets,
    AttachTargets.of({
      lookup: (threadId) =>
        Effect.succeed(
          threadCreators.has(threadId) ? { createdBy: threadCreators.get(threadId) ?? null } : null,
        ),
    }),
  );
  const layer = Layer.mergeAll(AsksService.layer, MissionService.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        MissionStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
        lookup,
        targets,
        signalsLayer,
        rooms,
        Ports.applierRegistry,
        NodeServices.layer,
      ),
    ),
  );
  return { signals, posts, threadCreators, layer };
};

export const seed = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  yield* store.commit({
    event: {
      missionId,
      kind: "mission.created",
      actor: { _tag: "system", component: "test" },
      provenance: { _tag: "system", component: "test" },
      summary: "seed",
      subject: null,
    },
    upserts: [
      { _tag: "mission", record: mission },
      { _tag: "role", record: role("role-master", "master") },
      { _tag: "role", record: role("role-writer", "writer") },
      { _tag: "role-binding", record: binding("b-master", "role-master", masterThread) },
      { _tag: "role-binding", record: binding("b-writer", "role-writer", writerThread) },
      { _tag: "lane", record: lane },
      { _tag: "work-item", record: item("wi-held") },
      { _tag: "work-item", record: item("wi-free") },
    ],
  });
});

export const otherMissionId = MissionId.make("m-2");
export const otherMasterThread = ThreadId.make("t-master-2");
export const otherLane: Lane = {
  ...lane,
  id: LaneId.make("lane-other"),
  missionId: otherMissionId,
  threadId: ThreadId.make("t-lane-2"),
};

/** A second mission whose master holds a custom role, found through masterRoleId. */
export const seedOther = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  yield* store.commit({
    event: {
      missionId: otherMissionId,
      kind: "mission.created",
      actor: { _tag: "system", component: "test" },
      provenance: { _tag: "system", component: "test" },
      summary: "seed other",
      subject: null,
    },
    upserts: [
      {
        _tag: "mission",
        record: {
          ...mission,
          id: otherMissionId,
          slug: "m-2",
          masterRoleId: RoleId.make("role-lead-2"),
        },
      },
      {
        _tag: "role",
        record: { ...role("role-lead-2", "custom"), missionId: otherMissionId },
      },
      {
        _tag: "role-binding",
        record: binding("b-lead-2", "role-lead-2", otherMasterThread),
      },
      { _tag: "lane", record: otherLane },
    ],
  });
});

export const askInput = (question: string, extra: Record<string, unknown> = {}) => ({
  missionId,
  question,
  context: "Two ways to run the migration.",
  options: [
    { id: "a", label: "Online", detail: "" },
    { id: "b", label: "Offline window", detail: "" },
  ],
  recommendation: { optionId: "a", reason: "No downtime." },
  blocks: [
    { kind: "work-item", id: "wi-held" },
    { kind: "lane", id: "lane-api" },
  ],
  costOfWaiting: "The migration lane idles.",
  ...extra,
});

export const failureCode = <A, R>(effect: Effect.Effect<A, MissionError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );

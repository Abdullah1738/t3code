/**
 * Shared fixtures for the guard tests. `membershipGuard` installs a send guard
 * that applies the real `decideSend` policy to a fixed mission: `master` is
 * its master, `lane` a thread the master created, `outsider` belongs to no
 * mission and `free` is an ordinary thread outside any mission.
 */
import {
  KnockId,
  MissionId,
  MissionMessageId,
  RoomId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import { idleThreadProjection, liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  installSendGuard,
  type SendGuardOutcome,
  type SendGuardRequest,
} from "../router/guardHook.ts";
import { decideSend, type Member } from "../router/model.ts";

export const missionId = MissionId.make("m-1");
export const master = ThreadId.make("t-master");
export const lane = ThreadId.make("t-lane");
export const outsider = ThreadId.make("t-outsider");
export const free = ThreadId.make("t-free");

const members = new Map<string, Member>([
  [master, { missionId, threadId: master, kind: "master" }],
  [lane, { missionId, threadId: lane, kind: "created" }],
]);

const routed: SendGuardOutcome = {
  _tag: "routed",
  missionId,
  roomId: RoomId.make("m-1:room:control"),
  messageId: MissionMessageId.make("m-1:msg:1"),
  seq: 1,
};
const knocked: SendGuardOutcome = { _tag: "knocked", missionId, knockId: KnockId.make("knock-1") };

/** Installs the real membership policy for the fixed mission; returns what it was asked. */
export const membershipGuard = Effect.gen(function* () {
  const seen: Array<SendGuardRequest> = [];
  yield* installSendGuard((request) => {
    seen.push(request);
    const decision = decideSend({
      target: members.get(request.targetThreadId) ?? null,
      sender: request.from._tag === "thread" ? (members.get(request.from.threadId) ?? null) : null,
      from: request.from,
      targetThreadId: request.targetThreadId,
    });
    switch (decision._tag) {
      case "not-member":
      case "allow":
        return Effect.succeed<SendGuardOutcome>({ _tag: "pass" });
      case "route":
        return Effect.succeed(routed);
      case "knock":
        return Effect.succeed(knocked);
    }
  });
  return seen;
});

/** When every pending request in `projectionFor` opened. */
export const askedAt = DateTime.makeUnsafe("2026-10-18T10:00:00.000Z");

/**
 * Every thread has three pending requests: `request-1` asks "release"
 * (options "Ship it" and "Hold"), `request-2` asks to approve a command, and
 * `request-3` asks "release" and "notes" together.
 */
export const projectionFor = (threadId: ThreadId): OrchestrationV2ThreadProjection =>
  ({
    ...idleThreadProjection(liveThreadShell(threadId)),
    runs: [{ id: RunId.make(`run:${threadId}`), ordinal: 1, status: "running" }],
    runtimeRequests: [
      {
        id: "request-1",
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: askedAt,
      },
      {
        id: "request-2",
        kind: "command",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: "provider-session" },
        createdAt: askedAt,
      },
      {
        id: "request-3",
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: askedAt,
      },
    ],
    turnItems: [
      {
        type: "user_input_request",
        requestId: "request-1",
        questions: [
          {
            id: "release",
            header: "Release",
            question: "Ship the release?",
            options: [
              { label: "Ship it", description: "Ship now." },
              { label: "Hold", description: "Wait for review." },
            ],
          },
        ],
      },
      {
        type: "user_input_request",
        requestId: "request-3",
        questions: [
          {
            id: "release",
            header: "Release",
            question: "Ship the release?",
            options: [
              { label: "Ship it", description: "Ship now." },
              { label: "Hold", description: "Wait for review." },
            ],
          },
          { id: "notes", header: "Notes", question: "Anything to add?", options: [] },
        ],
      },
    ],
  }) as unknown as OrchestrationV2ThreadProjection;

export interface Delivered {
  readonly sends: Queue.Queue<ThreadManagementService.ThreadManagementSendInput>;
  readonly dispatches: Ref.Ref<ReadonlyArray<OrchestrationV2ServerCommand>>;
}

export const makeDelivered = Effect.all({
  sends: Queue.unbounded<ThreadManagementService.ThreadManagementSendInput>(),
  dispatches: Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]),
});

/** Thread management that records every delivery instead of performing it. */
export const recordingThreads = (delivered: Delivered) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
    getThreadRecords: (threadId) => Effect.succeed(projectionFor(threadId)),
    getProjectThreadRecords: (input) => Effect.succeed(projectionFor(input.threadId)),
    sendToThread: (input) =>
      Queue.offer(delivered.sends, input).pipe(
        Effect.as({
          message: { id: input.messageId },
          run: { id: RunId.make("run:delivered"), status: "queued" },
          delivery: "queued",
        } as unknown as ThreadManagementService.ThreadManagementSendResult),
      ),
    dispatch: (command) =>
      Ref.update(delivered.dispatches, (commands) => [...commands, command]).pipe(
        Effect.as({ sequence: 1 } as never),
      ),
  });

// @effect-diagnostics nodeBuiltinImport:off - checks whether the restart installer still has pending resumes.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { CommandId, MessageId, MissionError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { stateFromShell } from "../../control/model.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

export type RecoveryThreadReadiness = "idle" | "busy" | "gone";

/**
 * How recovery reaches threads. One port so the router's doorbell can take
 * over later; until then a queued direct send, only to idle threads.
 */
export class RecoveryDelivery extends Context.Service<
  RecoveryDelivery,
  {
    readonly readiness: (threadId: ThreadId) => Effect.Effect<RecoveryThreadReadiness>;
    /** Idempotent per key: a retried send lands once. */
    readonly send: (input: {
      readonly threadId: ThreadId;
      readonly text: string;
      readonly key: string;
    }) => Effect.Effect<void, MissionError>;
    /** The cutover installer is still holding its own resume messages. */
    readonly installerPending: Effect.Effect<boolean>;
    /** The owner's zone for HH:MM in notices. */
    readonly timeZone: string;
  }
>()("t3/ardud/missions/recovery/RecoveryDelivery") {}

const failure = (what: string) => (error: unknown) =>
  new MissionError({
    code: "conflict",
    detail: `${what}: ${error instanceof Error ? error.message : String(error)}`,
  });

const installerFile = () =>
  NodePath.join(
    process.env.T3_RESTART_SNAPSHOTS_DIR ??
      NodePath.join(NodeOS.homedir(), ".robob", "restart-snapshots"),
    "pending.json",
  );

const ownerTimeZone = () =>
  process.env.ARDUD_OWNER_TIME_ZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

export const layer = Layer.effect(
  RecoveryDelivery,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    return RecoveryDelivery.of({
      readiness: (threadId) =>
        threads.getThreadShell(threadId).pipe(
          Effect.map((shell): RecoveryThreadReadiness => {
            if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null)
              return "gone";
            return stateFromShell(shell) === "idle" ? "idle" : "busy";
          }),
          Effect.orElseSucceed((): RecoveryThreadReadiness => "busy"),
        ),
      send: ({ threadId, text, key }) =>
        Effect.gen(function* () {
          const shell = yield* threads
            .getThreadShell(threadId)
            .pipe(Effect.mapError(failure("Cannot read the thread")));
          if (shell === null) {
            return yield* new MissionError({ code: "not-found", detail: `No thread ${threadId}.` });
          }
          yield* threads
            .sendToThread({
              projectId: shell.projectId,
              commandId: CommandId.make(`ardud-missions:recovery:${key}`),
              messageId: MessageId.make(`ardud-missions:recovery:${key}`),
              threadId,
              text,
              attachments: [],
              mode: "queue",
              createdBy: "system",
              creationSource: "server",
            })
            .pipe(Effect.mapError(failure("Cannot deliver the recovery notice")));
        }),
      installerPending: Effect.sync(() => NodeFS.existsSync(installerFile())),
      timeZone: ownerTimeZone(),
    });
  }),
);

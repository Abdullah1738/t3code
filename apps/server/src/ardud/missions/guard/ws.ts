/**
 * The guard's view of one WS connection. The session is classified once: a
 * paired Robob client is the owner and passes; any other bearer (the CLI, a
 * control token) is a session, and every client command that puts text into
 * an existing thread goes through the guard as that session. Writes are
 * stamped `user` only for the owner.
 */
import type {
  ClientSurface,
  McpAppUpdateModelContextInput,
  OrchestrationV2Command,
  ScheduledTaskListResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { guardSender, type SendGuardFailed, type SendRefused } from "../router/guardPaths.ts";
import type { SendPath } from "../router/model.ts";
import { authorityStore } from "./authority.ts";
import { guardFork } from "./forks.ts";
import {
  CurrentPrincipal,
  principalActor,
  principalKey,
  wsPrincipal,
  type WsSession,
} from "./principal.ts";
import { requestAnswerText } from "./requests.ts";
import { withoutHiddenWebhooks } from "./schedules.ts";
import { authorizeWatch } from "./watches.ts";

interface GuardedWrite {
  readonly path: SendPath;
  readonly targetThreadId: ThreadId;
  readonly text: string;
}

/**
 * The text a client command puts into an existing thread, or `null` when it
 * puts none. Queue reorder/cancel/promote, interrupts, settings, archive and
 * pins carry no new text. Forks and pull request watches are handled apart,
 * because they also record who started them.
 */
export const commandWrite = (command: OrchestrationV2Command): GuardedWrite | null => {
  switch (command.type) {
    case "message.dispatch":
      return { path: "ws-dispatch", targetThreadId: command.threadId, text: command.text };
    case "queued-run.edit":
      return { path: "queued-edit", targetThreadId: command.threadId, text: command.text };
    case "runtime-request.respond":
      return {
        path: "request-respond",
        targetThreadId: command.threadId,
        text: requestAnswerText({
          requestId: command.requestId,
          decision: command.decision,
          answers: command.answers,
        }),
      };
    case "thread.user-input.dismiss":
      return {
        path: "request-respond",
        targetThreadId: command.threadId,
        text: requestAnswerText({ requestId: command.requestId, dismissed: true }),
      };
    case "thread.merge_back":
      return {
        path: "merge-back",
        targetThreadId: command.targetThreadId,
        text: `Merge thread ${command.sourceThreadId} back into this thread.`,
      };
    case "delegated_task.request":
      return { path: "delegate", targetThreadId: command.parentThreadId, text: command.task };
    case "thread.created.record":
      return {
        path: "created-record",
        targetThreadId: command.parentThreadId,
        text: `Record thread ${command.targetThreadId} as created by this thread.`,
      };
    default:
      return null;
  }
};

const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const modelContextText = (input: McpAppUpdateModelContextInput): string => {
  const texts = (input.content ?? []).flatMap((block) =>
    typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
      ? [block.text]
      : [],
  );
  if (input.structuredContent !== undefined) {
    texts.push(Option.getOrElse(encodeJson(input.structuredContent), () => ""));
  }
  return ["Update this conversation's app context:", ...texts].join("\n");
};

export const makeWsGuard = (input: {
  readonly surface: ClientSurface | undefined;
  readonly session: WsSession;
  readonly sql: SqlClient.SqlClient;
}) => {
  const principal = wsPrincipal(input);
  const store = authorityStore(input.sql);
  const send = (
    write: GuardedWrite,
    requestId: string,
  ): Effect.Effect<void, SendRefused | SendGuardFailed> =>
    principal._tag === "owner"
      ? Effect.void
      : guardSender({
          ...write,
          from: principal,
          requestKey: `ws:${write.path}:${principalKey(principal)}:${requestId}`,
        });

  return {
    principal,
    /** `createdBy` for anything this connection writes. */
    actor: principalActor(principal),
    /** Checks a client command before it is dispatched. */
    command: (
      command: OrchestrationV2Command,
    ): Effect.Effect<void, SendRefused | SendGuardFailed> => {
      switch (command.type) {
        case "thread.fork":
          return guardFork(store, {
            caller: principal,
            sourceThreadId: command.sourceThreadId,
            targetThreadId: command.targetThreadId,
            title: command.title,
          });
        case "thread.pull-request.watch":
          return command.watching
            ? authorizeWatch(store, {
                principal,
                threadId: command.threadId,
                link: {
                  host: command.host,
                  repository: command.repository,
                  number: command.number,
                  url: command.link?.url,
                },
              })
            : Effect.void;
        default: {
          const write = commandWrite(command);
          return write === null ? Effect.void : send(write, command.commandId);
        }
      }
    },
    /** A launch that reuses an existing thread is a send into it. */
    launch: (launch: {
      readonly commandId: string;
      readonly threadId?: ThreadId | undefined;
      readonly reuseExistingThread?: boolean | undefined;
      readonly text?: string | undefined;
    }): Effect.Effect<void, SendRefused | SendGuardFailed> =>
      launch.reuseExistingThread === true && launch.threadId !== undefined
        ? send(
            {
              path: "thread-launch",
              targetThreadId: launch.threadId,
              text: launch.text ?? "Start a run in this thread.",
            },
            launch.commandId,
          )
        : Effect.void,
    /** App context reaches the conversation's next turn. */
    modelContext: (
      update: McpAppUpdateModelContextInput,
    ): Effect.Effect<void, SendRefused | SendGuardFailed> => {
      const text = modelContextText(update);
      return send(
        { path: "ws-dispatch", targetThreadId: update.conversationThreadId, text },
        `${update.threadId}:${update.itemId}:${text}`,
      );
    },
    /** Runs a scheduled task call as this connection. */
    schedules: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, CurrentPrincipal, principal),
    /** Hides webhook URLs of member-bound tasks this connection did not authorize. */
    visibleWebhooks: (result: ScheduledTaskListResult) =>
      withoutHiddenWebhooks(store, principal, result.tasks).pipe(
        Effect.map((tasks): ScheduledTaskListResult => ({ tasks })),
      ),
  };
};

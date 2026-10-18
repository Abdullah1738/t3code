import {
  OrchestratorMcpFailure,
  type MissionError,
  type MissionProvenance,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { MissionRouter } from "./MissionRouter.ts";
import { RouterToolkit } from "./tools.ts";

const REFUSALS: ReadonlySet<MissionError["code"]> = new Set([
  "forbidden",
  "provenance-required",
  "provenance-invalid",
]);

const toolFailure = (error: MissionError) =>
  new OrchestratorMcpFailure({
    code: REFUSALS.has(error.code) ? "capability_denied" : "invalid_request",
    message: error.message,
  });

/**
 * Runs as the calling T3 thread: agent provenance from the invocation
 * context. These tools are for mission threads, so a thread caller is required
 * (the access wrappers enforce that before this runs).
 */
const asCaller = <A>(
  run: (
    router: MissionRouter["Service"],
    threadId: ThreadId,
    provenance: MissionProvenance,
  ) => Effect.Effect<A, MissionError>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const caller = yield* McpInvocationContext.requireThreadScope(scope, "This tool");
    const router = yield* MissionRouter;
    const threadId = caller.thread.threadId;
    return yield* run(router, threadId, { _tag: "agent", threadId, roleId: null });
  }).pipe(Effect.catchTags({ MissionError: (error) => Effect.fail(toolFailure(error)) }));

const handlers = {
  mission_inbox: McpToolAccess.readsAsCaller(() =>
    asCaller((router, threadId) =>
      router.inbox(threadId).pipe(Effect.map(({ unread, entries }) => ({ unread, entries }))),
    ),
  ),
  mission_mark_read: McpToolAccess.actsAsCaller((input) =>
    asCaller((router, _threadId, provenance) =>
      router.markRead(input, provenance).pipe(Effect.map((position) => ({ position }))),
    ),
  ),
  mission_rooms: McpToolAccess.readsAsCaller((input) =>
    asCaller((router, _threadId, provenance) =>
      router.rooms(input.missionId, provenance).pipe(Effect.map((rooms) => ({ rooms }))),
    ),
  ),
  mission_room: McpToolAccess.readsAsCaller((input) =>
    asCaller((router, _threadId, provenance) =>
      router.roomPage(input, provenance).pipe(Effect.map((page) => ({ page }))),
    ),
  ),
  mission_subscribe: McpToolAccess.actsAsCaller((input) =>
    asCaller((router, _threadId, provenance) =>
      router.subscribe(input, provenance).pipe(Effect.map((subscription) => ({ subscription }))),
    ),
  ),
  mission_knocks: McpToolAccess.readsAsCaller((input) =>
    asCaller((router, _threadId, provenance) =>
      router.knocks(input.missionId, provenance).pipe(Effect.map((knocks) => ({ knocks }))),
    ),
  ),
  mission_knock_decide: McpToolAccess.actsAsCaller((input) =>
    asCaller((router, _threadId, provenance) =>
      router.decideKnock(input, provenance).pipe(Effect.map((knock) => ({ knock }))),
    ),
  ),
  mission_set_member: McpToolAccess.actsAsCaller((input) =>
    asCaller((router, _threadId, provenance) => router.setMember(input, provenance)),
  ),
  mission_room_tuning: McpToolAccess.readsAsCaller((input) =>
    asCaller((router, _threadId, provenance) =>
      router.roomTuning(input, provenance).pipe(Effect.map((tuning) => ({ tuning }))),
    ),
  ),
  mission_tune_room: McpToolAccess.actsAsCaller((input) =>
    asCaller((router, _threadId, provenance) =>
      router.tuneRoom(input, provenance).pipe(Effect.map((tuning) => ({ tuning }))),
    ),
  ),
  mission_attention: McpToolAccess.readsAsCaller((input) =>
    asCaller((router, _threadId, provenance) =>
      router.attention(input, provenance).pipe(Effect.map(({ entries }) => ({ entries }))),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof RouterToolkit.tools>;

export const layer = McpToolAccess.toLayer(RouterToolkit, handlers);

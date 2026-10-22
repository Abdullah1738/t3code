import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CLIENT_GUARDED_RPC_SCOPES,
  MISSIONS_VIEWS_GUARDED_SCOPES,
  MISSIONS_VIEWS_READ_SCOPES,
  MISSIONS_VIEWS_WS_METHODS,
  MissionsViewsRpcs,
  WsRpcGroup,
  type MissionViewsFeedItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { RPC_REQUIRED_SCOPES } from "../../../auth/RpcAuthorization.ts";
import { failureCode, missionId, ownerApp, seed } from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { fresh } from "./views.testkit.ts";
import { ViewService } from "./ViewService.ts";
import { viewsWsHandlers } from "./ws.ts";

const M = MISSIONS_VIEWS_WS_METHODS;
const paired = {
  sessionId: "session-app",
  subject: "one-time-token",
  origin: { _tag: "owner" as const, source: "cli" as const },
};
const cliIssued = { sessionId: "session-cli", subject: "cli-issued-session" };

const take = <A, E>(stream: Stream.Stream<A, E>, count: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const pull = yield* Stream.toPull(stream);
      const items: Array<A> = [];
      while (items.length < count) {
        items.push(...(yield* pull));
      }
      return items;
    }),
  );

describe("views WS RPCs", () => {
  it("every views RPC is in the server group and declares exactly one scope", () => {
    const all = new Set(WsRpcGroup.requests.keys());
    const required: Readonly<Record<string, string>> = RPC_REQUIRED_SCOPES;
    const clientGuarded: Readonly<Record<string, string>> = CLIENT_GUARDED_RPC_SCOPES;
    for (const method of MissionsViewsRpcs.requests.keys()) {
      expect(all.has(method)).toBe(true);
      const read = Object.hasOwn(MISSIONS_VIEWS_READ_SCOPES, method);
      const guarded = Object.hasOwn(MISSIONS_VIEWS_GUARDED_SCOPES, method);
      expect(read !== guarded).toBe(true);
      if (read) expect(required[method]).toBe(AuthOrchestrationReadScope);
      if (guarded) {
        expect(clientGuarded[method]).toBe(AuthOrchestrationOperateScope);
        expect(required[method]).toBe(AuthOrchestrationOperateScope);
      }
    }
  });

  it.effect("any client reads; only a paired session writes as the owner", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const cli = yield* viewsWsHandlers({ surface: "cli", session: cliIssued });
        const app = yield* viewsWsHandlers({ surface: "web", session: paired });

        const snapshot = yield* cli[M.get]({ missionId });
        expect(snapshot.layout.version).toBe(1);
        expect((yield* cli[M.catalog]({})).version).toBe(1);
        const preview = yield* cli[M.preview]({
          missionId,
          definition: {
            _tag: "section",
            definition: {
              key: "deploys",
              title: "Deploys",
              source: {
                _tag: "query",
                query: { kind: "work-item", sort: "updated-desc", limit: 5 },
              },
              body: [{ _tag: "list", title: "row.title", meta: [], status: null }],
            },
          },
        });
        expect(preview.ok).toBe(true);

        // Writes from a client that is not a paired owner session are refused.
        const hide = { missionId, ops: [{ _tag: "hide" as const, key: "sub-missions" }] };
        expect(yield* failureCode(cli[M.editLayout](hide))).toBe("provenance-required");
        expect(yield* failureCode(cli[M.editStarter]({ ops: hide.ops }))).toBe(
          "provenance-required",
        );
        expect((yield* cli[M.get]({ missionId })).layout.version).toBe(1);

        // The paired session writes as the owner; the event says so.
        yield* app[M.editLayout](hide);
        const after = yield* app[M.get]({ missionId });
        expect(after.layout.version).toBe(2);
        expect(after.layout.by).toBe("owner");
        const store = yield* MissionStore.MissionStore;
        const events = yield* store.recentEvents(missionId, 5);
        const changed = events.find((event) => event.kind === "view.layout-changed");
        expect(changed?.actor).toEqual({ _tag: "owner" });
        expect(changed?.provenance).toEqual({
          _tag: "owner-app",
          surface: "web",
          sessionId: "session-app",
        });
      }),
    ),
  );

  it.effect("the feed sends the snapshot, then a new one after each view change", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const app = yield* viewsWsHandlers({ surface: "web", session: paired });
        const items = yield* Effect.gen(function* () {
          const feed = app[M.subscribe]({ missionId });
          return yield* take(
            feed.pipe(
              Stream.tap((item: MissionViewsFeedItem) =>
                item._tag === "snapshot" && item.snapshot.layout.version === 1
                  ? app[M.editLayout]({
                      missionId,
                      ops: [{ _tag: "rename", key: "sub-missions", title: "Workstreams" }],
                    })
                  : Effect.void,
              ),
            ),
            2,
          );
        });
        expect(items.map((item) => item._tag)).toEqual(["snapshot", "snapshot"]);
        const last = items[1];
        expect(
          last?._tag === "snapshot" &&
            last.snapshot.layout.layout.entries.find((entry) => entry.key === "sub-missions")
              ?.title,
        ).toBe("Workstreams");
      }),
    ),
  );

  it.effect("a source stays fresh while its views are open", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const set = yield* views.setSource(ownerApp, {
          missionId,
          title: "Counter",
          runtime: "bash",
          code: `printf '{"rows":[]}'`,
          fields: { title: "text" },
          refreshMinutes: 5,
        });
        const app = yield* viewsWsHandlers({ surface: "web", session: paired });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const pull = yield* Stream.toPull(app[M.subscribe]({ missionId }));
            // The feed's next snapshot showing a finished run other than `before`.
            const ranAfter = (before: string | null) =>
              Effect.gen(function* () {
                while (true) {
                  for (const item of yield* pull) {
                    if (item._tag !== "snapshot") continue;
                    const run = item.snapshot.sourceRuns?.find((r) => r.sourceId === set.ref.id);
                    if (run && !run.running && run.ranAt !== null && run.ranAt !== before) {
                      return run;
                    }
                  }
                }
              });
            // Opening the views runs the source that never ran.
            const first = yield* ranAfter(null);
            expect(first.error).toBeNull();
            // Nothing reads a snapshot from here on; only the open feed can notice it went stale.
            yield* TestClock.adjust("5 minutes");
            const second = yield* ranAfter(first.ranAt);
            expect(second.error).toBeNull();
            expect(Date.parse(second.ranAt ?? "") - Date.parse(first.ranAt ?? "")).toBe(300_000);
          }),
        );
      }),
    ),
  );
});

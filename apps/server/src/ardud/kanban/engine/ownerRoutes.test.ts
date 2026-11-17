/** Words, picks and permanent board erasure need the owner's session; other administration uses operate. */
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { assert, it } from "@effect/vitest";
import {
  KANBAN_GUARDED_SCOPES,
  KANBAN_READ_SCOPES,
  KANBAN_WS_METHODS as M,
  type KanbanError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { NOT_OWNER_DEVICE_MESSAGE, type OwnerGateSession } from "../ownerGate.ts";
import { makeKanbanWsHandlers } from "../ws.ts";
import {
  makeFake,
  makeHttp,
  makeHttpAs,
  sessionOf,
  testLayer,
  workingCard,
  type HttpCaller,
} from "./askFlows.testkit.ts";
import type { KanbanServiceShape } from "./KanbanService.ts";
import type { KanbanScriptsShape } from "./ScriptService.ts";
import * as Rules from "./rules.ts";

/** Everyone with the operate scope who is not the owner. */
const NOT_THE_OWNER: ReadonlyArray<HttpCaller> = [
  { _tag: "component", component: "t3ctl" },
  // `t3 auth session issue`, the old shared control token.
  { _tag: "unmarked" },
  // His own phone, paired from a link made on the Mac.
  { _tag: "paired" },
];

const assertRefusal = (
  caller: HttpCaller,
  refusal: { readonly code: string; readonly reason?: string | undefined; readonly text: string },
  where: string,
) => {
  assert.strictEqual(refusal.code, "denied", where);
  if (caller._tag === "paired") {
    assert.strictEqual(refusal.reason, "not_owner_device", where);
    assert.strictEqual(refusal.text, NOT_OWNER_DEVICE_MESSAGE, where);
    return;
  }
  assert.strictEqual(refusal.reason, "role_not_allowed", where);
  assert.include(refusal.text, "Only the owner does this", where);
  if (caller._tag === "component") {
    assert.include(refusal.text, `the ${caller.component} component's session`, where);
  }
};

const OWNER_WRITES: ReadonlySet<string> = new Set([
  "POST /discussions/:discussion/messages",
  "POST /discussions/:discussion/answer",
  "POST /cards/:card/asks/:ask/answer",
  "POST /cards/:card/asks/:ask/reply",
  "POST /cards/:card/asks/:ask/hand",
  "POST /cards/:card/asks/:ask/snooze",
  "POST /cards/:card/asks/:ask/seen",
  "POST /asks/answer",
  "POST /asks/hand",
  "POST /asks/snooze",
]);

/** Every route in the HTTP route table, as written there. */
const httpRoutes = () => {
  const text = NodeFS.readFileSync(new URL("../http.ts", import.meta.url), "utf8");
  return [...text.matchAll(/HttpRouter\.route\("(GET|POST|PATCH)", `\$\{p\}([^`]+)`/g)].map(
    (match) => ({ method: match[1] as "GET" | "POST" | "PATCH", path: match[2]! }),
  );
};

it.effect(
  "a t3ctl session can change review chains and resize a pool but cannot post owner words",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { kanban, board, card } = yield* workingCard();
          const caller = { _tag: "component", component: "t3ctl" } as const;
          const http = yield* makeHttpAs(caller);
          const reviewChains = [{ name: "Focused review", steps: [board.defaultCardModel] }];
          const changed = yield* http.request("PATCH", "/boards/toy", {
            reviewChains,
            defaultReviewChain: "Focused review",
            guessedGates: ["money", "secret"],
          });
          assert.strictEqual(changed.status, 200);
          assert.deepStrictEqual(changed.body.reviewChains, reviewChains);
          assert.strictEqual(changed.body.defaultReviewChain, "Focused review");

          assert.deepStrictEqual(changed.body.guessedGates, ["money", "secret"]);
          const read = yield* http.request("GET", "/boards/toy");
          assert.deepStrictEqual(read.body.board.guessedGates, ["money", "secret"]);

          const resized = yield* http.post("/boards/toy/pools", {
            model: board.defaultCardModel,
            slots: 3,
          });
          assert.strictEqual(resized.status, 200);
          const saved = yield* kanban.snapshot(board.id);
          assert.deepStrictEqual(saved.board.reviewChains, reviewChains);
          assert.strictEqual(saved.board.defaultReviewChain, "Focused review");
          assert.deepStrictEqual(saved.board.guessedGates, ["money", "secret"]);
          const empty = yield* http.request("PATCH", "/boards/toy", { guessedGates: [] });
          assert.strictEqual(empty.status, 200);
          yield* http.request("PATCH", "/boards/toy", { name: "Renamed" });
          assert.deepStrictEqual(
            (yield* http.request("GET", "/boards/toy")).body.board.guessedGates,
            [],
          );
          const invalid = yield* http.request("PATCH", "/boards/toy", {
            guessedGates: ["unknown"],
          });
          assert.strictEqual(invalid.status, 400);
          assert.strictEqual(
            saved.pools.find((pool) => pool.key === Rules.poolKey(board.defaultCardModel))?.slots,
            3,
          );

          const discussion = yield* kanban.cardDiscussion(card.id);
          const before = yield* kanban.messages(discussion.id, {});
          const posted = yield* http.post(`/discussions/${discussion.id}/messages`, {
            text: "Approved.",
          });
          assert.strictEqual(posted.status, 403);
          assertRefusal(
            caller,
            {
              code: posted.body.error.code,
              reason: posted.body.error.reason,
              text: posted.body.error.message,
            },
            "t3ctl owner words",
          );
          assert.deepStrictEqual(yield* kanban.messages(discussion.id, {}), before);
        }),
      ).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect(
  "HTTP keeps owner words and picks gated while board administration accepts operate sessions",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { kanban, card } = yield* workingCard();
          const discussion = yield* kanban.cardDiscussion(card.id);
          const fill = (path: string) =>
            path
              .replace(":board", "toy")
              .replace(":card", "toy:1")
              .replace(":ask", "q1")
              .replace(":discussion", discussion.id)
              .replace(":seq", "1")
              .replace(":script", "no-such-script");
          const routes = httpRoutes();
          // The scan sees the table: every route there, and each family of write.
          assert.strictEqual(
            routes.length,
            NodeFS.readFileSync(new URL("../http.ts", import.meta.url), "utf8").match(
              /HttpRouter\.route\(/g,
            )?.length,
          );
          const writes = routes.filter((route) => route.method !== "GET");
          assert.includeMembers(
            writes.map((route) => `${route.method} ${route.path}`),
            [
              "POST /boards",
              "PATCH /boards/:board",
              "POST /boards/:board/pools",
              "POST /boards/:board/cards",
              "POST /boards/:board/discussions",
              "POST /boards/:board/evaluators",
              "POST /boards/:board/scripts",
              "PATCH /scripts/:script",
              "POST /cards/:card/move",
              "PATCH /discussions/:discussion",
              "POST /discussions/:discussion/messages",
              "POST /discussions/:discussion/answer",
              "POST /cards/:card/asks/:ask/answer",
              "POST /asks/hand",
            ],
          );

          assert.sameMembers(
            writes
              .map((route) => `${route.method} ${route.path}`)
              .filter((name) => OWNER_WRITES.has(name)),
            [...OWNER_WRITES],
          );

          for (const caller of NOT_THE_OWNER) {
            const http = yield* makeHttpAs(caller);
            for (const route of routes) {
              const name = `${route.method} ${route.path}`;
              const where = `${caller._tag} ${name}`;
              if (route.method === "GET") {
                // Reads are as before.
                assert.notStrictEqual((yield* http.get(fill(route.path))).status, 403, where);
                continue;
              }
              const answered = yield* http.request(route.method, fill(route.path), {});
              if (!OWNER_WRITES.has(name)) {
                assert.notStrictEqual(answered.status, 403, where);
                continue;
              }
              // Refused before the body is read: an empty one is not a 400.
              assert.strictEqual(answered.status, 403, where);
              assertRefusal(
                caller,
                {
                  code: answered.body.error.code,
                  reason: answered.body.error.reason,
                  text: answered.body.error.message,
                },
                where,
              );
            }
            const manual = yield* http.post("/scripts/no-such-script/run", { trigger: "manual" });
            assert.notStrictEqual(manual.status, 403, `${caller._tag} manual run`);
          }

          // None of it is refused to the owner's own session.
          const mine = yield* makeHttp;
          for (const route of writes) {
            const answered = yield* mine.request(route.method, fill(route.path), {});
            assert.notStrictEqual(answered.status, 403, `owner ${route.method} ${route.path}`);
          }
          const created = yield* mine.post("/boards/toy/cards", { prompt: "Second card" });
          assert.strictEqual(created.status, 200);
          assert.deepStrictEqual(created.body.createdBy, { _tag: "owner" });
          const opened = yield* mine.post("/boards/toy/discussions", { title: "Plans" });
          assert.strictEqual(opened.status, 200);
          const pinned = yield* mine.request("PATCH", `/discussions/${opened.body.id}`, {
            pinned: true,
          });
          assert.strictEqual(pinned.status, 200);
          assert.isString(pinned.body.pinnedAt);
        }),
      ).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

/** Stands in for the engine: says which of its calls ran, and ends there. */
const recordingEngine = () => {
  const ran: Array<string> = [];
  const of = <T extends object>(kind: string) =>
    new Proxy({} as T, {
      get: (_target, name) => () =>
        Effect.suspend(() => {
          ran.push(`${kind}.${String(name)}`);
          return Effect.die("the engine");
        }),
    });
  return {
    ran,
    service: of<KanbanServiceShape>("service"),
    scripts: of<KanbanScriptsShape>("scripts"),
  };
};

type Handler = (input: object) => Effect.Effect<unknown, KanbanError>;

const handlersFor = (session: OwnerGateSession) => {
  const engine = recordingEngine();
  const handlers = makeKanbanWsHandlers(engine.service, engine.scripts, session) as unknown as {
    readonly [method: string]: Handler;
  };
  return { ran: engine.ran, handlers };
};

const OWNER_RPCS: ReadonlySet<string> = new Set([M.cardAsk, M.messagePost, M.answer, M.boardPurge]);
/** Streams: the feed of boards and of one board. */
const STREAMS: ReadonlySet<string> = new Set([M.boards, M.subscribe]);

it.effect(
  "WS gates owner words, picks and board erasure while other administration accepts operate sessions",
  () =>
    Effect.gen(function* () {
      const guarded = Object.keys(KANBAN_GUARDED_SCOPES);
      const reads = Object.keys(KANBAN_READ_SCOPES);
      // Every method is in one of the two tables, and has a handler.
      assert.sameMembers([...guarded, ...reads], Object.values(M));
      assert.sameMembers(
        Object.keys(handlersFor(sessionOf({ _tag: "owner" })).handlers),
        Object.values(M),
      );
      const ownerWrites = guarded.filter((method) => OWNER_RPCS.has(method));
      assert.sameMembers(ownerWrites, [...OWNER_RPCS]);
      const operateWrites = guarded.filter((method) => !OWNER_RPCS.has(method));

      for (const caller of NOT_THE_OWNER) {
        const { ran, handlers } = handlersFor(sessionOf(caller));
        for (const method of ownerWrites) {
          const refused = yield* Effect.asVoid(handlers[method]!({})).pipe(Effect.flip);
          assert.strictEqual(refused._tag, "KanbanError", `${caller._tag} ${method}`);
          assertRefusal(
            caller,
            { code: refused.code, reason: refused.reason, text: refused.detail },
            `${caller._tag} ${method}`,
          );
        }
        // None of them got as far as the engine.
        assert.deepStrictEqual(ran, [], caller._tag);

        // Board administration and reads still reach the engine.
        for (const method of [...reads, ...operateWrites]) {
          if (STREAMS.has(method)) continue;
          ran.length = 0;
          const exit = yield* Effect.exit(handlers[method]!({}));
          assert.isTrue(Exit.isFailure(exit), `${caller._tag} ${method}`);
          assert.lengthOf(ran, 1, `${caller._tag} ${method}`);
        }
      }

      // The owner's app reaches the engine on every one of them.
      const mine = handlersFor(sessionOf({ _tag: "owner" }));
      for (const method of ownerWrites) {
        mine.ran.length = 0;
        const exit = yield* Effect.exit(mine.handlers[method]!({}));
        assert.isTrue(Exit.isFailure(exit), `owner ${method}`);
        assert.lengthOf(mine.ran, 1, `owner ${method}`);
      }
    }),
);

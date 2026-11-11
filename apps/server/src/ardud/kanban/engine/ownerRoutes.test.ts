/**
 * Every board write over HTTP or the socket acts as the owner, so every one of
 * them needs the owner's own session. These tests call each route and each RPC
 * as someone who holds the operate scope and is not him: a route or RPC added
 * without the check answers them, and fails here.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs";

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

/** Everyone with the operate scope who is not the owner. */
const NOT_THE_OWNER: ReadonlyArray<HttpCaller> = [
  { _tag: "component", component: "telegram-bridge" },
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
  assert.isUndefined(refusal.reason, where);
  assert.include(refusal.text, "Only the owner does this", where);
  if (caller._tag === "component") {
    assert.include(refusal.text, `the ${caller.component} component's session`, where);
  }
};

/**
 * The two HTTP writes that are not the owner's. Anything else that is not a
 * GET acts as him.
 */
const NOT_OWNER_WRITES: ReadonlySet<string> = new Set([
  // The board opens a card's discussion as itself (`system`), for whoever looks at the card.
  "POST /cards/:card/discussion",
  // A webhook sender runs a script with the operate scope alone; a manual run is checked below.
  "POST /scripts/:script/run",
]);

/** Every route in the HTTP route table, as written there. */
const httpRoutes = () => {
  const text = readFileSync(new URL("../http.ts", import.meta.url), "utf8");
  return [...text.matchAll(/HttpRouter\.route\("(GET|POST|PATCH)", `\$\{p\}([^`]+)`/g)].map(
    (match) => ({ method: match[1] as "GET" | "POST" | "PATCH", path: match[2]! }),
  );
};

it.effect("every HTTP write but a webhook run and a card's discussion needs the owner's session", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, board, card } = yield* workingCard();
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
          readFileSync(new URL("../http.ts", import.meta.url), "utf8").match(/HttpRouter\.route\(/g)
            ?.length,
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

        const state = Effect.gen(function* () {
          return {
            boards: yield* kanban.boards,
            card: (yield* kanban.card(card.id)).card,
            discussions: yield* kanban.discussions(board.id),
            evaluators: (yield* fake.evaluators).length,
          };
        });
        const before = yield* state;

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
            if (NOT_OWNER_WRITES.has(name)) {
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
          // A manual run is the owner's: it also runs a script that is turned off.
          const manual = yield* http.post("/scripts/no-such-script/run", { trigger: "manual" });
          assert.strictEqual(manual.status, 403, `${caller._tag} manual run`);
          assertRefusal(
            caller,
            {
              code: manual.body.error.code,
              reason: manual.body.error.reason,
              text: manual.body.error.message,
            },
            `${caller._tag} manual run`,
          );
        }
        // Nothing they sent changed a board, a card or a discussion, or started an evaluator.
        assert.deepStrictEqual(yield* state, before);

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

/** The one RPC with the operate scope that is not an owner write: the board opens the discussion as itself. */
const NOT_OWNER_RPCS: ReadonlySet<string> = new Set([M.cardDiscussion]);
/** Streams: the feed of boards and of one board. */
const STREAMS: ReadonlySet<string> = new Set([M.boards, M.subscribe]);

it.effect("every board RPC with the operate scope but a card's discussion needs the owner's session", () =>
  Effect.gen(function* () {
    const guarded = Object.keys(KANBAN_GUARDED_SCOPES);
    const reads = Object.keys(KANBAN_READ_SCOPES);
    // Every method is in one of the two tables, and has a handler.
    assert.sameMembers([...guarded, ...reads], Object.values(M));
    assert.sameMembers(
      Object.keys(handlersFor(sessionOf({ _tag: "owner" })).handlers),
      Object.values(M),
    );
    const ownerWrites = guarded.filter((method) => !NOT_OWNER_RPCS.has(method));
    assert.lengthOf(ownerWrites, guarded.length - 1);

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

      // Reads, and opening a card's discussion, are as before.
      for (const method of [...reads, ...NOT_OWNER_RPCS]) {
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

it("no handler passes the owner actor to the engine outside the owner check", () => {
  const http = readFileSync(new URL("../http.ts", import.meta.url), "utf8");
  // Each `const name = wrapper(` handler of the HTTP routes: one that names OWNER is an ownerWrite.
  const starts = [...http.matchAll(/\n {4}const (\w+) = (\w+)\(/g)];
  const unchecked = starts
    .map((match, index) => ({
      name: match[1]!,
      wrapper: match[2]!,
      body: http.slice(match.index, starts[index + 1]?.index ?? http.length),
    }))
    .filter((handler) => /\bOWNER\b/.test(handler.body) && handler.wrapper !== "ownerWrite");
  assert.deepStrictEqual(
    unchecked.map((handler) => handler.name),
    [],
  );

  // Each `[M.name]:` handler of the WS group: one that names OWNER is inside asOwner.
  const ws = readFileSync(new URL("../ws.ts", import.meta.url), "utf8");
  const table = ws.slice(ws.indexOf("  return {\n    [M."));
  const entries = [...table.matchAll(/\n {4}\[M\.(\w+)\]:/g)];
  assert.strictEqual(entries.length, Object.keys(M).length);
  const bare = entries
    .map((match, index) => ({
      name: match[1]!,
      body: table.slice(match.index, entries[index + 1]?.index ?? table.length),
    }))
    .filter((entry) => /\bOWNER\b/.test(entry.body) && !entry.body.includes("asOwner("));
  assert.deepStrictEqual(
    bare.map((entry) => entry.name),
    [],
  );
  // Above the table, OWNER is used by `patchCard` alone, which the table wraps.
  const above = ws.slice(0, ws.indexOf("  return {\n    [M."));
  assert.strictEqual(above.match(/\bOWNER\b/g)?.length, 4);
  assert.include(table, "asOwner(patchCard(input))");
  assert.include(table, "asOwner(updateBoard(input))");
});

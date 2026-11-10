/**
 * A secret field on an ask: the owner types the value in the app's private
 * field, it is held in memory, and the agent that asked gets a one-use ref.
 */
import { assert, it } from "@effect/vitest";
import {
  KANBAN_ASK_SECRET_PROVIDED,
  ProjectId,
  SecretRef,
  ThreadId,
  kanbanAskResponse,
  type KanbanActor,
  type KanbanAskSecretAnswerInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import { HELD_SECRET_MAX, SecretRedeemer, makeHeldSecrets } from "../../auth/heldSecrets.ts";
import type { OwnerProvenance } from "../../auth/provenance.ts";
import { answerAskSecrets } from "../askSecrets.ts";
import {
  askOf,
  makeFake,
  makeHttp,
  owner,
  testLayer,
  toyBoard,
  workingCard,
} from "./askFlows.testkit.ts";
import * as Asks from "./asks.ts";
import * as KanbanService from "./KanbanService.ts";

/** The value under test. Nothing but the tool that redeems its ref may ever show it. */
const SECRET = "whsec_T3st-V4lue+9f3a71c2e5";
const PROJECT = ProjectId.make("project-1");
const ownerApp: OwnerProvenance = { _tag: "owner-app", surface: "web", sessionId: "session-1" };
const REF = /secret-ref:[0-9a-f]{32}/;

const secretsLayer = SecretRequests.layer.pipe(
  Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
  Layer.provideMerge(ServerSecretStore.layer),
);
const layer = (fake: Parameters<typeof testLayer>[0]) =>
  secretsLayer.pipe(Layer.provideMerge(testLayer(fake)));

const tokenAsk = {
  question: "What is the webhook signing secret for the staging hook?",
  blocking: true,
  respond: {
    fields: [
      { id: "token", label: "Signing secret", type: "secret", required: true },
      { id: "env", label: "Environment", type: "text" },
    ],
  },
} as const;

const setup = Effect.gen(function* () {
  const kanban = yield* KanbanService.KanbanService;
  const secrets = yield* SecretRequests.SecretRequests;
  return { kanban, secrets, answer: answerAskSecrets(kanban, secrets) };
});

const input = (
  cardId: KanbanAskSecretAnswerInput["cardId"],
  secrets: Record<string, string> = { token: SECRET },
  answer: Partial<KanbanAskSecretAnswerInput["answer"]> = {},
): KanbanAskSecretAnswerInput => ({
  cardId,
  askId: "q1",
  answer: { verdict: "answered", values: { env: "staging" }, ...answer },
  secrets,
});

/** Uses a ref the way a tool does: as the thread its session says it is. */
const redeem = (
  secrets: SecretRequests.SecretRequests["Service"],
  ref: string,
  threadId: string | null,
  projectId = PROJECT,
) =>
  secrets
    .consume({ ref: SecretRef.make(ref), projectId })
    .pipe(
      Effect.provideService(SecretRedeemer, threadId === null ? null : ThreadId.make(threadId)),
    );

const refIn = (texts: ReadonlyArray<string>) => {
  const found = texts.map((text) => REF.exec(text)?.[0]).find((ref) => ref !== undefined);
  assert.isDefined(found, "the answer's wake text carries a secretRef");
  return found!;
};

/** Every row of every table, as text. */
const dumpDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
  const rows = yield* Effect.forEach(tables, (table) =>
    sql.unsafe(`SELECT * FROM "${table.name}"`).pipe(
      Effect.map((found) =>
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify(found, (_key, value: unknown) =>
          value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value,
        ),
      ),
    ),
  );
  return rows.join("\n");
});

/** Every file under the server's state directory, as text. */
const dumpFiles = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (store.directory === undefined) return { names: [] as Array<string>, text: "" };
  const names = yield* fs.readDirectory(store.directory, { recursive: true });
  const texts = yield* Effect.forEach(names, (name) =>
    fs.readFile(path.join(store.directory!, name)).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("utf8")),
      Effect.orElseSucceed(() => ""),
    ),
  );
  return { names, text: texts.join("\n") };
});

// @effect-diagnostics-next-line preferSchemaOverJson:off
const text = (value: unknown) => JSON.stringify(value) ?? "";

it.effect(
  "a secret typed into an ask reaches the asker as a one-use ref, and the value shows up nowhere",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const logs: Array<string> = [];
      const logger = Logger.make<unknown, void>((entry) => {
        logs.push(`${text(entry.message)} ${Cause.pretty(entry.cause)}`);
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { card, worker, threadId } = yield* workingCard("Fees");
          const { kanban, secrets, answer } = yield* setup;
          const http = yield* makeHttp;
          /** Everything anyone but the redeeming tool can read. */
          const seen: Array<readonly [string, string]> = [];

          const asked = yield* kanban.askOwner(card.id, tokenAsk, worker, "cardThread");
          seen.push(["ask reply", text(asked)]);
          const field = kanbanAskResponse(askOf((yield* kanban.card(card.id)).card)).fields[0]!;
          assert.deepStrictEqual([field.id, field.type, field.required], ["token", "secret", true]);

          // Refusals first: none of them may repeat the value either.
          const overHttp = yield* http.post("/cards/toy:1/asks/q1/answer", {
            verdict: "answered",
            values: { token: SECRET, env: "staging" },
          });
          assert.strictEqual(overHttp.status, 400);
          assert.include(text(overHttp.body), "private field");
          seen.push(["http refusal", text(overHttp.body)]);
          const without = yield* http.post("/cards/toy:1/asks/q1/answer", {
            verdict: "answered",
            values: { env: "staging" },
          });
          assert.strictEqual(without.status, 400);
          seen.push(["http refusal without it", text(without.body)]);
          for (const [name, bad, by] of [
            ["not the owner's app", input(card.id), null],
            ["a field that is not a secret", input(card.id, { env: SECRET }), ownerApp],
            ["an unknown field", input(card.id, { nope: SECRET }), ownerApp],
            ["too long", input(card.id, { token: SECRET.repeat(2000) }), ownerApp],
            ["a stale revision", input(card.id, undefined, { revision: 7 }), ownerApp],
            [
              "a verdict the ask doesn't take",
              input(card.id, undefined, { verdict: "approved" }),
              ownerApp,
            ],
          ] as const) {
            const error = yield* answer(bad, by).pipe(Effect.flip);
            seen.push([`refusal: ${name}`, `${error.message} ${text(error)}`]);
          }
          assert.isNull(askOf((yield* kanban.card(card.id)).card).closedAt);

          const before = (yield* fake.heard(threadId)).length;
          const reply = yield* answer(input(card.id), ownerApp);
          seen.push(["rpc reply", text(reply)]);

          // The stored answer says only that he gave it.
          const stored = (yield* kanban.card(card.id)).card;
          const ask = askOf(stored);
          assert.isNotNull(ask.closedAt);
          assert.deepStrictEqual(ask.answer?.values, {
            token: KANBAN_ASK_SECRET_PROVIDED,
            env: "staging",
          });
          assert.deepStrictEqual(reply.ask?.answer?.values, ask.answer?.values);

          // The asker is told, with a ref and how to use it.
          const told = (yield* fake.heard(threadId)).slice(before);
          const wake = [...told, stored.wakeNote ?? ""].join("\n");
          const ref = refIn([wake]);
          assert.include(wake, `Signing secret: he entered it privately. secretRef: ${ref}`);
          assert.include(wake, "Environment: staging");
          assert.include(wake, "It works once, until 1970-01-02T00:00:00.000Z");
          assert.include(wake, "only from the thread that asked");
          assert.include(wake, "kept in memory only");

          const detail = yield* kanban.card(card.id);
          seen.push(["card detail", text(detail)]);
          seen.push(["ask detail", text(yield* kanban.askDetail(card.id, "q1"))]);
          seen.push([
            "ask feed",
            text(yield* kanban.askFeed({ closedSince: "1970-01-01T00:00:00.000Z" })),
          ]);
          seen.push([
            "http feed",
            text((yield* http.get("/asks?closed=1970-01-01T00:00:00.000Z")).body),
          ]);
          seen.push(["http ask", text((yield* http.get("/cards/toy:1/asks/q1")).body)]);
          seen.push(["http card", text((yield* http.get("/cards/toy:1")).body)]);
          seen.push([
            "discussion",
            text(yield* kanban.messages(stored.discussionId!, { limit: 100 } as never)),
          ]);
          const everyThread = [...(yield* Ref.get(fake.threads)).values()];
          seen.push(["thread messages", text(everyThread)]);
          seen.push(["database", yield* dumpDatabase]);
          const files = yield* dumpFiles;
          seen.push(["files on disk", files.text]);
          seen.push(["logs", logs.join("\n")]);

          // Memory only: no saved-request file was written for it.
          assert.deepStrictEqual(
            files.names.filter((name) => /secret-request-[0-9a-f]{32}\.bin$/.test(name)),
            [],
          );
          for (const [where, output] of seen) {
            assert.isFalse(output.includes(SECRET), `the value shows in: ${where}`);
            assert.isFalse(
              output.includes(SECRET.slice(6, 20)),
              `part of the value shows in: ${where}`,
            );
          }
          // The outputs were real: they do hold the rest of the answer.
          assert.include(seen.find(([where]) => where === "database")![1], "staging");
          assert.include(seen.find(([where]) => where === "card detail")![1], '"secret":true');

          // The one place the value comes out: the asking thread's tool call, once.
          assert.strictEqual(yield* redeem(secrets, ref, threadId), SECRET);
          const again = yield* redeem(secrets, ref, threadId).pipe(Effect.flip);
          assert.strictEqual(again.reason, "ref_unavailable");
          assert.include(again.message, "Ask the user again");
        }),
      ).pipe(
        Effect.provide(
          Layer.merge(layer(fake.layer), Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
    }),
);

it.effect(
  "only the owner's paired app session gets a value in, and nothing is kept otherwise",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { card, worker } = yield* workingCard();
          const { kanban, secrets } = yield* setup;
          yield* kanban.askOwner(card.id, tokenAsk, worker, "cardThread");
          const kept: Array<string> = [];
          const spied = answerAskSecrets(kanban, {
            hold: (held, by) =>
              secrets
                .hold(held, by)
                .pipe(Effect.tap((made) => Effect.sync(() => kept.push(made.ref)))),
            discard: secrets.discard,
          });

          const refused = yield* spied(input(card.id), null).pipe(Effect.flip);
          assert.strictEqual(refused._tag, "EnvironmentAuthorizationError");
          assert.include(refused.message, "Only the owner can answer a secret request");
          // The store itself refuses too, whoever calls it.
          const direct = yield* secrets
            .hold(
              { projectId: PROJECT, value: SECRET, redeemableBy: () => Effect.succeed(true) },
              null,
            )
            .pipe(Effect.flip);
          assert.strictEqual(direct._tag, "EnvironmentAuthorizationError");
          assert.deepStrictEqual(kept, []);

          // An answer that fails after the value was taken leaves no value behind.
          const stale = yield* spied(input(card.id, undefined, { revision: 3 }), ownerApp).pipe(
            Effect.flip,
          );
          assert.strictEqual(stale._tag, "KanbanError");
          assert.strictEqual(kept.length, 1);
          const gone = yield* redeem(
            secrets,
            kept[0]!,
            worker._tag === "thread" ? worker.threadId : null,
          ).pipe(Effect.flip);
          assert.strictEqual(gone.reason, "ref_unavailable");
          assert.isNull(askOf((yield* kanban.card(card.id)).card).closedAt);

          // He can still say no without giving it.
          const no = yield* kanban
            .answerAsk(card.id, "q1", { verdict: "answered", text: "Use the old one." }, owner)
            .pipe(Effect.flip);
          assert.include(no.detail, "is a secret only the owner can give");
        }),
      ).pipe(Effect.provide(layer(fake.layer)));
    }),
);

it.effect("only the thread that asked can use the ref; anyone else is refused and it stays", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { card, worker, threadId } = yield* workingCard();
        const { kanban, secrets, answer } = yield* setup;
        yield* kanban.askOwner(card.id, tokenAsk, worker, "cardThread");
        const before = (yield* fake.heard(threadId)).length;
        yield* answer(input(card.id), ownerApp);
        const stored = (yield* kanban.card(card.id)).card;
        const ref = refIn([...(yield* fake.heard(threadId)).slice(before), stored.wakeNote ?? ""]);

        const other = yield* redeem(secrets, ref, "thread-someone-else").pipe(Effect.flip);
        assert.strictEqual(other.reason, "ref_other_thread");
        assert.include(other.message, "only that thread can use it");
        assert.isFalse(other.message.includes(SECRET));
        // A caller that is no thread at all (the app, a script).
        assert.strictEqual(
          (yield* redeem(secrets, ref, null).pipe(Effect.flip)).reason,
          "ref_other_thread",
        );
        // The right thread, scheduling into another project.
        assert.strictEqual(
          (yield* redeem(secrets, ref, threadId, ProjectId.make("project-2")).pipe(Effect.flip))
            .reason,
          "ref_unavailable",
        );
        assert.strictEqual(yield* redeem(secrets, ref, threadId), SECRET);
      }),
    ).pipe(Effect.provide(layer(fake.layer)));
  }),
);

it.effect("an evaluator's ask: whoever works the card when the ref is used redeems it", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban: board, board: toy } = yield* toyBoard();
        const { kanban, secrets, answer } = yield* setup;
        const evaluator: KanbanActor = {
          _tag: "evaluator",
          threadId: ThreadId.make("evaluator-main"),
        };
        // Asked before the card has any work thread.
        const card = yield* board.createCard(toy.id, { prompt: "Hook", title: "Hook" }, owner);
        yield* kanban.askOwner(card.id, tokenAsk, evaluator, "evaluator");
        assert.isNull((yield* kanban.card(card.id)).card.workThreadId);
        yield* answer(input(card.id), ownerApp);

        yield* kanban.dispatchNow;
        const working = (yield* kanban.card(card.id)).card;
        const worker = working.workThreadId!;
        assert.isNotNull(worker);
        const everything = [...(yield* Ref.get(fake.threads)).values()];
        const ref = refIn([
          working.wakeNote ?? "",
          ...everything.flatMap((thread) => thread.messages),
        ]);
        const wake =
          everything.flatMap((thread) => thread.messages).join("\n") + (working.wakeNote ?? "");
        assert.include(wake, "only from the thread working this card");

        // The evaluator that asked is not the one it is for.
        assert.strictEqual(
          (yield* redeem(secrets, ref, "evaluator-main").pipe(Effect.flip)).reason,
          "ref_other_thread",
        );
        assert.strictEqual(yield* redeem(secrets, ref, worker), SECRET);
      }),
    ).pipe(Effect.provide(layer(fake.layer)));
  }),
);

it.effect(
  "a ref lasts a day, and a restart loses it: both fail with a message that says to ask again",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const refs: Array<{ ref: string; threadId: string }> = [];
      const once = Effect.scoped(
        Effect.gen(function* () {
          const { card, worker, threadId } = yield* workingCard();
          const { kanban, secrets, answer } = yield* setup;
          yield* kanban.askOwner(card.id, tokenAsk, worker, "cardThread");
          const before = (yield* fake.heard(threadId)).length;
          yield* answer(input(card.id), ownerApp);
          const stored = (yield* kanban.card(card.id)).card;
          const ref = refIn([
            ...(yield* fake.heard(threadId)).slice(before),
            stored.wakeNote ?? "",
          ]);
          refs.push({ ref, threadId });
          return { secrets, ref, threadId };
        }),
      );
      // A day on, the ref is spent.
      yield* Effect.gen(function* () {
        const { secrets, ref, threadId } = yield* once;
        yield* TestClock.adjust("23 hours");
        yield* TestClock.adjust("61 minutes");
        const late = yield* redeem(secrets, ref, threadId).pipe(Effect.flip);
        assert.strictEqual(late.reason, "ref_expired");
        assert.include(late.message, "expired. Ask the user again");
      }).pipe(Effect.provide(layer(fake.layer)));

      // A new server process has no memory of an earlier one's refs.
      const fresh = yield* makeFake;
      yield* once.pipe(Effect.provide(layer(fresh.layer)));
      yield* Effect.gen(function* () {
        const secrets = yield* SecretRequests.SecretRequests;
        const { ref, threadId } = refs[1]!;
        const lost = yield* redeem(secrets, ref, threadId).pipe(Effect.flip);
        assert.strictEqual(lost.reason, "ref_unavailable");
        assert.include(lost.message, "does not exist. Ask the user again");
      }).pipe(Effect.provide(layer((yield* makeFake).layer)));
    }),
);

it.effect("the holder is bounded, and an expired value frees its place", () =>
  Effect.gen(function* () {
    const held = makeHeldSecrets();
    const one = { projectId: PROJECT, value: SECRET, redeemableBy: () => Effect.succeed(true) };
    for (let index = 0; index < HELD_SECRET_MAX; index++) yield* held.hold(one);
    const full = yield* held.hold(one).pipe(Effect.flip);
    assert.strictEqual(full.reason, "store_failed");
    assert.isFalse(full.message.includes(SECRET));
    yield* TestClock.adjust("25 hours");
    yield* held.sweep;
    assert.strictEqual(yield* held.size, 0);
    const kept = yield* held.hold(one);
    assert.match(kept.ref, /^secret-ref:[0-9a-f]{32}$/);
  }),
);

it("a secret field takes no default, is the owner's alone, and never accepts a value in values", () => {
  const fields = (extra: Record<string, unknown>, to?: string) =>
    Asks.askFields({
      question: "What is the token?",
      respond: { fields: [{ id: "token", label: "Token", type: "secret", ...extra }] },
      ...(to ? { to } : {}),
    } as never);
  const ok = fields({ required: true });
  assert.isFalse(Asks.isAskProblem(ok));
  const withDefault = fields({ default: SECRET });
  assert.isTrue(Asks.isAskProblem(withDefault));
  if (Asks.isAskProblem(withDefault)) {
    assert.include(withDefault.detail, "takes no default");
    assert.isFalse(withDefault.detail.includes(SECRET));
  }
  const toEvaluator = fields({}, "evaluator");
  assert.isTrue(Asks.isAskProblem(toEvaluator));
  if (Asks.isAskProblem(toEvaluator)) assert.include(toEvaluator.detail, "for the owner");
  // The preset kind is one required secret field.
  const preset = Asks.askFields({ question: "The deploy key?", kind: "secret" } as never);
  assert.isFalse(Asks.isAskProblem(preset));
  if (!Asks.isAskProblem(preset)) {
    assert.deepStrictEqual(
      preset.respond?.fields?.map((field) => [field.id, field.type, field.required]),
      [["secret", "secret", true]],
    );
  }
});

/**
 * A secret field on an ask: the owner types the value in the app's private
 * field, it is held in memory, and the agent that asked gets a one-use ref.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  KANBAN_ASK_SECRET_PROVIDED,
  KanbanAskSecretAnswerInput,
  ProjectId,
  SecretRef,
  ThreadId,
  WS_METHODS,
  kanbanAskResponse,
  type KanbanActor,
} from "@t3tools/contracts";
import { makeLocalFileTracer, type TraceRecord } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import { featureUsage } from "../../../telemetry/FeatureUsage.ts";
import { HELD_SECRET_MAX, SecretRedeemer, makeHeldSecrets } from "../../auth/heldSecrets.ts";
import type { OwnerProvenance } from "../../auth/provenance.ts";
import { answerAskSecrets } from "../askSecrets.ts";
import { NOT_OWNER_DEVICE_MESSAGE } from "../ownerGate.ts";
import {
  askOf,
  makeFake,
  makeHttp,
  owner,
  sessionOf,
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
  answer: { verdict: "answered", values: { env: "staging" }, revision: 0, ...answer },
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
    sql
      .unsafe(`SELECT * FROM "${table.name}"`)
      .pipe(
        Effect.map((found) =>
          JSON.stringify(found, (_key, value: unknown) =>
            value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value,
          ),
        ),
      ),
  );
  return rows.join("\n");
});

/**
 * Every file under the test server's base directory, as text: its state
 * directory (the secret store, attachments, logs, settings) and its caches.
 * The database is in memory and is read by `dumpDatabase`.
 */
const dumpFiles = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(config.baseDir, { recursive: true });
  const texts = yield* Effect.forEach(names, (name) =>
    fs.readFile(path.join(config.baseDir, name)).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("utf8")),
      // A directory has no bytes of its own.
      Effect.orElseSucceed(() => ""),
    ),
  );
  // The secret store is one of the directories this walked.
  const inside =
    store.directory !== undefined &&
    !path.relative(config.baseDir, store.directory).startsWith("..");
  return { names, text: texts.join("\n"), coversSecretStore: inside };
});

/** JSON for anything a log or trace holds, bigints included. */
const text = (value: unknown) =>
  JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  ) ?? "";

/**
 * What this test reads for the value: the answer handler's reply and refusals
 * (the function `secrets.answerAsk` runs, called directly), the board's reads
 * and HTTP routes, the discussion, every thread message, every database row,
 * every file under the test server's base directory, every log record (message,
 * cause, annotations and log spans) and every span the server's own tracer
 * records. It does not go through the RPC layer: decoding, the authorization
 * and instrumentation middleware and the reply's serialization are covered by
 * the `secrets.answerAsk` case in `ws.test.ts`.
 */
it.effect(
  "a secret typed into an ask reaches the asker as a one-use ref; the value is in no handler reply, board read, stored row, file, log record or trace span",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      // The whole record a logger gets: message, cause, annotations and log spans.
      const logs: Array<string> = [];
      const logger = Logger.map(Logger.formatStructured, (record) => void logs.push(text(record)));
      // The server's own tracer, writing to memory what it would write to the trace file.
      const traced: Array<TraceRecord> = [];
      const tracer = yield* makeLocalFileTracer({
        filePath: "unused",
        maxBytes: 1_000_000,
        maxFiles: 1,
        batchWindowMs: 0,
        sink: {
          filePath: "unused",
          push: (record) => void traced.push(record),
          flush: Effect.void,
          close: () => Effect.void,
        },
      }).pipe(Effect.provide(NodeServices.layer));
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
            revision: 0,
          });
          assert.strictEqual(overHttp.status, 400);
          assert.include(text(overHttp.body), "private field");
          seen.push(["http refusal", text(overHttp.body)]);
          const without = yield* http.post("/cards/toy:1/asks/q1/answer", {
            verdict: "answered",
            values: { env: "staging" },
            revision: 0,
          });
          assert.strictEqual(without.status, 400);
          seen.push(["http refusal without it", text(without.body)]);
          for (const [name, bad, by] of [
            ["not the owner's app", input(card.id), null],
            ["a field that is not a secret", input(card.id, { env: SECRET }), ownerApp],
            ["an unknown field", input(card.id, { nope: SECRET }), ownerApp],
            ["too long", input(card.id, { token: SECRET.repeat(2000) }), ownerApp],
            ["a stale revision", input(card.id, undefined, { revision: 7 }), ownerApp],
            ["no revision", input(card.id, undefined, { revision: undefined }), ownerApp],
            [
              "a verdict the ask doesn't take",
              input(card.id, undefined, { verdict: "approved" }),
              ownerApp,
            ],
          ] as const) {
            const error = yield* answer(bad, by).pipe(Effect.flip);
            seen.push([`refusal: ${name}`, `${error.message} ${text(error)}`]);
          }
          // An answer that names no revision is refused with the one to send.
          assert.include(
            seen.find(([name]) => name === "refusal: no revision")![1],
            "It is at revision 0",
          );
          assert.isNull(askOf((yield* kanban.card(card.id)).card).closedAt);

          const before = (yield* fake.heard(threadId)).length;
          const reply = yield* answer(input(card.id), ownerApp);
          seen.push(["answer handler reply", text(reply)]);

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
          seen.push(["files under the base directory", files.text]);
          // A record logged here, to show the capture holds annotations and log spans.
          yield* Effect.logInfo("leak-probe").pipe(
            Effect.annotateLogs({ probe: "probe-annotation" }),
            Effect.withLogSpan("probe-log-span"),
          );
          seen.push(["log records", logs.join("\n")]);
          seen.push(["trace spans", text(traced)]);

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
          // The outputs were real: they do hold the rest of the answer, and what was looked
          // for in logs, spans and files was there to look through.
          const read = (name: string) => seen.find(([where]) => where === name)![1];
          assert.include(read("database"), "staging");
          assert.include(read("card detail"), '"secret":true');
          assert.include(read("log records"), "probe-annotation");
          assert.include(read("log records"), "probe-log-span");
          assert.isAbove(traced.length, 0);
          assert.isTrue(traced.some((span) => span.name.startsWith("KanbanService.")));
          assert.isTrue(files.coversSecretStore);
          assert.isAbove(files.names.length, 0);

          // The one place the value comes out: the asking thread's tool call, once.
          assert.strictEqual(yield* redeem(secrets, ref, threadId), SECRET);
          const again = yield* redeem(secrets, ref, threadId).pipe(Effect.flip);
          assert.strictEqual(again.reason, "ref_unavailable");
          assert.include(again.message, "Ask the user again");
          // Using the ref leaves the value in no log record or span either.
          assert.isFalse(text(traced).includes(SECRET), "the value shows in a span after use");
          assert.isFalse(logs.join("\n").includes(SECRET), "the value shows in a log after use");
        }),
      ).pipe(
        Effect.withTracer(tracer),
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
          // A phone paired from a Mac-made link is told how to become his; nothing is kept.
          const phone = yield* spied(input(card.id), null, sessionOf({ _tag: "paired" })).pipe(
            Effect.flip,
          );
          assert.strictEqual(phone._tag, "KanbanError");
          assert.deepInclude(phone, {
            code: "denied",
            reason: "not_owner_device",
            detail: NOT_OWNER_DEVICE_MESSAGE,
          });
          // A token or a component keeps the plain refusal.
          for (const caller of [
            { _tag: "unmarked" },
            { _tag: "component", component: "telegram-bridge" },
          ] as const) {
            const other = yield* spied(input(card.id), null, sessionOf(caller)).pipe(Effect.flip);
            assert.strictEqual(other._tag, "EnvironmentAuthorizationError", caller._tag);
          }
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
            .answerAsk(
              card.id,
              "q1",
              { verdict: "answered", text: "Use the old one.", revision: 0 },
              owner,
            )
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

it.effect(
  "an ask that requires a secret can't be handed to the evaluator, once or every time",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { card, worker } = yield* workingCard();
          const { kanban } = yield* setup;
          const http = yield* makeHttp;
          yield* kanban.askOwner(card.id, tokenAsk, worker, "cardThread");
          const evaluators = (yield* fake.evaluators).length;

          for (const body of [{}, { always: true, text: "You decide these from now on." }]) {
            const refused = yield* http.post("/cards/toy:1/asks/q1/hand", body);
            assert.strictEqual(refused.status, 400);
            assert.include(
              refused.body.error.message,
              "q1 on card #1 needs a secret (Signing secret) that only you can give",
            );
            assert.include(refused.body.error.message, "the evaluator can't answer it");
          }
          // Not handed, nobody started, nothing recorded on the ask.
          const ask = askOf((yield* kanban.card(card.id)).card);
          assert.deepStrictEqual(
            [ask.handedAt, ask.handedAlways, ask.closedAt],
            [undefined, undefined, null],
          );
          assert.strictEqual((yield* fake.evaluators).length, evaluators);
          const direct = yield* kanban
            .handAsk(card.id, "q1", "hand", owner, true)
            .pipe(Effect.flip);
          assert.strictEqual(direct.code, "invalid");

          // A secret he may leave out doesn't hold the hand back: the evaluator answers without it.
          yield* kanban.askOwner(
            card.id,
            {
              question: "Rotate the staging key now?",
              blocking: false,
              respond: {
                verdict: true,
                fields: [{ id: "key", label: "New key", type: "secret" }],
              },
            },
            { _tag: "evaluator", threadId: ThreadId.make("evaluator-main") },
            "evaluator",
          );
          const handed = yield* http.post("/cards/toy:1/asks/q2/hand", {});
          assert.strictEqual(handed.status, 200);
          assert.isString(handed.body.ask.handedAt);
        }),
      ).pipe(Effect.provide(layer(fake.layer)));
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
  // An ask edited to require a secret after it was handed: the evaluator is told to give it back.
  const card = { number: 4 } as never;
  const handed = {
    id: "q1",
    text: "Token?",
    blocking: false,
    by: { _tag: "owner" },
    at: "2026-11-10T10:00:00.000Z",
    seq: null,
    closedAt: null,
    handedAt: "2026-11-10T10:05:00.000Z",
    respond: { fields: [{ id: "token", label: "Token", type: "secret", required: true }] },
  } as never;
  const byEvaluator = Asks.answerFor(
    card,
    handed,
    { verdict: "answered", text: "ok", revision: 0 },
    { _tag: "evaluator", threadId: ThreadId.make("evaluator-main") },
    "2026-11-10T10:06:00.000Z",
  );
  assert.isTrue(Asks.isAskProblem(byEvaluator));
  if (Asks.isAskProblem(byEvaluator)) assert.include(byEvaluator.detail, "Return the ask to him");
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

it("what sees every request records nothing of this one: analytics, and a payload that fails to decode", () => {
  const payload = {
    cardId: "card-1",
    askId: "q1",
    answer: { verdict: "answered", values: { env: "staging" } },
    secrets: { token: SECRET },
  };
  // The authorization middleware hands every authorized payload to this hook.
  assert.isUndefined(featureUsage(WS_METHODS.secretsAnswerAsk, payload));

  // A malformed request is refused by the schema with the path, never what was there.
  const decode = Schema.decodeUnknownExit(KanbanAskSecretAnswerInput);
  assert.isTrue(Exit.isSuccess(decode(payload)));
  for (const bad of [
    { ...payload, answer: {} },
    { ...payload, cardId: 5 },
    { ...payload, secrets: SECRET },
    { ...payload, secrets: { token: { value: SECRET } } },
    { ...payload, secrets: { token: [SECRET] } },
    { ...payload, answer: { verdict: 1, values: { token: SECRET } } },
  ]) {
    const exit = decode(bad);
    assert.isTrue(Exit.isFailure(exit));
    assert.isFalse(`${String(exit)} ${text(exit)}`.includes(SECRET));
  }
});

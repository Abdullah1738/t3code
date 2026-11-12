// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
import { observeExit } from "./process.ts";
import { shapedFetch } from "./network.ts";
import { assertRuntime } from "./runtime.ts";
import { configureOwnerAnswerMock, ownerAnswerRoutingEvidence } from "./ownerAnswerFixture.ts";
import * as NodeSqlite from "node:sqlite";
import {
  assertOpenOwnerAsk,
  assertClosedOwnerAsk,
  mockAnswerDelivery,
  ownerAnswerCases,
  ownerAnswerRequest,
  ownerAnswerSamples,
  ownerAnswerWorkload,
} from "./ownerAnswers.ts";
import {
  assertOpenOwnerPost,
  assertPersistedOwnerPost,
  assertClosedOwnerPost,
  ownerMessagePostCases,
  ownerMessagePostInput,
  ownerMessagePostSamples,
} from "./ownerMessagePosts.ts";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
  readFileSync,
  mkdirSync,
  createWriteStream,
  statSync,
  cpSync,
  constants,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { cpus, totalmem, platform, arch } from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import {
  CommandId,
  ThreadId,
  KanbanBoardId,
  KanbanDiscussionId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import { makeWsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";
import {
  percentiles,
  phaseMetrics,
  appendLedger,
  hash,
  artifactHash,
  type Run,
} from "./metrics.ts";
const token = "synthetic-performance-credential-only";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// ext4 may fall back from FICLONE to a buffered multi-GB copy. Flush both
// inputs and clones before profiling so preparation writeback cannot contend
// with the measured WAL/checkpoint workload.
function flushFixtureDatabases(home: string) {
  try {
    for (const name of ["statev2.sqlite", "boards.sqlite", "archive.sqlite"]) {
      const path = resolve(home, "userdata", name);
      // Newly generated fixtures have not opened the history archive yet.
      if (name === "archive.sqlite" && !existsSync(path)) continue;
      const fd = openSync(path, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  } catch (cause) {
    throw Object.assign(new Error("Fixture flush failed", { cause }), {
      code: "PERF_PREPARATION_FLUSH_FAILED",
    });
  }
}
function dirtyPages() {
  if (process.platform !== "linux") return undefined;
  const memory = readFileSync("/proc/meminfo", "utf8");
  return {
    dirtyBytes: Number(memory.match(/^Dirty:\s+(\d+)/m)?.[1] ?? 0) * 1024,
    writebackBytes: Number(memory.match(/^Writeback:\s+(\d+)/m)?.[1] ?? 0) * 1024,
  };
}

export async function drive(
  home: string,
  sha: string,
  repeat: number,
  ledger: string,
  serverEntry = "apps/server/dist/bin.mjs",
  harnessHash?: string,
): Promise<Run> {
  assertRuntime();
  const attemptId = randomUUID();
  appendLedger(ledger + ".attempts", {
    attemptId,
    sha,
    repeat,
    status: "started",
    at: new Date().toISOString(),
  });
  let completed = false;
  const pristine = resolve(home);
  const runHome = mkdtempSync(resolve(tmpdir(), "robob-perf-run-"));
  let prepared = false;
  try {
    const sourceFixture = JSON.parse(readFileSync(resolve(pristine, "fixture.json"), "utf8"));
    if (sourceFixture.synthetic !== true) throw new Error("Synthetic fixture marker required");
    if (sourceFixture.version !== 3 || sourceFixture.ownerWrites !== ownerAnswerWorkload)
      throw new Error(
        "Owner-writes-v3 fixture required; upgrade retained synthetic fixtures with ownerAnswerFixture.ts",
      );
    const dirtyBefore = dirtyPages();
    const syncStarted = performance.now();
    flushFixtureDatabases(pristine);
    const sourceSyncMs = performance.now() - syncStarted;
    const cloneStarted = performance.now();
    cpSync(pristine, runHome, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => path !== resolve(pristine, "perf"),
    });
    const cloneMs = performance.now() - cloneStarted;
    const dirtyBeforeCloneSync = dirtyPages();
    const cloneSyncStarted = performance.now();
    flushFixtureDatabases(runHome);
    appendLedger(ledger + ".preparation", {
      sha,
      repeat,
      sourceSyncMs,
      cloneMs,
      cloneSyncMs: performance.now() - cloneSyncStarted,
      dirtyBefore,
      dirtyBeforeCloneSync,
      dirtyAfterCloneSync: dirtyPages(),
    });
    home = runHome;
    const fixture = JSON.parse(readFileSync(resolve(home, "fixture.json"), "utf8"));
    if (fixture.synthetic !== true) throw new Error("Synthetic fixture marker required");
    const port = await new Promise<number>((ok, fail) => {
      const s = createServer();
      s.once("error", fail);
      s.listen(0, "127.0.0.1", () => {
        const p = s.address();
        s.close(() => (typeof p === "object" && p ? ok(p.port) : fail(new Error("port"))));
      });
    });
    prepared = true;
    return await drivePrepared(port, fixture);
  } finally {
    try {
      if (!prepared)
        appendLedger(ledger + ".attempts", {
          attemptId,
          sha,
          repeat,
          status: "failed",
          stage: "prepare",
        });
    } finally {
      rmSync(runHome, { recursive: true, force: true });
    }
  }
  async function drivePrepared(
    port: number,
    fixture: { agents: number; fixtureHash: string; seed: number; scale: string },
  ): Promise<Run> {
    const origin = `http://127.0.0.1:${port}`;
    mkdirSync(resolve(home, "perf"), { recursive: true });
    const mockScript = resolve("apps/server/scripts/acp-mock-agent.ts");
    if (!existsSync(mockScript)) throw new Error("Credential-free ACP mock script required");
    configureOwnerAnswerMock(home, mockScript);
    const log = createWriteStream(resolve(home, "perf", `server-${repeat}.log`));
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=8192",
        "--import",
        resolve("packages/perf-harness/src/sampler.ts"),
        resolve(serverEntry),
        "--base-dir",
        resolve(home),
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "--mode",
        "web",
        "--dev-url",
        "http://127.0.0.1:9",
        "--no-browser",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: resolve(home),
          T3CODE_DEV_AUTH_TOKEN: token,
          T3CODE_TELEMETRY_ENABLED: "false",
          ROBOB_PERF_SAMPLE_FILE: resolve(home, "perf", `samples-${repeat}.json`),
          T3CODE_TRACE_FILE: resolve(home, "perf", `trace-${repeat}.ndjson`),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const lifetime = observeExit(child);
    const childExit = lifetime.exit;
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    const metrics: Record<string, number | null> = { rowsVisited: null };
    const gaps = [
      "Native paint/device timings unmeasured",
      "Driver body-delivery simulation: 10 Mbps / 100 ms RTT; native cursor resume unmeasured",
      "USB SSD/fsync latency unmeasured",
      "Rows visited unavailable from node:sqlite",
      "Durable commit boundary unavailable on base; response includes delivery",
      "Owner-answer delivery uses a credential-free ACP mock; live provider delivery is unmeasured",
    ];
    const requests: Record<string, number[]> = {};
    const record = (key: string, value: number) => (requests[key] ??= []).push(value);
    let operations = 0;
    const actionIds = new Set<string>();
    const answerActionIds = new Set<string>();
    const messagePostActionIds = new Set<string>();
    let consumedAsks = 0;
    let rpcAnswers = 0;
    let rpcPosts = 0,
      persistedPosts = 0,
      consumedPostAsks = 0;
    const request = async (path: string, body?: unknown, measured = true) => {
      const start = performance.now(),
        actionId = randomUUID();
      if (measured && !path.includes("websocket-ticket")) actionIds.add(actionId);
      const response = await fetch(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-robob-action-id": actionId,
          [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60000),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      operations++;
      if (!response.ok)
        throw new Error(
          `${path}: HTTP ${response.status}: ${new TextDecoder().decode(bytes).slice(0, 500)}`,
        );
      return {
        value: JSON.parse(new TextDecoder().decode(bytes)),
        bytes: bytes.byteLength,
        ms: performance.now() - start,
      };
    };
    const measure = async (key: string, run: () => Promise<{ ms: number; bytes: number }>) => {
      const r = await run();
      record(key + ".response.ms", r.ms);
      metrics[key + ".response.ms"] = r.ms;
      metrics[key + ".bytes"] = r.bytes;
    };
    let stop = false;
    const background: Promise<void>[] = [];
    let backgroundFailure: unknown;
    let httpLoadStarted = false;
    const startHttpLoad = () => {
      httpLoadStarted = true;
      for (let agent = 0; agent < fixture.agents; agent++)
        background.push(
          (async () => {
            while (!stop) {
              await request(
                `/api/ardud/kanban/discussions/synthetic-board-0-card-${1 + (agent % 3)}-discussion/messages`,
                { text: `Synthetic load ${agent}` },
                false,
              );
              await delay(500);
            }
          })(),
        );
      for (const job of background)
        void job.catch((error) => {
          backgroundFailure = error;
          stop = true;
        });
    };
    try {
      let ticket: string | undefined;
      const until = Date.now() + 120000;
      while (!ticket && Date.now() < until) {
        if (lifetime.exited)
          throw new Error(
            `Synthetic server exited ${child.exitCode}; see ${home}/perf/server-${repeat}.log`,
          );
        try {
          ticket = (await request("/api/auth/websocket-ticket", {})).value.ticket;
        } catch {
          await delay(200);
        }
      }
      if (!ticket) throw new Error("Synthetic server readiness timed out");
      await new Promise<void>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error("Profiler start timeout")), 30000);
        const started = (message: { type?: string }) => {
          if (message.type === "perf-failed") {
            clearTimeout(timer);
            fail(new Error("Sampler start failed"));
            return;
          }
          if (message.type !== "perf-started") return;
          clearTimeout(timer);
          child.off("message", started);
          ok();
        };
        child.on("message", started);
        child.send({ type: "perf-start" });
      });
      operations = 0;
      const discussionId = "synthetic-board-0-card-0-discussion";
      if (process.env.ROBOB_PERF_LEGACY_BURST === "1") {
        gaps.push("Attribution-only legacy HTTP burst before WebSocket handshake");
        startHttpLoad();
      }
      const socket = Socket.layerWebSocket(
        `${origin.replace("http:", "ws:")}/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION_TEXT}&wsTicket=${encodeURIComponent(ticket)}`,
      ).pipe(
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor, (url) => {
            const ws = new WebSocket(url);
            ws.addEventListener("message", (event) => {
              const bytes =
                typeof event.data === "string"
                  ? Buffer.byteLength(event.data)
                  : event.data instanceof ArrayBuffer
                    ? event.data.byteLength
                    : 0;
              metrics["ws.receivedPayloadBytes"] =
                (metrics["ws.receivedPayloadBytes"] ?? 0) + bytes;
            });
            return ws;
          }),
        ),
      );
      const protocol = RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* makeWsRpcProtocolClient;
          // Establish the authenticated socket before introducing HTTP contention.
          yield* client["kanban.messages"]({
            discussionId: KanbanDiscussionId.make(discussionId),
            limit: 1,
          });
          operations++;
          if (!httpLoadStarted) startHttpLoad();
          const loadFibers = yield* Effect.forEach(
            Array.from({ length: fixture.agents }, (_, i) => i),
            (agent) =>
              Effect.gen(function* () {
                let tick = 0;
                while (!stop) {
                  yield* client["orchestration.dispatchCommand"]({
                    type: "thread.metadata.update",
                    commandId: CommandId.make(randomUUID()),
                    threadId: ThreadId.make(`synthetic-thread-${agent}`),
                    title: `Synthetic activity ${agent}:${++tick}`,
                  });
                  operations++;
                  yield* Effect.sleep("500 millis");
                }
              }).pipe(Effect.forkScoped),
          );
          // Include sustained activity, not only the first admission burst.
          yield* Effect.sleep("10 seconds");
          const answerCases = ownerAnswerCases();
          const messagePostCases = ownerMessagePostCases();
          for (let sample = 0; sample < 40; sample++) {
            // HTTP requests re-run SessionStore.verify under the sustained writer
            // load above; keep their distributions separate from WS RPC timings.
            yield* Effect.promise(() => measure("auth", () => request("/api/auth/session")));
            yield* Effect.promise(() =>
              measure("threadList", () => request("/api/orchestration/shell?paged=true")),
            );

            yield* Effect.promise(() =>
              measure("boardGet", () => request("/api/ardud/kanban/boards/synthetic-board-0")),
            );
            yield* Effect.promise(() =>
              measure("discussionGet", () =>
                request(`/api/ardud/kanban/discussions/${discussionId}/messages`),
              ),
            );
            const boardId = KanbanBoardId.make("synthetic-board-0");
            const boardAction = randomUUID(),
              listAction = randomUUID(),
              discussionAction = randomUUID();
            for (const id of [boardAction, listAction, discussionAction]) actionIds.add(id);
            const startedBoards = performance.now();
            const boards = yield* Stream.runHead(
              client["kanban.boards"]({}, { headers: { "x-robob-action-id": listAction } }),
            );
            metrics["boards.response.ms"] = performance.now() - startedBoards;
            record("boards.response.ms", metrics["boards.response.ms"]!);
            operations++;
            metrics["boards.decodedBytes"] = Buffer.byteLength(JSON.stringify(boards));
            const startedBoard = performance.now();
            const board = yield* Stream.runHead(
              client["kanban.subscribe"](
                { boardId },
                { headers: { "x-robob-action-id": boardAction } },
              ),
            );
            metrics["board.response.ms"] = performance.now() - startedBoard;
            record("board.response.ms", metrics["board.response.ms"]!);
            operations++;
            metrics["board.decodedBytes"] = Buffer.byteLength(JSON.stringify(board));
            const started = performance.now();
            const messages = yield* client["kanban.messages"]({
              discussionId: KanbanDiscussionId.make(discussionId),
              limit: 50,
            }).pipe(RpcClient.withHeaders({ "x-robob-action-id": discussionAction }));
            metrics["discussion.response.ms"] = performance.now() - started;
            record("discussion.response.ms", metrics["discussion.response.ms"]!);
            operations++;
            metrics["discussion.decodedBytes"] = Buffer.byteLength(JSON.stringify(messages));
            yield* Effect.promise(() =>
              measure("post", () =>
                request(`/api/ardud/kanban/discussions/${discussionId}/messages`, {
                  text: `Synthetic repeat ${repeat}`,
                }),
              ),
            );
            yield* Effect.promise(() =>
              measure("move", () =>
                request("/api/ardud/kanban/cards/synthetic-board-0-card-3/move", {
                  to: sample % 2 === 0 ? "needs_owner" : "needs_review",
                  question: "Synthetic question",
                }),
              ),
            );
            const answer = answerCases[sample]!;
            const cardPath = `/api/ardud/kanban/cards/${answer.cardId}`;
            const messagePath = `/api/ardud/kanban/discussions/${answer.discussionId}/messages/${answer.seq}`;
            yield* Effect.promise(async () => {
              const before = await request(cardPath, undefined, false);
              const message = await request(messagePath, undefined, false);
              assertOpenOwnerAsk(answer, before.value.card, message.value);
              appendLedger(resolve(home, "perf/owner-answers.ndjson"), {
                ...answer,
                status: "open",
              });
            });
            const answerAction = randomUUID();
            actionIds.add(answerAction);
            answerActionIds.add(answerAction);
            const input = ownerAnswerRequest(answer).body;
            const startedAnswer = performance.now();
            const answerResult = yield* client["kanban.answer"]({
              discussionId: KanbanDiscussionId.make(answer.discussionId),
              ...input,
            }).pipe(
              RpcClient.withHeaders({ "x-robob-action-id": answerAction }),
              Effect.timeout("60 seconds"),
            );
            const answerMs = performance.now() - startedAnswer;
            record("answer.response.ms", answerMs);
            rpcAnswers++;
            metrics["answer.response.ms"] = answerMs;
            metrics["answer.decodedBytes"] = Buffer.byteLength(JSON.stringify(answerResult));
            operations++;
            yield* Effect.promise(async () => {
              // Candidates may acknowledge persistence before routing. Validation
              // is outside answer.response.ms and must observe eventual ask closure.
              const until = performance.now() + 15000;
              while (true) {
                const after = await request(cardPath, undefined, false);
                const saved = await request(messagePath, undefined, false);
                if (
                  after.value.card.asks.find((ask: { id: string }) => ask.id === answer.askId)
                    ?.closedAt !== null
                ) {
                  assertClosedOwnerAsk(answer, after.value.card, saved.value);
                  consumedAsks++;
                  appendLedger(resolve(home, "perf/owner-answers.ndjson"), {
                    ...answer,
                    status: "closed",
                    responseMs: requests["answer.response.ms"]!.at(-1),
                  });
                  break;
                }
                if (performance.now() >= until)
                  throw new Error(`Owner-answer sample ${sample} closure timed out`);
                await delay(50);
              }
            });
            const ownerPost = messagePostCases[sample]!;
            const postCardPath = `/api/ardud/kanban/cards/${ownerPost.cardId}`;
            const postMessagesPath = `/api/ardud/kanban/discussions/${ownerPost.discussionId}/messages`;
            yield* Effect.promise(async () => {
              const before = await request(postCardPath, undefined, false);
              const question = await request(
                `${postMessagesPath}/${ownerPost.seq}`,
                undefined,
                false,
              );
              assertOpenOwnerPost(ownerPost, before.value.card, question.value);
              appendLedger(resolve(home, "perf/owner-message-posts.ndjson"), {
                ...ownerPost,
                status: "open",
              });
            });
            const postAction = randomUUID();
            actionIds.add(postAction);
            messagePostActionIds.add(postAction);
            const startedPost = performance.now();
            const posted = yield* client["kanban.message.post"]({
              discussionId: KanbanDiscussionId.make(ownerPost.discussionId),
              ...ownerMessagePostInput(ownerPost),
            }).pipe(
              RpcClient.withHeaders({ "x-robob-action-id": postAction }),
              Effect.timeout("60 seconds"),
            );
            const postMs = performance.now() - startedPost;
            record("messagePost.response.ms", postMs);
            rpcPosts++;
            metrics["messagePost.response.ms"] = postMs;
            metrics["messagePost.decodedBytes"] = Buffer.byteLength(JSON.stringify(posted));
            operations++;
            assertPersistedOwnerPost(ownerPost, posted);
            yield* Effect.promise(async () => {
              const saved = await request(`${postMessagesPath}/${posted.seq}`, undefined, false);
              assertPersistedOwnerPost(ownerPost, saved.value);
              persistedPosts++;
              appendLedger(resolve(home, "perf/owner-message-posts.ndjson"), {
                ...ownerPost,
                status: "persisted",
                responseMs: postMs,
                returnedSeq: posted.seq,
              });
              // Persistence, ask closure and provider delivery are separate from
              // the RPC response budget when routing runs after acknowledgement.
              const until = performance.now() + 60000;
              while (true) {
                const after = await request(postCardPath, undefined, false);
                if (
                  after.value.card.asks.find((ask: { id: string }) => ask.id === ownerPost.askId)
                    ?.closedAt !== null
                ) {
                  assertClosedOwnerPost(ownerPost, after.value.card);
                  consumedPostAsks++;
                  appendLedger(resolve(home, "perf/owner-message-posts.ndjson"), {
                    ...ownerPost,
                    status: "closed",
                  });
                  break;
                }
                if (performance.now() >= until)
                  throw new Error(`Owner-post sample ${sample} closure timed out`);
                await delay(50);
              }
            });
          }
          // A successful answer RPC alone proves neither launch nor delivery.
          // Preserve separate provider evidence and leave missing delivery explicit.
          const deliveryUntil = performance.now() + 15000;
          yield* Effect.promise(async () => {
            while (performance.now() < deliveryUntil) {
              const path = resolve(home, "perf/mock-requests.ndjson");
              const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
              if (
                mockAnswerDelivery(raw).observed === ownerAnswerSamples &&
                mockAnswerDelivery(raw, messagePostCases).observed === ownerMessagePostSamples
              )
                break;
              await delay(100);
            }
          });
          yield* Effect.promise(() =>
            measure("mobile.coldFirstPage", () => request("/api/orchestration/shell?paged=true")),
          );
          const shapedPage = async () => {
            const result = await shapedFetch(() =>
              fetch(origin + "/api/orchestration/shell?paged=true", {
                headers: {
                  authorization: `Bearer ${token}`,
                  [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
                },
                signal: AbortSignal.timeout(60000),
              }),
            );
            operations++;
            return result;
          };
          yield* Effect.promise(() => measure("mobile.shapedColdFirstPage", shapedPage));
          // Suspension drops the connection/cache in this HTTP-only fallback.
          // Keep the native resume gate missing until its cursor path is driven.
          yield* Effect.sleep("1 second");
          yield* Effect.promise(() => measure("mobile.shapedFullRefreshResume", shapedPage));
          metrics["mobile.coldFirstPage.p95.ms"] = null;
          metrics["mobile.resume.p95.ms"] = null;
          stop = true;
          yield* Effect.forEach(loadFibers, Fiber.join, { discard: true });
          // Forty 10–43s posts cannot fit the old read-focused two-minute window.
          // Bound each write RPC while allowing the slow baseline to finish both families.
        }).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("90 minutes")),
      );
      stop = true;
      await Promise.all(background);
      if (backgroundFailure) throw backgroundFailure;
      metrics["wal.bytes"] = (() => {
        try {
          return statSync(resolve(home, "userdata/statev2.sqlite-wal")).size;
        } catch {
          return 0;
        }
      })();
      await new Promise<void>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error("Sampler timeout")), 30000);
        child.on("message", (message: { type?: string }) => {
          if (message.type !== "perf-stopped") return;
          clearTimeout(timer);
          ok();
        });
        child.send({ type: "perf-stop" });
      });
      const samples = JSON.parse(
        readFileSync(resolve(home, "perf", `samples-${repeat}.json`), "utf8"),
      );
      const summaries = Object.fromEntries(
        Object.entries(requests).map(([key, values]) => [key, percentiles(values)!]),
      );
      const mockLog = resolve(home, "perf/mock-requests.ndjson");
      const delivery = mockAnswerDelivery(existsSync(mockLog) ? readFileSync(mockLog, "utf8") : "");
      const postDelivery = mockAnswerDelivery(
        existsSync(mockLog) ? readFileSync(mockLog, "utf8") : "",
        ownerMessagePostCases(),
      );
      const ownerAnswers = {
        workload: ownerAnswerWorkload,
        rpcAnswers,
        consumedAsks,
        routedAsks: 0,
        launchedEvaluators: 0,
        mockProvider: "acp-local" as const,
        mockDelivered: delivery.observed,
        liveDelivery: "unmeasured" as const,
      };
      if (delivery.missing.length)
        gaps.push(`ACP mock did not receive owner-answer samples: ${delivery.missing.join(",")}`);
      const ownerMessagePosts = {
        workload: ownerAnswerWorkload,
        rpcPosts,
        persistedPosts,
        consumedAsks: consumedPostAsks,
        routedPosts: 0,
        launchedEvaluators: 0,
        mockProvider: "acp-local" as const,
        mockDelivered: postDelivery.observed,
        liveDelivery: "unmeasured" as const,
      };
      if (postDelivery.missing.length)
        gaps.push(`ACP mock did not receive owner-post samples: ${postDelivery.missing.join(",")}`);
      for (const [key, summary] of Object.entries(summaries)) {
        // Gate v2 compares the median of per-run request p95, not p50.
        metrics[key] = summary.p95;
        metrics[key + ".p50"] = summary.p50;
        metrics[key + ".p95"] = summary.p95;
      }
      metrics["wal.writeBytesPerOp"] =
        samples.walWriteBytes === null ? null : samples.walWriteBytes / operations;
      metrics["wal.writeFramesPerOp"] =
        samples.walWriteFrames === null ? null : samples.walWriteFrames / operations;
      metrics["operations"] = operations;
      metrics["eventLoop.p99.ms"] = samples.eventLoopP99Ms;
      metrics["server.rss.bytes"] = samples.rssBytes;
      metrics["eventLoop.max.ms"] = samples.eventLoopMaxMs;
      if (samples.walError) gaps.push(`WAL counters unavailable: ${samples.walError}`);
      if (samples.profileError) gaps.push(`CPU profile unavailable: ${samples.profileError}`);
      let traceFlushed = true;
      child.kill("SIGTERM");
      await Promise.race([childExit, delay(30000)]);
      if (!lifetime.exited) {
        child.kill("SIGKILL");
        gaps.push("Server required forced shutdown; trace phases unmeasured");
        traceFlushed = false;
      }
      if (traceFlushed) {
        const boardEvidence = new NodeSqlite.DatabaseSync(resolve(home, "userdata/boards.sqlite"), {
          readOnly: true,
        });
        const mainEvidence = new NodeSqlite.DatabaseSync(resolve(home, "userdata/statev2.sqlite"), {
          readOnly: true,
        });
        try {
          Object.assign(ownerAnswers, ownerAnswerRoutingEvidence(boardEvidence, mainEvidence));
          if (
            ownerAnswers.routedAsks !== ownerAnswerSamples ||
            ownerAnswers.launchedEvaluators !== 10
          )
            gaps.push(
              `Owner-answer routing incomplete: ${ownerAnswers.routedAsks}/40 recipients, ${ownerAnswers.launchedEvaluators}/10 evaluator launches`,
            );
          const postRouting = ownerAnswerRoutingEvidence(
            boardEvidence,
            mainEvidence,
            ownerMessagePostCases(),
          );
          ownerMessagePosts.routedPosts = postRouting.routedAsks;
          ownerMessagePosts.launchedEvaluators = postRouting.launchedEvaluators;
          if (
            ownerMessagePosts.routedPosts !== ownerMessagePostSamples ||
            ownerMessagePosts.launchedEvaluators !== 10
          )
            gaps.push(
              `Owner-post routing incomplete: ${ownerMessagePosts.routedPosts}/40 recipients, ${ownerMessagePosts.launchedEvaluators}/10 evaluator launches`,
            );
        } finally {
          boardEvidence.close();
          mainEvidence.close();
        }
      }
      try {
        if (!traceFlushed) throw new Error("Unflushed trace");
        const spans = readFileSync(resolve(home, "perf", `trace-${repeat}.ndjson`), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const selected = new Set<string>(
          spans.filter((s) => actionIds.has(s.attributes?.["action.id"])).map((s) => s.spanId),
        );
        let changed = true;
        while (changed) {
          changed = false;
          for (const span of spans)
            if (selected.has(span.parentSpanId) && !selected.has(span.spanId)) {
              selected.add(span.spanId);
              changed = true;
            }
        }
        const phases = phaseMetrics(spans.filter((s) => selected.has(s.spanId)));
        for (const [name, distribution] of Object.entries(phases))
          metrics[`phase.${name}.p95.ms`] = distribution?.p95 ?? null;
        for (const [family, ids] of [
          ["answer", answerActionIds],
          ["messagePost", messagePostActionIds],
        ] as const) {
          const familySpans = new Set<string>(
            spans.filter((s) => ids.has(s.attributes?.["action.id"])).map((s) => s.spanId),
          );
          for (let size = -1; size !== familySpans.size;) {
            size = familySpans.size;
            for (const span of spans)
              if (familySpans.has(span.parentSpanId)) familySpans.add(span.spanId);
          }
          for (const [name, distribution] of Object.entries(
            phaseMetrics(spans.filter((s) => familySpans.has(s.spanId))),
          ))
            metrics[`phase.${family}.${name}.p95.ms`] = distribution?.p95 ?? null;
        }
      } catch {
        gaps.push("Trace flush not available before shutdown");
      }
      appendLedger(ledger + ".environment", {
        sha,
        repeat,
        node: process.version,
        sqlite: process.versions.sqlite,
        cpu: cpus()[0]?.model,
        cpuCount: cpus().length,
        ramBytes: totalmem(),
        platform: platform(),
        arch: arch(),
      });
      const run: Run = {
        gateVersion: "paired-bootstrap-v2",
        requests,
        summaries,
        ownerAnswers,
        ownerMessagePosts,
        host: samples.host,
        workloadMode: process.env.ROBOB_PERF_LEGACY_BURST === "1" ? "legacy-burst" : "steady",
        sha,
        ...(harnessHash ? { harnessHash } : {}),
        serverHash: await artifactHash(resolve(serverEntry)),
        repeat,
        fixtureHash: fixture.fixtureHash,
        runtimeHash: hash({ node: process.version, sqlite: process.versions.sqlite }),
        hardwareHash: hash({
          cpu: cpus()[0]?.model,
          count: cpus().length,
          totalmem: totalmem(),
          platform: platform(),
          arch: arch(),
        }),
        seed: fixture.seed,
        scale: fixture.scale,
        agents: fixture.agents,
        correctness: "unmeasured",
        metrics,
        gaps,
      };
      appendLedger(ledger, run);
      completed = true;
      return run;
    } finally {
      appendLedger(ledger + ".attempts", {
        attemptId,
        sha,
        repeat,
        status: completed ? "completed" : "failed",
        at: new Date().toISOString(),
      });
      stop = true;
      await Promise.allSettled(background);
      // Preserve CPU evidence on timeouts and failed actions too.
      if (!lifetime.exited && !existsSync(resolve(home, "perf", `samples-${repeat}.json`))) {
        await new Promise<void>((ok) => {
          const timer = setTimeout(ok, 30000);
          child.once("message", () => {
            clearTimeout(timer);
            ok();
          });
          child.send({ type: "perf-stop" });
        });
      }
      if (!lifetime.exited) {
        child.kill("SIGTERM");
        await Promise.race([childExit, delay(30000)]);
        if (!lifetime.exited) {
          child.kill("SIGKILL");
          await childExit;
        }
      }
      log.end();
      cpSync(
        resolve(home, "perf"),
        resolve(ledger + ".artifacts", `repeat-${repeat}-${attemptId}`),
        {
          recursive: true,
        },
      );
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [home, sha, ledger, repeats = "10", entry = "apps/server/dist/bin.mjs"] =
    process.argv.slice(2);
  for (let i = 0; i < Number(repeats); i++) {
    try {
      console.log(await drive(home!, sha!, i, ledger!, entry));
    } catch (error) {
      appendLedger(ledger! + ".failures", {
        sha,
        repeat: i,
        status: "failed",
        error: String(error),
      });
      console.error(error);
      process.exitCode = 1;
    }
  }
}

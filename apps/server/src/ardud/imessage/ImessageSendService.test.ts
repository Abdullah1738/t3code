import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer, Tool } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ControlStore from "../control/ControlStore.ts";
import * as ImessageBridgeCli from "./ImessageBridgeCli.ts";
import * as ImessageSendHandlers from "./handlers.ts";
import * as ImessageSendService from "./ImessageSendService.ts";
import { ImessageSendToolkit } from "./tools.ts";

const HEX = "0123456789abcdef".repeat(4);

const imessageRoot = ThreadId.make("t-imessage-root");
const subagent = ThreadId.make("t-imessage-subagent");
const grandchild = ThreadId.make("t-imessage-grandchild");
const plainRoot = ThreadId.make("t-plain-root");
const plainChild = ThreadId.make("t-plain-child");
const telegramRoot = ThreadId.make("t-telegram-root");
const unmarkedChild = ThreadId.make("t-unmarked-child");
const unmarkedRoot = ThreadId.make("t-unmarked-root");

const child = (
  id: ThreadId,
  parent: ThreadId,
  root: ThreadId,
  runId = "run:child",
): OrchestrationV2ThreadShell => ({
  ...liveThreadShell(id, { activeRunId: RunId.make(runId) }),
  lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: root },
});

interface Harness {
  readonly calls: Array<ReadonlyArray<string>>;
  reply: ImessageBridgeCli.BridgeCliResult;
  runIds: Record<string, string>;
}

const makeHarness = (): Harness => ({
  calls: [],
  reply: {
    stdout: `{"id":"send:${HEX}","created":true}\n`,
    stderr: "",
    exitCode: 0,
    timedOut: false,
  },
  runIds: {},
});

const shells = (harness: Harness): Record<string, OrchestrationV2ThreadShell> => ({
  [imessageRoot]: liveThreadShell(imessageRoot, {
    activeRunId: RunId.make(harness.runIds[imessageRoot] ?? "run:root"),
  }),
  [subagent]: child(subagent, imessageRoot, imessageRoot),
  [grandchild]: child(grandchild, subagent, imessageRoot),
  [plainRoot]: liveThreadShell(plainRoot),
  [plainChild]: child(plainChild, plainRoot, plainRoot),
  [telegramRoot]: liveThreadShell(telegramRoot),
  [unmarkedRoot]: liveThreadShell(unmarkedRoot),
  [unmarkedChild]: child(unmarkedChild, unmarkedRoot, unmarkedRoot),
});

const origins: Record<string, string> = {
  [imessageRoot]: "imessage",
  [telegramRoot]: "telegram",
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const layerFor = (harness: Harness) =>
  McpHttpServer.toolkitRegistration(ImessageSendToolkit, ImessageSendHandlers.layer).pipe(
    Layer.provide(ImessageSendService.layer),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(shells(harness)[threadId] ?? null),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ControlStore.ControlStore)({
        getOrigins: (ids) =>
          Effect.succeed(
            new Map(ids.flatMap((id) => (origins[id] === undefined ? [] : [[id, origins[id]!]]))),
          ),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ImessageBridgeCli.ImessageBridgeCli, {
        run: (args) =>
          Effect.sync(() => {
            harness.calls.push(args);
            return harness.reply;
          }),
      }),
    ),
  );

const caller = (
  threadId: ThreadId,
  providerSessionId = `provider:${threadId}`,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: providerSessionId,
  thread: { threadId, providerSessionId, providerInstanceId: ProviderInstanceId.make("codex") },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const call = (scope: McpInvocationContext.McpInvocationScope, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "imessage_send", arguments: args })),
    Effect.map((result) => ({
      isError: result.isError === true,
      text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      structured: result.structuredContent as Record<string, unknown> | undefined,
    })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const run = <A, E>(harness: Harness, effect: Effect.Effect<A, E, McpServer.McpServer>) =>
  effect.pipe(Effect.scoped, Effect.provide(layerFor(harness)));

const option = (args: ReadonlyArray<string>, name: string) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

describe("imessage_send", () => {
  it("publishes an object-root, ref-free schema with keyed, non-destructive annotations", () => {
    const tool = ImessageSendToolkit.tools.imessage_send;
    const schema = Tool.getJsonSchema(tool);
    expect(schema).toMatchObject({ type: "object" });
    expect(JSON.stringify(schema)).not.toContain('"$ref"');
    expect(Object.keys((schema as { properties: object }).properties).toSorted()).toEqual([
      "effect",
      "file",
      "key",
      "session",
      "text",
      "to",
    ]);
    expect(Context.getOption(tool.annotations, Tool.Title)).toEqual(
      Option.some("Send an iMessage"),
    );
    expect(Context.get(tool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
    expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
    expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(true);
  });

  it.effect("texts the root thread's chat with a default session and key", () => {
    const harness = makeHarness();
    return run(
      harness,
      Effect.gen(function* () {
        const result = yield* call(caller(imessageRoot), { text: "on it" });
        expect(result.isError).toBe(false);
        expect(result.structured).toEqual({ id: `send:${HEX}`, created: true, chat: "owner" });
        expect(harness.calls).toHaveLength(1);
        const args = harness.calls[0]!;
        expect(args[0]).toBe("send");
        expect(option(args, "text")).toBe("on it");
        expect(option(args, "session")).toBe(imessageRoot);
        expect(option(args, "key")).toMatch(/^mcp:[a-f0-9]{40}$/);
        expect(option(args, "to")).toBeUndefined();
      }),
    );
  });

  it.effect("keys a retry the same, and the same text in a later run differently", () => {
    const harness = makeHarness();
    return run(
      harness,
      Effect.gen(function* () {
        yield* call(caller(imessageRoot), { text: "same" });
        yield* call(caller(imessageRoot), { text: "same" });
        harness.runIds[imessageRoot] = "run:next-turn";
        yield* call(caller(imessageRoot), { text: "same" });
        const keys = harness.calls.map((args) => option(args, "key"));
        expect(keys[0]).toBe(keys[1]);
        expect(keys[2]).not.toBe(keys[0]);
      }),
    );
  });

  it.effect("lets subagents and their children text the root's chat", () => {
    const harness = makeHarness();
    return run(
      harness,
      Effect.gen(function* () {
        for (const threadId of [subagent, grandchild]) {
          const result = yield* call(caller(threadId), { text: "from a child" });
          expect(result.isError, threadId).toBe(false);
        }
        expect(harness.calls.map((args) => option(args, "session"))).toEqual([
          imessageRoot,
          imessageRoot,
        ]);
      }),
    );
  });

  it.effect("refuses threads whose root is not an iMessage chat", () => {
    const harness = makeHarness();
    return run(
      harness,
      Effect.gen(function* () {
        for (const threadId of [plainRoot, plainChild, telegramRoot, unmarkedChild]) {
          const result = yield* call(caller(threadId), { text: "hello" });
          expect(result.isError, threadId).toBe(true);
          expect(result.text, threadId).toContain(
            "imessage_send only works in iMessage chat threads",
          );
        }
        expect(harness.calls).toHaveLength(0);
      }),
    );
  });

  it.effect("refuses callers outside a thread", () => {
    const harness = makeHarness();
    return run(
      harness,
      Effect.gen(function* () {
        const result = yield* call(
          {
            ...caller(imessageRoot),
            thread: undefined,
            client: { sessionId: "client", label: "client", access: "full-access" },
          },
          { text: "hello" },
        );
        expect(result.isError).toBe(true);
        expect(harness.calls).toHaveLength(0);
      }),
    );
  });

  it.effect("passes to, effect, session, key and files through", () => {
    const harness = makeHarness();
    return run(
      harness,
      Effect.gen(function* () {
        const toMoni = yield* call(caller(imessageRoot), {
          text: "hi Moni",
          to: "moni",
          session: "t-imessage-root@4",
          key: "my-key",
        });
        expect(toMoni.structured).toMatchObject({ chat: "moni" });
        expect(harness.calls[0]).toEqual([
          "send",
          "--text=hi Moni",
          "--session=t-imessage-root@4",
          "--key=my-key",
          "--to=moni",
        ]);

        yield* call(caller(imessageRoot), { text: "yay", effect: "confetti", key: "k2" });
        expect(option(harness.calls[1]!, "effect")).toBe("confetti");

        harness.reply = {
          stdout: `{"id":"file:${HEX}","created":false}`,
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
        const file = yield* call(caller(imessageRoot), { file: "/tmp/card.png", text: "today" });
        expect(file.structured).toEqual({ id: `file:${HEX}`, created: false, chat: "owner" });
        expect(harness.calls[2]![0]).toBe("send-file");
        expect(option(harness.calls[2]!, "file")).toBe("/tmp/card.png");
        expect(option(harness.calls[2]!, "text")).toBe("today");
      }),
    );
  });

  it.effect("rejects invalid input before running the CLI", () => {
    const harness = makeHarness();
    return run(
      harness,
      Effect.gen(function* () {
        const invalid: ReadonlyArray<Record<string, unknown>> = [
          {},
          { text: "   " },
          { text: "x".repeat(12_001) },
          { file: "relative/path.png" },
          { text: "hi", to: "moni", effect: "confetti" },
          { text: "hi", effect: "wobble" },
          { text: "hi", to: "Moni" },
          { text: "hi", to: "-moni" },
          { text: "hi", session: "has space" },
          { text: "hi", session: "x".repeat(201) },
          { text: "hi", key: "k".repeat(201) },
          { file: "/tmp/a.png", effect: "confetti" },
        ];
        for (const args of invalid) {
          // Schema failures come back as MCP InvalidParams, before the handler runs.
          const exit = yield* Effect.exit(call(caller(imessageRoot), args));
          const rejected = exit._tag === "Failure" || exit.value.isError;
          expect(rejected, JSON.stringify(args).slice(0, 80)).toBe(true);
        }
        expect(harness.calls).toHaveLength(0);
      }),
    );
  });

  it.effect("maps CLI failures to the CLI's own error line", () => {
    const harness = makeHarness();
    return run(
      harness,
      Effect.gen(function* () {
        harness.reply = {
          stdout: "",
          stderr: '{"error":"Bridge request failed (HTTP 403): --to only from the owner chat"}\n',
          exitCode: 1,
          timedOut: false,
        };
        const refused = yield* call(caller(imessageRoot), { text: "hi", to: "moni" });
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain(
          "Bridge request failed (HTTP 403): --to only from the owner chat",
        );

        harness.reply = { stdout: "", stderr: "", exitCode: null, timedOut: true };
        const timedOut = yield* call(caller(imessageRoot), { text: "hi" });
        expect(timedOut.isError).toBe(true);
        expect(timedOut.text).toContain("timed out after 30s");

        harness.reply = { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
        const garbled = yield* call(caller(imessageRoot), { text: "hi" });
        expect(garbled.isError).toBe(true);
        expect(garbled.text).toContain("unexpected reply");
      }),
    );
  });
});

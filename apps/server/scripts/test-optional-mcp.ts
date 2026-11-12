// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off -- isolated real CLI integration exercises Node streams, HTTP transport and process cleanup.
// Run offbox only. No credentials or existing harness homes are used.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeAssert from "node:assert/strict";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import {
  optionalMcpRegistration,
  type McpRegistrationStatus,
} from "../src/ardud/mcp/optionalRegistration.ts";

const cliArgument = process.argv[2];
NodeAssert.ok(cliArgument, "pass an isolated Claude CLI binary path");
const cliPath = NodePath.resolve(cliArgument);
const listen = async (server: ReturnType<typeof NodeHttp.createServer>) => {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  NodeAssert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
};
const model = NodeHttp.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!req.url?.includes("messages")) {
    res.writeHead(200).end("{}");
    return;
  }
  const body = JSON.parse(raw);
  const message = {
    id: "msg_isolated_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "MCP_OUTAGE_OK" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const events = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "MCP_OUTAGE_OK" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
const modelUrl = await listen(model);
try {
  for (const mode of ["refused", "hung"] as const) {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "robob-mcp-isolated-"));
    await NodeFSP.mkdir(NodePath.join(home, ".claude"));
    await NodeFSP.writeFile(
      NodePath.join(home, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true }),
    );
    let healthy = false;
    const callers: string[] = [];
    const mcp = NodeHttp.createServer(async (req, res) => {
      callers.push(String(req.headers["x-robob-thread"]));
      if (!healthy && req.url !== "/sibling") return; // accept TCP/HTTP, never answer initialize
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const frame = raw ? JSON.parse(raw) : {};
      if (frame.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        frame.method === "initialize"
          ? {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "isolated", version: "1" },
            }
          : { tools: [] };
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    });
    const mcpUrl = await listen(mcp);
    if (mode === "refused") await new Promise<void>((resolve) => mcp.close(() => resolve()));
    let offer!: (message: SDKUserMessage) => void;
    const prompt = new Promise<SDKUserMessage>((resolve) => {
      offer = resolve;
    });
    let child: ReturnType<typeof NodeChildProcess.spawn> | undefined;
    const statuses: McpRegistrationStatus[] = [];
    const runtime = query({
      prompt: (async function* () {
        yield await prompt;
        await new Promise(() => {});
      })(),
      options: {
        pathToClaudeCodeExecutable: cliPath,
        cwd: home,
        tools: [],
        strictMcpConfig: true,
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        persistSession: false,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDE_CONFIG_DIR: NodePath.join(home, ".claude"),
          ANTHROPIC_API_KEY: "isolated-fake-key",
          ANTHROPIC_BASE_URL: modelUrl,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
          MCP_TIMEOUT: "300",
        },
        spawnClaudeCodeProcess: (options) => {
          child = NodeChildProcess.spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
          });
          child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
          NodeAssert.ok(child.stdin && child.stdout);
          return Object.assign(child, { stdin: child.stdin, stdout: child.stdout });
        },
      },
    });
    const watchdog = setTimeout(() => runtime.close(), 25_000);
    const registration = optionalMcpRegistration({
      servers: mode === "hung" ? ["recall", "t3-code"] : ["recall"],
      timeoutMs: 1500,
      register: () =>
        runtime.setMcpServers({
          recall: {
            type: "http",
            url: `${mcpUrl}/mcp`,
            headers: { "X-Robob-Thread": "isolated-test", "X-Robob-Driver": "claudeAgent" },
          },
          ...(mode === "hung"
            ? {
                "t3-code": {
                  type: "http" as const,
                  url: `${mcpUrl}/sibling`,
                  headers: { "X-Robob-Thread": "isolated-test" },
                },
              }
            : {}),
        }),
      reconnect: async (servers) => {
        await Promise.allSettled(servers.map((server) => runtime.reconnectMcpServer(server)));
        const actual = await runtime.mcpServerStatus();
        return {
          errors: Object.fromEntries(
            servers
              .filter(
                (server) => actual.find((status) => status.name === server)?.status !== "connected",
              )
              .map((server) => [server, "failed"]),
          ),
        };
      },
      report: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
    });
    try {
      await Effect.runPromise(registration.attempt);
      console.log(JSON.stringify({ phase: "registered", mode, statuses }));
      NodeAssert.equal(statuses[0]?.status, "unavailable");
      if (mode === "hung")
        NodeAssert.equal(statuses[1]?.status, "available", "healthy sibling must register");
      // A timed-out registration must not block a separate SDK control request.
      await runtime.setModel("claude-sonnet-4-6");
      offer({
        type: "user",
        message: { role: "user", content: "Reply MCP_OUTAGE_OK" },
        parent_tool_use_id: null,
        session_id: "",
      });
      let answer = false;
      while (true) {
        const next = await runtime.next();
        if (next.done) break;
        const message = next.value;
        if (message.type === "assistant")
          answer ||= JSON.stringify(message.message.content).includes("MCP_OUTAGE_OK");
        if (message.type === "result") {
          NodeAssert.equal(message.is_error, false);
          break;
        }
      }
      NodeAssert.ok(answer, "turn must answer despite failed MCP");
      if (mode === "hung") {
        healthy = true;
        await Effect.runPromise(Effect.sleep(1100));
        await Effect.runPromise(registration.attempt);
        NodeAssert.equal(
          statuses.filter((status) => status.server === "recall").at(-1)?.status,
          "available",
          "recovered MCP must be re-registered",
        );
        NodeAssert.ok(callers.every((caller) => caller === "isolated-test"));
      }
      console.log(JSON.stringify({ mode, answered: true, statuses }));
    } finally {
      clearTimeout(watchdog);
      await Effect.runPromise(registration.close);
      runtime.close();
      if (child && child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          new Promise<void>((resolve) => child!.once("exit", () => resolve())),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("CLI process leaked")), 3000).unref(),
          ),
        ]);
      }
      mcp.closeAllConnections();
      mcp.close();
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  }
} finally {
  model.closeAllConnections();
  model.close();
}

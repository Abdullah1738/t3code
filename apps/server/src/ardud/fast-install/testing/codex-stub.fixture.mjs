#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
const home = process.env.CODEX_HOME;
if (!home || !NodeFS.existsSync(NodePath.join(home, ".crash-sandbox")))
  throw Error("Expected marked synthetic home");
const log = NodePath.join(home, "provider-requests.ndjson");
const stat = NodeFS.readFileSync("/proc/self/stat", "utf8");
NodeFS.appendFileSync(
  NodePath.join(home, "processes.ndjson"),
  JSON.stringify({
    pid: process.pid,
    startTime: stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19],
    executable: NodeFS.readlinkSync("/proc/self/exe"),
  }) + "\n",
);
let sequence = 0;
function nextNative(kind) {
  const file = NodePath.join(home, kind + "-sequence");
  let n = 0;
  try {
    n = Number(NodeFS.readFileSync(file, "utf8"));
  } catch {}
  NodeFS.writeFileSync(file, String(n + 1));
  return `${kind}-${n + 1}`;
}
let mcp;
// The pool may give the child a fresh process instead of reusing the root's.
// Keep this scenario boundary shared so either process follows the same plan.
const delegationStarted = NodePath.join(home, ".delegation-started");
const hasDelegated = () => NodeFS.existsSync(delegationStarted);
const mode = () => {
  try {
    return JSON.parse(NodeFS.readFileSync(NodePath.join(home, ".crash-plan"), "utf8")).mode;
  } catch {
    return null;
  }
};
const boundary = (name) => NodeFS.writeFileSync(NodePath.join(home, ".boundary"), name);
async function delegate() {
  const base = {
    method: "POST",
    headers: {
      ...mcp.http_headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
  };
  const init = await fetch(mcp.url, {
    ...base,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "crash-stub", version: "1" },
      },
    }),
  });
  const session = init.headers.get("mcp-session-id");
  await init.text();
  const headers = { ...base.headers, ...(session ? { "mcp-session-id": session } : {}) };
  const res = await fetch(mcp.url, {
    ...base,
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "delegate_task",
        arguments: {
          task: "Synthetic child request",
          mode: "wait",
          clientRequestId: "crash-child-seed-1",
          target: {
            providerInstanceId: "codex",
            model: "gpt-6.1-sol",
            options: { serviceTier: "default", reasoningEffort: "high" },
          },
        },
      },
    }),
  });
  const result = await res.text();
  NodeFS.writeFileSync(NodePath.join(home, "delegation-result.log"), result);
}
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\n");
for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  const redacted = JSON.parse(
    JSON.stringify(m.params ?? {}, (key, value) =>
      key.toLowerCase() === "http_headers" ? "[redacted]" : value,
    ),
  );
  NodeFS.appendFileSync(
    log,
    JSON.stringify({ at: Date.now(), pid: process.pid, method: m.method, params: redacted }) + "\n",
  );
  if (m.method === "thread/start") mcp = m.params?.config?.["mcp_servers.t3-code"] ?? mcp;
  const id =
    m.params?.threadId ??
    (m.method === "thread/start" ? nextNative("native") : `unused-${++sequence}`);
  if (
    m.method === "thread/start" &&
    (mode() === "preparation" || (mode() === "awaiting" && hasDelegated()))
  ) {
    boundary(mode());
    continue;
  }

  const thread = {
    id,
    projectId: null,
    sessionId: "synthetic-session",
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: home,
    cliVersion: "0.0.0",
    source: "appServer",
    gitInfo: null,
    name: null,
    turns: [],
  };
  switch (m.method) {
    case "initialize":
      reply(m.id, {
        userAgent: "crash-stub",
        codexHome: home,
        platformFamily: "unix",
        platformOs: "linux",
      });
      break;
    case "thread/start":
    case "thread/resume":
      reply(m.id, {
        thread,
        model: "gpt-6.1-sol",
        modelProvider: "openai",
        cwd: home,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "dangerFullAccess" },
        reasoningEffort: "high",
      });
      break;
    case "thread/read":
      reply(m.id, { thread });
      break;
    case "turn/start": {
      const turn = { id: nextNative("turn"), items: [], status: "inProgress", error: null };
      reply(m.id, { turn });
      process.stdout.write(
        JSON.stringify({ method: "turn/started", params: { threadId: id, turn } }) + "\n",
      );
      if (mode() === "running") boundary("running");
      if (mode() === "awaiting" || mode() === "child") {
        if (!hasDelegated()) {
          NodeFS.writeFileSync(delegationStarted, "1\n");
          void delegate().catch((e) =>
            NodeFS.writeFileSync(NodePath.join(home, "delegation-error.log"), String(e)),
          );
        } else boundary(mode());
      }
      break;
    }
    case "model/list":
      reply(m.id, { data: [], nextCursor: null });
      break;
    case "account/read":
      reply(m.id, { account: null, requiresOpenaiAuth: false });
      break;
    case "skills/list":
      reply(m.id, { data: [] });
      break;
    default:
      reply(m.id, {});
  }
}

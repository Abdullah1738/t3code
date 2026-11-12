#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const home = process.env.CODEX_HOME;
if (!home || !fs.existsSync(path.join(home, ".crash-sandbox")))
  throw Error("Expected marked synthetic home");
const log = path.join(home, "provider-requests.ndjson");
const stat = fs.readFileSync("/proc/self/stat", "utf8");
fs.appendFileSync(
  path.join(home, "processes.ndjson"),
  JSON.stringify({
    pid: process.pid,
    startTime: stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19],
    executable: fs.readlinkSync("/proc/self/exe"),
  }) + "\n",
);
let sequence = 0;
function nextNative(kind) {
  const file = path.join(home, kind + "-sequence");
  let n = 0;
  try {
    n = Number(fs.readFileSync(file, "utf8"));
  } catch {}
  fs.writeFileSync(file, String(n + 1));
  return `${kind}-${n + 1}`;
}
let mcp;
// The pool may give the child a fresh process instead of reusing the root's.
// Keep this scenario boundary shared so either process follows the same plan.
const delegationStarted = path.join(home, ".delegation-started");
const hasDelegated = () => fs.existsSync(delegationStarted);
const mode = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, ".crash-plan"), "utf8")).mode;
  } catch {
    return null;
  }
};
const boundary = (name) => fs.writeFileSync(path.join(home, ".boundary"), name);
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
  fs.writeFileSync(path.join(home, "delegation-result.log"), result);
}
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\n");
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  const redacted = JSON.parse(
    JSON.stringify(m.params ?? {}, (key, value) =>
      key.toLowerCase() === "http_headers" ? "[redacted]" : value,
    ),
  );
  fs.appendFileSync(
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
          fs.writeFileSync(delegationStarted, "1\n");
          void delegate().catch((e) =>
            fs.writeFileSync(path.join(home, "delegation-error.log"), String(e)),
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

#!/usr/bin/env node
// t3ctl: shell access to the ardud control API. Prints JSON unless --text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { ControlClient, SHARED_TOKEN_FILE, componentTokenFile } from "./client.mjs";

const TOKEN_FILE = componentTokenFile("t3ctl");

const HELP = `t3ctl <command> [options]

  login --url URL --token TOKEN        save to ~/.robob/components/t3ctl.json (chmod 600)
  health                               check the connection and token
  requests [--origin O]                pending approvals and questions everywhere
  projects                             list projects
  models                               default model and available models
  threads [--origin O] [--active] [--state S] [--since ISO] [--limit N] [--all-kinds]
  create [--prompt P] [--title T] [--dir D | --project ID] [--model M] [--instance I]
         [--variant V] [--option K=V ...] [--mode full-access|approval-required|...] [--origin O] [--plan]
         [--wait] [--timeout SECONDS]
  status THREAD                        state, run, pending requests
  native SES_ID [--driver D]           thread for an OpenCode session id (or any native id)
  identity NATIVE_ID [--driver D] [--instance I] [--agent A]
                                       resolve any native id to its exact Robob execution
  messages THREAD [--limit N] [--last] [--role user|assistant]
  send THREAD TEXT [--mode auto|queue|steer|restart] [--model M] [--instance I] [--variant V] [--option K=V ...] [--wait]
  wait THREAD [--timeout SECONDS] [--drain]
  interrupt THREAD [--expect-run RUN] [--expect-attempt ATTEMPT] [--reason TEXT]
  respond THREAD REQUEST (--approve | --deny | --always | --answer KEY=VALUE ... | --dismiss)
  origin THREAD ORIGIN|none
  set THREAD [--mode RUNTIME_MODE] [--model M] [--instance I] [--variant V] [--option K=V ...] [--title T] [--archive|--unarchive] [--settle|--unsettle]
  archive-if-idle THREAD [--session NATIVE_SESSION_ID]   exits 3 when refused (thread left alone)
  events [--thread ID] [--origin O] [--types a,b] [--after SEQ]
  desktop-lease status
  desktop-lease acquire --task ID --scope TARGET --mode native|cua-driver [--driver D --native-id ID --agent-id ID]
  desktop-lease heartbeat|release --ticket TICKET [--driver D --native-id ID --agent-id ID]
  desktop-lease reconcile --ticket TICKET --evidence TEXT   requires environment:maintain

Connection: T3_CONTROL_URL / T3_CONTROL_TOKEN, else the file named by
T3_CONTROL_TOKEN_FILE, else the first found of ${TOKEN_FILE} and
${SHARED_TOKEN_FILE}.`;

const { values: flags, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    driver: { type: "string" },
    instance: { type: "string" },
    agent: { type: "string" },
    prompt: { type: "string" },
    title: { type: "string" },
    dir: { type: "string" },
    project: { type: "string" },
    model: { type: "string" },
    variant: { type: "string" },
    option: { type: "string", multiple: true },
    mode: { type: "string" },
    origin: { type: "string" },
    plan: { type: "boolean" },
    wait: { type: "boolean" },
    drain: { type: "boolean" },
    timeout: { type: "string" },
    active: { type: "boolean" },
    state: { type: "string" },
    since: { type: "string" },
    limit: { type: "string" },
    "all-kinds": { type: "boolean" },
    last: { type: "boolean" },
    role: { type: "string" },
    approve: { type: "boolean" },
    deny: { type: "boolean" },
    always: { type: "boolean" },
    dismiss: { type: "boolean" },
    answer: { type: "string", multiple: true },
    archive: { type: "boolean" },
    unarchive: { type: "boolean" },
    settle: { type: "boolean" },
    unsettle: { type: "boolean" },
    thread: { type: "string" },
    session: { type: "string" },
    "expect-run": { type: "string" },
    "expect-attempt": { type: "string" },
    reason: { type: "string" },
    "native-id": { type: "string" },
    "agent-id": { type: "string" },
    task: { type: "string" },
    scope: { type: "string" },
    ticket: { type: "string" },
    evidence: { type: "string" },
    types: { type: "string" },
    after: { type: "string" },
    text: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...args] = positionals;
const print = (value) => console.log(JSON.stringify(value, null, 2));
const need = (value, name) => {
  if (!value) {
    console.error(`missing ${name}\n\n${HELP}`);
    process.exit(2);
  }
  return value;
};
const timeoutMs = () => (flags.timeout ? Number(flags.timeout) * 1000 : 10 * 60_000);
const modelOptions = () =>
  flags.option?.map((entry) => {
    const index = entry.indexOf("=");
    if (index <= 0 || index === entry.length - 1) {
      throw new Error("--option needs a non-empty K=V");
    }
    const id = entry.slice(0, index);
    const value = entry.slice(index + 1);
    return { id, value: value === "true" ? true : value === "false" ? false : value };
  });

async function main() {
  if (!command || flags.help) {
    console.log(HELP);
    return;
  }
  if (command === "login") {
    const url = need(flags.url, "--url");
    const token = need(flags.token ?? process.env.T3_CONTROL_TOKEN, "--token");
    NodeFS.mkdirSync(NodePath.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(TOKEN_FILE, `${JSON.stringify({ url, token }, null, 2)}\n`, {
      mode: 0o600,
    });
    NodeFS.chmodSync(TOKEN_FILE, 0o600);
    console.log(`saved ${TOKEN_FILE}`);
    return;
  }
  const client = new ControlClient({ url: flags.url, token: flags.token, component: "t3ctl" });
  switch (command) {
    case "health":
      return print(await client.health());
    case "requests":
      return print(await client.pendingRequests({ origin: flags.origin }));
    case "projects":
      return print(await client.projects());
    case "models":
      return print(await client.models());
    case "desktop-lease": {
      const action = need(args[0], "desktop-lease action");
      const path = "/desktop-lease";
      if (action === "status") return print(await client.request("GET", path));
      if (action === "reconcile")
        return print(
          await client.request("POST", `${path}/reconcile`, {
            ticket: need(flags.ticket, "--ticket"),
            evidence: need(flags.evidence, "--evidence"),
          }),
        );
      if (!["acquire", "heartbeat", "release"].includes(action)) {
        console.error(`unknown desktop-lease action ${action}`);
        process.exit(2);
      }
      const envCaller = process.env.CODEX_THREAD_ID
        ? { driver: "codex", nativeId: process.env.CODEX_THREAD_ID }
        : process.env.OPENCODE_SESSION_ID
          ? { driver: "opencode", nativeId: process.env.OPENCODE_SESSION_ID }
          : null;
      const explicit = flags.driver !== undefined || flags["native-id"] !== undefined;
      const caller = explicit ? { driver: flags.driver, nativeId: flags["native-id"] } : envCaller;
      if (!caller?.driver || !caller.nativeId) {
        console.error("no caller identity");
        process.exit(2);
      }
      const identity = { ...caller, ...(flags["agent-id"] ? { agentId: flags["agent-id"] } : {}) };
      if (action === "acquire")
        return print(
          await client.request("POST", `${path}/acquire`, {
            ...identity,
            taskId: need(flags.task, "--task"),
            scope: need(flags.scope, "--scope"),
            mode: need(flags.mode, "--mode"),
          }),
        );
      return print(
        await client.request("POST", `${path}/${action}`, {
          ...identity,
          ticket: need(flags.ticket, "--ticket"),
        }),
      );
    }
    case "threads": {
      const result = await client.listThreads({
        origin: flags.origin,
        active: flags.active,
        state: flags.state,
        updatedSince: flags.since,
        limit: flags.limit,
        includeSubagents: flags["all-kinds"],
      });
      if (flags.text) {
        for (const thread of result.threads) {
          console.log(
            `${thread.threadId}\t${thread.state}\t${thread.origin ?? "-"}\t${thread.title}`,
          );
        }
        return;
      }
      return print(result);
    }
    case "create": {
      const created = await client.createThread({
        prompt: flags.prompt,
        title: flags.title,
        ...(flags.dir ? { directory: flags.dir } : {}),
        ...(flags.project ? { projectId: flags.project } : {}),
        model: flags.model,
        variant: flags.variant,
        providerInstanceId: flags.instance,
        options: modelOptions(),
        runtimeMode: flags.mode,
        origin: flags.origin,
        ...(flags.plan ? { interactionMode: "plan" } : {}),
      });
      if (!flags.wait) return print(created);
      const waited = await client.wait(created.threadId, { timeoutMs: timeoutMs() });
      if (flags.text) return console.log(waited.lastAssistant?.text ?? "");
      return print({ ...created, ...waited });
    }
    case "status":
      return print(await client.thread(need(args[0], "THREAD")));
    case "native":
      return print(
        await client.threadByNativeSession(need(args[0], "SES_ID"), { driver: flags.driver }),
      );
    case "identity":
      return print(
        await client.identity(need(args[0], "NATIVE_ID"), {
          driver: flags.driver,
          instance: flags.instance,
          agentId: flags.agent,
        }),
      );
    case "messages": {
      const threadId = need(args[0], "THREAD");
      const result = await client.messages(threadId, {
        limit: flags.limit,
        role: flags.role,
      });
      if (flags.last) {
        return flags.text
          ? console.log(result.lastAssistant?.text ?? "")
          : print(result.lastAssistant);
      }
      return print(result);
    }
    case "send": {
      const threadId = need(args[0], "THREAD");
      const sent = await client.send(threadId, need(args.slice(1).join(" "), "TEXT"), {
        mode: flags.mode,
        model: flags.model,
        variant: flags.variant,
        providerInstanceId: flags.instance,
        options: modelOptions(),
      });
      if (!flags.wait) return print(sent);
      const waited = await client.wait(threadId, { timeoutMs: timeoutMs(), runId: sent.runId });
      if (flags.text) return console.log(waited.lastAssistant?.text ?? "");
      return print({ ...sent, ...waited });
    }
    case "wait": {
      const waited = await client.wait(need(args[0], "THREAD"), {
        timeoutMs: timeoutMs(),
        drain: flags.drain,
      });
      if (flags.text) return console.log(waited.lastAssistant?.text ?? "");
      return print(waited);
    }
    case "interrupt":
      return print(
        await client.interrupt(need(args[0], "THREAD"), {
          expectedRunId: flags["expect-run"],
          expectedAttemptId: flags["expect-attempt"],
          reason: flags.reason,
        }),
      );
    case "respond": {
      const threadId = need(args[0], "THREAD");
      const requestId = need(args[1], "REQUEST");
      const answers = flags.answer?.length
        ? Object.fromEntries(
            flags.answer.map((entry) => {
              const index = entry.indexOf("=");
              return index < 0 ? [entry, ""] : [entry.slice(0, index), entry.slice(index + 1)];
            }),
          )
        : undefined;
      const decision = flags.approve
        ? "approve"
        : flags.deny
          ? "deny"
          : flags.always
            ? "always"
            : undefined;
      return print(
        await client.respond(threadId, requestId, {
          ...(decision ? { decision } : {}),
          ...(answers ? { answers } : {}),
          ...(flags.dismiss ? { dismiss: true } : {}),
        }),
      );
    }
    case "origin": {
      const origin = need(args[1], "ORIGIN");
      return print(
        await client.setOrigin(need(args[0], "THREAD"), origin === "none" ? null : origin),
      );
    }
    case "set":
      if (flags.settle && flags.unsettle) {
        console.error("pick one of --settle or --unsettle");
        process.exit(2);
      }
      return print(
        await client.updateThread(need(args[0], "THREAD"), {
          runtimeMode: flags.mode,
          model: flags.model,
          variant: flags.variant,
          providerInstanceId: flags.instance,
          options: modelOptions(),
          title: flags.title,
          ...(flags.archive ? { archived: true } : flags.unarchive ? { archived: false } : {}),
          ...(flags.settle ? { settled: true } : flags.unsettle ? { settled: false } : {}),
        }),
      );
    case "archive-if-idle": {
      const result = await client.archiveIfIdle(need(args[0], "THREAD"), {
        expectedSession: flags.session,
      });
      print(result);
      if (!result?.archived) process.exitCode = 3;
      return;
    }
    case "events": {
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      process.once("SIGTERM", () => controller.abort());
      for await (const event of client.events({
        signal: controller.signal,
        threadId: flags.thread,
        origin: flags.origin,
        types: flags.types?.split(","),
        after: flags.after === undefined ? undefined : Number(flags.after),
        onError: (error) => console.error(`events: ${error.message ?? error}`),
      })) {
        console.log(JSON.stringify(event));
      }
      return;
    }
    default:
      console.error(`unknown command ${command}\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((error) => {
  console.error(error.code ? `${error.code}: ${error.message}` : (error.message ?? String(error)));
  process.exit(1);
});

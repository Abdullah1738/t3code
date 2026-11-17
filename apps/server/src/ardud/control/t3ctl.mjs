#!/usr/bin/env node
// t3ctl: shell access to the ardud control API. Prints JSON unless --text.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { ControlClient, SHARED_TOKEN_FILE, componentTokenFile } from "./client.mjs";
import { runDeepHealthCli } from "./deep-health-cli.mjs";
import { runLiveCli } from "./t3ctl-live-cli.mjs";
export { checkLive } from "./live-check.mjs";

import { ignoreMacosTypeOfServiceEinval } from "./control-qos.mjs";
export { ignoreMacosTypeOfServiceEinval } from "./control-qos.mjs";

ignoreMacosTypeOfServiceEinval();

const TOKEN_FILE = componentTokenFile("t3ctl");

const HELP = `t3ctl <command> [options]

  login --url URL --token TOKEN        save to ~/.robob/components/t3ctl.json (chmod 600)
  health [--deep] [--json]              connection/token; deep: lag + real state read (10s bound)
  live SHA-OR-REF [--repo PATH] [--timeout SECONDS]
                                       check running build ancestry (20s total, health <=10s)
  requests [--origin O]                pending approvals and questions everywhere
  projects                             list projects
  models                               default model and available models
  usage --since ISO|MS [--until ISO|MS] [--board ID] [--limit N] [--all-pages]
        [--cursor CURSOR] [--timeout-ms MS]  per-page deadline (default 30000ms)
        --all-pages defaults to 1000 rows per page
  threads [--origin O] [--active] [--state S] [--since ISO] [--limit N] [--cursor C] [--all-kinds]
  create [--prompt P] [--title T] [--dir D | --project ID] [--model M] [--instance I]
         [--variant V] [--option K=V ...] [--mode full-access|approval-required|...] [--origin O] [--plan]
         [--wait] [--timeout SECONDS]
  status THREAD                        state, run, pending requests
  native SES_ID [--driver D] [--view owner]
                                       thread for a native session id
  identity NATIVE_ID [--driver D] [--instance I] [--agent A]
                                       resolve any native id to its exact Robob execution
  messages THREAD [--limit N] [--last] [--role user|assistant]
  send THREAD TEXT [--request-id ID] [--mode auto|queue|steer|restart] [--model M] [--instance I] [--variant V] [--option K=V ...] [--wait]
  wait THREAD [--timeout SECONDS] [--drain]
  interrupt THREAD [--expect-run RUN] [--expect-attempt ATTEMPT] [--reason TEXT]
  respond THREAD REQUEST (--approve | --deny | --always | --answer KEY=VALUE ... | --dismiss)
  origin THREAD ORIGIN|none
  set THREAD [--mode RUNTIME_MODE] [--model M] [--instance I] [--variant V] [--option K=V ...] [--title T] [--archive|--unarchive] [--settle|--unsettle]
  archive-if-idle THREAD [--session NATIVE_SESSION_ID]   exits 3 when refused (thread left alone)
  events [--thread ID] [--origin O] [--types a,b] [--after SEQ]
  desktop-lease status
  harness-cutover plan|run|status       plan, start/resume the paced job, or inspect cutover
  desktop-lease acquire --task ID --scope TARGET --mode native|cua-driver [--driver D --native-id ID --agent-id ID]
  desktop-lease heartbeat|release --ticket TICKET [--driver D --native-id ID --agent-id ID]
  desktop-lease reconcile --ticket TICKET --evidence TEXT   requires environment:maintain

Global: --request-timeout SECONDS      HTTP request deadline (default 30s for ordinary requests)
Send uses a new request ID unless --request-id is supplied. On a send timeout or
abort it exits 4 and prints a safe retry with the same ID and send options.
It also prints that retry after a connection drops before the response.
Keep the same credentials when retrying; an explicit --token is never printed.
For a URL containing credentials or a query, set T3CTL_RETRY_URL before retrying.
Use -- before a thread or text beginning with -.
--request-timeout also limits wait requests and event streams when supplied;
--timeout controls live's total deadline or how long the server waits for a thread.

Connection: T3_CONTROL_URL / T3_CONTROL_TOKEN, else the file named by
T3_CONTROL_TOKEN_FILE, else the first found of ${TOKEN_FILE} and
${SHARED_TOKEN_FILE}.`;

const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

export async function readUsage(
  client,
  filters,
  { allPages = false, timeoutMs = client.timeoutMs ?? 30_000 } = {},
) {
  const items = [];
  const seen = new Set(filters.cursor ? [filters.cursor] : []);
  let cursor = filters.cursor;
  let first;
  let pageNumber = 1;
  while (true) {
    let page;
    try {
      page = await client.usage({ ...filters, cursor }, { timeoutMs });
      if (
        !page ||
        !Array.isArray(page.items) ||
        (page.nextCursor !== null && typeof page.nextCursor !== "string")
      ) {
        throw new Error("invalid usage page");
      }
      if (allPages && page.nextCursor !== null && seen.has(page.nextCursor)) {
        throw new Error("usage pagination returned a repeated cursor");
      }
    } catch (cause) {
      const failure =
        cause?.name === "AbortError" || cause?.name === "TimeoutError"
          ? `timed out after ${timeoutMs} ms`
          : `failed: ${cause?.code ? `${cause.code}: ` : ""}${cause?.message ?? String(cause)}`;
      const resume = cursor
        ? `resume with --cursor ${shellQuote(cursor)}`
        : "retry without --cursor";
      throw new Error(
        `usage page ${pageNumber} ${failure}; cursor ${cursor ?? "<start>"}; ${items.length} items read; ${resume}`,
        { cause },
      );
    }
    first ??= page;
    if (!allPages) return page;
    items.push(...page.items);
    if (page.nextCursor === null) return { ...first, items, nextCursor: null };
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
    pageNumber++;
  }
}
const shellOption = (name, value) =>
  value.startsWith("-") ? `--${name}=${shellQuote(value)}` : `--${name} ${shellQuote(value)}`;

function sendRetry(flags, threadId, text, requestId, token) {
  const retry = ["t3ctl", "send"];
  const threadNeedsSeparator = threadId.startsWith("-");
  if (!threadNeedsSeparator) retry.push(shellQuote(threadId));
  retry.push(shellOption("request-id", requestId));
  if (flags.url !== undefined) {
    let sensitiveUrl;
    try {
      const url = new URL(flags.url);
      sensitiveUrl = Boolean(url.username || url.password || url.search || url.hash);
    } catch {
      sensitiveUrl = true;
    }
    if (token && (flags.url.includes(token) || flags.url.includes(encodeURIComponent(token)))) {
      sensitiveUrl = true;
    }
    retry.push(
      sensitiveUrl
        ? '--url "${T3CTL_RETRY_URL:?set T3CTL_RETRY_URL to the original control URL}"'
        : shellOption("url", flags.url),
    );
  }
  for (const name of ["request-timeout", "mode", "model", "instance", "variant", "timeout"]) {
    if (flags[name] !== undefined) retry.push(shellOption(name, flags[name]));
  }
  for (const option of flags.option ?? []) retry.push(shellOption("option", option));
  if (flags.wait) retry.push("--wait");
  if (flags.text) retry.push("--text");
  retry.push("--");
  if (threadNeedsSeparator) retry.push(shellQuote(threadId));
  retry.push(shellQuote(text));
  return retry.join(" ");
}

function transportRetry(error) {
  for (let cause = error; cause; cause = cause.cause) {
    if (
      cause.name === "AbortError" ||
      cause.name === "TimeoutError" ||
      cause.code === "UND_ERR_ABORTED" ||
      cause.code === "UND_ERR_CONNECT_TIMEOUT" ||
      cause.code === "UND_ERR_HEADERS_TIMEOUT" ||
      cause.code === "UND_ERR_BODY_TIMEOUT"
    ) {
      return true;
    }
  }
  return false;
}

function transportDisconnected(error) {
  for (let cause = error; cause; cause = cause.cause) {
    if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(cause.code)) return true;
  }
  return false;
}

async function main() {
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
      repo: { type: "string" },
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
      "request-timeout": { type: "string" },
      "timeout-ms": { type: "string" },
      "request-id": { type: "string" },
      active: { type: "boolean" },
      state: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      board: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      "all-pages": { type: "boolean" },
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
      view: { type: "string" },
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
      deep: { type: "boolean" },
      json: { type: "boolean" },
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
  if (command === "live") {
    const commit = need(args[0], "SHA-OR-REF");
    const seconds = flags.timeout === undefined ? 20 : Number(flags.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_481_647) {
      throw new Error("--timeout must be a positive number of seconds");
    }
    const budget = Math.max(1, Math.round(seconds * 1000));
    runLiveCli({ commit, repo: flags.repo, url: flags.url, token: flags.token, timeoutMs: budget });
    return;
  }
  let requestTimeoutMs;
  if (flags["request-timeout"] !== undefined) {
    const seconds = Number(flags["request-timeout"]);
    if (
      flags["request-timeout"].trim() === "" ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds * 1000 > 2_147_483_647
    ) {
      throw new Error("--request-timeout must be a positive number of seconds");
    }
    requestTimeoutMs = Math.max(1, Math.round(seconds * 1000));
  }
  if (command === "health" && flags.deep) {
    runDeepHealthCli({
      url: flags.url,
      token: flags.token,
      timeoutMs: requestTimeoutMs,
      json: flags.json,
    });
    return;
  }
  const client = new ControlClient({
    url: flags.url,
    token: flags.token,
    component: "t3ctl",
    timeoutMs: requestTimeoutMs,
  });
  if (requestTimeoutMs !== undefined && command !== "usage") {
    // wait() normally gives its long-poll an extra 30s; an explicit deadline wins.
    const request = client.request.bind(client);
    client.request = (method, path, body, options = {}) =>
      request(method, path, body, { ...options, timeoutMs: requestTimeoutMs });
  }
  switch (command) {
    case "health":
      return print(await client.health());
    case "requests":
      return print(await client.pendingRequests({ origin: flags.origin }));
    case "projects":
      return print(await client.projects());
    case "models":
      return print(await client.models());
    case "usage": {
      const pageTimeoutMs =
        flags["timeout-ms"] === undefined
          ? (requestTimeoutMs ?? 30_000)
          : Number(flags["timeout-ms"]);
      if (
        !Number.isSafeInteger(pageTimeoutMs) ||
        pageTimeoutMs < 1 ||
        pageTimeoutMs > 2_147_483_647
      ) {
        throw new Error(
          "--timeout-ms must be a positive integer of at most 2147483647 milliseconds",
        );
      }
      const filters = {
        since: need(flags.since, "--since"),
        until: flags.until,
        boardId: flags.board,
        limit: flags.limit ?? (flags["all-pages"] ? "1000" : undefined),
        cursor: flags.cursor,
      };
      return print(
        await readUsage(client, filters, {
          allPages: flags["all-pages"],
          timeoutMs: pageTimeoutMs,
        }),
      );
    }
    case "harness-cutover": {
      const action = need(args[0], "harness-cutover action");
      if (!["plan", "run", "status"].includes(action))
        throw new Error(`unknown harness-cutover action ${action}`);
      const result = await client.request(
        action === "run" ? "POST" : "GET",
        `/harness-cutover/${action}`,
        action === "run" ? {} : undefined,
      );
      print(result);
      if (action === "run" && result?.cutover?.refusals?.length > 0) process.exitCode = 3;
      return;
    }
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
        cursor: flags.cursor,
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
        await client.threadByNativeSession(need(args[0], "SES_ID"), {
          driver: flags.driver,
          view: flags.view,
        }),
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
      const text = need(args.slice(1).join(" "), "TEXT");
      const requestId =
        flags["request-id"] === undefined
          ? NodeCrypto.randomUUID()
          : need(flags["request-id"], "--request-id");
      const controller = new AbortController();
      const abort = () => controller.abort();
      const request = client.request.bind(client);
      client.request = (method, path, body, options = {}) =>
        request(method, path, body, { ...options, signal: controller.signal });
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      let sent;
      try {
        sent = await client.send(threadId, text, {
          mode: flags.mode,
          model: flags.model,
          variant: flags.variant,
          providerInstanceId: flags.instance,
          options: modelOptions(),
          clientRequestId: requestId,
        });
      } catch (error) {
        const timedOut = controller.signal.aborted || transportRetry(error);
        if (timedOut || transportDisconnected(error)) {
          console.error(
            `send ${timedOut ? "timed out" : "connection dropped"}; it may or may not have been delivered. Retry safely with: ${sendRetry(flags, threadId, text, requestId, client.token)}`,
          );
          process.exitCode = 4;
          return;
        }
        throw error;
      } finally {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
        client.request = request;
      }
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
      const timeout =
        requestTimeoutMs === undefined ? undefined : AbortSignal.timeout(requestTimeoutMs);
      for await (const event of client.events({
        signal: timeout ? AbortSignal.any([controller.signal, timeout]) : controller.signal,
        threadId: flags.thread,
        origin: flags.origin,
        types: flags.types?.split(","),
        after: flags.after === undefined ? undefined : Number(flags.after),
        onError: (error) => console.error(`events: ${error.message ?? error}`),
      })) {
        console.log(JSON.stringify(event));
      }
      if (timeout?.aborted && !controller.signal.aborted) throw timeout.reason;
      return;
    }
    default:
      console.error(`unknown command ${command}\n\n${HELP}`);
      process.exit(2);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      error.code ? `${error.code}: ${error.message}` : (error.message ?? String(error)),
    );
    process.exitCode = process.argv[2] === "live" ? 2 : 1;
  });
}

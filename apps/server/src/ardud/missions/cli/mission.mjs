#!/usr/bin/env node
// mission: shell access to Robob missions over the control API
// (/api/ardud/missions/desk). Prints JSON unless --text. Read-only except
// answers, draft decisions and owner requests, which need the owner's
// iMessage inbound id.
// Every other write goes through the mission_* MCP tools: HTTP cannot prove
// which thread is calling.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { ControlApiError, DEFAULT_TOKEN_FILE, discoverConfig } from "../../control/client.mjs";

const PREFIX = "/api/ardud/missions/desk";

const HELP = `mission <command> [options]

  missions                                  list missions
  status [MISSION]                          one mission's desk, or all missions
  digest MISSION [--since 6h|ISO]           what happened since (default 24h)
  asks [--mission M] [--open | --status S]  asks, newest first
  ask show ASK
  ask answer ASK (--option ID | --text T) --via imessage --inbound ID
  drafts [--mission M] [--status pending,rewrite-requested]
  draft approve DRAFT [--edit TEXT] --via imessage --inbound ID
  draft rewrite DRAFT --note TEXT --via imessage --inbound ID
  draft drop DRAFT --via imessage --inbound ID
  requests MISSION [--status waiting-on-master|answered|settled]
  request open MISSION --text T --via imessage --inbound ID
  request reply REQUEST --text T --via imessage --inbound ID
  events MISSION [--after SEQ] [--limit N]
  watch MISSION --on KINDS [--interval SECONDS]   prints the robob-watch command
  watch-check MISSION --on KINDS --cursor FILE    one watcher tick: prints new matches only

Watch kinds: ask-opened, ask-answered, draft-opened, suggestion-opened, fork-closed,
milestone-at-risk, lane-stalled, swarm-paused.

Answers, approvals and owner requests are refused unless the inbound id is a
real iMessage from the owner's or Moni's chat that says the same thing.

Everything else that changes a mission (plan, lanes, approvals, rules, asks,
forks) goes through the mission_* MCP tools from the calling thread, never this
CLI: HTTP cannot prove which thread is calling.

Connection: T3_CONTROL_URL / T3_CONTROL_TOKEN, or ${DEFAULT_TOKEN_FILE}.`;

const { values: flags, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    mission: { type: "string" },
    open: { type: "boolean" },
    status: { type: "string" },
    since: { type: "string" },
    option: { type: "string" },
    text: { type: "string" },
    via: { type: "string" },
    inbound: { type: "string" },
    edit: { type: "string" },
    note: { type: "string" },
    after: { type: "string" },
    limit: { type: "string" },
    on: { type: "string" },
    interval: { type: "string" },
    cursor: { type: "string" },
    pretty: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...args] = positionals;
const print = (value) => console.log(JSON.stringify(value, null, 2));
const fail = (message) => {
  console.error(message);
  process.exit(2);
};
const need = (value, name) =>
  value === undefined || value === "" ? fail(`missing ${name}`) : value;
const query = (params) => {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== "");
  return entries.length === 0 ? "" : `?${new URLSearchParams(entries).toString()}`;
};
const id = (value, name) => encodeURIComponent(need(value, name));

async function request(method, path, body) {
  const { url, token } = discoverConfig({ url: flags.url, token: flags.token });
  const response = await fetch(`${url}${PREFIX}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON bodies only come from proxies or crashes.
  }
  if (!response.ok || data?.ok === false) {
    throw new ControlApiError(
      response.status,
      data?.error?.code ?? "http_error",
      data?.error?.message ?? `HTTP ${response.status}`,
    );
  }
  return data;
}

/** The owner's voice over the CLI is always an iMessage the server re-reads. */
function ownerInbound() {
  if (flags.via !== "imessage") fail("--via imessage is required: only the owner can decide this");
  return need(flags.inbound, "--inbound (the spectrum inbound id of his message)");
}

const eventLine = (event) => {
  const subject = event.subject ? ` [${event.subject.kind} ${event.subject.id}]` : "";
  return `#${event.seq} ${event.kind}${subject} ${event.summary}`;
};

// One robob-watch tick. The first run only records the current seq, so a new
// watcher never replays history; later runs print matches (which wakes the
// agent) and advance the cursor. Nothing printed means nothing to wake for.
async function watchCheck(missionId) {
  const cursorFile = need(flags.cursor, "--cursor");
  const on = need(flags.on, "--on");
  let after;
  try {
    after = NodeFS.readFileSync(cursorFile, "utf8").trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const result = await request("GET", `/watch${query({ mission: missionId, on, after })}`);
  NodeFS.mkdirSync(NodePath.dirname(cursorFile), { recursive: true });
  NodeFS.writeFileSync(cursorFile, `${result.latestSeq}\n`);
  if (result.matches.length === 0) return;
  console.log(`Mission ${missionId}: ${result.matches.length} new (${on})`);
  for (const event of result.matches) console.log(eventLine(event));
}

async function main() {
  if (flags.help || command === undefined || command === "help") {
    console.log(HELP);
    return;
  }
  switch (command) {
    case "missions":
      return print(await request("GET", "/missions"));
    case "status":
      return print(await request("GET", `/status${query({ mission: args[0] ?? flags.mission })}`));
    case "digest": {
      const result = await request(
        "GET",
        `/digest${query({ mission: need(args[0] ?? flags.mission, "MISSION"), since: flags.since })}`,
      );
      if (flags.pretty) {
        console.log(`Since ${result.since}: ${result.events.length} events`);
        for (const event of result.events) console.log(eventLine(event));
        return;
      }
      return print(result);
    }
    case "asks":
      return print(
        await request(
          "GET",
          `/asks${query({ mission: flags.mission, status: flags.open ? "open" : flags.status })}`,
        ),
      );
    case "ask": {
      const [action, askId] = args;
      if (action === "show") return print(await request("GET", `/asks/${id(askId, "ASK")}`));
      if (action === "answer") {
        if (flags.option === undefined && flags.text === undefined) {
          fail("ask answer needs --option or --text");
        }
        const inboundId = ownerInbound();
        return print(
          await request("POST", `/asks/${id(askId, "ASK")}/answer`, {
            optionId: flags.option ?? null,
            text: flags.text ?? "",
            inboundId,
          }),
        );
      }
      return fail(`unknown ask action ${action ?? ""}\n\n${HELP}`);
    }
    case "drafts":
      return print(
        await request("GET", `/drafts${query({ mission: flags.mission, status: flags.status })}`),
      );
    case "draft": {
      const [action, draftId] = args;
      if (action !== "approve" && action !== "rewrite" && action !== "drop") {
        return fail(`unknown draft action ${action ?? ""}\n\n${HELP}`);
      }
      const inboundId = ownerInbound();
      return print(
        await request("POST", `/drafts/${id(draftId, "DRAFT")}/decide`, {
          action,
          inboundId,
          ...(action === "approve" && flags.edit !== undefined ? { editedText: flags.edit } : {}),
          ...(action === "rewrite" ? { rewriteNote: need(flags.note, "--note") } : {}),
        }),
      );
    }
    // ardud missions: router (owner requests)
    case "requests":
      return print(
        await request(
          "GET",
          `/requests${query({ mission: need(args[0] ?? flags.mission, "MISSION"), status: flags.status })}`,
        ),
      );
    case "request": {
      const [action, target] = args;
      if (action !== "open" && action !== "reply") {
        return fail(`unknown request action ${action ?? ""}\n\n${HELP}`);
      }
      const text = need(flags.text, "--text (his words, exactly as he sent them)");
      const inboundId = ownerInbound();
      if (action === "open") {
        return print(
          await request("POST", "/requests", {
            missionId: need(target ?? flags.mission, "MISSION"),
            text,
            inboundId,
          }),
        );
      }
      return print(
        await request("POST", `/requests/${id(target, "REQUEST")}/reply`, { text, inboundId }),
      );
    }
    // end ardud missions: router
    case "events":
      return print(
        await request(
          "GET",
          `/events${query({ mission: need(args[0] ?? flags.mission, "MISSION"), after: flags.after, limit: flags.limit })}`,
        ),
      );
    case "watch": {
      const result = await request(
        "GET",
        `/watch${query({ mission: need(args[0] ?? flags.mission, "MISSION"), on: need(flags.on, "--on"), interval: flags.interval })}`,
      );
      return print({ check: result.check, add: result.add, latestSeq: result.latestSeq });
    }
    case "watch-check":
      return watchCheck(need(args[0] ?? flags.mission, "MISSION"));
    default:
      return fail(
        `unknown command ${command}. Mission writes use the mission_* MCP tools.\n\n${HELP}`,
      );
  }
}

main().catch((error) => {
  console.error(error.code ? `${error.code}: ${error.message}` : (error.message ?? String(error)));
  process.exit(1);
});

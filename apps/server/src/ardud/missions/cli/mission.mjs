#!/usr/bin/env node
// mission: shell access to Robob missions over the control API
// (/api/ardud/missions/desk). Prints JSON. With the mission-cli component
// credential it reads everything the owner sees, and it acts for him only
// with the inbound id of the iMessage in which he said so.
// Every other write goes through the mission_* MCP tools: HTTP cannot prove
// which thread is calling.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  ControlApiError,
  SHARED_TOKEN_FILE,
  componentTokenFile,
  discoverConfig,
} from "../../control/client.mjs";

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
  draft show DRAFT                          full text plus attachments (paths, urls)
  requests MISSION [--status waiting-on-master|answered|settled]
  request open MISSION --text T --via imessage --inbound ID
  request reply REQUEST --text T --via imessage --inbound ID
  request settle|reopen REQUEST [--note T] --via imessage --inbound ID
  discuss KIND:ID --mission M --text T --via imessage --inbound ID
  needs [--mission M]                       what the board shows him under Needs you
  approvals MISSION [--status pending,approved]   default: pending plus recent
  approval approve|reject APPROVAL [--note T] --via imessage --inbound ID
  calls MISSION
  call react CALL --reaction ok|discuss|overruled|none [--note T] --via imessage --inbound ID
  work MISSION [--lane L] [--stage ticket,pr] [--offset N] [--limit N]
  timeline MISSION [--before SEQ] [--limit N]
  progress MISSION                          per sub-mission and milestone
  events MISSION [--after SEQ] [--limit N]
  watch MISSION --on KINDS [--id ID] [--interval SECONDS]   prints the robob-watch command
  watch-check MISSION --on KINDS [--id ID] --cursor FILE    one tick: prints new matches only
  report MISSION --chat C --text T [--file PATH] [--key K]  a chat's bug or idea to the master

report is for an iMessage chat agent: a tool or CLI broke, or something in
the chat could work better. --chat is the chat's session (its Robob thread
id) or slug (owner, moni, group-...). Put the command, error, ids and what
you tried in --text. It reaches the master as a request from that chat,
never as him, and the same report twice posts once (--key names a report you
may resend). Complaints he or Moni typed still go through
request open ... --via imessage --inbound ID.

Watch kinds: ask-opened, ask-answered, draft-opened, draft-decided,
suggestion-opened, milestone-at-risk, lane-stalled, swarm-paused,
request-replied, request-answered, approval-opened, work-item-done. --id narrows
a watch to one record (a request, approval, work item or draft).

Actions for the owner need --via imessage --inbound ID: the id of the iMessage
in which he told you to. The server checks it is a message he (or Moni) typed
after the record opened, keeps his words as the quote, and lets one message
do each action once. Pass your reading of his words as the option, text or
note; never invent an inbound id.

Everything else that changes a mission (plan, lanes, rules, asks) goes
through the mission_* MCP tools from the calling thread, never this CLI: HTTP
cannot prove which thread is calling.

Connection: T3_CONTROL_URL plus MISSION_TOKEN (the mission-cli component
credential) or T3_CONTROL_TOKEN, else the file named by T3_CONTROL_TOKEN_FILE,
else the first found of ${componentTokenFile("mission-cli")} and
${SHARED_TOKEN_FILE}. Only the mission-cli credential reads his full view
and acts for him.`;

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
    id: { type: "string" },
    interval: { type: "string" },
    reaction: { type: "string" },
    lane: { type: "string" },
    stage: { type: "string" },
    offset: { type: "string" },
    before: { type: "string" },
    cursor: { type: "string" },
    chat: { type: "string" },
    file: { type: "string" },
    key: { type: "string" },
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
  const { url, token } = discoverConfig({
    url: flags.url,
    token: flags.token ?? process.env.MISSION_TOKEN,
    component: "mission-cli",
  });
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
  const result = await request(
    "GET",
    `/watch${query({ mission: missionId, on, id: flags.id, after })}`,
  );
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
      if (action === "show") return print(await request("GET", `/drafts/${id(draftId, "DRAFT")}`));
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
      if (action === "settle" || action === "reopen") {
        const inboundId = ownerInbound();
        return print(
          await request("POST", `/requests/${id(target, "REQUEST")}/${action}`, {
            inboundId,
            ...(flags.note === undefined ? {} : { note: flags.note }),
          }),
        );
      }
      if (action !== "open" && action !== "reply") {
        return fail(`unknown request action ${action ?? ""}\n\n${HELP}`);
      }
      const text = need(flags.text, "--text (what he asked, in his words)");
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
    case "discuss": {
      // KIND:ID names the card he wants to talk about (draft:d-1, call:c-2...).
      const ref = need(args[0], "KIND:ID");
      const split = ref.indexOf(":");
      if (split <= 0 || split === ref.length - 1) fail("discuss needs KIND:ID, e.g. draft:draft-1");
      const text = need(flags.text, "--text (what he wants to discuss)");
      const inboundId = ownerInbound();
      return print(
        await request("POST", "/requests", {
          missionId: need(flags.mission, "--mission"),
          text,
          subject: { kind: ref.slice(0, split), id: ref.slice(split + 1) },
          inboundId,
        }),
      );
    }
    // end ardud missions: router
    case "needs":
      return print(await request("GET", `/needs${query({ mission: args[0] ?? flags.mission })}`));
    case "approvals":
      return print(
        await request(
          "GET",
          `/approvals${query({ mission: need(args[0] ?? flags.mission, "MISSION"), status: flags.status })}`,
        ),
      );
    case "approval": {
      const [action, approvalId] = args;
      if (action !== "approve" && action !== "reject") {
        return fail(`unknown approval action ${action ?? ""}\n\n${HELP}`);
      }
      const inboundId = ownerInbound();
      return print(
        await request("POST", `/approvals/${id(approvalId, "APPROVAL")}/decide`, {
          action,
          inboundId,
          ...(flags.note === undefined ? {} : { note: flags.note }),
        }),
      );
    }
    case "calls":
      return print(
        await request(
          "GET",
          `/calls${query({ mission: need(args[0] ?? flags.mission, "MISSION") })}`,
        ),
      );
    case "call": {
      const [action, callId] = args;
      if (action !== "react") return fail(`unknown call action ${action ?? ""}\n\n${HELP}`);
      const reaction = need(flags.reaction, "--reaction ok|discuss|overruled|none");
      if (!["ok", "discuss", "overruled", "none"].includes(reaction)) {
        fail("--reaction is ok, discuss, overruled or none");
      }
      const inboundId = ownerInbound();
      return print(
        await request("POST", `/calls/${id(callId, "CALL")}/react`, {
          reaction: reaction === "none" ? null : reaction,
          inboundId,
          ...(flags.note === undefined ? {} : { note: flags.note }),
        }),
      );
    }
    case "work":
      return print(
        await request(
          "GET",
          `/work${query({
            mission: need(args[0] ?? flags.mission, "MISSION"),
            lane: flags.lane,
            stage: flags.stage,
            offset: flags.offset,
            limit: flags.limit,
          })}`,
        ),
      );
    case "timeline":
      return print(
        await request(
          "GET",
          `/timeline${query({ mission: need(args[0] ?? flags.mission, "MISSION"), before: flags.before, limit: flags.limit })}`,
        ),
      );
    case "progress":
      return print(
        await request(
          "GET",
          `/progress${query({ mission: need(args[0] ?? flags.mission, "MISSION") })}`,
        ),
      );
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
        `/watch${query({ mission: need(args[0] ?? flags.mission, "MISSION"), on: need(flags.on, "--on"), id: flags.id, interval: flags.interval })}`,
      );
      return print({ check: result.check, add: result.add, latestSeq: result.latestSeq });
    }
    case "watch-check":
      return watchCheck(need(args[0] ?? flags.mission, "MISSION"));
    case "report": {
      const missionId = need(args[0] ?? flags.mission, "MISSION");
      const chat = need(flags.chat, "--chat (this chat's session or slug)");
      const text = need(flags.text, "--text (what broke: command, error, ids, what you tried)");
      let file;
      if (flags.file !== undefined) {
        file = NodePath.resolve(need(flags.file, "--file"));
        if (!NodeFS.existsSync(file)) fail(`--file ${file} does not exist`);
      }
      return print(
        await request("POST", "/reports", {
          missionId,
          chat,
          text,
          ...(file === undefined ? {} : { file }),
          ...(flags.key === undefined ? {} : { key: need(flags.key, "--key") }),
        }),
      );
    }
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

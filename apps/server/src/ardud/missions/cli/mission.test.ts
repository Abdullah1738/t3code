// @effect-diagnostics nodeBuiltinImport:off - the CLI under test is plain Node by design.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

const CLI = NodePath.join(import.meta.dirname, "mission.mjs");

let server: NodeHttp.Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

/** A fake desk API: records requests and answers from `reply`. */
const listen = (reply: (seen: Seen) => unknown) =>
  new Promise<{ readonly url: string; readonly seen: Seen[] }>((resolve) => {
    const seen: Seen[] = [];
    server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const entry = { method: request.method ?? "", url: request.url ?? "", body };
        seen.push(entry);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(reply(entry)));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, seen });
    });
  });

const run = (url: string, args: ReadonlyArray<string>) =>
  new Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>(
    (resolve) => {
      NodeChildProcess.execFile(
        process.execPath,
        [CLI, ...args, "--url", url, "--token", "t0k"],
        { env: { ...process.env, T3_CONTROL_TOKEN_FILE: "/nonexistent" } },
        (error, stdout, stderr) =>
          resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
      );
    },
  );

const event = (seq: number, kind: string) => ({
  seq,
  kind,
  summary: `event ${seq}`,
  subject: { kind: "ask", id: `ask-${seq}` },
});

describe("mission CLI", () => {
  it("starts a watcher at now, then prints only new matches", async () => {
    const { url, seen } = await listen(({ url: path }) =>
      path.includes("after=")
        ? path.includes("after=7")
          ? { ok: true, matches: [event(9, "ask.opened")], latestSeq: 9 }
          : { ok: true, matches: [], latestSeq: 9 }
        : { ok: true, matches: [], latestSeq: 7 },
    );
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mission-watch-"));
    const cursor = NodePath.join(dir, "mission-cursor");
    const args = ["watch-check", "m-1", "--on", "ask-opened", "--cursor", cursor];

    const first = await run(url, args);
    expect(first).toMatchObject({ code: 0, stdout: "" });
    expect(NodeFS.readFileSync(cursor, "utf8").trim()).toBe("7");

    const second = await run(url, args);
    expect(second.stdout).toContain("#9 ask.opened [ask ask-9] event 9");
    expect(NodeFS.readFileSync(cursor, "utf8").trim()).toBe("9");

    const third = await run(url, args);
    expect(third.stdout).toBe("");
    expect(seen.map((entry) => entry.url)).toEqual([
      "/api/ardud/missions/desk/watch?mission=m-1&on=ask-opened",
      "/api/ardud/missions/desk/watch?mission=m-1&on=ask-opened&after=7",
      "/api/ardud/missions/desk/watch?mission=m-1&on=ask-opened&after=9",
    ]);
  });

  it("answers only through --via imessage with an inbound id", async () => {
    const { url, seen } = await listen(() => ({ ok: true, ask: { id: "ask-1" }, released: [] }));
    const refused = await run(url, ["ask", "answer", "ask-1", "--option", "a"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--via imessage");
    expect(seen).toEqual([]);

    const answered = await run(url, [
      "ask",
      "answer",
      "ask-1",
      "--option",
      "a",
      "--via",
      "imessage",
      "--inbound",
      "spc-msg-1",
    ]);
    expect(answered.code).toBe(0);
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "/api/ardud/missions/desk/asks/ask-1/answer",
    });
    expect(JSON.parse(seen[0]!.body)).toEqual({
      optionId: "a",
      text: "",
      inboundId: "spc-msg-1",
    });
  });

  // ardud missions: router (owner requests)
  it("sends owner requests and replies only with his inbound id", async () => {
    const { url, seen } = await listen(() => ({ ok: true, request: { id: "request-1" } }));
    const refused = await run(url, ["request", "open", "m-1", "--text", "How is it going?"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--via imessage");

    const via = ["--via", "imessage", "--inbound", "spc-msg-2"];
    const opened = await run(url, ["request", "open", "m-1", "--text", "How is it going?", ...via]);
    const replied = await run(url, ["request", "reply", "request-1", "--text", "Ship it", ...via]);
    expect([opened.code, replied.code]).toEqual([0, 0]);
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "POST /api/ardud/missions/desk/requests",
      "POST /api/ardud/missions/desk/requests/request-1/reply",
    ]);
    expect(seen.map((entry) => JSON.parse(entry.body))).toEqual([
      { missionId: "m-1", text: "How is it going?", inboundId: "spc-msg-2" },
      { text: "Ship it", inboundId: "spc-msg-2" },
    ]);
  });
  // end ardud missions: router

  it("reads his full view and acts for him only with the inbound id", async () => {
    const { url, seen } = await listen(() => ({ ok: true }));
    const via = ["--via", "imessage", "--inbound", "spc-msg-3"];
    const commands = [
      ["needs"],
      ["approvals", "m-1"],
      ["calls", "m-1"],
      ["draft", "show", "draft-1"],
      ["work", "m-1", "--stage", "ticket,pr", "--limit", "5"],
      ["timeline", "m-1", "--before", "40"],
      ["progress", "m-1"],
      ["watch", "m-1", "--on", "request-replied", "--id", "request-1"],
      ["approval", "approve", "approval-1", ...via],
      ["call", "react", "call-1", "--reaction", "overruled", "--note", "keep v1", ...via],
      ["request", "settle", "request-1", ...via],
      ["request", "reopen", "request-1", "--note", "one more", ...via],
      ["discuss", "draft:draft-1", "--mission", "m-1", "--text", "tighten the intro", ...via],
    ];
    for (const args of commands) {
      const result = await run(url, args);
      expect({ args, code: result.code, stderr: result.stderr }).toEqual({
        args,
        code: 0,
        stderr: "",
      });
    }
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "GET /api/ardud/missions/desk/needs",
      "GET /api/ardud/missions/desk/approvals?mission=m-1",
      "GET /api/ardud/missions/desk/calls?mission=m-1",
      "GET /api/ardud/missions/desk/drafts/draft-1",
      "GET /api/ardud/missions/desk/work?mission=m-1&stage=ticket%2Cpr&limit=5",
      "GET /api/ardud/missions/desk/timeline?mission=m-1&before=40",
      "GET /api/ardud/missions/desk/progress?mission=m-1",
      "GET /api/ardud/missions/desk/watch?mission=m-1&on=request-replied&id=request-1",
      "POST /api/ardud/missions/desk/approvals/approval-1/decide",
      "POST /api/ardud/missions/desk/calls/call-1/react",
      "POST /api/ardud/missions/desk/requests/request-1/settle",
      "POST /api/ardud/missions/desk/requests/request-1/reopen",
      "POST /api/ardud/missions/desk/requests",
    ]);
    expect(seen.slice(8).map((entry) => JSON.parse(entry.body))).toEqual([
      { action: "approve", inboundId: "spc-msg-3" },
      { reaction: "overruled", inboundId: "spc-msg-3", note: "keep v1" },
      { inboundId: "spc-msg-3" },
      { inboundId: "spc-msg-3", note: "one more" },
      {
        missionId: "m-1",
        text: "tighten the intro",
        subject: { kind: "draft", id: "draft-1" },
        inboundId: "spc-msg-3",
      },
    ]);

    const refused = await Promise.all([
      run(url, ["approval", "approve", "approval-1"]),
      run(url, ["call", "react", "call-1", "--reaction", "fine", ...via]),
      run(url, ["discuss", "draft-1", "--mission", "m-1", "--text", "hm", ...via]),
    ]);
    expect(refused.map((result) => result.code)).toEqual([2, 2, 2]);
    expect(seen).toHaveLength(13);
  });

  it("sends his --note with a decision; a rewrite keeps it as the rewrite note", async () => {
    const { url, seen } = await listen(() => ({ ok: true }));
    const via = ["--via", "imessage", "--inbound", "spc-msg-4"];
    const commands = [
      ["ask", "answer", "ask-1", "--option", "a", "--note", "only for v2", ...via],
      ["draft", "approve", "draft-1", "--note", "drop the first sentence", ...via],
      ["draft", "rewrite", "draft-1", "--note", "start with Order:", ...via],
      ["draft", "drop", "draft-1", "--note", "Pavan already knows", ...via],
      ["approval", "reject", "approval-1", "--note", "split it first", ...via],
    ];
    for (const args of commands) {
      expect((await run(url, args)).code).toBe(0);
    }
    expect(seen.map((entry) => JSON.parse(entry.body))).toEqual([
      { optionId: "a", text: "", inboundId: "spc-msg-4", note: "only for v2" },
      { action: "approve", inboundId: "spc-msg-4", note: "drop the first sentence" },
      { action: "rewrite", inboundId: "spc-msg-4", rewriteNote: "start with Order:" },
      { action: "drop", inboundId: "spc-msg-4", note: "Pavan already knows" },
      { action: "reject", inboundId: "spc-msg-4", note: "split it first" },
    ]);
  });

  it("surfaces server refusals", async () => {
    const { url } = await listen(() => ({
      ok: false,
      error: { code: "forbidden", message: "Mission provenance-invalid: not his message." },
    }));
    const result = await run(url, [
      "draft",
      "approve",
      "draft-1",
      "--via",
      "imessage",
      "--inbound",
      "wake:x",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("forbidden: Mission provenance-invalid");
  });

  it("files a chat's report with an absolute file, and refuses a missing chat or file", async () => {
    const { url, seen } = await listen(() => ({ ok: true, report: { chat: "moni" } }));
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mission-report-"));
    NodeFS.writeFileSync(NodePath.join(dir, "noon.log"), "502");
    const session = "ardud-control:thread:abc@4";

    const sent = await new Promise<{ readonly code: number }>((resolve) => {
      NodeChildProcess.execFile(
        process.execPath,
        [
          CLI,
          "report",
          "robob",
          "--chat",
          session,
          "--text",
          "noon CLI 502 at checkout",
          "--file",
          "noon.log",
          "--key",
          "noon-502",
          "--url",
          url,
          "--token",
          "t0k",
        ],
        { cwd: dir, env: { ...process.env, T3_CONTROL_TOKEN_FILE: "/nonexistent" } },
        (error) => resolve({ code: error ? Number(error.code ?? 1) : 0 }),
      );
    });
    expect(sent.code).toBe(0);
    expect(seen.map(({ method, url: path }) => `${method} ${path}`)).toEqual([
      "POST /api/ardud/missions/desk/reports",
    ]);
    expect(JSON.parse(seen[0]!.body)).toEqual({
      missionId: "robob",
      chat: session,
      text: "noon CLI 502 at checkout",
      file: NodePath.join(NodeFS.realpathSync(dir), "noon.log"),
      key: "noon-502",
    });

    const refused = await Promise.all([
      run(url, ["report", "robob", "--text", "no chat"]),
      run(url, ["report", "robob", "--chat", session]),
      run(url, ["report", "robob", "--chat", session, "--text", "x", "--file", "/no/such/file"]),
    ]);
    expect(refused.map((result) => result.code)).toEqual([2, 2, 2]);
    expect(seen).toHaveLength(1);
  });
});

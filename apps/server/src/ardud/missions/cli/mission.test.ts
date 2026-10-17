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
});

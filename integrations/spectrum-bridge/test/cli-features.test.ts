import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EFFECT_NAMES, loadCommandPayload, parseCommand } from "../src/cli.ts";
import { EFFECTS } from "../src/photon.ts";

const session = ["--session", "s-1", "--key", "k-1"];

describe("send, poll, and app commands", () => {
  test("CLI effect names match the SDK list", () => {
    expect([...EFFECT_NAMES]).toEqual(EFFECTS);
  });

  test("send builds a /send body with optional effect and subject", () => {
    expect(parseCommand(["send", "--text", "Hi", ...session])).toEqual({ method: "POST", path: "/send",
      body: { text: "Hi", dedupeKey: "k-1", sessionId: "s-1" } });
    expect(parseCommand(["send", "--text=Hi", ...session, "--effect=confetti", "--subject", "Re"]).body)
      .toEqual({ text: "Hi", dedupeKey: "k-1", sessionId: "s-1", effect: "confetti", subject: "Re" });
  });

  test("send validates text, effect, subject, and session", () => {
    expect(() => parseCommand(["send", ...session])).toThrow("--text is required");
    expect(() => parseCommand(["send", "--text", "x".repeat(12_001), ...session])).toThrow("--text must be at most");
    expect(() => parseCommand(["send", "--text", "Hi", ...session, "--effect", "rainbow"])).toThrow("--effect must be one of slam");
    expect(() => parseCommand(["send", "--text", "Hi", ...session, "--subject", "a\nb"])).toThrow("--subject must be");
    expect(() => parseCommand(["send", "--text", "Hi", "--key", "k"])).toThrow("--session is required");
    expect(() => parseCommand(["send", "--text", "Hi", "--key", "k", "--session", "a b"])).toThrow("Invalid --session");
    expect(() => parseCommand(["send", "--text", "Hi", ...session, "--effect=slam", "--effect=loud"])).toThrow("Duplicate command option");
  });

  test("poll collects repeated options in order and validates count, length, and uniqueness", () => {
    expect(parseCommand(["poll", "--title", "Lunch?", "--option", "Pizza", "--option=Sushi", ...session])).toEqual({
      method: "POST", path: "/poll", body: { title: "Lunch?", options: ["Pizza", "Sushi"], dedupeKey: "k-1", sessionId: "s-1" } });
    const options = (count: number) => Array.from({ length: count }, (_, i) => ["--option", `o${i}`]).flat();
    expect(parseCommand(["poll", "--title", "T", ...options(12), ...session]).body?.options).toHaveLength(12);
    expect(() => parseCommand(["poll", "--title", "T", ...options(1), ...session])).toThrow("2 to 12");
    expect(() => parseCommand(["poll", "--title", "T", ...options(13), ...session])).toThrow("2 to 12");
    expect(() => parseCommand(["poll", "--title", "T", "--option", "a", "--option", "x".repeat(101), ...session])).toThrow("--option must be");
    expect(() => parseCommand(["poll", "--title", "T", "--option", "a", "--option", "a", ...session])).toThrow("distinct");
    expect(() => parseCommand(["poll", "--option", "a", "--option", "b", ...session])).toThrow("--title is required");
    expect(() => parseCommand(["poll", "--title", "T", "--title", "U", "--option", "a", "--option", "b", ...session])).toThrow("Duplicate command option");
  });

  test("wake builds a session-free /wake body and validates it", () => {
    expect(parseCommand(["wake", "--text", "Nik replied", "--source", "robob-watch nik", "--key", "nik:3"])).toEqual({
      method: "POST", path: "/wake", body: { text: "Nik replied", source: "robob-watch nik", dedupeKey: "nik:3" } });
    expect(() => parseCommand(["wake", "--source", "s", "--key", "k"])).toThrow("--text is required");
    expect(() => parseCommand(["wake", "--text", "x".repeat(12_001), "--source", "s", "--key", "k"])).toThrow("--text must be at most");
    expect(() => parseCommand(["wake", "--text", "t", "--key", "k"])).toThrow("--source is required");
    expect(() => parseCommand(["wake", "--text", "t", "--source", "a\nb", "--key", "k"])).toThrow("--source must be");
    expect(() => parseCommand(["wake", "--text", "t", "--source", "s"])).toThrow("--key is required");
    expect(() => parseCommand(["wake", "--text", "t", "--source", "s", "--key", "k", "--session", "x"])).toThrow("Invalid command arguments");
  });

  test("app requires an https URL and caption, mapping optional layout flags", () => {
    expect(parseCommand(["app", "--url", "https://apps.test/x/", "--caption", "Tracker", "--subcaption", "Today",
      "--trailing", "3", "--trailing-subcaption", "left", "--summary", "Open", ...session])).toEqual({
      method: "POST", path: "/app", body: { url: "https://apps.test/x/", caption: "Tracker", subcaption: "Today",
        trailingCaption: "3", trailingSubcaption: "left", summary: "Open", dedupeKey: "k-1", sessionId: "s-1" } });
    for (const url of ["http://apps.test/", "file:///etc/passwd", "apps.test", "https://u:p@apps.test/", "https://apps.test/a b"]) {
      expect(() => parseCommand(["app", "--url", url, "--caption", "c", ...session])).toThrow("--url must be an absolute https URL");
    }
    expect(() => parseCommand(["app", "--url", "https://apps.test/", ...session])).toThrow("--caption is required");
  });

  test("new commands pass through loadCommandPayload unchanged", async () => {
    const command = parseCommand(["poll", "--title", "T", "--option", "a", "--option", "b", ...session]);
    expect(await loadCommandPayload(command)).toEqual(command.body!);
  });

  test("app --to keeps the caller session and validates the recipient slug", async () => {
    const args = ["app", "--url", "https://ride.example.com/", "--caption", "Your ride", ...session];
    const command = parseCommand([...args, "--to", "moni", "--summary", "Open ride"]);
    expect(await loadCommandPayload(command)).toEqual({ url: "https://ride.example.com/", caption: "Your ride",
      dedupeKey: "k-1", sessionId: "s-1", to: "moni", summary: "Open ride" });
    for (const to of ["", "Moni", "../moni", "moni name", "x".repeat(101)]) {
      expect(() => parseCommand([...args, "--to", to])).toThrow("Invalid chat slug");
    }
    expect(() => parseCommand([...args, "--to", "moni", "--to", "owner"])).toThrow("Duplicate command option");
    expect(() => parseCommand(["app", "--url", "https://ride.example.com/", "--caption", "Your ride", "--key", "k", "--to", "moni"]))
      .toThrow("--session is required");
  });

  test("the CLI prints only the queue acknowledgement and hides response bodies", async () => {
    const home = await fs.mkdtemp(join(os.tmpdir(), "spectrum-cli-features-"));
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const socket = join(home, "s.sock");
    const id = "poll:" + "b".repeat(64);
    const requests: { path?: string; body: unknown }[] = [];
    let status = 202;
    let reply: unknown = { id, created: true, extra: "PRIVATE" };
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
      const run = async () => {
        const child = Bun.spawn([process.execPath, "run", cli, "poll", "--title", "T", "--option", "a", "--option", "b", ...session], {
          env: { HOME: home, SPECTRUM_BRIDGE_SOCKET: socket }, stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { stdout, stderr, exitCode };
      };
      expect(await run()).toEqual({ stdout: `${JSON.stringify({ id, created: true })}\n`, stderr: "", exitCode: 0 });
      reply = { id: "file:" + "b".repeat(64), created: true };
      expect(await run()).toEqual({ stdout: "", stderr: `${JSON.stringify({ error: "Bridge returned an invalid acknowledgement" })}\n`, exitCode: 1 });
      status = 409;
      reply = { error: "PRIVATE" };
      expect(await run()).toEqual({ stdout: "", stderr: `${JSON.stringify({ error: "Bridge request failed (HTTP 409)" })}\n`, exitCode: 1 });
      // 403/404 carry the daemon's fixed refusal reason, so the CLI shows it.
      status = 403;
      reply = { error: "Only the owner's chat can do this" };
      expect(await run()).toEqual({ stdout: "", stderr: `${JSON.stringify({ error: "Bridge request failed (HTTP 403): Only the owner's chat can do this" })}\n`, exitCode: 1 });
      expect(requests[0]).toEqual({ path: "/poll", body: { title: "T", options: ["a", "b"], dedupeKey: "k-1", sessionId: "s-1" } });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

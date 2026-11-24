import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliFailure, loadCommandPayload, MAX_FILE_BYTES, parseCommand, sendCommand, SEND_TIMEOUT_EXIT_CODE } from "../src/cli.ts";

const sendFile = ["send-file", "--file", "/nonexistent/report.pdf", "--key", "file-1", "--session", "session-1"];

describe("parseCommand", () => {
  test("messages reads recent, earlier, or individual messages", () => {
    expect(parseCommand(["messages", "--session", "ses_1"])).toEqual({ method: "POST", path: "/messages", body: { sessionId: "ses_1" } });
    expect(parseCommand(["messages", "--session", "ses_1", "--chat", "moni", "--limit", "5", "--before", "X"]).body)
      .toEqual({ sessionId: "ses_1", chat: "moni", limit: 5, before: "X" });
    expect(parseCommand(["messages", "--session", "ses_1", "--id", "X"]).body).toEqual({ sessionId: "ses_1", id: "X" });
    expect(() => parseCommand(["messages"])).toThrow("--session");
    expect(() => parseCommand(["messages", "--session", "ses_1", "--id", "X", "--before", "Y"])).toThrow("--id and --before");
    for (const limit of ["0", "101", "abc", "1.5", "-1", "1e2", " 2", "1000"]) {
      expect(() => parseCommand(["messages", "--session", "ses_1", `--limit=${limit}`])).toThrow("--limit must be 1 to 100");
    }
    for (const limit of ["1", "100", "005"]) expect(parseCommand(["messages", "--session", "ses_1", "--limit", limit]).body?.limit).toBe(Number(limit));
    for (const key of ["id", "before"]) {
      for (const value of ["", " ", "x".repeat(201), "x\ny", "x\x00y", "x\x7fy", "x\x85y"]) {
        expect(() => parseCommand(["messages", "--session", "ses_1", `--${key}`, value])).toThrow(`Invalid --${key}`);
      }
      expect(parseCommand(["messages", "--session", "ses_1", `--${key}`, "x".repeat(200)]).body?.[key]).toBe("x".repeat(200));
    }
  });
  test("parses health without a body", () => {
    expect(parseCommand(["health"])).toEqual({ method: "GET", path: "/health" });
  });

  test("location commands take an optional --chat slug", () => {
    expect(parseCommand(["location", "--session", "ses_1"])).toEqual({ method: "POST", path: "/location", body: { sessionId: "ses_1" } });
    expect(parseCommand(["location", "--session", "ses_1", "--chat", "moni"]).body).toEqual({ sessionId: "ses_1", chat: "moni" });
    expect(parseCommand(["location-request", "--session", "ses_1", "--key", "k", "--chat", "moni"]).body)
      .toEqual({ sessionId: "ses_1", dedupeKey: "k", chat: "moni" });
    expect(() => parseCommand(["location", "--session", "ses_1", "--chat", "Not A Slug"])).toThrow("Invalid chat slug");
  });

  test("parses send-file purely as a local reference with a required session, optional caption and MIME", () => {
    expect(parseCommand(sendFile)).toEqual({ method: "POST", path: "/files",
      body: { file: "/nonexistent/report.pdf", dedupeKey: "file-1", text: "", sessionId: "session-1" } });
    const args = [...sendFile, "--text=  Caption\nline  ", "--mime=application/pdf"];
    const before = [...args];
    expect(parseCommand(args)).toEqual({ method: "POST", path: "/files", body: { file: "/nonexistent/report.pdf", dedupeKey: "file-1",
      text: "  Caption\nline  ", sessionId: "session-1", mimeType: "application/pdf" } });
    expect(args).toEqual(before);
    expect(parseCommand([...sendFile, "--text="]).body?.text).toBe("");
  });

  test("validates send-file path, filename, key, caption, MIME and session without exposing values", () => {
    const invalid = [
      ["--file", "relative-PRIVATE_FILE"], ["--file", "file:///PRIVATE_FILE"], ["--file", "/PRIVATE_FILE\n"],
      ["--file", "/PRIVATE\x00FILE"], ["--file", "/PRIVATE\\FILE"], ["--file", "/"], ["--file", "/.."],
      ["--file", "/" + "x".repeat(256)], ["--key", "k".repeat(201)], ["--text", "x".repeat(12_001)],
      ["--mime", ""], ["--mime", "text"], ["--mime", "text/plain\n"], ["--mime", "text/plain; charset=utf-8"],
      ["--mime", "x/" + "a".repeat(99)], ["--session", ""], ["--session", "PRIVATE SESSION"],
      ["--session", "PRIVATE_SESSION\n"], ["--session", "s".repeat(201)],
    ];
    for (const [option, value] of invalid) {
      const args = [...sendFile];
      const index = args.indexOf(option);
      if (index >= 0) args.splice(index, 2);
      expect(() => parseCommand([...args, option, value])).toThrow();
    }
    expect(parseCommand(["send-file", "--file=/" + "x".repeat(255), "--key=" + "k".repeat(200),
      "--mime=x/" + "a".repeat(98), "--text=" + "t".repeat(12_000), "--session=s"]).path).toBe("/files");
  });

  test("one-time notification sends moved to the telegram bridge; send-file requires --session", () => {
    for (const command of ["notify", "remind", "reminders", "notifications", "cancel", "snooze"]) {
      expect(() => parseCommand([command])).toThrow("Expected health, send, cancel-send, send-file");
      expect(() => parseCommand([command])).toThrow("telegram bridge CLI");
    }
    expect(() => parseCommand(["send-file", "--file", "/nonexistent/report.pdf", "--key", "file-1"]))
      .toThrow("--session is required");
  });

  test.each(["like", "love", "dislike", "laugh", "emphasize", "question"])("parses reaction %s without resolving its target", kind => {
    for (const target of ["last", "known-message-id"]) {
      expect(parseCommand(["react", "--target", target, "--kind", kind])).toEqual({ method: "POST", path: "/react", body: { target, kind } });
    }
  });

  test("supports equals syntax and preserves nonempty text exactly without mutating args", () => {
    const args = ["send-file", "--file=/nonexistent/report.pdf", "--key=file-1", "--session=session-1", "--text=  hello\nworld  "];
    const before = [...args];
    expect(parseCommand(args).body?.text).toBe("  hello\nworld  ");
    expect(args).toEqual(before);
  });

  test.each([[], ["unknown"], ["toString"], ["__proto__"], ["--help"]].map(args => ({ args })))("rejects missing or unknown command %j", ({ args }) => {
    expect(() => parseCommand(args)).toThrow("Expected health");
  });

  test.each([
    ["health", "extra"], [...sendFile, "extra"],
    ["react", "--target", "last", "--kind", "like", "extra"],
    ["health", "--", "extra"],
  ].map(args => ({ args })))("rejects extra positional arguments %j", ({ args }) => {
    expect(() => parseCommand(args)).toThrow();
  });

  test.each([
    ["health", "--text", "secret"], [...sendFile, "--at=2026-09-11T09:30:00Z"],
    [...sendFile, "--target=other"], [...sendFile, "--source=other"], [...sendFile, "--mime"], [...sendFile, "--session"],
  ].map(args => ({ args })))("strictly rejects unknown, misplaced, or valueless options %j", ({ args }) => {
    expect(() => parseCommand(args)).toThrow("Invalid command arguments");
  });

  test("rejects duplicate options instead of silently choosing the last", () => {
    for (const option of ["file", "key", "text", "session", "mime"]) {
      const args = [...sendFile];
      if (!["file", "key", "session"].includes(option)) args.push(`--${option}=first`);
      expect(() => parseCommand([...args, `--${option}=second`])).toThrow("Duplicate command option");
    }
  });

  test.each([
    [sendFile, ["--file", "--key", "--session"]],
    [["react", "--target", "last", "--kind", "like"], ["--target", "--kind"]],
  ] as [string[], string[]][])("rejects every missing or blank required option in %j", (args, options) => {
    for (const option of options) {
      const index = args.indexOf(option);
      const missing = [...args];
      missing.splice(index, 2);
      expect(() => parseCommand(missing)).toThrow(`${option} is required`);
      for (const blank of ["", " \t\n"]) {
        const empty = [...args];
        empty[index + 1] = blank;
        expect(() => parseCommand(empty)).toThrow(`${option} is required`);
      }
    }
  });

  test.each(["heart", "LIKE", "remove"])("rejects unsupported reaction %s", kind => {
    expect(() => parseCommand(["react", "--target", "last", "--kind", kind])).toThrow("--kind must be");
  });

  test("never echoes invalid arguments or private option values in errors", () => {
    for (const args of [["private-value"], ["health", "--private-value"], [...sendFile, "--mime=private-value"],
      ["send-file", "--file=private-value", "--key=key", "--session=s"]]) {
      try {
        parseCommand(args);
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain("private-value");
        expect((error as Error).message).not.toBe("Expected rejection");
      }
    }
  });
});

describe("local file payloads (temporary fixtures only)", () => {
  let home: string;
  let restoreHome: () => void;

  beforeEach(async () => {
    home = await fs.mkdtemp(join(os.tmpdir(), "spectrum-cli-"));
    const mock = spyOn(os, "homedir").mockReturnValue(home);
    restoreHome = () => mock.mockRestore();
  });
  afterEach(async () => {
    restoreHome();
    await fs.rm(home, { recursive: true, force: true });
  });

  test("loads only the requested bytes, keeps parsing immutable, and does not touch files for other commands", async () => {
    const path = join(home, "report.PDF");
    const data = Buffer.from([0, 1, 2, 128, 255]);
    await fs.writeFile(path, data);
    const command = parseCommand(["send-file", `--file=${path}`, "--key=k", "--text=Caption", "--session=s"]);
    const before = structuredClone(command);
    expect(await loadCommandPayload(command)).toEqual({ base64: data.toString("base64"), name: "report.PDF", mimeType: "application/pdf",
      text: "Caption", dedupeKey: "k", sessionId: "s" });
    expect(command).toEqual(before);
    expect(await loadCommandPayload(parseCommand(["react", "--target", "last", "--kind", "like"]))).toEqual({ target: "last", kind: "like" });
    expect(await loadCommandPayload(parseCommand(["health"]))).toBeUndefined();
  });

  test("infers a small MIME map or octet-stream and respects explicit overrides", async () => {
    for (const [name, mimeType] of [["photo.JPEG", "image/jpeg"], ["photo.png", "image/png"], ["a.pdf", "application/pdf"],
      ["a.txt", "text/plain"], ["a.json", "application/json"], ["a.csv", "text/csv"], ["a.zip", "application/zip"],
      ["a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], ["a.unknown", "application/octet-stream"]]) {
      const path = join(home, name);
      await fs.writeFile(path, "fixture");
      expect((await loadCommandPayload(parseCommand(["send-file", `--file=${path}`, "--key=k", "--session=s"])))?.mimeType).toBe(mimeType);
      expect((await loadCommandPayload(parseCommand(["send-file", `--file=${path}`, "--key=k", "--session=s", "--mime=text/plain"])))?.mimeType).toBe("text/plain");
    }
  });

  test("rejects symlinks, directories, missing files, empty files, and oversize files with sanitized errors", async () => {
    const path = join(home, "PRIVATE_FILE");
    await fs.writeFile(path, "PRIVATE_CONTENT");
    const link = join(home, "link");
    await fs.symlink(path, link);
    const empty = join(home, "empty");
    await fs.writeFile(empty, "");
    const large = join(home, "large");
    await fs.writeFile(large, "");
    await fs.truncate(large, MAX_FILE_BYTES + 1);
    for (const file of [link, home, empty, large, join(home, "MISSING_PRIVATE_FILE")]) {
      try {
        await loadCommandPayload(parseCommand(["send-file", `--file=${file}`, "--key=k", "--session=s"]));
        throw new Error("Expected rejection");
      } catch (error) {
        expect((error as Error).message).not.toContain("PRIVATE");
        expect((error as Error).message).not.toContain(home);
        expect((error as Error).message).not.toBe("Expected rejection");
      }
    }
  });

  test("reads exactly 20 MiB and closes the nofollow regular-file descriptor", async () => {
    const path = join(home, "limit.bin");
    await fs.writeFile(path, Buffer.alloc(MAX_FILE_BYTES, 0xff));
    const originalOpen = fs.open;
    let closed = false;
    let flags = 0;
    const opening = spyOn(fs, "open").mockImplementation(async (...args) => {
      flags = Number(args[1]);
      const handle = await originalOpen(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); closed = true; };
      return handle;
    });
    try {
      const payload = await loadCommandPayload(parseCommand(["send-file", `--file=${path}`, "--key=k", "--session=s"]));
      expect(Buffer.from(payload!.base64 as string, "base64").length).toBe(MAX_FILE_BYTES);
      expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      expect(closed).toBe(true);
    } finally { opening.mockRestore(); }
  });

  test.each(["grow", "shrink", "replace", "symlink", "rewrite"])("rejects a file that changes during reading: %s", async mode => {
    const path = join(home, "race.bin");
    const size = 128 * 1024;
    await fs.writeFile(path, Buffer.alloc(size, 1));
    const originalOpen = fs.open;
    let readBytes = 0;
    let closed = false;
    let changed = false;
    const opening = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const read = handle.read;
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); closed = true; };
      spyOn(handle, "read").mockImplementation(async (...args: any[]) => {
        const result = await Reflect.apply(read, handle, args);
        readBytes += result.bytesRead;
        if (!changed) {
          changed = true;
          if (mode === "grow") await fs.appendFile(path, Buffer.alloc(2 * size));
          if (mode === "shrink") await fs.truncate(path, 1);
          if (mode === "replace" || mode === "symlink") {
            await fs.rename(path, path + ".old");
            if (mode === "replace") await fs.writeFile(path, Buffer.alloc(size, 2));
            else await fs.symlink(path + ".old", path);
          }
          if (mode === "rewrite") {
            await fs.writeFile(path, Buffer.alloc(size, 2));
            await fs.utimes(path, new Date(0), new Date(0));
          }
        }
        return result;
      });
      return handle;
    });
    try {
      await expect(loadCommandPayload(parseCommand(["send-file", `--file=${path}`, "--key=k", "--session=s"]))).rejects.toThrow("Attachment changed while reading");
      expect(readBytes).toBeLessThanOrEqual(size + 1);
      expect(closed).toBe(true);
    } finally { opening.mockRestore(); }
  });

  test("nofollow refuses a symlink swapped in after lstat and before open", async () => {
    const path = join(home, "race.bin");
    await fs.writeFile(path, "safe fixture");
    const originalOpen = fs.open;
    const opening = spyOn(fs, "open").mockImplementation(async (...args) => {
      await fs.rename(path, path + ".old");
      await fs.symlink(path + ".old", path);
      return originalOpen(...args);
    });
    try {
      await expect(loadCommandPayload(parseCommand(["send-file", `--file=${path}`, "--key=k", "--session=s"]))).rejects.toThrow("Attachment could not be read safely");
    } finally { opening.mockRestore(); }
  });

  test("blocks only the bridge's fixed credentials/database paths and aliases, not all config or dotfiles", async () => {
    const state = join(home, ".config", "spectrum-bridge");
    await fs.mkdir(state, { recursive: true });
    await fs.symlink(state, join(home, "state-alias"));
    for (const name of ["credentials.env", "state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "state.sqlite-journal"]) {
      const path = join(state, name);
      await fs.writeFile(path, "PRIVATE_FIXTURE");
      const hardlink = join(home, `${name}.alias`);
      await fs.link(path, hardlink);
      for (const file of [path, hardlink, join(home, "state-alias", name)]) {
        await expect(loadCommandPayload(parseCommand(["send-file", `--file=${file}`, "--key=k", "--session=s"]))).rejects.toThrow("Bridge credentials and state cannot be attached");
      }
    }
    for (const path of [join(state, "config.json"), join(home, ".env"), join(home, "credentials.env"), join(home, "privatekey.txt")]) {
      await fs.writeFile(path, "explicitly requested harmless fixture");
      expect((await loadCommandPayload(parseCommand(["send-file", `--file=${path}`, "--key=k", "--session=s"])))?.base64)
        .toBe(Buffer.from("explicitly requested harmless fixture").toString("base64"));
    }
  });

  test("CLI sends bytes, not local paths, and projects only queue acknowledgement from an offline mock socket", async () => {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const path = join(home, "PRIVATE_FILENAME.txt");
    await fs.writeFile(path, "PRIVATE_CONTENT");
    const socket = join(home, "s.sock");
    const id = "file:" + "a".repeat(64);
    const requests: { path?: string; body: unknown }[] = [];
    let status = 202;
    let reply: unknown = { id, created: true, base64: "PRIVATE_RESPONSE_CONTENT", file: path, providerId: "PRIVATE_PROVIDER" };
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
      for (const outcome of ["accepted", "error", "invalid-ack", "control-ack"]) {
        if (outcome === "error") { status = 409; reply = { error: "PRIVATE_RESPONSE_CONTENT" }; }
        if (outcome === "invalid-ack") { status = 200; reply = { id: "PRIVATE_ID", created: true }; }
        if (outcome === "control-ack") { status = 200; reply = { id: id + "\n", created: true }; }
        const child = Bun.spawn([process.execPath, "run", cli, "send-file", `--file=${path}`, "--key=k", "--session=s", "--text=Caption"], {
          env: { NODE_ENV: "test", TOOLLOG_DIR: process.env.TOOLLOG_DIR, HOME: home, SPECTRUM_BRIDGE_SOCKET: socket }, stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(exitCode).toBe(outcome === "accepted" ? 0 : 1);
        expect(stdout).toBe(outcome === "accepted" ? `${JSON.stringify({ id, created: true })}\n` : "");
        expect(stderr).toBe(outcome === "accepted" ? "" : `${JSON.stringify({ error: outcome === "error"
          ? "Bridge request failed (HTTP 409)" : "Bridge returned an invalid file acknowledgement" })}\n`);
        expect(stdout + stderr).not.toContain("PRIVATE");
      }
      expect(requests).toEqual(Array(4).fill({ path: "/files", body: { base64: Buffer.from("PRIVATE_CONTENT").toString("base64"),
        name: "PRIVATE_FILENAME.txt", mimeType: "text/plain", text: "Caption", dedupeKey: "k", sessionId: "s" } }));
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe("CLI entry point (no live socket)", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const directory = fileURLToPath(new URL("../src", import.meta.url));

  test("keeps database filename markers out of CLI source", async () => {
    // The harness statev2 guard scans script source, even when the command never opens a database.
    const source = await fs.readFile(cli, "utf8");
    for (const marker of ["state.sqlite", "statev2", "opencode.db"]) {
      expect(source).not.toContain(marker);
    }
  });

  test.each([
    { args: ["health", "--private-value"], socket: cli, error: "Invalid command arguments" },
    { args: ["health"], socket: cli, error: "Bridge socket must be a Unix socket, not a file or symlink" },
    { args: ["health"], socket: directory, error: "Bridge socket must be a Unix socket, not a file or symlink" },
    { args: ["health"], socket: "", error: "Bridge socket is unavailable" },
    { args: ["health"], socket: "relative-private-path", error: "Bridge socket is unavailable" },
    { args: ["health"], socket: `${cli}/missing-private-socket`, error: "Bridge socket is unavailable" },
  ] as { args: string[]; socket: string; error: string }[])("emits only sanitized JSON for %j", async ({ args, socket, error }) => {
    const child = Bun.spawn([process.execPath, "run", cli, ...args], {
      env: { NODE_ENV: "test", TOOLLOG_DIR: process.env.TOOLLOG_DIR, SPECTRUM_BRIDGE_SOCKET: socket }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(`${JSON.stringify({ error })}\n`);
  });
});

describe("guest-allow", () => {
  test("takes providers, facts and several evidence refs; --action is the old name for --provider", () => {
    const body = parseCommand(["guest-allow", "--address", "+447700900123", "--name", "Ali", "--purpose", "pick me up",
      "--provider", "flight-updates:EK57", "--action", "meeting", "--fact", "meeting point=Door 4", "--evidence", "msgs:21", "--evidence", "owner:o-1", "--session", "ses_1"]).body;
    expect(body).toEqual({ address: "+447700900123", name: "Ali", purpose: "pick me up", providers: ["flight-updates:EK57", "meeting"],
      facts: ["meeting point=Door 4"], evidence: ["msgs:21", "owner:o-1"], sessionId: "ses_1" });
    expect(() => parseCommand(["guest-allow", "--address", "+447700900123", "--name", "A", "--purpose", "p", "--provider", "shell", "--evidence", "msgs:1", "--session", "ses_1"])).toThrow();
    expect(() => parseCommand(["guest-allow", "--address", "+447700900123", "--name", "A", "--purpose", "p", "--fact", "nokey", "--evidence", "msgs:1", "--session", "ses_1"])).toThrow();
    expect(() => parseCommand(["guest-allow", "--address", "+447700900123", "--name", "A", "--purpose", "p", "--session", "ses_1"])).toThrow();
  });
});

test("message length errors name actual length, limit and a recovery", () => {
  const cases: [string[], number][] = [
    [["send", "--session", "s", "--key", "k"], 12_000],
    [["send", "--to", "moni", "--session", "s", "--key", "k"], 12_000],
    [["wake", "--source", "watch", "--key", "k"], 12_000],
    [["guest-send", "--address", "+15555550199", "--session", "s", "--key", "k"], 2_000],
  ];
  for (const [args, limit] of cases) {
    const actual = limit + 412;
    expect(() => parseCommand([...args, "--text", "x".repeat(actual)])).toThrow(
      `message too long: ${actual.toLocaleString("en-US")} chars, limit ${limit.toLocaleString("en-US")}; split it or send as a card`);
  }
});

test("log-rollup is local, validates UTC dates and rolls up fixture input", async () => {
  const { parseLocalCommand, runLocalCommand, isLocalCommand } = await import("../src/cli.ts");
  const { captureLogs } = await import("./log-fixture.ts");
  const { toolLog } = await import("../src/toollog.ts");
  expect(isLocalCommand(["log-rollup"])).toBe(true);
  for (const day of ["../x", "2026-02-30", "2026-11-13T12:00Z", "13-11-2026", ""]) expect(() => parseLocalCommand(["log-rollup", "--day", day])).toThrow();
  await captureLogs(async () => {
    toolLog.write({ component: "cli-fixture", kind: "event", name: "msg.received" });
    const day = new Date().toISOString().slice(0, 10);
    expect(await runLocalCommand(parseLocalCommand(["log-rollup", "--day", day]))).toMatchObject({ total: 1, day });
    for (const kind of ["quick", "delivery", "ride", "nutrition"]) {
      await runLocalCommand(parseLocalCommand(["log-card-render", "--kind", kind, "--ms", "1.5", "--ok", "true"]));
    }
  });
  for (const ms of ["-1", "NaN", "Infinity", ""]) expect(() => parseLocalCommand(["log-card-render", "--kind", "quick", "--ms", ms, "--ok", "true"])).toThrow();
});

test("log-rollup excludes calls buffered before captureLogs", async () => {
  const { parseLocalCommand, runLocalCommand } = await import("../src/cli.ts");
  const { captureLogs } = await import("./log-fixture.ts");
  const { toolLog } = await import("../src/toollog.ts");
  toolLog.write({ component: "robob", kind: "perf", name: "turn.robob_call", durationMs: 5, ok: true,
    props: { method: "GET", route: "/health" } });
  const logs = await captureLogs(async () => {
    toolLog.write({ component: "cli-fixture", kind: "event", name: "msg.received" });
    const day = new Date().toISOString().slice(0, 10);
    expect(await runLocalCommand(parseLocalCommand(["log-rollup", "--day", day]))).toMatchObject({ total: 1, day });
  });
  expect(logs.map(line => line.name)).toEqual(["msg.received"]);
});

test.each([false, true])("captureLogs drains action calls before restoring its directory (throws=%s)", async throws => {
  const { captureLogs } = await import("./log-fixture.ts");
  const { toolLog } = await import("../src/toollog.ts");
  const failure = new Error("fixture action failed");
  const outer = process.env.TOOLLOG_DIR;
  const logs = await captureLogs(async () => {
    const inner = captureLogs(async () => {
      toolLog.write({ component: "robob", kind: "perf", name: "turn.robob_call", durationMs: 5, ok: true,
        props: { method: "GET", route: "/health" } });
      if (throws) throw failure;
    });
    if (throws) await expect(inner).rejects.toBe(failure);
    else {
      const captured = await inner;
      expect(captured.map(line => line.name)).toEqual(["turn.robob_calls"]);
      expect(captured[0]?.calls?.health.count).toBe(1);
    }
    toolLog.write({ component: "cli-fixture", kind: "event", name: "msg.received" });
  });
  expect(logs.map(line => line.name)).toEqual(["msg.received"]);
  expect(process.env.TOOLLOG_DIR).toBe(outer);
});

test("nutrition's live-only renderer is observed at file preparation, on success and failure", async () => {
  const { captureLogs } = await import("./log-fixture.ts");
  const root = await fs.mkdtemp(join(os.tmpdir(), "nutrition-log-fixture-"));
  try {
    const path = join(root, "nutrition.png");
    await fs.writeFile(path, "PRIVATE_HEALTH_IMAGE");
    const logs = await captureLogs(async () => {
      await loadCommandPayload(parseCommand(["send-file", "--file", path, "--session", "fixture-session", "--key", "nutrition-fixture"]));
      await expect(loadCommandPayload(parseCommand(["send-file", "--file", join(root, "nutrition-missing.png"), "--session", "fixture-session", "--key", "missing-fixture"]))).rejects.toThrow();
    });
    expect(logs.filter(l => l.name === "card.render" || l.name === "card.renders").map(l => [l.component, l.ok, l.props?.cardKind]).sort((a, b) => Number(b[1]) - Number(a[1]))).toEqual([["card-file", true, "nutrition"], ["card-file", false, "nutrition"]]);
    expect(JSON.stringify(logs)).not.toContain("PRIVATE_HEALTH_IMAGE");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

describe("agent bus commands", () => {
  const request = `areq_${"a".repeat(64)}`;
  test("builds ask, parent ask, answer statuses and requests without changing text", () => {
    const args = ["agent-ask", "--to", "moni", "--text", "  question\nline  ", "--session", "ses_1", "--key", "k"];
    expect(parseCommand(args)).toEqual({ method: "POST", path: "/agent-ask",
      body: { to: "moni", text: "  question\nline  ", sessionId: "ses_1", dedupeKey: "k" } });
    expect(parseCommand([...args, "--parent", request]).body?.parent).toBe(request);
    const answer = ["agent-answer", "--request", request, "--text", "answer", "--session", "ses_1"];
    expect(parseCommand(answer)).toEqual({ method: "POST", path: "/agent-answer",
      body: { request, text: "answer", sessionId: "ses_1" } });
    for (const status of ["pending", "done", "declined"]) expect(parseCommand([...answer, "--status", status]).body?.status).toBe(status);
    expect(parseCommand(["agent-requests", "--session", "ses_1"])).toEqual({ method: "POST", path: "/agent-requests", body: { sessionId: "ses_1" } });
    expect(parseCommand(["agent-requests", "--session=ses_1", `--request=${request}`])).toEqual({ method: "POST", path: "/agent-requests", body: { sessionId: "ses_1", request } });
    for (const value of ["", "missing", `areq_${"g".repeat(64)}`]) expect(() => parseCommand(["agent-requests", "--session=ses_1", `--request=${value}`])).toThrow("Invalid --request");
  });
  test("requires sessions and ask keys; rejects invalid ids, status, slugs and lengths", () => {
    for (const args of [
      ["agent-ask", "--to", "owner", "--text", "q", "--key", "k"],
      ["agent-ask", "--to", "owner", "--text", "q", "--session", "s"],
      ["agent-answer", "--request", request, "--text", "a"], ["agent-requests"],
      ["agent-ask", "--to", "Not A Slug", "--text", "q", "--session", "s", "--key", "k"],
    ]) expect(() => parseCommand(args)).toThrow();
    for (const command of ["agent-ask", "agent-answer"]) {
      const base = command === "agent-ask" ? [command, "--to", "owner", "--key", "k"] : [command, "--request", request];
      for (const text of ["", "  ", "x".repeat(12_001)]) expect(() => parseCommand([...base, "--text", text, "--session", "s"])).toThrow();
      expect(parseCommand([...base, "--text", "x".repeat(12_000), "--session", "s"]).path).toBe(`/${command}`);
    }
    for (const bad of ["bad", "areq_", `areq_${"a".repeat(65)}`, `areq_${"A".repeat(64)}`, request + "\n"]) {
      expect(() => parseCommand(["agent-answer", "--request", bad, "--text", "a", "--session", "s"])).toThrow("Invalid --request");
      expect(() => parseCommand(["agent-ask", "--to", "owner", "--text", "a", "--session", "s", "--key", "k", "--parent", bad])).toThrow("Invalid --parent");
    }
    expect(() => parseCommand(["agent-answer", "--request", request, "--text", "a", "--session", "s", "--status", "timed_out"])).toThrow("Invalid --status");
  });
});

describe("notify-rule commands", () => {
  test("parses add/list/remove with a required session", () => {
    expect(parseCommand(["notify-rule", "add", "--text", "tell me when Moni orders", "--session", "s"]))
      .toEqual({ method: "POST", path: "/notify-rule", body: { action: "add", text: "tell me when Moni orders", sessionId: "s" } });
    expect(parseCommand(["notify-rule", "list", "--session=s"]))
      .toEqual({ method: "POST", path: "/notify-rule", body: { action: "list", sessionId: "s" } });
    expect(parseCommand(["notify-rule", "rm", "--id=123", "--session=s"]))
      .toEqual({ method: "POST", path: "/notify-rule", body: { action: "rm", id: 123, sessionId: "s" } });
  });
  test("rejects missing sessions, malformed ids/text, and unrelated options", () => {
    for (const args of [["add", "--text=x"], ["list"], ["rm", "--id=1"]]) expect(() => parseCommand(["notify-rule", ...args])).toThrow("--session");
    for (const args of [[], ["unknown"], ["add"], ["add", "--text="], ["add", "--text=x\ny"], ["add", `--text=${"x".repeat(2001)}`],
      ["add", "--text=x", "--id=1"], ["list", "--text=x"], ["list", "--id=1"], ["list", "extra"], ["rm"],
      ...["0", "-1", "1.5", "01", "1e3", "9007199254740992"].map(id => ["rm", `--id=${id}`]), ["rm", "--id=1", "--text=x"]]) {
      expect(() => parseCommand(["notify-rule", ...args, "--session=s"])).toThrow();
    }
  });
});


test("send-status encodes the key and requires a session", () => {
  expect(parseCommand(["send-status", "--key=k /?%", "--session=s@2"])).toEqual({
    method: "GET", path: "/send-status/?key=k%20%2F%3F%25&sessionId=s%402" });
  expect(() => parseCommand(["send-status", "--key=k"])).toThrow("--session");
  for (const kind of ["send", "file"]) expect(parseCommand(["send-status", "--key=k", "--session=s", `--kind=${kind}`]).path)
    .toBe(`/send-status/?key=k&sessionId=s&kind=${kind}`);
  for (const kind of ["", "files", "SEND", "both"]) expect(() => parseCommand(["send-status", "--key=k", "--session=s", `--kind=${kind}`]))
    .toThrow("--kind must be send or file");
});

test.each([".", "..", "...", "%2e", "%2e%2e", "./", "../", "a/../b", "/", "\\", "?&#=+", "%", "k /?%", "مفتاح 🔑", " . ", "-k"])(
  "send-status preserves URL-sensitive key %j", key => {
    expect(parseCommand(["send", "--text=PRIVATE_TEXT", `--key=${key}`, "--session=s@2"]).body?.dedupeKey).toBe(key);
    const command = parseCommand(["send-status", `--key=${key}`, "--session=s@2"]);
    const url = new URL(command.path, "http://bridge");
    expect(url.pathname).toBe("/send-status/");
    expect(url.searchParams.get("key")).toBe(key);
    expect(url.searchParams.get("sessionId")).toBe("s@2");
  });

test("socket aborts distinguish send/file/agent-answer/agent-ask outcome unknown from read failures", async () => {
  const { toolLog } = await import("../src/toollog.ts");
  const root = await fs.mkdtemp(join(os.tmpdir(), "cli-timeout-"));
  const socket = join(root, "s.sock"), file = join(root, "fixture.txt");
  await fs.writeFile(file, "PRIVATE_CONTENT");
  const server = createServer();
  const oldSocket = process.env.SPECTRUM_BRIDGE_SOCKET;
  process.env.SPECTRUM_BRIDGE_SOCKET = socket;
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  try {
    await new Promise<void>(resolve => server.listen(socket, resolve));
    const requestId = `areq_${"a".repeat(64)}`;
    const cases = [
      { args: ["send", "--text=PRIVATE_TEXT", "--session=s", "--key=private-key"],
        failure: { exitCode: SEND_TIMEOUT_EXIT_CODE, body: { error: "Bridge request timed out", outcome: "unknown", key: "private-key",
          hint: "The message may already be queued. Re-run with the same --key (it won't send twice) or check with send-status --key." } },
        log: { name: "cli.send_timeout", ids: { operationId: `send:${sha("private-key")}` }, props: { path: "/send" } } },
      { args: ["send-file", `--file=${file}`, "--session=s", "--key=private-key"],
        failure: { exitCode: SEND_TIMEOUT_EXIT_CODE, body: { error: "Bridge request timed out", outcome: "unknown", key: "private-key",
          hint: "The message may already be queued. Re-run with the same --key (it won't send twice) or check with send-status --key." } },
        log: { name: "cli.send_timeout", ids: { operationId: `file:${sha("private-key")}` }, props: { path: "/files" } } },
      { args: ["agent-answer", `--request=${requestId}`, "--text=PRIVATE_TEXT", "--session=s"],
        failure: { exitCode: SEND_TIMEOUT_EXIT_CODE, body: { error: "Bridge request timed out", outcome: "unknown", requestId,
          hint: "The answer may already be admitted. Check agent-requests --request <requestId> --session <session>, or repeat the identical agent-answer call (it won't deliver twice)." } },
        log: { name: "cli.agent_bus_timeout", ids: { operationId: `agent-answer:${sha(requestId)}` }, props: { command: "agent-answer" } } },
      { args: ["agent-ask", "--to=owner", "--text=PRIVATE_TEXT", "--session=s", "--key=private-key"],
        failure: { exitCode: SEND_TIMEOUT_EXIT_CODE, body: { error: "Bridge request timed out", outcome: "unknown", key: "private-key",
          hint: "The request may already be sent. Re-run the identical agent-ask with the same --key (it is created once per key) or check agent-requests --session <session>." } },
        log: { name: "cli.agent_bus_timeout", ids: { operationId: `agent-ask:${sha("private-key")}` }, props: { command: "agent-ask" } } },
      { args: ["agent-requests", "--session=s"], failure: { exitCode: 1, body: { error: "Bridge request timed out" } } },
      { args: ["health"], failure: { exitCode: 1, body: { error: "Bridge request timed out" } } },
    ];
    for (const { args, failure: expected, log } of cases) {
      const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: Parameters<typeof setTimeout>[0]) => {
        queueMicrotask(() => { if (typeof callback === "function") callback(); });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
      const writes = spyOn(toolLog, "write").mockImplementation(() => {});
      let failure;
      try { await sendCommand(parseCommand(args)); }
      catch (error) { failure = cliFailure(error); }
      finally { timer.mockRestore(); }
      const timeouts = writes.mock.calls.map(([entry]) => entry).filter(entry => entry.name.endsWith("_timeout"));
      writes.mockRestore();
      expect(failure).toEqual(expected);
      if (log === undefined) expect(timeouts).toEqual([]);
      else {
        expect(timeouts).toHaveLength(1);
        expect(timeouts[0]).toMatchObject({ component: "cli", kind: "event", ...log });
        expect(Object.keys(timeouts[0]!.props!).sort()).toEqual([...Object.keys(log.props), "elapsedMs"].sort());
        expect(JSON.stringify(timeouts)).not.toMatch(/PRIVATE|private-key|areq_/);
      }
    }
  } finally {
    if (oldSocket === undefined) delete process.env.SPECTRUM_BRIDGE_SOCKET;
    else process.env.SPECTRUM_BRIDGE_SOCKET = oldSocket;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

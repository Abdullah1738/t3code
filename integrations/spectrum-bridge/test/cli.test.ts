import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCommandPayload, MAX_FILE_BYTES, parseCommand } from "../src/cli.ts";

const sendFile = ["send-file", "--file", "/nonexistent/report.pdf", "--key", "file-1", "--session", "session-1"];

describe("parseCommand", () => {
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
      expect(() => parseCommand([command])).toThrow("Expected health, send, send-file, poll, app, react, wake, secret-request, secret, publish, or unpublish");
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
          env: { HOME: home, SPECTRUM_BRIDGE_SOCKET: socket }, stdout: "pipe", stderr: "pipe",
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

  test.each([
    { args: ["health", "--private-value"], socket: cli, error: "Invalid command arguments" },
    { args: ["health"], socket: cli, error: "Bridge socket must be a Unix socket, not a file or symlink" },
    { args: ["health"], socket: directory, error: "Bridge socket must be a Unix socket, not a file or symlink" },
    { args: ["health"], socket: "", error: "Bridge socket is unavailable" },
    { args: ["health"], socket: "relative-private-path", error: "Bridge socket is unavailable" },
    { args: ["health"], socket: `${cli}/missing-private-socket`, error: "Bridge socket is unavailable" },
  ] as { args: string[]; socket: string; error: string }[])("emits only sanitized JSON for %j", async ({ args, socket, error }) => {
    const child = Bun.spawn([process.execPath, "run", cli, ...args], {
      env: { SPECTRUM_BRIDGE_SOCKET: socket }, stdout: "pipe", stderr: "pipe",
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

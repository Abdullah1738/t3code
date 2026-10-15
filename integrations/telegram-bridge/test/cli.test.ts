import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCommandPayload, MAX_FILE_BYTES, parseCommand, sanitizeSource } from "../src/cli.ts";

const at = "2026-09-11T09:30:00+04:00";
const notify = ["notify", "--source", "tests", "--text", "hello", "--key", "event-1"];
const remind = ["remind", "--at", at, "--text", "stretch", "--key", "reminder-1"];
const sendFile = ["send-file", "--file", "/nonexistent/report.pdf", "--key", "file-1"];

describe("parseCommand", () => {
  test.each(["health", "reminders", "notifications"])("parses %s without a body", command => {
    expect(parseCommand([command])).toEqual({ method: "GET", path: `/${command}` });
  });

  test("maps notification keys and defaults severity to info", () => {
    expect(parseCommand(notify)).toEqual({
      method: "POST", path: "/notify",
      body: { source: "tests", severity: "info", text: "hello", dedupeKey: "event-1" },
    });
  });

  test("sanitizes --source to the bridge's accepted shape", () => {
    expect(parseCommand(["notify", "--source", "risk-liquidation-latest#58", "--text", "hi", "--key", "k"]).body?.source)
      .toBe("risk-liquidation-latest-58");
    expect(sanitizeSource("  a!!b   c/d  ")).toBe("a-b   c-d");
    expect(sanitizeSource("x".repeat(60))).toHaveLength(40);
    expect(sanitizeSource("#### ")).toBe("agent");
  });

  test("parses send-file purely as a local reference with an optional caption and MIME", () => {
    expect(parseCommand(sendFile)).toEqual({ method: "POST", path: "/files", body: { file: "/nonexistent/report.pdf", dedupeKey: "file-1", text: "" } });
    const args = [...sendFile, "--text=  Caption\nline  ", "--mime=application/pdf"];
    const before = [...args];
    expect(parseCommand(args)).toEqual({ method: "POST", path: "/files", body: { file: "/nonexistent/report.pdf", dedupeKey: "file-1",
      text: "  Caption\nline  ", mimeType: "application/pdf" } });
    expect(args).toEqual(before);
    expect(parseCommand([...sendFile, "--text="]).body?.text).toBe("");
  });

  test("validates send-file path, filename, key, and caption without exposing values", () => {
    const invalid = [
      ["--file", "relative-PRIVATE_FILE"], ["--file", "file:///PRIVATE_FILE"], ["--file", "/PRIVATE_FILE\n"],
      ["--file", "/PRIVATE\x00FILE"], ["--file", "/PRIVATE\\FILE"], ["--file", "/"], ["--file", "/.."],
      ["--file", "/" + "x".repeat(256)], ["--key", "k".repeat(201)], ["--text", "x".repeat(12_001)],
      ["--mime", ""], ["--mime", "text"], ["--mime", "text/plain\n"], ["--mime", "text/plain; charset=utf-8"],
      ["--mime", "x/" + "a".repeat(99)],
    ];
    for (const [option, value] of invalid) {
      const args = [...sendFile];
      const index = args.indexOf(option);
      if (index >= 0) args.splice(index, 2);
      expect(() => parseCommand([...args, option, value])).toThrow();
    }
    expect(parseCommand(["send-file", "--file=/" + "x".repeat(255), "--key=" + "k".repeat(200),
      "--mime=x/" + "a".repeat(98), "--text=" + "t".repeat(12_000)]).path).toBe("/files");
  });

  test.each(["info", "attention", "error"])("accepts severity %s", severity => {
    expect(parseCommand([...notify, "--severity", severity]).body?.severity).toBe(severity);
  });

  test("maps reminder keys and omits an unspecified timezone", () => {
    expect(parseCommand(remind)).toEqual({
      method: "POST", path: "/reminders", body: { text: "stretch", at, idempotencyKey: "reminder-1" },
    });
  });

  test.each(["Asia/Dubai", "America/New_York", "Etc/GMT+5", "UTC"])("preserves IANA timezone %s", timezone => {
    expect(parseCommand([...remind, "--timezone", timezone]).body).toEqual({ text: "stretch", at, idempotencyKey: "reminder-1", timezone });
  });

  test("encodes reminder IDs as a single path segment and sends an empty cancel object", () => {
    const id = "id/with ?#&%";
    expect(parseCommand(["cancel", id])).toEqual({ method: "POST", path: `/reminders/${encodeURIComponent(id)}/cancel`, body: {} });
    expect(parseCommand(["snooze", id, "--at", at])).toEqual({ method: "POST", path: `/reminders/${encodeURIComponent(id)}/snooze`, body: { at } });
    expect(parseCommand(["snooze", "--at", at, id])).toEqual(parseCommand(["snooze", id, "--at", at]));
  });

  test.each([[], ["unknown"], ["toString"], ["__proto__"], ["--help"]].map(args => ({ args })))("rejects missing or unknown command %j", ({ args }) => {
    expect(() => parseCommand(args)).toThrow("Expected health");
  });

  test.each([
    ["health", "extra"], ["reminders", "extra"], ["notifications", "extra"],
    [...notify, "extra"], [...remind, "extra"], [...sendFile, "extra"],
    ["cancel"], ["cancel", "one", "two"], ["snooze", "--at", at], ["snooze", "one", "two", "--at", at],
    ["health", "--", "extra"],
  ].map(args => ({ args })))("rejects extra or missing positional arguments %j", ({ args }) => {
    expect(() => parseCommand(args)).toThrow();
  });

  test.each([
    ["health", "--text", "secret"], ["notify", "--token=secret"], [...notify, "--at", at],
    [...remind, "--severity", "info"], ["cancel", "id", "--at", at],
    ["snooze", "id", "--at", at, "--timezone", "UTC"], [...notify, "--severity"],
    [...notify, "-s", "tests"], [...notify, "--severity", "--text"],
    [...sendFile, "--source=other"], [...sendFile, "--mime"], [...sendFile, "--session=s"],
  ].map(args => ({ args })))("strictly rejects unknown, misplaced, or valueless options %j", ({ args }) => {
    expect(() => parseCommand(args)).toThrow("Invalid command arguments");
  });

  test("rejects duplicate options instead of silently choosing the last", () => {
    expect(() => parseCommand([...notify, "--text=other"])).toThrow("Duplicate command option");
    expect(() => parseCommand([...notify, "--severity=info", "--severity=error"])).toThrow("Duplicate command option");
    for (const option of ["file", "key", "text", "mime"]) {
      const args = [...sendFile];
      if (!["file", "key"].includes(option)) args.push(`--${option}=first`);
      expect(() => parseCommand([...args, `--${option}=second`])).toThrow("Duplicate command option");
    }
  });

  test.each([
    [notify, ["--source", "--text", "--key"]],
    [remind, ["--at", "--text", "--key"]],
    [sendFile, ["--file", "--key"]],
    [["snooze", "id", "--at", at], ["--at"]],
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

  test.each(["", " \n"])("rejects blank reminder IDs %j", id => {
    expect(() => parseCommand(["cancel", id])).toThrow("Reminder ID is required");
    expect(() => parseCommand(["snooze", id, "--at", at])).toThrow("Reminder ID is required");
  });

  test.each(["", "warning", "INFO", " info"])("rejects unsupported severity %j", severity => {
    expect(() => parseCommand([...notify, `--severity=${severity}`])).toThrow("--severity must be");
  });

  test.each([
    "2026-09-11T09:30:00Z", "2026-09-11T09:30:00.123Z", "2026-09-11T09:30+04:00",
    "2026-09-11T09:30:00-07:00", "2026-09-11T09:30:00+05:45", "2028-02-29T23:59:59Z", "2000-02-29T00:00:00Z",
  ])("accepts explicit-offset ISO timestamp %s without normalization", value => {
    expect(parseCommand(["remind", "--at", value, "--text", "test", "--key", "key"]).body?.at).toBe(value);
    expect(parseCommand(["snooze", "id", "--at", value]).body?.at).toBe(value);
  });

  test.each([
    "tomorrow", "2026-09-11", "2026-09-11T09:30", "2026-09-11T09:30:00", "2026-09-11 09:30:00Z",
    "2026-09-11T09:30:00+0400", "2026-09-11T09:30:00+04", "2026-09-11T09:30:00+24:00",
    "2026-09-11T09:30:00+04:60", "2026-09-11T24:00:00Z", "2026-09-11T09:60:00Z", "2026-09-11T09:30:60Z",
    "2026-02-29T09:30:00Z", "1900-02-29T09:30:00Z", "2026-02-30T09:30:00Z", "2026-04-31T09:30:00Z",
    "2026-00-11T09:30:00Z", "2026-13-11T09:30:00Z", "2026-09-00T09:30:00Z", "2026-09-32T09:30:00Z",
    " 2026-09-11T09:30:00Z", "2026-09-11T09:30:00Z\n", "2026-09-11T09:30:00Zjunk",
  ])("rejects invalid or zone-less ISO timestamp %j for both commands", value => {
    expect(() => parseCommand(["remind", "--at", value, "--text", "test", "--key", "key"])).toThrow("explicit offset");
    expect(() => parseCommand(["snooze", "id", "--at", value])).toThrow("explicit offset");
  });

  test.each(["", " ", "Not/A_Zone", "+04:00", "UTC+4"])("rejects invalid timezone %j", timezone => {
    expect(() => parseCommand([...remind, `--timezone=${timezone}`])).toThrow("--timezone");
  });

  test("never echoes invalid arguments or private option values in errors", () => {
    for (const args of [["private-value"], ["health", "--private-value"], [...notify, "--severity=private-value"], [...remind, "--timezone=private-value"],
      [...sendFile, "--mime=private-value"], ["send-file", "--file=private-value", "--key=key"]]) {
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
    home = await fs.mkdtemp(join(os.tmpdir(), "telegram-cli-"));
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
    const command = parseCommand(["send-file", `--file=${path}`, "--key=k", "--text=Caption"]);
    const before = structuredClone(command);
    expect(await loadCommandPayload(command)).toEqual({ base64: data.toString("base64"), name: "report.PDF", mimeType: "application/pdf",
      text: "Caption", dedupeKey: "k" });
    expect(command).toEqual(before);
    expect(await loadCommandPayload(parseCommand(notify))).toEqual(parseCommand(notify).body);
    expect(await loadCommandPayload(parseCommand(["health"]))).toBeUndefined();
  });

  test("infers a small MIME map or octet-stream and respects explicit overrides", async () => {
    for (const [name, mimeType] of [["photo.JPEG", "image/jpeg"], ["photo.png", "image/png"], ["a.pdf", "application/pdf"],
      ["a.txt", "text/plain"], ["a.json", "application/json"], ["a.csv", "text/csv"], ["a.zip", "application/zip"],
      ["a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], ["a.unknown", "application/octet-stream"]]) {
      const path = join(home, name);
      await fs.writeFile(path, "fixture");
      expect((await loadCommandPayload(parseCommand(["send-file", `--file=${path}`, "--key=k"])))?.mimeType).toBe(mimeType);
      expect((await loadCommandPayload(parseCommand(["send-file", `--file=${path}`, "--key=k", "--mime=text/plain"])))?.mimeType).toBe("text/plain");
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
        await loadCommandPayload(parseCommand(["send-file", `--file=${file}`, "--key=k"]));
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
      const payload = await loadCommandPayload(parseCommand(["send-file", `--file=${path}`, "--key=k"]));
      expect(Buffer.from(payload!.base64, "base64").length).toBe(MAX_FILE_BYTES);
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
      await expect(loadCommandPayload(parseCommand(["send-file", `--file=${path}`, "--key=k"]))).rejects.toThrow("Attachment changed while reading");
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
      await expect(loadCommandPayload(parseCommand(["send-file", `--file=${path}`, "--key=k"]))).rejects.toThrow("Attachment could not be read safely");
    } finally { opening.mockRestore(); }
  });

  test("blocks only the bridge's fixed credentials/database paths and aliases, not all config or dotfiles", async () => {
    const state = join(home, ".config", "telegram-bridge");
    await fs.mkdir(state, { recursive: true });
    await fs.symlink(state, join(home, "state-alias"));
    for (const name of ["credentials.env", "state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "state.sqlite-journal", "bridge.sock"]) {
      const path = join(state, name);
      await fs.writeFile(path, "PRIVATE_FIXTURE");
      const hardlink = join(home, `${name}.alias`);
      await fs.link(path, hardlink);
      for (const file of [path, hardlink, join(home, "state-alias", name)]) {
        await expect(loadCommandPayload(parseCommand(["send-file", `--file=${file}`, "--key=k"]))).rejects.toThrow("Bridge credentials and state cannot be attached");
      }
    }
    for (const path of [join(state, "config.json"), join(home, ".env"), join(home, "credentials.env"), join(home, "privatekey.txt")]) {
      await fs.writeFile(path, "explicitly requested harmless fixture");
      expect((await loadCommandPayload(parseCommand(["send-file", `--file=${path}`, "--key=k"])))?.base64)
        .toBe(Buffer.from("explicitly requested harmless fixture").toString("base64"));
    }
  });

  test("CLI sends bytes, not local paths, and projects only queue acknowledgement from an offline mock socket", async () => {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const path = join(home, "PRIVATE_FILENAME.txt");
    await fs.writeFile(path, "PRIVATE_CONTENT");
    const socket = join(home, "t.sock");
    const id = "file:" + "a".repeat(64);
    const requests: { path?: string; body: unknown }[] = [];
    let status = 202;
    let reply: unknown = { id, created: true, base64: "PRIVATE_RESPONSE_CONTENT", file: path, providerId: 999 };
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
        const child = Bun.spawn([process.execPath, "run", cli, "send-file", `--file=${path}`, "--key=k", "--text=Caption"], {
          env: { HOME: home, TELEGRAM_BRIDGE_SOCKET: socket }, stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(exitCode).toBe(outcome === "accepted" ? 0 : 1);
        expect(stdout).toBe(outcome === "accepted" ? `${JSON.stringify({ id, created: true })}\n` : "");
        expect(stderr).toBe(outcome === "accepted" ? "" : `${JSON.stringify({ error: outcome === "error"
          ? "Bridge request failed (HTTP 409)" : "Bridge returned an invalid file acknowledgement" })}\n`);
        expect(stdout + stderr).not.toContain("PRIVATE");
      }
      expect(requests).toEqual(Array(4).fill({ path: "/files", body: { base64: Buffer.from("PRIVATE_CONTENT").toString("base64"),
        name: "PRIVATE_FILENAME.txt", mimeType: "text/plain", text: "Caption", dedupeKey: "k" } }));
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
      env: { TELEGRAM_BRIDGE_SOCKET: socket }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(`${JSON.stringify({ error })}\n`);
  });
});

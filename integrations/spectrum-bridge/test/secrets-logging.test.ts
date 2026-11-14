import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetSecret, getSecretRequest, putSecretRequest, readSecret, SECRET_VALUE_TTL_MS, submitSecret, sweepSecrets, tokenHash } from "../src/secrets.ts";
import { Store } from "../src/store.ts";
import { type LogLine, toolLog } from "../src/toollog.ts";

let root: string;
let store: Store;
let originalLogRoot: string | undefined;
const token = "t".repeat(43);
let clock: number;
const secret = "PRIVATE_VALUE_SENTINEL";
const deps = () => ({ store, stateRoot: root, now: () => clock });
const valuePath = () => join(root, "secrets", `${tokenHash(token)}.json`);
const diagnostic = (line: LogLine) => ({ tag: line.error?.tag, name: line.error?.name, code: line.error?.code });

beforeEach(async () => {
  clock = Date.now();
  root = await fs.mkdtemp(join(tmpdir(), "secrets-logging-"));
  store = new Store(":memory:");
  originalLogRoot = process.env.TOOLLOG_DIR;
  toolLog.flush();
  process.env.TOOLLOG_DIR = join(root, "logs");
});
afterEach(async () => {
  toolLog.flush();
  if (originalLogRoot === undefined) delete process.env.TOOLLOG_DIR;
  else process.env.TOOLLOG_DIR = originalLogRoot;
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});
async function lines(): Promise<LogLine[]> {
  toolLog.flush();
  const text = await fs.readFile(join(root, "logs", `${new Date().toISOString().slice(0, 10)}.ndjson`), "utf8")
    .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
  return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : [];
}
function request(state: "open" | "submitted" = "open", requestToken = token) {
  putSecretRequest(store, requestToken, { sessionId: "fixture", generation: 1, purpose: "PRIVATE_PURPOSE_SENTINEL",
    fields: [{ name: "password", label: "PRIVATE_LABEL_SENTINEL", type: "password" }],
    createdAt: clock, expiresAt: clock + 900_000, state, valuesExpireAt: clock + 1_800_000 });
}

test("two idle chat stores with no secrets directory stay silent across 120 sweep ticks", async () => {
  const chats = [root, join(root, "second-chat")];
  await fs.mkdir(chats[1]!);
  for (let tick = 0; tick < 120; tick++) {
    for (const stateRoot of chats) await sweepSecrets({ store, stateRoot, now: () => clock + tick * 30_000 });
  }
  expect(await lines()).toEqual([]);
  for (const stateRoot of chats) await expect(fs.stat(join(stateRoot, "secrets"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("missing values are normal for unsubmitted, forgotten, expired and already removed forms", async () => {
  request();
  await forgetSecret(deps(), token);
  await forgetSecret(deps(), token);
  request("submitted");
  clock += SECRET_VALUE_TTL_MS;
  await expect(readSecret(deps(), token, "password")).rejects.toMatchObject({ status: 410 });
  await sweepSecrets(deps());
  expect(getSecretRequest(store, token)?.state).toBe("expired");
  expect((await lines()).filter(line => line.component === "secrets")).toEqual([]);
});

test.each([
  { operation: "read", missing: "file", tag: "secrets.catch7" },
  { operation: "read", missing: "directory", tag: "secrets.catch7" },
  { operation: "sweep", missing: "directory", tag: "secrets.catch9" },
])("$operation reports a missing $missing for an active submission", async ({ operation, missing, tag }) => {
  request();
  expect(await submitSecret(deps(), token, new URLSearchParams({ password: secret }))).toEqual({ status: "ok" });
  if (missing === "file") await fs.unlink(valuePath());
  else await fs.rm(join(root, "secrets"), { recursive: true });
  if (operation === "read") await expect(readSecret(deps(), token, "password")).rejects.toMatchObject({ status: 410 });
  else await sweepSecrets(deps());
  expect(getSecretRequest(store, token)?.state).toBe("submitted");
  const logged = (await lines()).filter(line => line.component === "secrets");
  expect(logged.map(diagnostic)).toEqual([{ tag, name: "Error", code: "ENOENT" }]);
  expect(logged[0]).toMatchObject({ kind: "error", ok: false });
  for (const value of [secret, token, tokenHash(token), "PRIVATE_PURPOSE_SENTINEL", "PRIVATE_LABEL_SENTINEL"]) {
    expect(JSON.stringify(logged)).not.toContain(value);
  }
});

test.each(["forgotten", "expired", "deadline"])("read ENOENT stays quiet after confirmed %s race", async state => {
  request();
  await submitSecret(deps(), token, new URLSearchParams({ password: secret }));
  const open = fs.open;
  const race = spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    if (state === "forgotten") await forgetSecret(deps(), token);
    else {
      clock += SECRET_VALUE_TTL_MS;
      if (state === "expired") await sweepSecrets(deps());
      else await fs.unlink(valuePath());
    }
    return open(...args);
  });
  try { await expect(readSecret(deps(), token, "password")).rejects.toMatchObject({ status: 410 }); }
  finally { race.mockRestore(); }
  expect(getSecretRequest(store, token)?.state).toBe(state === "deadline" ? "submitted" : state);
  expect((await lines()).filter(line => line.component === "secrets")).toEqual([]);
});

test.each(["forgotten", "expired", "deadline"])("sweep ENOENT stays quiet after confirmed %s race", async state => {
  request();
  await submitSecret(deps(), token, new URLSearchParams({ password: secret }));
  const readdir = fs.readdir;
  const race = spyOn(fs, "readdir").mockImplementationOnce(async () => {
    if (state === "forgotten") await forgetSecret(deps(), token);
    else {
      clock += SECRET_VALUE_TTL_MS;
      if (state === "expired") await expect(readSecret(deps(), token, "password")).rejects.toMatchObject({ status: 410 });
    }
    await fs.rm(join(root, "secrets"), { recursive: true });
    await readdir(join(root, "secrets"));
    throw new Error("Expected the directory to be missing");
  });
  try { await sweepSecrets(deps()); } finally { race.mockRestore(); }
  expect(getSecretRequest(store, token)?.state).toBe(state === "deadline" ? "submitted" : state);
  expect((await lines()).filter(line => line.component === "secrets")).toEqual([]);
});

test.each(["deleted-record", "reopened-record"])("read ENOENT remains an error after %s", async state => {
  request();
  await submitSecret(deps(), token, new URLSearchParams({ password: secret }));
  const open = fs.open;
  const race = spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    await fs.unlink(valuePath());
    if (state === "deleted-record") store.db.query("DELETE FROM kv WHERE key = ?").run(`secret-request:${token}`);
    else request();
    return open(...args);
  });
  try { await expect(readSecret(deps(), token, "password")).rejects.toMatchObject({ status: 410 }); }
  finally { race.mockRestore(); }
  expect((await lines()).filter(line => line.component === "secrets").map(diagnostic)).toEqual([{ tag: "secrets.catch7", name: "Error", code: "ENOENT" }]);
});

test("sweep still reports missing values when one submission is forgotten and another remains active", async () => {
  const other = "u".repeat(43);
  request(); request("open", other);
  await submitSecret(deps(), token, new URLSearchParams({ password: secret }));
  await submitSecret(deps(), other, new URLSearchParams({ password: secret }));
  const readdir = fs.readdir;
  const race = spyOn(fs, "readdir").mockImplementationOnce(async () => {
    await forgetSecret(deps(), token);
    await fs.rm(join(root, "secrets"), { recursive: true });
    await readdir(join(root, "secrets"));
    throw new Error("Expected the directory to be missing");
  });
  try { await sweepSecrets(deps()); } finally { race.mockRestore(); }
  expect(getSecretRequest(store, token)?.state).toBe("forgotten");
  expect(getSecretRequest(store, other)?.state).toBe("submitted");
  expect((await lines()).filter(line => line.component === "secrets").map(diagnostic)).toEqual([{ tag: "secrets.catch9", name: "Error", code: "ENOENT" }]);
});

test("a duplicate value file loses the submission race without a secrets error", async () => {
  request();
  expect(await submitSecret(deps(), token, new URLSearchParams({ password: secret }))).toEqual({ status: "ok" });
  request();
  expect(await submitSecret(deps(), token, new URLSearchParams({ password: "other" }))).toEqual({ status: "gone" });
  expect(JSON.parse(await fs.readFile(valuePath(), "utf8")).values.password === secret).toBe(true);
  expect((await lines()).filter(line => line.component === "secrets")).toEqual([]);
});

test("a real readdir failure retains a safe system code", async () => {
  await fs.writeFile(join(root, "secrets"), secret);
  await sweepSecrets(deps());
  expect((await lines()).map(diagnostic)).toEqual([{ tag: "secrets.catch9", name: "Error", code: "ENOTDIR" }]);
});

test.each(["EACCES", "EIO", "PRIVATE_CODE_SENTINEL"])("readdir %s is an error without error contents", async code => {
  const fail = spyOn(fs, "readdir").mockRejectedValueOnce(Object.assign(new Error(secret), { code, path: "PRIVATE_PATH_SENTINEL" }));
  try { await sweepSecrets(deps()); } finally { fail.mockRestore(); }
  const logged = await lines();
  expect(logged.map(diagnostic)).toEqual([{ tag: "secrets.catch9", name: "Error", code: code === "PRIVATE_CODE_SENTINEL" ? undefined : code }]);
  expect(logged[0]).toMatchObject({ kind: "error", ok: false });
  for (const value of [secret, "PRIVATE_PATH_SENTINEL", "PRIVATE_CODE_SENTINEL"]) expect(JSON.stringify(logged)).not.toContain(value);
});

test.each([
  { message: "database is locked", code: 123456, errno: 654321, status: 123 },
  { message: "out of memory", code: "tokenExpired", errno: "tokenExpired", status: 456 },
  { message: secret, code: "PRIVATE_CODE_SENTINEL", errno: "PRIVATE_ERRNO_SENTINEL", status: 599 },
])("secret errors exclude prose and non-errno diagnostics: $code", async detail => {
  const cause = Object.assign(new TypeError(detail.message), detail, { path: "PRIVATE_PATH_SENTINEL" });
  cause.stack = `${cause.name}: ${cause.message}\n    at /private/PRIVATE_PATH_SENTINEL/spectrum-bridge/src/secrets.ts:42:5`;
  const fail = spyOn(fs, "readdir").mockRejectedValueOnce(cause);
  try { await sweepSecrets(deps()); } finally { fail.mockRestore(); }
  const logged = await lines();
  expect(logged.map(line => line.error)).toEqual([{ tag: "secrets.catch9", name: "TypeError", message: "[redacted]", stack: ["src/secrets.ts:42"] }]);
  expect(logged[0]?.site).toMatch(/^src\/secrets\.ts:\d+$/);
  for (const value of [String(detail.code), String(detail.errno), String(detail.status), detail.message, "PRIVATE_PATH_SENTINEL"]) {
    expect(JSON.stringify(logged)).not.toContain(value);
  }
});

test("secret errors retain a real errno code and number", async () => {
  const cause = Object.assign(new Error(secret), { code: "ENOENT", errno: -2 });
  const fail = spyOn(fs, "readdir").mockRejectedValueOnce(cause);
  request("submitted");
  try { await sweepSecrets(deps()); } finally { fail.mockRestore(); }
  const logged = (await lines()).filter(line => line.component === "secrets");
  expect(logged[0]?.error).toMatchObject({ tag: "secrets.catch9", name: "Error", message: "[redacted]", code: "ENOENT", errno: -2 });
});

test("secret errors retain redacted external frames without the original paths", async () => {
  const cause = new Error(secret);
  cause.stack = `Error: ${secret}\n    at /private/PRIVATE_PATH_SENTINEL/one.js:12:5\n    at /private/PRIVATE_PATH_SENTINEL/two.js:34:6`;
  const fail = spyOn(fs, "readdir").mockRejectedValueOnce(cause);
  try { await sweepSecrets(deps()); } finally { fail.mockRestore(); }
  const logged = await lines();
  expect(logged[0]?.error).toEqual({ tag: "secrets.catch9", name: "Error", message: "[redacted]", stack: ["<external>:12", "<external>:34"] });
  for (const value of [secret, "PRIVATE_PATH_SENTINEL", "one.js", "two.js"]) expect(JSON.stringify(logged)).not.toContain(value);
});

test.each(["EACCES", "EIO"])("value removal %s remains an error and does not forget the record", async code => {
  request("submitted");
  const fail = spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error(secret), { code }));
  try { await expect(forgetSecret(deps(), token)).rejects.toMatchObject({ code }); } finally { fail.mockRestore(); }
  expect(getSecretRequest(store, token)?.state).toBe("submitted");
  expect((await lines()).filter(line => line.component === "secrets").map(diagnostic)).toEqual([{ tag: "secrets.catch1", name: "Error", code }]);
});

test.each(["open", "read"])("value %s failures keep their safe code", async operation => {
  request(operation === "read" ? "submitted" : "open");
  const fail = spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error(secret), { code: "EACCES" }));
  try {
    if (operation === "read") await expect(readSecret(deps(), token, "password")).rejects.toMatchObject({ status: 410 });
    else await expect(submitSecret(deps(), token, new URLSearchParams({ password: secret }))).rejects.toMatchObject({ code: "EACCES" });
  } finally { fail.mockRestore(); }
  expect((await lines()).filter(line => line.component === "secrets").map(diagnostic))
    .toEqual([{ tag: `secrets.catch${operation === "read" ? 7 : 2}`, name: "Error", code: "EACCES" }]);
});

test.each(["malformed", "wrong-shape"])("corrupt %s stored values are errors without stored contents", async kind => {
  request("submitted");
  await fs.mkdir(join(root, "secrets"));
  await fs.writeFile(valuePath(), kind === "malformed" ? secret : JSON.stringify({ values: secret }));
  await expect(readSecret(deps(), token, "password")).rejects.toMatchObject({ status: 410 });
  const logged = (await lines()).filter(line => line.component === "secrets");
  expect(logged.map(diagnostic)).toEqual([{ tag: "secrets.catch8", name: kind === "malformed" ? "SyntaxError" : "SecretError", code: undefined }]);
  for (const value of [secret, token, tokenHash(token), "PRIVATE_PURPOSE_SENTINEL", "PRIVATE_LABEL_SENTINEL"]) {
    expect(JSON.stringify(logged)).not.toContain(value);
  }
});

test.each(["stat-missing", "unlink-missing", "stat-denied", "unlink-denied"])("orphan cleanup handles %s", async kind => {
  await fs.mkdir(join(root, "secrets"));
  await fs.writeFile(valuePath(), secret);
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(valuePath(), old, old);
  const code = kind.endsWith("missing") ? "ENOENT" : "EACCES";
  const fail = kind.startsWith("stat")
    ? spyOn(fs, "lstat").mockRejectedValueOnce(Object.assign(new Error(secret), { code }))
    : spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error(secret), { code }));
  try { await sweepSecrets(deps()); } finally { fail.mockRestore(); }
  expect((await lines()).map(diagnostic)).toEqual(code === "ENOENT" ? [] : [{ tag: `secrets.catch${kind.startsWith("stat") ? 10 : 11}`, name: "Error", code: "EACCES" }]);
});

test.each(["ENOENT", "EIO"])("failed write and cleanup %s retain only real failures", async code => {
  request();
  await fs.mkdir(join(root, "secrets"));
  const handle = await fs.open(valuePath(), "wx");
  const opened = spyOn(fs, "open").mockResolvedValueOnce(handle);
  const writing = spyOn(handle, "writeFile").mockRejectedValueOnce(Object.assign(new Error(secret), { code: "ENOSPC" }));
  const closing = spyOn(handle, "close").mockRejectedValueOnce(Object.assign(new Error(secret), { code: "EBADF" }));
  const removing = spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error(secret), { code }));
  try {
    await expect(submitSecret(deps(), token, new URLSearchParams({ password: secret }))).rejects.toMatchObject({ code: "ENOSPC" });
  } finally {
    opened.mockRestore(); writing.mockRestore(); closing.mockRestore(); removing.mockRestore();
    await handle.close();
  }
  expect((await lines()).filter(line => line.component === "secrets").map(diagnostic))
    .toEqual([{ tag: "secrets.catch3", name: "Error", code: "ENOSPC" }, { tag: "secrets.catch4", name: "Error", code: "EBADF" },
      ...(code === "EIO" ? [{ tag: "secrets.catch5", name: "Error", code: "EIO" }] : [])]);
  expect(getSecretRequest(store, token)?.state).toBe("open");
});

test.each(["ENOENT", "EIO"])("failed submission transaction cleanup %s retains only real failures", async code => {
  request();
  const accepting = spyOn(store, "acceptInbound").mockImplementationOnce(() => { throw new Error("fixture transaction failure"); });
  const removing = spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error(secret), { code }));
  try {
    await expect(submitSecret(deps(), token, new URLSearchParams({ password: secret }))).rejects.toThrow("fixture transaction failure");
  } finally { accepting.mockRestore(); removing.mockRestore(); }
  expect((await lines()).filter(line => line.component === "secrets").map(diagnostic))
    .toEqual(code === "ENOENT" ? [] : [{ tag: "secrets.catch6", name: "Error", code: "EIO" }]);
  expect(getSecretRequest(store, token)?.state).toBe("open");
});

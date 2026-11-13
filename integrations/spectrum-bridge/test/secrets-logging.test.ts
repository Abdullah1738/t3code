import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetSecret, getSecretRequest, putSecretRequest, readSecret, submitSecret, sweepSecrets, tokenHash } from "../src/secrets.ts";
import { Store } from "../src/store.ts";
import { type LogLine, toolLog } from "../src/toollog.ts";

let root: string;
let store: Store;
let originalLogRoot: string | undefined;
const token = "t".repeat(43);
const clock = Date.now();
const secret = "PRIVATE_VALUE_SENTINEL";
const deps = () => ({ store, stateRoot: root, now: () => clock });
const valuePath = () => join(root, "secrets", `${tokenHash(token)}.json`);

beforeEach(async () => {
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
function request(state: "open" | "submitted" = "open") {
  putSecretRequest(store, token, { sessionId: "fixture", generation: 1, purpose: "PRIVATE_PURPOSE_SENTINEL",
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
  await expect(readSecret(deps(), token, "password")).rejects.toMatchObject({ status: 410 });
  await sweepSecrets({ ...deps(), now: () => clock + 1_800_000 });
  expect(getSecretRequest(store, token)?.state).toBe("expired");
  expect((await lines()).filter(line => line.component === "secrets")).toEqual([]);
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
  expect((await lines()).map(line => line.error?.tag)).toEqual(["secrets.catch9.ENOTDIR"]);
});

test.each(["EACCES", "EIO", "PRIVATE_CODE_SENTINEL"])("readdir %s is an error without error contents", async code => {
  const fail = spyOn(fs, "readdir").mockRejectedValueOnce(Object.assign(new Error(secret), { code, path: "PRIVATE_PATH_SENTINEL" }));
  try { await sweepSecrets(deps()); } finally { fail.mockRestore(); }
  const logged = await lines();
  expect(logged.map(line => line.error?.tag)).toEqual([`secrets.catch9.${code === "PRIVATE_CODE_SENTINEL" ? "unknown" : code}`]);
  expect(logged[0]).toMatchObject({ kind: "error", ok: false });
  for (const value of [secret, "PRIVATE_PATH_SENTINEL", "PRIVATE_CODE_SENTINEL"]) expect(JSON.stringify(logged)).not.toContain(value);
});

test.each(["EACCES", "EIO"])("value removal %s remains an error and does not forget the record", async code => {
  request("submitted");
  const fail = spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error(secret), { code }));
  try { await expect(forgetSecret(deps(), token)).rejects.toMatchObject({ code }); } finally { fail.mockRestore(); }
  expect(getSecretRequest(store, token)?.state).toBe("submitted");
  expect((await lines()).filter(line => line.component === "secrets").map(line => line.error?.tag)).toEqual([`secrets.catch1.${code}`]);
});

test.each(["open", "read"])("value %s failures keep their safe code", async operation => {
  request(operation === "read" ? "submitted" : "open");
  const fail = spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error(secret), { code: "EACCES" }));
  try {
    if (operation === "read") await expect(readSecret(deps(), token, "password")).rejects.toMatchObject({ status: 410 });
    else await expect(submitSecret(deps(), token, new URLSearchParams({ password: secret }))).rejects.toMatchObject({ code: "EACCES" });
  } finally { fail.mockRestore(); }
  expect((await lines()).filter(line => line.component === "secrets").map(line => line.error?.tag))
    .toEqual([`secrets.catch${operation === "read" ? 7 : 2}.EACCES`]);
});

test.each(["malformed", "wrong-shape"])("corrupt %s stored values are errors without stored contents", async kind => {
  request("submitted");
  await fs.mkdir(join(root, "secrets"));
  await fs.writeFile(valuePath(), kind === "malformed" ? secret : JSON.stringify({ values: secret }));
  await expect(readSecret(deps(), token, "password")).rejects.toMatchObject({ status: 410 });
  const logged = (await lines()).filter(line => line.component === "secrets");
  expect(logged.map(line => line.error?.tag)).toEqual([`secrets.catch8.${kind === "malformed" ? "SyntaxError" : "invalid_values"}`]);
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
  expect((await lines()).map(line => line.error?.tag)).toEqual(code === "ENOENT" ? [] : [`secrets.catch${kind.startsWith("stat") ? 10 : 11}.EACCES`]);
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
  expect((await lines()).filter(line => line.component === "secrets").map(line => line.error?.tag))
    .toEqual(["secrets.catch3.ENOSPC", "secrets.catch4.EBADF", ...(code === "EIO" ? ["secrets.catch5.EIO"] : [])]);
  expect(getSecretRequest(store, token)?.state).toBe("open");
});

test.each(["ENOENT", "EIO"])("failed submission transaction cleanup %s retains only real failures", async code => {
  request();
  const accepting = spyOn(store, "acceptInbound").mockImplementationOnce(() => { throw new Error("fixture transaction failure"); });
  const removing = spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error(secret), { code }));
  try {
    await expect(submitSecret(deps(), token, new URLSearchParams({ password: secret }))).rejects.toThrow("fixture transaction failure");
  } finally { accepting.mockRestore(); removing.mockRestore(); }
  expect((await lines()).filter(line => line.component === "secrets").map(line => line.error?.tag))
    .toEqual(code === "ENOENT" ? [] : ["secrets.catch6.EIO"]);
  expect(getSecretRequest(store, token)?.state).toBe("open");
});

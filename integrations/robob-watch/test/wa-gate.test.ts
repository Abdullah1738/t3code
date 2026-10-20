import { afterAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// wa draft gate against a fake wacli; no WhatsApp involved.
const box = mkdtempSync(join(tmpdir(), "wa-gate-test-"));
const draftDir = join(box, "drafts");
const calls = join(box, "calls.log");
const fakeWacli = join(box, "wacli");
const src = join(import.meta.dir, "../helpers/wa");
const waBin = join(box, "wa");
writeFileSync(fakeWacli, `#!/bin/sh\necho "$@" >> "$FAKE_CALLS"\necho '{"success":true}'\n`);
chmodSync(fakeWacli, 0o755);
writeFileSync(waBin, readFileSync(src));
chmodSync(waBin, 0o755);

const OWNER = "971585134795@s.whatsapp.net";
const BOB = "971500000001@s.whatsapp.net";
const reset = () => {
  rmSync(draftDir, { recursive: true, force: true });
  rmSync(calls, { force: true });
};
const wa = (...args: string[]) => {
  const r = Bun.spawnSync(["/bin/zsh", waBin, ...args], {
    env: { HOME: box, PATH: "/usr/bin:/bin", WA_WACLI: fakeWacli, WA_DRAFT_DIR: draftDir, FAKE_CALLS: calls, LANG: "en_US.UTF-8" },
  });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
const callLog = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
const idFrom = (out: string) => out.match(/^DRAFT ([0-9a-f]{10}) /m)?.[1] ?? "";
const draftJson = (id: string) => JSON.parse(readFileSync(join(draftDir, `${id}.json`), "utf8"));

afterAll(() => rmSync(box, { recursive: true, force: true }));
beforeEach(reset);

test("direct send to another person is blocked and wacli is never called", () => {
  const r = wa("send", BOB, "hello there");
  expect(r.code).toBe(2);
  expect(r.err).toContain("Blocked: WhatsApp sends need Abdullah's OK");
  expect(callLog()).toHaveLength(0);
});

test("direct sendfile to another person is blocked", () => {
  const f = join(box, "pic.png");
  writeFileSync(f, "x");
  const r = wa("sendfile", BOB, f, "image");
  expect(r.code).toBe(2);
  expect(callLog()).toHaveLength(0);
});

test("owner self-send goes straight through with --allow-self", () => {
  const r = wa("send", OWNER, "note to self");
  expect(r.code).toBe(0);
  expect(r.out).toBe("(sent) Me: note to self");
  expect(callLog()).toEqual([`--json send text --to ${OWNER} --message note to self --allow-self`]);
});

test("draft then send --approved sends the exact text once", () => {
  const d = wa("draft", BOB, "Can we do EUR 3500?");
  expect(d.code).toBe(0);
  const id = idFrom(d.out);
  expect(id).toMatch(/^[0-9a-f]{10}$/);
  expect(d.out).toContain(`Show Abdullah this exact text. Send only after he OKs it: wa send --approved ${id}`);
  expect(callLog()).toHaveLength(0);
  const j = draftJson(id);
  expect(j).toMatchObject({ kind: "text", jid: BOB, text: "Can we do EUR 3500?" });
  expect(typeof j.created_at).toBe("number");

  const s = wa("send", "--approved", id);
  expect(s.code).toBe(0);
  expect(s.out).toBe("(sent) Me: Can we do EUR 3500?");
  expect(callLog()).toEqual([`--json send text --to ${BOB} --message Can we do EUR 3500?`]);
  expect(existsSync(join(draftDir, `${id}.sent.json`))).toBe(true);
  expect(existsSync(join(draftDir, `${id}.json`))).toBe(false);
});

test("second use of an approved draft is refused and sends nothing", () => {
  const id = idFrom(wa("draft", BOB, "once only").out);
  expect(wa("send", "--approved", id).code).toBe(0);
  const again = wa("send", "--approved", id);
  expect(again.code).toBe(2);
  expect(again.err).toContain("already used");
  expect(callLog()).toHaveLength(1);
});

test("expired draft (older than 24h) is refused", () => {
  const id = idFrom(wa("draft", BOB, "stale offer").out);
  const j = draftJson(id);
  j.created_at = Math.floor(Date.now() / 1000) - 2 * 86400;
  writeFileSync(join(draftDir, `${id}.json`), JSON.stringify(j));
  const r = wa("send", "--approved", id);
  expect(r.code).toBe(2);
  expect(r.err).toContain("older than 24h");
  expect(callLog()).toHaveLength(0);
  expect(existsSync(join(draftDir, `${id}.json`))).toBe(true);
});

test("unknown draft id is refused", () => {
  const r = wa("send", "--approved", "0123456789");
  expect(r.code).toBe(2);
  expect(r.err).toContain("no draft");
  expect(callLog()).toHaveLength(0);
});

test("a text draft cannot be sent with sendfile --approved", () => {
  const id = idFrom(wa("draft", BOB, "text only").out);
  const r = wa("sendfile", "--approved", id);
  expect(r.code).toBe(2);
  expect(r.err).toContain("not file");
  expect(callLog()).toHaveLength(0);
});

test("multi-line text draft is refused", () => {
  const r = wa("draft", BOB, "line one\nline two");
  expect(r.code).toBe(2);
  expect(existsSync(draftDir)).toBe(false);
});

test("draftfile then sendfile --approved passes --as and caption through", () => {
  const f = join(box, "menu.pdf");
  writeFileSync(f, "pdf");
  const d = wa("draftfile", BOB, f, "--as", "document", "the", "menu");
  expect(d.code).toBe(0);
  const id = idFrom(d.out);
  expect(d.out).toContain(`wa sendfile --approved ${id}`);
  const j = draftJson(id);
  expect(j).toMatchObject({ kind: "file", jid: BOB, path: f, as: "document", caption: "the menu" });

  const s = wa("sendfile", "--approved", id);
  expect(s.code).toBe(0);
  expect(s.out).toBe("(sent) Me: [document] menu.pdf");
  expect(callLog()).toEqual([`--json send file --to ${BOB} --file ${f} --as document --caption the menu`]);
  expect(existsSync(join(draftDir, `${id}.sent.json`))).toBe(true);
  expect(wa("sendfile", "--approved", id).code).toBe(2);
  expect(callLog()).toHaveLength(1);
});

test("draftfile refuses a missing path and direct sendfile to others stays blocked", () => {
  const r = wa("draftfile", BOB, join(box, "nope.png"));
  expect(r.code).toBe(2);
  expect(existsSync(draftDir)).toBe(false);
  const f = join(box, "pic.png");
  writeFileSync(f, "x");
  expect(wa("sendfile", BOB, f).code).toBe(2);
  expect(callLog()).toHaveLength(0);
});

test("a failed approved send is settled as failed and not retried", () => {
  const bad = join(box, "fail-wacli");
  writeFileSync(bad, `#!/bin/sh\necho "$@" >> "$FAKE_CALLS"\necho '{"success":false}'\nexit 1\n`);
  chmodSync(bad, 0o755);
  const id = idFrom(wa("draft", BOB, "may fail").out);
  const r = Bun.spawnSync(["/bin/zsh", waBin, "send", "--approved", id], {
    env: { HOME: box, PATH: "/usr/bin:/bin", WA_WACLI: bad, WA_DRAFT_DIR: draftDir, FAKE_CALLS: calls },
  });
  expect(r.exitCode).toBe(1);
  expect(existsSync(join(draftDir, `${id}.failed.json`))).toBe(true);
  expect(wa("send", "--approved", id).code).toBe(2);
  expect(callLog()).toHaveLength(1);
  expect(readdirSync(draftDir).filter(f => f.endsWith(".sending.json"))).toHaveLength(0);
});

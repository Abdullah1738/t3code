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
// Stand-in for send-approval: `visible` refuses "<think"; `check` logs its args as JSON, waits SA_SLEEP seconds, refuses while SA_REFUSE is set.
const fakeApproval = join(box, "send-approval");
const approvals = join(box, "approvals.log");
// Stand-in for wa-db (found at $HOME/.local/share/robob-watch/helpers/wa-db): knows one contact name.
const helpers = join(box, ".local/share/robob-watch/helpers");
mkdirSync(helpers, { recursive: true });
const fakeDb = join(helpers, "wa-db");
writeFileSync(fakeWacli, `#!/bin/sh\necho "$@" >> "$FAKE_CALLS"\necho '{"success":true}'\n`);
writeFileSync(
  fakeApproval,
  `#!/usr/bin/python3\nimport json, os, sys, time\n` +
    `if sys.argv[1] == "visible": sys.exit("Refused: hidden text" if "<think" in sys.argv[2] else 0)\n` +
    `open(os.environ["FAKE_APPROVALS"], "a").write(json.dumps(sys.argv[1:]) + "\\n")\n` +
    `time.sleep(float(os.environ.get("SA_SLEEP") or 0))\n` +
    `if os.environ.get("SA_REFUSE"): sys.exit("Refused: not shown")\nprint("approved: ok")\n`,
);
writeFileSync(
  fakeDb,
  `#!/bin/sh\ncase "$1" in\n  name) case "$2" in 971500000001@s.whatsapp.net) echo Bob ;; *@g.us) echo Host ;; esac ;;\n` +
    `  resolve) echo "$2"; [ "$2" = "111@lid" ] && echo 971500000002@s.whatsapp.net ;;\nesac\nexit 0\n`,
);
for (const f of [fakeWacli, fakeApproval, fakeDb]) chmodSync(f, 0o755);
writeFileSync(waBin, readFileSync(src));
chmodSync(waBin, 0o755);

const OWNER = "971585134795@s.whatsapp.net";
const BOB = "971500000001@s.whatsapp.net";
const reset = () => {
  rmSync(draftDir, { recursive: true, force: true });
  rmSync(calls, { force: true });
  rmSync(approvals, { force: true });
};
const env = (extra: Record<string, string> = {}) => ({
  HOME: box,
  PATH: "/usr/bin:/bin",
  WA_WACLI: fakeWacli,
  WA_DRAFT_DIR: draftDir,
  WA_SEND_APPROVAL: fakeApproval,
  FAKE_CALLS: calls,
  FAKE_APPROVALS: approvals,
  LANG: "en_US.UTF-8",
  ...extra,
});
const waEnv = (extra: Record<string, string>, ...args: string[]) => {
  const r = Bun.spawnSync(["/bin/zsh", waBin, ...args], { env: env(extra) });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
const wa = (...args: string[]) => waEnv({}, ...args);
const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : []);
const callLog = () => lines(calls);
const approvalLog = (): string[][] => lines(approvals).map(l => JSON.parse(l));
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

const OK = ["--inbound", "6E3E6964-50F0-4C1B-9A11-000000000001"];

test("draft prints a preview with name and number; send --approved needs his OK and sends the exact text once", () => {
  const d = wa("draft", BOB, "Can we do EUR 3500?");
  expect(d.code).toBe(0);
  const id = idFrom(d.out);
  expect(id).toMatch(/^[0-9a-f]{10}$/);
  const preview = `WhatsApp to Bob (+971500000001):\nCan we do EUR 3500?\n(draft ${id})`;
  expect(d.out).toContain(preview);
  expect(d.out).toContain(`After his OK: wa send --approved ${id} --inbound <incoming message ID of his reply>`);
  expect(callLog()).toHaveLength(0);
  const j = draftJson(id);
  expect(j).toMatchObject({ kind: "text", jid: BOB, text: "Can we do EUR 3500?", preview });
  expect(typeof j.created_at).toBe("number");

  const s = wa("send", "--approved", id, ...OK);
  expect(s.code).toBe(0);
  expect(s.out).toBe("approved: ok\n(sent) Me: Can we do EUR 3500?");
  expect(approvalLog()).toEqual([["check", ...OK, "--preview", preview, "--drafted-at", String(j.created_at)]]);
  expect(callLog()).toEqual([`--json send text --to ${BOB} --message Can we do EUR 3500?`]);
  expect(existsSync(join(draftDir, `${id}.sent.json`))).toBe(true);
  expect(existsSync(join(draftDir, `${id}.json`))).toBe(false);
});

test("--approved <id> alone is not consent: refused before anything is checked or sent", () => {
  const id = idFrom(wa("draft", BOB, "no ok yet").out);
  for (const extra of [[], ["--inbound"], ["--inbound", ""], ["--yes"]]) {
    const r = wa("send", "--approved", id, ...extra);
    expect(r.code).toBe(2);
    expect(r.err).toContain("alone isn't Abdullah's OK");
  }
  expect(approvalLog()).toHaveLength(0);
  expect(callLog()).toHaveLength(0);
  expect(existsSync(join(draftDir, `${id}.json`))).toBe(true);
});

test("a refused approval leaves the draft pending and sends nothing; a later OK still works", () => {
  const id = idFrom(wa("draft", BOB, "wait for him").out);
  const r = waEnv({ SA_REFUSE: "1" }, "send", "--approved", id, ...OK);
  expect(r.code).toBe(2);
  expect(r.err).toContain("Refused: not shown");
  expect(callLog()).toHaveLength(0);
  expect(existsSync(join(draftDir, `${id}.json`))).toBe(true);
  expect(wa("send", "--approved", id, "--app").code).toBe(0);
  expect(approvalLog()[1]?.slice(0, 2)).toEqual(["check", "--app"]);
  expect(callLog()).toHaveLength(1);
});

test("a revised text is a new draft that needs its own OK", () => {
  const a = idFrom(wa("draft", BOB, "EUR 3500").out);
  const b = idFrom(wa("draft", BOB, "EUR 3400").out);
  expect(a).not.toBe(b);
  expect(wa("send", "--approved", b, ...OK).code).toBe(0);
  expect(approvalLog()[0]?.[4]).toBe(`WhatsApp to Bob (+971500000001):\nEUR 3400\n(draft ${b})`);
});

test("a LID recipient becomes its phone number, so the same message has one draft either way", () => {
  const d = wa("draft", "111@lid", "hi");
  const id = idFrom(d.out);
  expect(d.out).toContain(`WhatsApp to +971500000002:\nhi\n(draft ${id})`);
  expect(draftJson(id).jid).toBe("971500000002@s.whatsapp.net");
  expect(idFrom(wa("draft", "971500000002", "hi").out)).toBe(id);
  expect(wa("send", "--approved", id, ...OK).code).toBe(0);
  expect(wa("draft", "111@lid", "hi").err).toContain("already sent");
  expect(callLog()).toEqual(["--json send text --to 971500000002@s.whatsapp.net --message hi"]);
  const u = wa("draft", "222@lid", "hey");
  expect(u.out).toContain("WhatsApp to (222@lid):\nhey");
});

test("a group preview names the group and its jid, so same-named chats differ", () => {
  const a = wa("draft", "120363000000000001@g.us", "see you at 8");
  const b = wa("draft", "120363000000000002@g.us", "see you at 8");
  expect(a.out).toContain("WhatsApp to group Host (120363000000000001@g.us):\nsee you at 8");
  expect(b.out).toContain("WhatsApp to group Host (120363000000000002@g.us):\nsee you at 8");
  expect(idFrom(a.out)).not.toBe(idFrom(b.out));
});

test("a text draft from before preview binding is refused", () => {
  const id = idFrom(wa("draft", BOB, "old style").out);
  const j = draftJson(id);
  delete j.preview;
  writeFileSync(join(draftDir, `${id}.json`), JSON.stringify(j));
  const r = wa("send", "--approved", id, ...OK);
  expect(r.code).toBe(2);
  expect(r.err).toContain("predates preview binding");
  expect(approvalLog()).toHaveLength(0);
  expect(callLog()).toHaveLength(0);
});

test("two senders at once send once", async () => {
  const id = idFrom(wa("draft", BOB, "only once").out);
  const procs = [1, 2, 3].map(() =>
    Bun.spawn(["/bin/zsh", waBin, "send", "--approved", id, ...OK], { env: env({ SA_SLEEP: "1" }), stderr: "pipe" }),
  );
  const codes = (await Promise.all(procs.map(p => p.exited))).sort();
  expect(codes).toEqual([0, 2, 2]);
  expect(callLog()).toHaveLength(1);
  expect(existsSync(join(draftDir, `${id}.sent.json`))).toBe(true);
});

test("second use of an approved draft is refused and sends nothing", () => {
  const id = idFrom(wa("draft", BOB, "once only").out);
  expect(wa("send", "--approved", id, ...OK).code).toBe(0);
  const again = wa("send", "--approved", id, ...OK);
  expect(again.code).toBe(2);
  expect(again.err).toContain("already used");
  expect(callLog()).toHaveLength(1);
  expect(wa("draft", BOB, "once only").err).toContain("already sent");
});

test("expired draft (older than 24h) is refused", () => {
  const id = idFrom(wa("draft", BOB, "stale offer").out);
  const j = draftJson(id);
  j.created_at = Math.floor(Date.now() / 1000) - 2 * 86400;
  writeFileSync(join(draftDir, `${id}.json`), JSON.stringify(j));
  const r = wa("send", "--approved", id, ...OK);
  expect(r.code).toBe(2);
  expect(r.err).toContain("older than 24h");
  expect(callLog()).toHaveLength(0);
  expect(existsSync(join(draftDir, `${id}.json`))).toBe(true);
});

test("an expired draft written again gets a new id and keeps the old one dead", () => {
  // Astra r1 B5: redrafting used to renew created_at on the same id, so a days-old OK sent it.
  const id = idFrom(wa("draft", BOB, "stale offer").out);
  const j = draftJson(id);
  j.created_at = Math.floor(Date.now() / 1000) - 3 * 86400;
  writeFileSync(join(draftDir, `${id}.json`), JSON.stringify(j));
  const again = wa("draft", BOB, "stale offer");
  expect(again.code).toBe(0);
  const fresh = idFrom(again.out);
  expect(fresh).toMatch(/^[0-9a-f]{10}$/);
  expect(fresh).not.toBe(id);
  expect(existsSync(join(draftDir, `${id}.expired.json`))).toBe(true);
  const old = wa("send", "--approved", id, ...OK);
  expect(old.code).toBe(2);
  expect(old.err).toContain("already used (expired)");
  expect(approvalLog()).toHaveLength(0);
  expect(callLog()).toHaveLength(0);
  expect(draftJson(fresh).preview).toContain(`(draft ${fresh})`);
});

test("an id retired while a drafter waits for its lock is not reused", async () => {
  // Astra r2 S1 (mail; same pattern here): the failed/expired check ran only before the lock.
  const id = idFrom(wa("draft", BOB, "racy offer").out);
  for (const f of [`${id}.json`]) rmSync(join(draftDir, f));
  const lock = join(draftDir, "locks", id);
  const holder = Bun.spawn(["/usr/bin/python3", "-c",
    "import fcntl,sys,time\nf=open(sys.argv[1],'a')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('held',flush=True)\ntime.sleep(3)", lock],
    { stdout: "pipe" });
  const reader = holder.stdout.getReader();
  await reader.read();
  const drafter = Bun.spawn(["/bin/zsh", waBin, "draft", BOB, "racy offer"], { env: env(), stdout: "pipe", stderr: "pipe" });
  await Bun.sleep(1000);
  writeFileSync(join(draftDir, `${id}.failed.json`), "{}");
  await holder.exited;
  await drafter.exited;
  const out = await new Response(drafter.stdout).text();
  expect(drafter.exitCode).toBe(0);
  const fresh = idFrom(out);
  expect(fresh).toMatch(/^[0-9a-f]{10}$/);
  expect(fresh).not.toBe(id);
  expect(existsSync(join(draftDir, `${id}.json`))).toBe(false);
});

test("drafting a pending draft again keeps it as is (same clock, same preview)", () => {
  const id = idFrom(wa("draft", BOB, "keep me").out);
  const j = draftJson(id);
  j.created_at -= 3600;
  writeFileSync(join(draftDir, `${id}.json`), JSON.stringify(j));
  const again = wa("draft", BOB, "keep me");
  expect(again.code).toBe(0);
  expect(again.out).toContain(`DRAFT ${id} (already pending, unchanged)`);
  expect(draftJson(id).created_at).toBe(j.created_at);
});

test("wa tui (the old ungated sender) is gone", () => {
  // Astra r1 B7: `wa tui send <jid> <text>` reached the legacy whatscli wrapper with no approval.
  for (const sub of ["tui", "screen"]) {
    const r = wa(sub, "send", BOB, "hello");
    expect(r.code).toBe(2);
    expect(r.err).toContain("retired");
  }
  expect(callLog()).toHaveLength(0);
});

test("unknown draft id is refused", () => {
  const r = wa("send", "--approved", "0123456789", ...OK);
  expect(r.code).toBe(2);
  expect(r.err).toContain("no draft");
  expect(callLog()).toHaveLength(0);
});

test("a text draft cannot be sent with sendfile --approved", () => {
  const id = idFrom(wa("draft", BOB, "text only").out);
  const r = wa("sendfile", "--approved", id, ...OK);
  expect(r.code).toBe(2);
  expect(r.err).toContain("not file");
  expect(callLog()).toHaveLength(0);
});

test("a draft with text the chat would hide is refused and stores nothing", () => {
  const r = wa("draft", BOB, "Price is 400 <think>say 500</think>");
  expect(r.code).toBe(2);
  expect(r.err).toContain("hidden text");
  expect(existsSync(draftDir) ? readdirSync(draftDir).filter(f => f.endsWith(".json")) : []).toEqual([]);
});

test("multi-line text draft is refused", () => {
  const r = wa("draft", BOB, "line one\nline two");
  expect(r.code).toBe(2);
  expect(existsSync(draftDir)).toBe(false);
});

test("draftfile binds the file bytes; sendfile --approved passes --as and caption through", () => {
  const f = join(box, "menu.pdf");
  writeFileSync(f, "pdf");
  const d = wa("draftfile", BOB, f, "--as", "document", "the", "menu");
  expect(d.code).toBe(0);
  const id = idFrom(d.out);
  const sha = new Bun.CryptoHasher("sha256").update("pdf").digest("hex");
  const preview = `WhatsApp to Bob (+971500000001): file ${f} [document] (sha256 ${sha.slice(0, 12)})\n` +
    `Caption: the menu\n(draft ${id})`;
  expect(d.out).toContain(preview);
  expect(d.out).toContain(`wa sendfile --approved ${id}`);
  expect(d.out).toContain(`send-file him ${f}`);
  const j = draftJson(id);
  expect(j).toMatchObject({ kind: "file", jid: BOB, path: f, as: "document", caption: "the menu", sha256: sha, preview });

  const s = wa("sendfile", "--approved", id, ...OK);
  expect(s.code).toBe(0);
  expect(s.out).toBe("approved: ok\n(sent) Me: [document] menu.pdf");
  expect(approvalLog()[0]).toEqual(["check", ...OK, "--preview", preview, "--drafted-at", String(j.created_at), "--file", sha, "menu.pdf"]);
  expect(callLog()).toEqual([`--json send file --to ${BOB} --file ${f} --as document --caption the menu`]);
  expect(existsSync(join(draftDir, `${id}.sent.json`))).toBe(true);
  expect(wa("sendfile", "--approved", id, ...OK).code).toBe(2);
  expect(callLog()).toHaveLength(1);
});

test("a file changed after its draft is refused and stays unsent", () => {
  const f = join(box, "quote.pdf");
  writeFileSync(f, "v1");
  const id = idFrom(wa("draftfile", BOB, f).out);
  writeFileSync(f, "v2");
  const r = wa("sendfile", "--approved", id, ...OK);
  expect(r.code).toBe(2);
  expect(r.err).toContain("changed since draft");
  expect(approvalLog()).toHaveLength(0);
  expect(callLog()).toHaveLength(0);
});

test("a file draft from before file binding is refused", () => {
  const f = join(box, "old.pdf");
  writeFileSync(f, "x");
  const id = idFrom(wa("draftfile", BOB, f).out);
  const j = draftJson(id);
  delete j.sha256;
  writeFileSync(join(draftDir, `${id}.json`), JSON.stringify(j));
  const r = wa("sendfile", "--approved", id, ...OK);
  expect(r.code).toBe(2);
  expect(r.err).toContain("predates file binding");
  expect(callLog()).toHaveLength(0);
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

test("owner self-drafts skip the approval check", () => {
  const id = idFrom(wa("draft", OWNER, "reminder").out);
  expect(wa("send", "--approved", id, ...OK).code).toBe(0);
  expect(approvalLog()).toHaveLength(0);
  expect(callLog()).toEqual([`--json send text --to ${OWNER} --message reminder --allow-self`]);
});

test("a failed approved send is settled as failed and not retried", () => {
  const bad = join(box, "fail-wacli");
  writeFileSync(bad, `#!/bin/sh\necho "$@" >> "$FAKE_CALLS"\necho '{"success":false}'\nexit 1\n`);
  chmodSync(bad, 0o755);
  const id = idFrom(wa("draft", BOB, "may fail").out);
  const r = waEnv({ WA_WACLI: bad }, "send", "--approved", id, ...OK);
  expect(r.code).toBe(1);
  expect(existsSync(join(draftDir, `${id}.failed.json`))).toBe(true);
  expect(wa("send", "--approved", id, ...OK).code).toBe(2);
  expect(callLog()).toHaveLength(1);
  expect(readdirSync(draftDir).filter(f => f.endsWith(".sending.json"))).toHaveLength(0);
  // Writing it again gives a new id and preview, so the old OK can't send it.
  const again = idFrom(wa("draft", BOB, "may fail").out);
  expect(again).not.toBe(id);
});

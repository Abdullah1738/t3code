import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// wa send over stdin / --file / --quiet. The text must reach the sync daemon's socket only: never argv, env, a file or any output.
// A fake daemon stands in for the real send socket; no WhatsApp is involved. Box dir under /tmp keeps the unix socket path short.
const box = mkdtempSync("/tmp/wa-ss-");
const sock = join(box, "d.sock");
const requestsLog = join(box, "requests.log");
const draftDir = join(box, "drafts");
const calls = join(box, "calls.log");
const approvals = join(box, "approvals.log");
const fakeWacli = join(box, "wacli");
const fakeApproval = join(box, "send-approval");
const fakeDb = join(box, ".local/share/robob-watch/helpers/wa-db");
const daemonPy = join(box, "daemon.py");
const waBin = join(box, "wa");
const pkg = join(import.meta.dir, "../helpers");

// Fake wacli: logs argv to FAKE_CALLS. FAKE_MODE=id prints a message id; FAKE_MODE=fail echoes its argv and exits 1.
writeFileSync(
  fakeWacli,
  `#!/bin/sh\necho "$@" >> "$FAKE_CALLS"\n` +
    `case "$FAKE_MODE" in\n` +
    `  id) echo '{"success":true,"data":{"id":"3EB0POS0001"}}' ;;\n` +
    `  fail) echo "boom: $@"; exit 1 ;;\n` +
    `  *) echo '{"success":true}' ;;\nesac\n`,
);
writeFileSync(
  fakeApproval,
  `#!/usr/bin/python3\nimport json, os, sys, time\n` +
    `if sys.argv[1] == "visible": sys.exit("Refused: hidden text" if "<think" in sys.argv[2] else 0)\n` +
    `open(os.environ["FAKE_APPROVALS"], "a").write(json.dumps(sys.argv[1:]) + "\\n")\nprint("approved: ok")\n`,
);
mkdirSync(join(box, ".local/share/robob-watch/helpers"), { recursive: true });
writeFileSync(
  fakeDb,
  `#!/bin/sh\ncase "$1" in\n  name) case "$2" in 971500000001@s.whatsapp.net) echo Bob ;; esac ;;\n` +
    `  resolve) echo "$2" ;;\nesac\nexit 0\n`,
);
// Fake daemon: one thread per connection. Logs each request line; then by "to": the 9 number gets a refusal that
// echoes the message, the 8 number sleeps 3 s and closes with no reply, anything else sleeps 1 s and sends ok.
writeFileSync(
  daemonPy,
  `import json, os, socket, sys, threading, time\n` +
    `sock_path, log_path = sys.argv[1], sys.argv[2]\n` +
    `try:\n    os.unlink(sock_path)\nexcept FileNotFoundError:\n    pass\n` +
    `srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\nsrv.bind(sock_path)\nsrv.listen(16)\n` +
    `def handle(conn):\n    with conn:\n        buf = b""\n` +
    `        while b"\\n" not in buf:\n            chunk = conn.recv(65536)\n            if not chunk:\n                break\n            buf += chunk\n` +
    `        line = buf.split(b"\\n", 1)[0].decode("utf-8")\n` +
    `        with open(log_path, "a") as f:\n            f.write(line + "\\n")\n` +
    `        req = json.loads(line)\n        to, msg = req.get("to"), req.get("message", "")\n` +
    `        if to == "971500000009@s.whatsapp.net":\n            reply = {"ok": False, "error": 'could not send "%s": bad' % msg}\n` +
    `        elif to == "971500000008@s.whatsapp.net":\n            time.sleep(3)\n            return\n` +
    `        else:\n            time.sleep(1)\n            reply = {"ok": True, "sent": True, "to": to, "id": "3EB0TEST0001"}\n` +
    `        conn.sendall((json.dumps(reply) + "\\n").encode("utf-8"))\n` +
    `while True:\n    conn, _ = srv.accept()\n    threading.Thread(target=handle, args=(conn,), daemon=True).start()\n`,
);
// Fake approval also serves draft's "visible" check; keep the same shape as the wa-gate fixture.
for (const f of [fakeWacli, fakeApproval, fakeDb]) chmodSync(f, 0o755);
writeFileSync(waBin, readFileSync(join(pkg, "wa")));
chmodSync(waBin, 0o755);
// wa finds wa-sendtext next to itself (${0:A:h}), so the box needs its own copy.
writeFileSync(join(box, "wa-sendtext"), readFileSync(join(pkg, "wa-sendtext")));
chmodSync(join(box, "wa-sendtext"), 0o755);

const OWNER_JID = "971585134795@s.whatsapp.net";
const OWNER_NUM = "971585134795";
const BOB = "971500000001@s.whatsapp.net";
const NINE = "971500000009";
const EIGHT = "971500000008";
const TIP = "Tip: when a message speaks for Abdullah with new wording, money, dates or a commitment, show him a wa draft preview first.";
const enc = (s: string) => new TextEncoder().encode(s);
const secret = () => `Password: Zq9-${globalThis.crypto.randomUUID()}-$!x`;
const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
const callLog = () => lines(calls);
const requests = (): Record<string, unknown>[] => lines(requestsLog).map(l => JSON.parse(l));
const idFrom = (out: string) => out.match(/^DRAFT ([0-9a-f]{10}) /m)?.[1] ?? "";
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Env without the socket unless asked; WA_SEND_SOCK is what makes a stdin/file send reach the (fake) daemon.
const baseEnv = (): Record<string, string> => ({
  HOME: box,
  PATH: "/usr/bin:/bin",
  ROBOB_TEST: "1",
  WA_WACLI: fakeWacli,
  WA_DRAFT_DIR: draftDir,
  WA_SEND_APPROVAL: fakeApproval,
  FAKE_CALLS: calls,
  FAKE_APPROVALS: approvals,
  LANG: "en_US.UTF-8",
});

// Runs wa and samples every process's argv+env (ps -axwwE) until it exits, so a leak onto any process shows up.
async function runWa(args: string[], stdin: Uint8Array | null, extra: Record<string, string> = {}, withSock = true) {
  const env = { ...baseEnv(), ...(withSock ? { WA_SEND_SOCK: sock } : {}), ...extra };
  const proc = Bun.spawn(["/bin/zsh", waBin, ...args], {
    env,
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const samples: string[] = [];
  let done = false;
  proc.exited.then(() => (done = true));
  while (!done) {
    samples.push(Bun.spawnSync(["/bin/ps", "-axwwE", "-o", "command="]).stdout.toString());
    await sleep(30);
  }
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out.trim(), err: err.trim(), samples };
}

// Plain synchronous run for the paths that take the text positionally or on the draft side.
const waEnv = (extra: Record<string, string>, ...args: string[]) => {
  const r = Bun.spawnSync(["/bin/zsh", waBin, ...args], { env: { ...baseEnv(), ...extra } });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

function expectNoSecret(r: { out: string; err: string; samples: string[] }, s: string) {
  expect(r.out).not.toContain(s);
  expect(r.err).not.toContain(s);
  for (const sample of r.samples) expect(sample).not.toContain(s);
}

let daemon: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  daemon = Bun.spawn(["/usr/bin/python3", daemonPy, sock, requestsLog], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100 && !existsSync(sock); i++) await sleep(50);
  if (!existsSync(sock)) throw new Error("fake daemon socket never appeared");
});

afterAll(() => {
  daemon?.kill();
  rmSync(box, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(draftDir, { recursive: true, force: true });
  rmSync(calls, { force: true });
  rmSync(approvals, { force: true });
  rmSync(requestsLog, { force: true });
});

test("a. stdin send to another person goes through the socket: text on no argv, no output, only the id printed", async () => {
  const s = secret();
  const r = await runWa(["send", BOB, "-"], enc(`${s}\n`));
  expect(r.code).toBe(0);
  expect(r.out).toBe("(sent) id 3EB0TEST0001");
  expect(r.err).toBe(TIP);
  expectNoSecret(r, s);
  expect(r.samples.some(x => x.includes("wa-sendtext"))).toBe(true);
  const reqs = requests();
  expect(reqs).toEqual([{ version: 1, kind: "text", to: BOB, message: s, post_send_wait_ms: 2000, timeout_ms: 90000, deadline_unix_ms: expect.any(Number) }]);
  expect(reqs[0]).not.toHaveProperty("allow_self");
  expect(callLog()).toHaveLength(0);
});

test("b. --file send: same guarantees as stdin", async () => {
  const s = secret();
  const f = join(box, "msg.txt");
  writeFileSync(f, `${s}\n`);
  const r = await runWa(["send", BOB, "--file", f], null);
  expect(r.code).toBe(0);
  expect(r.out).toBe("(sent) id 3EB0TEST0001");
  expect(r.err).toBe(TIP);
  expectNoSecret(r, s);
  expect(r.samples.some(x => x.includes("wa-sendtext"))).toBe(true);
  const reqs = requests();
  expect(reqs).toHaveLength(1);
  expect(reqs[0]).toMatchObject({ version: 1, kind: "text", to: BOB, message: s });
  expect(reqs[0]).not.toHaveProperty("allow_self");
  expect(callLog()).toHaveLength(0);
});

test("c. owner's own number via stdin: allow_self is set and there is no Tip line", async () => {
  const s = secret();
  const r = await runWa(["send", OWNER_NUM, "-"], enc(`${s}\n`));
  expect(r.code).toBe(0);
  expect(r.out).toBe("(sent) id 3EB0TEST0001");
  expect(r.err).toBe("");
  expectNoSecret(r, s);
  const reqs = requests();
  expect(reqs).toHaveLength(1);
  expect(reqs[0]).toMatchObject({ to: OWNER_JID, message: s, allow_self: true });
  expect(callLog()).toHaveLength(0);
});

test("d. daemon refusal: exit 1, the text is hidden in the error", async () => {
  const s = secret();
  const r = await runWa(["send", NINE, "-"], enc(`${s}\n`));
  expect(r.code).toBe(1);
  expect(r.err).toContain("not sent");
  expect(r.err).toContain("[message hidden]");
  expect(r.out).toBe("");
  expectNoSecret(r, s);
  expect(requests()).toHaveLength(1);
});

test("e. no reply from the daemon: exit 4 and the message may have gone through", async () => {
  const s = secret();
  const r = await runWa(["send", EIGHT, "-"], enc(`${s}\n`), { WA_SEND_TIMEOUT_MS: "1000" });
  expect(r.code).toBe(4);
  expect(r.err).toContain("may still have gone through");
  expect(r.out).toBe("");
  expectNoSecret(r, s);
});

test("f. daemon unreachable: exit 3, nothing sent, wacli never called", async () => {
  const s = secret();
  const r = await runWa(["send", BOB, "-"], enc(`${s}\n`), { WA_SEND_SOCK: join(box, "none.sock") }, false);
  expect(r.code).toBe(3);
  expect(r.err).toContain("Nothing was sent");
  expectNoSecret(r, s);
  expect(callLog()).toHaveLength(0);
  expect(requests()).toHaveLength(0);
});

test("g. multi-line stdin and empty stdin are refused with no secret in the output and nothing logged", async () => {
  const s = secret();
  const multi = await runWa(["send", BOB, "-"], enc(`${s}\nsecond line\n`));
  expect(multi.code).toBe(2);
  expect(multi.err).toContain("single-line text only");
  expectNoSecret(multi, s);

  const empty = await runWa(["send", BOB, "-"], new Uint8Array(0));
  expect(empty.code).toBe(2);
  expect(empty.err).toContain("empty text");
  expect(requests()).toHaveLength(0);
  expect(callLog()).toHaveLength(0);
});

test("h. --quiet with positional text prints only the id; the text never reaches stdout or stderr", () => {
  const s = secret();
  const before = waEnv({ FAKE_MODE: "id" }, "send", "--quiet", BOB, s);
  expect(before.code).toBe(0);
  expect(before.out).toBe("(sent) id 3EB0POS0001");
  expect(before.out).not.toContain(s);
  expect(before.err).not.toContain(s);

  const after = waEnv({ FAKE_MODE: "id" }, "send", BOB, "--quiet", s);
  expect(after.code).toBe(0);
  expect(after.out).toBe("(sent) id 3EB0POS0001");

  const failing = waEnv({ FAKE_MODE: "fail" }, "send", "--quiet", BOB, s);
  expect(failing.code).toBe(1);
  expect(failing.err).toContain("[message hidden]");
  expect(failing.err).not.toContain(s);
  expect(failing.out).not.toContain(s);
});

test("i. --approved <id> --quiet prints only the id", () => {
  const s = secret();
  const id = idFrom(waEnv({}, "draft", BOB, s).out);
  expect(id).toMatch(/^[0-9a-f]{10}$/);
  const r = waEnv({ FAKE_MODE: "id" }, "send", "--approved", id, "--quiet");
  expect(r.code).toBe(0);
  expect(r.out).toBe("(sent) id 3EB0POS0001");
  expect(r.out).not.toContain(s);
  expect(r.err).not.toContain(s);
});

test("j. guard: a test run refuses stdin sends unless WA_SEND_SOCK points at a stub", async () => {
  const s = secret();
  const r = await runWa(["send", BOB, "-"], enc(`${s}\n`), {}, false);
  expect(r.code).toBe(2);
  expect(r.err).toContain("refused: test run");
  expectNoSecret(r, s);
  expect(requests()).toHaveLength(0);
  expect(callLog()).toHaveLength(0);
});

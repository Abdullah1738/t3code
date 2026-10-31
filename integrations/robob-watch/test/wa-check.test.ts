import { afterAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// wa check against a fake ~/.wacli, a fake wacli and a fake launchctl; no WhatsApp or launchd involved.
const box = mkdtempSync(join(tmpdir(), "wa-check-test-"));
const store = join(box, ".wacli");
const bin = join(box, "bin");
const helpersDir = join(box, ".local/share/robob-watch/helpers");
for (const d of [store, bin, helpersDir]) mkdirSync(d, { recursive: true });
const db = join(store, "wacli.db");
const sql = (q: string, path = db) => { const r = Bun.spawnSync(["/usr/bin/sqlite3", path, q]); if (r.exitCode) throw new Error(r.stderr.toString()); };
sql(`create table chats (jid text primary key, kind text, name text, last_message_ts int, unread_count int default 0);
  create table contacts (jid text primary key, phone text, push_name text, full_name text, first_name text, business_name text, system_name text, updated_at int);
  create table contact_aliases (jid text primary key, alias text, notes text, updated_at int);
  insert into contacts values ('971500000001@s.whatsapp.net','971500000001','Bob Driver','','','','',0);
  insert into contacts values ('123456789012345@lid','971500000009','','','','','',0);`);
sql(`create table whatsmeow_lid_map (lid text primary key, pn text unique not null); insert into whatsmeow_lid_map values ('222','447700900123');
  create table whatsmeow_contacts (our_jid text, their_jid text, first_name text, full_name text, push_name text, business_name text, redacted_phone text);
  insert into whatsmeow_contacts values ('me','222@lid','','','Chauffeur Sam','','');`, join(store, "session.db"));

const calls = join(box, "calls.log");
const down = join(box, "daemon-down");
const mark = join(store, ".backfill-until");
// Fake launchctl: records calls and tracks whether the sync agent is loaded (bootout unloads, bootstrap loads).
const fakeLaunchctl = join(bin, "launchctl");
writeFileSync(fakeLaunchctl, `#!/bin/sh
echo "launchctl $*" >> "$FAKE_CALLS"
case "$1" in
  bootout) : > "$FAKE_DOWN" ;;
  bootstrap) [ -n "$FAKE_NO_RELOAD" ] && exit 5; rm -f "$FAKE_DOWN" ;;
  print) [ -e "$FAKE_DOWN" ] && exit 113 ;;
esac
exit 0
`);
// Fake wacli: records its args plus whether the daemon was down and the guard marker present at call time.
const fakeWacli = join(bin, "wacli");
writeFileSync(fakeWacli, `#!/bin/sh
state=up; [ -e "$FAKE_DOWN" ] && state=down
m=nomark; [ -e "$HOME/.wacli/.backfill-until" ] && m=mark
echo "wacli[$state,$m] $*" >> "$FAKE_CALLS"
[ -n "$FAKE_WACLI_ERR" ] && printf '%s\\n' "$FAKE_WACLI_ERR" >&2
[ -n "$FAKE_WACLI_OUT" ] && printf '%s\\n' "$FAKE_WACLI_OUT"
exit \${FAKE_WACLI_RC:-0}
`);
chmodSync(fakeLaunchctl, 0o755);
chmodSync(fakeWacli, 0o755);
const waBin = join(box, "wa");
writeFileSync(waBin, readFileSync(join(import.meta.dir, "../helpers/wa")));
chmodSync(waBin, 0o755);
writeFileSync(join(helpersDir, "wa-db"), readFileSync(join(import.meta.dir, "../helpers/wa-db")));
chmodSync(join(helpersDir, "wa-db"), 0o755);

const uid = Bun.spawnSync(["/usr/bin/id", "-u"]).stdout.toString().trim();
const SVC = `gui/${uid}/com.ardud.wacli-sync`;
const PLIST = join(box, "Library/LaunchAgents/com.ardud.wacli-sync.plist");
const wa = (args: string[], extra: Record<string, string> = {}) => {
  const r = Bun.spawnSync(["/bin/zsh", waBin, ...args], {
    env: { HOME: box, PATH: [bin, "/usr/bin", "/bin"].join(":"), ROBOB_TEST: "1", WA_WACLI: fakeWacli, WA_LAUNCHCTL: fakeLaunchctl,
      FAKE_CALLS: calls, FAKE_DOWN: down, LANG: "en_US.UTF-8", ...extra },
  });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
const callLog = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
const reply = (data: unknown) => JSON.stringify({ success: true, data, error: null });

afterAll(() => rmSync(box, { recursive: true, force: true }));
beforeEach(() => { for (const f of [calls, down, mark]) rmSync(f, { force: true }); });

test("number in contacts is known locally; wacli and launchctl are never called", () => {
  const r = wa(["check", "+971 50 000 0001"]);
  expect(r).toMatchObject({ code: 0, err: "" });
  expect(r.out).toBe("+971500000001 | on WhatsApp (known locally) | 971500000001@s.whatsapp.net | Bob Driver");
  expect(callLog()).toHaveLength(0);
});

test("number only in the LID map is known locally (name from the LID identity)", () => {
  const r = wa(["check", "00447700900123"]);
  expect(r.code).toBe(0);
  expect(r.out).toBe("+447700900123 | on WhatsApp (known locally) | 447700900123@s.whatsapp.net | Chauffeur Sam");
  expect(callLog()).toHaveLength(0);
});

test("the phone column of a LID contact row is not taken as a phone number", () => {
  const r = wa(["check", "--local-only", "971500000009"]);
  expect(r.out).toBe("+971500000009 | unknown locally");
});

test("--local-only prints unknown locally and calls nothing", () => {
  const r = wa(["check", "--local-only", "+971501112222", "971500000001"]);
  expect(r.code).toBe(0);
  expect(r.out.split("\n")).toEqual([
    "+971501112222 | unknown locally",
    "+971500000001 | on WhatsApp (known locally) | 971500000001@s.whatsapp.net | Bob Driver",
  ]);
  expect(callLog()).toHaveLength(0);
});

test("unknown numbers get one live check with the daemon paused, then restored", () => {
  const out = reply([
    { query: "+971501112222", phone: "971501112222", jid: "971501112222@s.whatsapp.net", registered: true, responded: true },
    { query: "+971503334444", phone: "971503334444", registered: false, responded: true },
    { query: "+971505556666", phone: "971505556666", registered: false, responded: false },
  ]);
  const r = wa(["check", "971501112222", "+971500000001", "+971 50 333 4444", "971505556666"], { FAKE_WACLI_OUT: out });
  expect(r.code).toBe(0);
  expect(r.out.split("\n")).toEqual([
    "+971501112222 | on WhatsApp | 971501112222@s.whatsapp.net",
    "+971500000001 | on WhatsApp (known locally) | 971500000001@s.whatsapp.net | Bob Driver",
    "+971503334444 | NOT on WhatsApp",
    "+971505556666 | no answer from WhatsApp (unknown, try again later)",
  ]);
  const log = callLog();
  expect(log[0]).toBe(`launchctl bootout ${SVC}`);
  expect(log[1]).toMatch(/^wacli\[down,mark\] --json --timeout \d+s --lock-wait 8s contacts check \+971501112222 \+971503334444 \+971505556666$/);
  expect(Number(log[1].match(/--timeout (\d+)s/)?.[1])).toBeLessThanOrEqual(25);
  expect(log[2]).toBe(`launchctl bootstrap gui/${uid} ${PLIST}`);
  expect(log[3]).toBe(`launchctl print ${SVC}`);
  expect(log).toHaveLength(4);
  expect(log.filter(l => l.startsWith("wacli"))).toHaveLength(1);
  expect(existsSync(down)).toBe(false);
  expect(existsSync(mark)).toBe(false);
});

test("failing wacli: daemon still restored, exit 1, clear message", () => {
  const r = wa(["check", "+971501112222"], {
    FAKE_WACLI_RC: "1",
    FAKE_WACLI_ERR: JSON.stringify({ success: false, data: null, error: "store is locked (another wacli is running?) pid=1475" }),
  });
  expect(r.code).toBe(1);
  expect(r.out).toBe("+971501112222 | unknown (live check failed)");
  expect(r.err).toContain("wa check: live check failed (wacli exit 1): store is locked (another wacli is running?) pid=1475");
  expect(r.err).toContain("the sync daemon was reloaded");
  const log = callLog();
  expect(log[0]).toBe(`launchctl bootout ${SVC}`);
  expect(log[1]).toStartWith("wacli[down,mark] ");
  expect(log[2]).toBe(`launchctl bootstrap gui/${uid} ${PLIST}`);
  expect(existsSync(down)).toBe(false);
  expect(existsSync(mark)).toBe(false);
});

test("non-JSON wacli output with exit 0 is a failure, not a NOT on WhatsApp", () => {
  const r = wa(["check", "+971501112222"], { FAKE_WACLI_OUT: "971501112222\tregistered" });
  expect(r.code).toBe(1);
  expect(r.out).toBe("+971501112222 | unknown (live check failed)");
  expect(r.err).toContain("live check failed (wacli exit 0): 971501112222\tregistered");
  expect(callLog().at(-2)).toBe(`launchctl bootstrap gui/${uid} ${PLIST}`);
});

test("a daemon that does not come back is reported", () => {
  const r = wa(["check", "+971501112222"], { FAKE_WACLI_OUT: reply([{ phone: "971501112222", registered: false, responded: true }]), FAKE_NO_RELOAD: "1" });
  expect(r.code).toBe(0);
  expect(r.out).toBe("+971501112222 | NOT on WhatsApp");
  expect(r.err).toContain("the sync daemon did NOT reload, run: wa start");
});

test("a running history backfill blocks the live check; nothing is stopped", () => {
  writeFileSync(mark, `${Math.floor(Date.now() / 1000) + 120}\n`);
  const r = wa(["check", "+971501112222", "971500000001"]);
  expect(r.code).toBe(3);
  expect(r.out.split("\n")).toEqual([
    "+971501112222 | unknown locally",
    "+971500000001 | on WhatsApp (known locally) | 971500000001@s.whatsapp.net | Bob Driver",
  ]);
  expect(r.err).toContain("paused for a history backfill");
  expect(callLog()).toHaveLength(0);
  expect(existsSync(mark)).toBe(true);
});

// Holds the shared live lock from another process, like a running wa check or wa read --more would.
const holdLock = () => {
  const lockFile = join(store, ".wa-check.lock");
  writeFileSync(lockFile, "");
  const p = Bun.spawn(["/bin/zsh", "-c", `zmodload zsh/system; zsystem flock "${lockFile}" && { print held; sleep 20 }`], { stdout: "pipe" });
  return p;
};
const waitHeld = async (p: ReturnType<typeof Bun.spawn>) => {
  const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain("held");
};

test("a live check waits for the shared lock and reports busy (exit 3) without pausing the daemon", async () => {
  const p = holdLock();
  try {
    await waitHeld(p);
    const r = wa(["check", "+971501112222"], { WA_LOCK_WAIT: "1" });
    expect(r.code).toBe(3);
    expect(r.out).toBe("+971501112222 | unknown locally");
    expect(r.err).toContain("another live check or history backfill is running");
    expect(callLog()).toHaveLength(0);
    expect(existsSync(mark)).toBe(false);
  } finally { p.kill(); }
});

test("wa read --more takes the same lock, so it never pauses the daemon during a live check", async () => {
  const p = holdLock();
  try {
    await waitHeld(p);
    const r = wa(["read", "971500000001", "--more", "1"], { WA_LOCK_WAIT: "1" });
    expect(r.code).toBe(3);
    expect(r.err).toContain("a live wa check is running");
    expect(callLog()).toHaveLength(0);
    expect(existsSync(mark)).toBe(false);
  } finally { p.kill(); }
});

test("a bootstrap that fails right after bootout is retried, then kickstarted", () => {
  const r = wa(["check", "+971501112222"], { FAKE_WACLI_OUT: reply([{ phone: "971501112222", registered: true, responded: true, jid: "971501112222@s.whatsapp.net" }]), FAKE_NO_RELOAD: "1" });
  expect(r.code).toBe(0);
  const log = callLog();
  expect(log.filter((l) => l.startsWith("launchctl bootstrap"))).toHaveLength(2);
  expect(log).toContain(`launchctl kickstart -k ${SVC}`);
  expect(existsSync(mark)).toBe(false);
});

test("bad numbers and empty calls are refused before anything runs", () => {
  for (const args of [["check"], ["check", "--local-only"], ["check", "0501234567"], ["check", "123@lid"], ["check", "12ab34"]]) {
    const r = wa(args);
    expect(r.code).toBe(2);
    expect(r.err).not.toBe("");
  }
  expect(callLog()).toHaveLength(0);
});

test("wa help prints the whole usage header including check", () => {
  const r = wa(["help"]);
  expect(r.out).toContain("wa check <number...> [--local-only]");
  expect(r.out.split("\n")[0]).toStartWith("# wa ");
  expect(r.out.split("\n").at(-1)).toContain("<id>.sent.json or <id>.failed.json");
});

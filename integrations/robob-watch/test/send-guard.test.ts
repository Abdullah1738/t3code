import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Card #14: a real send or draft refuses under a test run; a stub injected by the test still works.
// The test-run marker comes from the shared preload (test/setup-test-run.ts via bunfig.toml).
const helpers = join(import.meta.dir, "../helpers");
// The test-run marker comes from the shared setup (bunfig.toml preload), not from each fixture. A child env built
// here keeps it only when the parent has it, so a missing shared setup shows up as a real send, not a pass.
// Children write caches and locks under HOME, so it is a throwaway dir, never the repo.
const bareHome = mkdtempSync(join(tmpdir(), "send-guard-home-"));
afterAll(() => rmSync(bareHome, { recursive: true, force: true }));
const bare = (extra: Record<string, string> = {}) => ({
  PATH: "/usr/bin:/bin",
  LANG: "en_US.UTF-8",
  HOME: bareHome,
  ...(process.env.ROBOB_TEST ? { ROBOB_TEST: process.env.ROBOB_TEST } : {}),
  ...extra,
});

test("wa send refuses a real send under ROBOB_TEST without touching wacli", () => {
  const r = Bun.spawnSync(["/bin/zsh", join(helpers, "wa"), "send", "971500000002", "hi"], {
    env: bare(),
  });
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("refused: test run");
});

test("wa draft refuses under NODE_ENV=test (bun test)", () => {
  const r = Bun.spawnSync(["/bin/zsh", join(helpers, "wa"), "draft", "971500000002", "hi"], {
    env: bare({ NODE_ENV: "test" }),
  });
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("refused: test run");
});

test("wa sendfile refuses under PYTEST_CURRENT_TEST", () => {
  const r = Bun.spawnSync(["/bin/zsh", join(helpers, "wa"), "sendfile", "971500000002", "/etc/hosts"], {
    env: bare({ PYTEST_CURRENT_TEST: "x" }),
  });
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("refused: test run");
});

test("wa send still runs its stubbed wacli under a test run", () => {
  const r = Bun.spawnSync(["/bin/zsh", join(helpers, "wa"), "send", "971500000002", "hi"], {
    env: bare({ WA_WACLI: "/usr/bin/false" }),
  });
  // The guard let it through: the stub (false) ran and failed, so the refusal text is absent.
  expect(r.stderr.toString()).not.toContain("refused: test run");
});

// src/lib.ts sends iMessage and Telegram through the bridge CLIs; a test run must refuse without a stub CLI.
const libGuard = (expr: string) => Bun.spawnSync([process.execPath, "-e",
  `import { imessage, wake, telegram } from ${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))}; console.log(JSON.stringify(await (${expr})))`],
  { env: bare() });

test("src imessage() refuses a real send under a test run", () => {
  const r = libGuard(`imessage("hi", "k")`);
  expect(r.stdout.toString()).toContain("refused: test run");
});

test("src wake() refuses a real wake under a test run", () => {
  const r = libGuard(`wake("src", "hi", "k")`);
  expect(r.stdout.toString()).toContain("refused: test run");
});

test("src telegram() refuses a real notify under a test run", () => {
  const r = libGuard(`telegram("src", "hi", "k")`);
  expect(r.stdout.toString()).toContain("refused: test run");
});

// A stub removed while imessage() is still awaiting liveSession() must not reopen the live bridge: the command
// is decided before the await. A harmless default-path sentinel records if the live CLI runs.
// A stub removed while imessage() is still awaiting liveSession() must not reopen the live bridge: the command is
// decided before the await. The fake HOME has a real Bun, a live route and a sentinel at the default bridge path.
test("removing the stub mid-call runs the stub, never the live bridge", () => {
  const home = mkdtempSync(join(tmpdir(), "imsg-pending-"));
  mkdirSync(join(home, ".bun/bin"), { recursive: true });
  symlinkSync(process.execPath, join(home, ".bun/bin/bun"));
  mkdirSync(join(home, ".config/spectrum-bridge"), { recursive: true });
  const db = join(home, ".config/spectrum-bridge/state.sqlite");
  const mk = Bun.spawnSync(["/usr/bin/sqlite3", db, `create table kv(key text primary key, value text); insert into kv values('route', '{"id":"ses_test"}');`]);
  expect(mk.exitCode).toBe(0);
  mkdirSync(join(home, ".local/share/spectrum-bridge/src"), { recursive: true });
  const liveRan = join(home, "live-ran");
  writeFileSync(join(home, ".local/share/spectrum-bridge/src/cli.ts"), `require("node:fs").writeFileSync(${JSON.stringify(liveRan)}, "ran");`);
  const stubRan = join(home, "stub-ran");
  const stub = join(home, "stub-cli.ts");
  writeFileSync(stub, `require("node:fs").writeFileSync(${JSON.stringify(stubRan)}, process.argv.slice(2).join(" "));`);
  const code = `process.env.ROBOB_WATCH_SPECTRUM_CLI = ${JSON.stringify(stub)};
const { imessage } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))});
const p = imessage("hi", "k");
delete process.env.ROBOB_WATCH_SPECTRUM_CLI;
console.log(JSON.stringify(await p));`;
  const r = Bun.spawnSync([process.execPath, "-e", code], { env: bare({ HOME: home }) });
  const out = r.stdout.toString() + r.stderr.toString();
  expect(r.exitCode, out).toBe(0);
  expect(JSON.parse(r.stdout.toString()).ok, out).toBe(true);
  expect(existsSync(stubRan), out).toBe(true);
  expect(existsSync(liveRan), out).toBe(false);
});

// runCheck: a check that runs wa send, with no stub, is refused under the test markers the parent carries.
test("a check child under a test run inherits the markers and is refused a real wa send", () => {
  const code = `import { runCheck } from ${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))};
const w = { id: "t", title: "t", serial: false, check: "/bin/zsh -c 'exec ${join(helpers, "wa")} send 971500000002 hi'" } as any;
const r = await runCheck(w, "/tmp");
console.log(JSON.stringify(r.stderr + r.stdout));`;
  const r = Bun.spawnSync([process.execPath, "-e", code], { env: bare() });
  expect(r.stdout.toString()).toContain("refused: test run");
});

// An ordinary fixture (no stub) refuses: the regression that the shared setup must stop.
test("a fixture with no stub refuses a real send", () => {
  const r = Bun.spawnSync([join(helpers, "wa"), "send", "971500000002", "hi"], { env: bare() });
  expect(r.stderr.toString()).toContain("refused: test run");
});

// ride-card and convo-card look up their card before they reach the bridge, so call bridge() directly.
const bridgeGuard = (file: string) => {
  const code = `from importlib.machinery import SourceFileLoader; m = SourceFileLoader("h", ${JSON.stringify(file)}).load_module(); m.bridge("send", "--text", "x")`;
  return Bun.spawnSync(["/usr/bin/python3", "-c", code], { env: bare() });
};

test("ride-card bridge() refuses a real send under a test run", () => {
  const r = bridgeGuard(join(helpers, "ride-card/ride_card.py"));
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("refused: test run");
});

test("convo-card bridge() refuses a real send under a test run", () => {
  const r = bridgeGuard(join(helpers, "convo-card/convo_card.py"));
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("refused: test run");
});

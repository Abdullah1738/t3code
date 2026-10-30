import { expect, test } from "bun:test";
import { join } from "node:path";

// Card #14: a real send or draft refuses under a test run; a stub injected by the test still works.
// Every spawn strips the ambient env and sets ROBOB_TEST itself, so the guard is tested without relying on the caller's env.
const helpers = join(import.meta.dir, "../helpers");
const bare = (extra: Record<string, string> = {}) => ({
  PATH: "/usr/bin:/bin",
  LANG: "en_US.UTF-8",
  HOME: join(import.meta.dir, ".."),
  ...extra,
});

test("wa send refuses a real send under ROBOB_TEST without touching wacli", () => {
  const r = Bun.spawnSync(["/bin/zsh", join(helpers, "wa"), "send", "971500000002", "hi"], {
    env: bare({ ROBOB_TEST: "1" }),
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
    env: bare({ ROBOB_TEST: "1", WA_WACLI: "/usr/bin/false" }),
  });
  // The guard let it through: the stub (false) ran and failed, so the refusal text is absent.
  expect(r.stderr.toString()).not.toContain("refused: test run");
});

// src/lib.ts sends iMessage and Telegram through the bridge CLIs; a test run must refuse without a stub CLI.
const libGuard = (expr: string) => Bun.spawnSync([process.execPath, "-e",
  `import { imessage, wake, telegram } from ${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))}; console.log(JSON.stringify(await (${expr})))`],
  { env: bare({ ROBOB_TEST: "1" }) });

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

// Override set after import: the guard reads the env at call time, and so does the command, so the stub is used.
test("an override installed after import is honoured by the guard and the command", () => {
  const code = `import { imessage } from ${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))};
process.env.ROBOB_WATCH_SPECTRUM_CLI = "/nonexistent/stub-cli.ts";
console.log(JSON.stringify(await imessage("hi", "k")));`;
  const r = Bun.spawnSync([process.execPath, "-e", code], { env: bare({ ROBOB_TEST: "1" }) });
  expect(r.stdout.toString()).not.toContain("refused: test run");
});

// runCheck: a check that runs wa send, with no stub, is refused under the test markers the parent carries.
test("a check child under a test run inherits the markers and is refused a real wa send", () => {
  const code = `import { runCheck } from ${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))};
const w = { id: "t", title: "t", serial: false, check: "/bin/zsh -c 'exec ${join(helpers, "wa")} send 971500000002 hi'" } as any;
const r = await runCheck(w, "/tmp");
console.log(JSON.stringify(r.stderr + r.stdout));`;
  const r = Bun.spawnSync([process.execPath, "-e", code], { env: bare({ ROBOB_TEST: "1" }) });
  expect(r.stdout.toString()).toContain("refused: test run");
});

// An ordinary fixture (no stub) refuses: the regression that the shared setup must stop.
test("a fixture with no stub refuses a real send", () => {
  const r = Bun.spawnSync([join(helpers, "wa"), "send", "971500000002", "hi"], { env: bare({ ROBOB_TEST: "1" }) });
  expect(r.stderr.toString()).toContain("refused: test run");
});

// ride-card and convo-card look up their card before they reach the bridge, so call bridge() directly.
const bridgeGuard = (file: string) => {
  const code = `from importlib.machinery import SourceFileLoader; m = SourceFileLoader("h", ${JSON.stringify(file)}).load_module(); m.bridge("send", "--text", "x")`;
  return Bun.spawnSync(["/usr/bin/python3", "-c", code], { env: bare({ ROBOB_TEST: "1" }) });
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

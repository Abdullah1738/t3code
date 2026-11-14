// @effect-diagnostics nodeBuiltinImport:off - Exercises the shell entry point in a disposable repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { afterEach, describe, expect, it } from "vite-plus/test";

const script = NodePath.join(import.meta.dirname, "release-gate-integration.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

function createRepo(lockfile: "bun.lock" | "bun.lockb" | null = "bun.lock") {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "release-gate-")),
  );
  roots.push(root);
  const integration = NodePath.join(root, "integrations/fake");
  const bin = NodePath.join(root, "bin");
  const out = NodePath.join(root, "gate output");
  const calls = NodePath.join(root, "bun-calls");
  NodeFS.mkdirSync(integration, { recursive: true });
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(NodePath.join(integration, "package.json"), '{"private":true}');
  if (lockfile) NodeFS.writeFileSync(NodePath.join(integration, lockfile), "");
  NodeFS.writeFileSync(
    NodePath.join(bin, "bun"),
    `#!/bin/sh
{
  printf '%s' "$PWD"
  printf '\\t%s' "$@"
  printf '\\n'
} >> "$BUN_CALLS"
case "$1" in
  --version) echo 1.4.0-fake ;;
  install) exit "\${INSTALL_RC:-0}" ;;
  test) exit "\${TEST_RC:-0}" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );

  return {
    root,
    integration,
    bin,
    out,
    run: (files: string[] = [], env: NodeJS.ProcessEnv = {}, name = "fake", outDir = out) =>
      NodeChildProcess.spawnSync("/bin/bash", [script, outDir, name, ...files], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...NodeProcess.env,
          PATH: `${bin}${NodePath.delimiter}${NodeProcess.env.PATH}`,
          BUN_CALLS: calls,
          INSTALL_RC: "0",
          TEST_RC: "0",
          ...env,
        },
      }),
    log: () => NodeFS.readFileSync(NodePath.join(out, "integration-fake.log"), "utf8"),
    rc: () => NodeFS.readFileSync(NodePath.join(out, "integration-fake.rc"), "utf8"),
    calls: () =>
      NodeFS.readFileSync(calls, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => line.split("\t")),
  };
}

describe("release-gate-integration", () => {
  it.each(["bun.lock", "bun.lockb"] as const)(
    "installs %s frozen before testing from the integration with normalized arguments",
    (lockfile) => {
      const repo = createRepo(lockfile);
      const result = repo.run([
        "integrations/fake/test/cli.test.ts",
        "test/control.test.ts",
        "integrations/fake/test/with spaces.test.ts",
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(repo.calls()).toEqual([
        [repo.integration, "--version"],
        [repo.integration, "install", "--frozen-lockfile"],
        [
          repo.integration,
          "test",
          "test/cli.test.ts",
          "test/control.test.ts",
          "test/with spaces.test.ts",
        ],
      ]);
      expect(repo.rc()).toBe("0\n");
      expect(repo.log()).toContain("GATE_BUN_VERSION 1.4.0-fake\n");
      expect(result.stdout).toContain("GATE_BUN integration-fake 1.4.0-fake\n");
      expect(result.stdout).toContain("GATE_STEP integration-fake rc=0\n");
    },
  );

  it("runs the whole package with no test files and accepts a relative output directory", () => {
    const repo = createRepo();
    const result = repo.run([], {}, "fake", "gate output");

    expect(result.status, result.stderr).toBe(0);
    expect(repo.calls().at(-1)).toEqual([repo.integration, "test"]);
    expect(repo.log()).toContain("GATE_BUN_VERSION 1.4.0-fake\n");
    expect(repo.rc()).toBe("0\n");
  });

  it("propagates a test failure to the exit code, receipt and gate line", () => {
    const repo = createRepo();
    const result = repo.run([], { TEST_RC: "23" });

    expect(result.status, result.stderr).toBe(23);
    expect(repo.rc()).toBe("23\n");
    expect(result.stdout).toContain("GATE_STEP integration-fake rc=23\n");
    expect(result.stdout).toContain("GATE_BUN integration-fake 1.4.0-fake\n");
  });

  it("stops after a frozen install failure and records its exit code", () => {
    const repo = createRepo();
    const result = repo.run([], { INSTALL_RC: "42" });

    expect(result.status, result.stderr).toBe(42);
    expect(repo.calls()).toEqual([
      [repo.integration, "--version"],
      [repo.integration, "install", "--frozen-lockfile"],
    ]);
    expect(repo.log()).toContain("GATE_INSTALL_FAILED rc=42\n");
    expect(repo.rc()).toBe("42\n");
    expect(result.stdout).toContain("GATE_STEP integration-fake rc=42\n");
  });

  it("skips installation when there is no lockfile", () => {
    const repo = createRepo(null);
    const result = repo.run(["test/runner.test.ts"]);

    expect(result.status, result.stderr).toBe(0);
    expect(repo.calls()).toEqual([
      [repo.integration, "--version"],
      [repo.integration, "test", "test/runner.test.ts"],
    ]);
    expect(repo.log()).toContain("GATE_NO_LOCKFILE\n");
  });

  it("records a missing Bun as exit 127", () => {
    const repo = createRepo();
    const onlyUtilities = NodePath.join(repo.root, "utilities");
    NodeFS.mkdirSync(onlyUtilities);
    for (const name of ["mkdir", "tail", "awk"]) {
      const path = NodeChildProcess.execFileSync("/bin/sh", ["-c", `command -v ${name}`], {
        encoding: "utf8",
      }).trim();
      NodeFS.symlinkSync(path, NodePath.join(onlyUtilities, name));
    }
    const result = repo.run([], { PATH: onlyUtilities });

    expect(result.status, result.stderr).toBe(127);
    expect(repo.log()).toContain("GATE_BUN_MISSING\n");
    expect(repo.rc()).toBe("127\n");
    expect(result.stdout).toContain("GATE_STEP integration-fake rc=127\n");
  });

  it("rejects an unknown integration with usage and exit 2", () => {
    const repo = createRepo();
    const result = repo.run([], {}, "unknown");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
    expect(NodeFS.existsSync(repo.out)).toBe(false);
  });
});

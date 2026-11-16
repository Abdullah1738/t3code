import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";

const script = NodeURL.fileURLToPath(new URL("./release-gate-env.sh", import.meta.url));
const roots = [];
NodeTest.afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function fixture({
  sqlite = true,
  python = true,
  aptExit = 0,
  pythonExit = 0,
  sqliteExit = 0,
} = {}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "release-env-"));
  roots.push(root);
  const executable = (name, body) =>
    NodeFS.writeFileSync(NodePath.join(root, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  if (python)
    executable("python3", `[[ \${1:-} == --version ]] && echo Python-fake; exit ${pythonExit}`);
  const sqliteBody = `[[ \${1:-} == --version ]] && echo sqlite-fake; exit ${sqliteExit}`;
  executable("sqlite-ready", sqliteBody);
  if (sqlite) executable("sqlite3", sqliteBody);
  executable("uname", "echo Linux");
  executable("id", "echo 0");
  NodeFS.symlinkSync("/usr/bin/env", NodePath.join(root, "env"));
  executable(
    "apt-get",
    `printf '%s\\n' "$*" >> "$PATH/apt-calls"\n[[ $1 == update ]] && exit ${aptExit}\n/bin/cp "$PATH/sqlite-ready" "$PATH/sqlite3"`,
  );
  return {
    root,
    run: (source = false) =>
      NodeChildProcess.spawnSync(
        "/bin/bash",
        source
          ? [
              "-c",
              'python3() { return 99; }; source "$1" || exit $?; printf "CHILD_PYTHON=%s\\n" "$HARNESS_TEST_PYTHON"',
              "gate",
              script,
            ]
          : [script, "/bin/bash", "-c", 'printf "CHILD_PYTHON=%s\\n" "$HARNESS_TEST_PYTHON"'],
        { encoding: "utf8", env: { PATH: root, HARNESS_TEST_PYTHON: "/not/the/box/python" } },
      ),
  };
}

for (const source of [false, true]) {
  NodeTest.test(`exports box Python to the gate (${source ? "sourced" : "wrapper"})`, () => {
    const f = fixture();
    const r = f.run(source);
    NodeAssert.equal(r.status, 0, r.stderr);
    NodeAssert.ok(r.stdout.includes(`CHILD_PYTHON=${f.root}/python3\n`), r.stdout);
    NodeAssert.ok(r.stdout.includes(`GATE_SQLITE ${f.root}/sqlite3\n`));
  });
}

NodeTest.test("refreshes apt lists and installs sqlite before running the gate", () => {
  const f = fixture({ sqlite: false });
  const r = f.run();
  NodeAssert.equal(r.status, 0, r.stderr);
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(f.root, "apt-calls"), "utf8"),
    "update\ninstall -y sqlite3\n",
  );
  NodeAssert.ok(r.stdout.includes("CHILD_PYTHON="));
});

for (const source of [false, true]) {
  for (const [name, options] of [
    ["apt update", { sqlite: false, aptExit: 42 }],
    ["Python sqlite module", { pythonExit: 42 }],
    ["sqlite query", { sqliteExit: 42 }],
  ]) {
    NodeTest.test(`${name} failure stops the gate (${source ? "sourced" : "wrapper"})`, () => {
      const f = fixture(options);
      const r = f.run(source);
      NodeAssert.equal(r.status, 42, r.stderr);
      NodeAssert.ok(!r.stdout.includes("CHILD_PYTHON="));
    });
  }
}

NodeTest.test("missing Python stops the gate before package installation", () => {
  const f = fixture({ python: false });
  const r = f.run();
  NodeAssert.equal(r.status, 127, r.stderr);
  NodeAssert.ok(r.stderr.includes("GATE_PYTHON_MISSING"));
  NodeAssert.ok(!r.stdout.includes("CHILD_PYTHON="));
});

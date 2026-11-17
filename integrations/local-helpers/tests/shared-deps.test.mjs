import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const helpers = fileURLToPath(new URL("..", import.meta.url));
const vp = path.join(helpers, "bin/vp");
const pnpm = path.join(helpers, "libexec/repo-node-pin/pnpm-bin/pnpm");

function fixture(t, shape) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "shared-deps-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "work tree");
  const store = path.join(temporary, "main/node_modules");
  fs.mkdirSync(path.join(root, "apps/server"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(store, ".pnpm"), { recursive: true });
  fs.mkdirSync(path.join(store, ".bin"));
  fs.writeFileSync(path.join(store, "sentinel"), "unchanged");
  const modules = path.join(root, "node_modules");
  if (shape === "node_modules") fs.symlinkSync(store, modules);
  else {
    fs.mkdirSync(path.join(modules, ".bin"), { recursive: true });
    if (shape === ".bin") fs.rmdirSync(path.join(modules, ".bin"));
    if (shape) fs.symlinkSync(path.join(store, shape), path.join(modules, shape));
  }
  fs.mkdirSync(path.join(modules, "vite-plus/bin"), { recursive: true });
  fs.writeFileSync(path.join(modules, "vite-plus/bin/vp"), "fixture");
  fs.writeFileSync(path.join(modules, ".bin/vp"), "#!/bin/sh\necho forwarded\n", { mode: 0o755 });
  const cli = path.join(temporary, "pnpm.cjs");
  fs.writeFileSync(cli, "console.log('forwarded');\n");
  function run(tool, args, cwd = root) {
    const env = {
      ...process.env,
      XDG_STATE_HOME: path.join(temporary, "state"),
      ROBOB_REPO_NODE: process.execPath,
      ROBOB_REPO_PNPM_CLI: cli,
    };
    delete env.REPO_VP_SHIM_ACTIVE;
    return spawnSync(tool === "vp" ? vp : pnpm, args, { cwd, env, encoding: "utf8" });
  }
  return { root, store, run };
}

for (const shape of ["node_modules", ".pnpm", ".bin"]) {
  test(`refuses writes through ${shape}, including pnpm automatic installs`, (t) => {
    const f = fixture(t, shape);
    for (const [tool, args] of [
      ["vp", ["i"]],
      ["vp", ["install", "--frozen-lockfile"]],
      ["vp", ["add", "x"]],
      ["pnpm", ["install"]],
      ["pnpm", ["i"]],
      ["pnpm", ["add", "x"]],
      ["pnpm", ["exec", "vp", "test"]],
      ["pnpm", ["run", "test"]],
      ["pnpm", ["test"]],
      ["pnpm", []],
      ["pnpm", ["--filter", "t3", "install"]],
      ["pnpm", ["-r", "i"]],
      ["vp", ["--filter=t3", "install"]],
    ]) {
      for (const cwd of [f.root, path.join(f.root, "apps/server")]) {
        const r = f.run(tool, args, cwd);
        assert.equal(r.status, 1, `${tool} ${args.join(" ")}: ${r.stderr}`);
        assert.match(r.stderr, /offbox run -- pnpm install --frozen-lockfile/);
        assert.equal(r.stdout, "", "the underlying tool never ran");
      }
    }
    assert.equal(fs.readFileSync(path.join(f.store, "sentinel"), "utf8"), "unchanged");
  });
}

test("directory flags guard the destination, from outside the checkout", (t) => {
  const f = fixture(t, ".pnpm");
  for (const tool of ["vp", "pnpm"]) {
    for (const args of [
      ["-C", f.root, "install"],
      ["--dir", f.root, "i"],
      [`--dir=${f.root}`, "add", "x"],
      [`-C${f.root}`, "install"],
      [`-C=${f.root}`, "install"],
      ["--prefix", f.root, "install"],
      [`--prefix=${f.root}`, "install"],
      ...["-C", "--dir", "--prefix"].map((flag) => ["install", flag, f.root]),
      ...["-C=", "-C", "--dir=", "--prefix="].map((flag) => ["install", flag + f.root]),
      ["--reporter", "ndjson", "-C", f.root, "install"],
      ["-C", path.relative(os.tmpdir(), f.root), "install"],
    ]) {
      assert.equal(f.run(tool, args, os.tmpdir()).status, 1, `${tool} ${args}`);
    }
  }
});

test("pnpm child directory arguments neither escape the guard nor change its target", (t) => {
  const borrowed = fixture(t, ".pnpm");
  const owned = fixture(t);
  for (const prefix of [
    ["exec", "sh", "-c", ":", "dummy"],
    ["exec", "--", "sh"],
    ["run", "build"],
    ["run-script", "build"],
    ["run", "--", "build"],
    ["test"],
    ["t"],
    ["tst"],
    ["start"],
    ["build"],
    ["create", "x"],
    ["dlx", "x"],
  ]) {
    for (const directoryArgs of [
      (dir) => ["--dir", dir],
      (dir) => [`--dir=${dir}`],
      (dir) => ["-C", dir],
      (dir) => [`-C=${dir}`],
      (dir) => ["--prefix", dir],
      (dir) => ["--", "--dir", dir],
    ]) {
      const blocked = borrowed.run("pnpm", [...prefix, ...directoryArgs(owned.root)]);
      assert.equal(blocked.status, 1, `${prefix}: ${blocked.stderr}`);
      assert.equal(blocked.stdout, "");
      const allowed = owned.run("pnpm", [...prefix, ...directoryArgs(borrowed.root)]);
      assert.equal(allowed.status, 0, `${prefix}: ${allowed.stderr}`);
    }
  }
  for (const args of [
    ["run", "--dir", borrowed.root, "build"],
    ["run-script", `-C=${borrowed.root}`, "build"],
    ["--filter", "t3", "--dir", borrowed.root, "exec", "sh"],
  ])
    assert.equal(owned.run("pnpm", args).status, 1, `${args}`);
});

test("vp pm guards raw package-manager installs and respects child boundaries", (t) => {
  const borrowed = fixture(t, ".pnpm");
  const owned = fixture(t);
  for (const args of [
    ["pm", "install"],
    ["pm", "i"],
    ["pm", "add", "x"],
    ["pm", "exec", "vp", "test"],
    ["pm", "run", "build"],
    ["pm", "test"],
    ["pm", "recursive", "install"],
  ]) {
    assert.equal(borrowed.run("vp", args).status, 1, `${args}`);
    assert.equal(owned.run("vp", args).status, 0, `${args}`);
  }
  for (const args of [
    ["-C", borrowed.root, "pm", "install"],
    ["pm", "-C", borrowed.root, "install"],
    ["pm", "install", "-C", borrowed.root],
    ["pm", "run", "--dir", borrowed.root, "build"],
  ])
    assert.equal(owned.run("vp", args).status, 1, `${args}`);
  for (const prefix of [
    ["pm", "exec", "sh"],
    ["pm", "run", "build"],
    ["pm", "test"],
  ]) {
    assert.equal(borrowed.run("vp", [...prefix, "--dir", owned.root]).status, 1);
    assert.equal(owned.run("vp", [...prefix, "--dir", borrowed.root]).status, 0);
  }
});

test("mutation aliases and recursive wrappers keep destination selectors", (t) => {
  const borrowed = fixture(t, ".pnpm");
  const owned = fixture(t);
  const commands = [
    "i",
    "install",
    "add",
    "ci",
    "clean-install",
    "ic",
    "install-clean",
    "install-test",
    "it",
    "update",
    "up",
    "upgrade",
    "remove",
    "rm",
    "uninstall",
    "un",
    "uni",
    "link",
    "ln",
    "unlink",
    "dislink",
    "prune",
    "dedupe",
    "rebuild",
    "rb",
    "fetch",
    "patch",
    "patch-commit",
    "patch-remove",
    "import",
    "deploy",
  ];
  for (const prefix of [[], ["recursive"], ["multi"], ["m"], ["with", "current"]]) {
    for (const command of commands) {
      for (const args of [
        [...prefix, command, "-C", borrowed.root],
        [...prefix, command, `--dir=${borrowed.root}`],
      ])
        assert.equal(owned.run("pnpm", args).status, 1, `${args}`);
    }
  }
});

test("options with separate values do not hide subsequent destination selectors", (t) => {
  const borrowed = fixture(t, ".pnpm");
  const owned = fixture(t);
  const globalOptions = [
    ["--color", "always"],
    ["--color", "auto"],
    ["--color", "never"],
    ["--color", "true"],
    ["--color", "false"],
    ["--filter", "t3"],
    ["-F", "t3"],
    ["--filter-prod", "t3"],
    ["--reporter", "ndjson"],
    ["--loglevel", "error"],
    ["--test-pattern", "test/*"],
    ["--changed-files-ignore-pattern", "docs/*"],
    ["--workspace-packages", "t3"],
    ["--pm-on-fail", "ignore"],
  ];
  const installOptions = [
    ["--child-concurrency", "2"],
    ["--store-dir", "store"],
    ["--registry", "https://example.org"],
    ["--hoist-pattern", "*"],
    ["--only", "prod"],
    ["--link-workspace-packages", "deep"],
    ["--config.store-dir", "store"],
    ["--ignore-scripts", "false"],
  ];
  for (const option of [...globalOptions, ...installOptions]) {
    for (const tool of ["pnpm", "vp"]) {
      assert.equal(
        owned.run(tool, [...option, "--dir", borrowed.root, "install"]).status,
        1,
        `${tool} ${option}`,
      );
    }
  }
  for (const option of [
    ...globalOptions,
    ["--workspace-concurrency", "2"],
    ["--resume-from", "t3"],
    ["--scripts-prepend-node-path", "auto"],
    ["--scripts-prepend-node-path", "warn-only"],
    ["--scripts-prepend-node-path", "true"],
    ["--scripts-prepend-node-path", "false"],
  ]) {
    for (const prefix of [[], ["recursive"]]) {
      assert.equal(
        owned.run("pnpm", [...prefix, "run", ...option, "--dir", borrowed.root, "build"]).status,
        1,
        `${prefix} run ${option}`,
      );
      assert.equal(
        owned.run("pnpm", [...prefix, "run", ...option, "build", "--dir", borrowed.root]).status,
        0,
        `${prefix} run ${option} build`,
      );
    }
  }
  // Boolean flags must leave the next command/script in place when no value is supplied.
  for (const option of ["--ignore-scripts", "--color", "--link-workspace-packages"]) {
    assert.equal(owned.run("pnpm", [option, "install", "--dir", borrowed.root]).status, 1);
  }
  assert.equal(
    owned.run("pnpm", ["run", "--if-present", "build", "--dir", borrowed.root]).status,
    0,
  );
});

test("package-local shared stores are refused without changing the workspace store", (t) => {
  const f = fixture(t);
  const nested = path.join(f.root, "apps/server");
  fs.mkdirSync(path.join(nested, "node_modules"));
  fs.symlinkSync(path.join(f.store, ".pnpm"), path.join(nested, "node_modules/.pnpm"));
  for (const tool of ["vp", "pnpm"]) {
    assert.equal(f.run(tool, ["install"], nested).status, 1);
  }
});

test("broken dependency symlinks are also refused", (t) => {
  const f = fixture(t, ".pnpm");
  fs.renameSync(path.join(f.store, ".pnpm"), path.join(f.store, "old-store"));
  assert.equal(f.run("pnpm", ["install"]).status, 1);
});

test("owned installs pass through; borrowed fmt/lint and diagnostics still work", (t) => {
  const owned = fixture(t);
  for (const tool of ["vp", "pnpm"]) {
    for (const args of [["i"], ["install"], ["add", "x"]]) {
      const r = owned.run(tool, args);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), "forwarded");
    }
  }
  const borrowed = fixture(t, ".pnpm");
  for (const tool of ["vp", "pnpm"]) {
    for (const args of [["--version"], ["--help"], ["help", "install"]]) {
      assert.equal(borrowed.run(tool, args).status, 0);
    }
  }
  for (const command of ["fmt", "lint"]) {
    assert.equal(borrowed.run("vp", [command, "--check", "src.ts"]).status, 0);
  }
});

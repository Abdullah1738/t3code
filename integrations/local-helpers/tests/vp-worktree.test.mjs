import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const shim = fileURLToPath(new URL("../bin/vp", import.meta.url));
const maintenance = fileURLToPath(new URL("../libexec/vp/toolchain", import.meta.url));
const binding = `@oxfmt/binding-${os.platform()}-${os.arch()}`;
function fixtureLock() {
  return {
    lockfileVersion: "9.0",
    importers: {
      ".": {
        devDependencies: {
          "vite-plus": { specifier: "1.0.0", version: "1.0.0(peer@2.0.0)" },
          "@fixture/lint": { specifier: "1.0.0", version: "1.0.0" },
          unrelated: { specifier: "1.0.0", version: "1.0.0" },
        },
      },
    },
    packages: { [`${binding}@1.0.0`]: { os: [os.platform()], cpu: [os.arch()] } },
    snapshots: {
      "vite-plus@1.0.0(peer@2.0.0)": { dependencies: { oxfmt: "1.0.0", oxlint: "1.0.0" } },
      "oxfmt@1.0.0": { optionalDependencies: { [binding]: "1.0.0" } },
      "oxlint@1.0.0": {},
      [`${binding}@1.0.0`]: {},
      "@fixture/lint@1.0.0": {},
    },
  };
}

function fixture(t, nativeModules) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vp-worktree-")));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const main = path.join(temporary, "main");
  const wt = path.join(temporary, "work tree");
  fs.mkdirSync(main);
  const git = (...args) => {
    const r = spawnSync("git", ["-C", main, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-q");
  for (const [name, content] of Object.entries({
    "vite.config.ts": nativeModules
      ? 'export default {fmt:{ignorePatterns:["dist/**"]},lint:{}};\n'
      : 'export default {fmt:{ignorePatterns:["dist/**"],overrides:[{files:["src/**"],options:{semi:false}}]},lint:{ignorePatterns:["dist/**"],jsPlugins:["@fixture/lint/rules"]}};\n',
    "package.json": "{}\n",
    "pnpm-lock.yaml": nativeModules
      ? fs.readFileSync(path.join(nativeModules, "../pnpm-lock.yaml"), "utf8")
      : JSON.stringify(fixtureLock()),
    ".gitignore": "dist/\n",
  }))
    fs.writeFileSync(path.join(main, name), content);
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  git("worktree", "add", "-q", "--detach", wt);
  if (nativeModules) {
    const modules = path.join(main, "node_modules");
    fs.mkdirSync(modules);
    for (const name of fs.readdirSync(nativeModules)) {
      if (!name.startsWith(".") || name === ".bin")
        fs.symlinkSync(fs.realpathSync(path.join(nativeModules, name)), path.join(modules, name));
    }
    return {
      main,
      wt,
      run: (args, cwd = wt) => spawnSync(shim, args, { cwd, encoding: "utf8" }),
      native: (args, cwd = main) =>
        spawnSync(path.join(main, "node_modules/.bin/vp"), args, { cwd, encoding: "utf8" }),
    };
  }
  fs.mkdirSync(path.join(main, "node_modules/.bin"), { recursive: true });
  for (const [name, metadata] of Object.entries({
    "vite-plus": {
      type: "module",
      exports: { ".": { import: "./index.js" } },
      dependencies: { oxfmt: "1.0.0", oxlint: "1.0.0" },
    },
    oxfmt: { optionalDependencies: { [binding]: "1.0.0" } },
    oxlint: {},
    [binding]: { os: [os.platform()], cpu: [os.arch()] },
    "@fixture/lint": { exports: { "./rules": "./index.js" } },
    yaml: {},
    rolldown: { type: "module", exports: "./index.js" },
  })) {
    const dir = path.join(main, "node_modules", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", ...metadata }),
    );
    fs.writeFileSync(
      path.join(dir, "index.js"),
      name === "yaml" ? "exports.parse = JSON.parse;" : "",
    );
  }
  fs.writeFileSync(
    path.join(main, "node_modules/vite-plus/index.js"),
    `
    import { pathToFileURL } from "node:url";
    export async function loadConfigFromFile(_, file) {
      return { dependencies: [], config: (await import(pathToFileURL(file))).default };
    }
  `,
  );
  fs.writeFileSync(
    path.join(main, "node_modules/rolldown/index.js"),
    `
    export async function rolldown(options) {
      return { async generate() { for (const p of options.plugins) p.load(options.input); }, async close() {} };
    }
  `,
  );

  const fake = path.join(main, "node_modules/.bin/vp");
  fs.writeFileSync(
    fake,
    `#!${process.execPath}
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const i = args.indexOf('--config');
    console.log(JSON.stringify({cwd:process.cwd(), args, config:i<0?null:JSON.parse(fs.readFileSync(args[i+1]))}));
    process.exit(Number(process.env.FAKE_EXIT || 0));
  `,
    { mode: 0o755 },
  );
  function run(args, cwd = wt, env = {}) {
    return spawnSync(shim, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  }
  function routed(args, cwd = wt) {
    const r = run(args, cwd);
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.cwd, args[0] === "fmt" ? wt : main);
    assert.match(r.stderr, /no node_modules in this worktree; running/);
    assert.equal(path.dirname(result.args[2]), wt);
    assert.equal(fs.existsSync(result.args[2]), false, "temporary config cleaned up");
    return result;
  }
  return { main, wt, run, routed, fake };
}

test("fmt uses worktree-root patterns; lint uses main cwd and absolute paths", (t) => {
  const f = fixture(t);
  for (const command of ["fmt", "lint"]) {
    const r = f.routed([command, "--check", "src/a b.ts", path.join(f.wt, "other.ts")]);
    assert.deepEqual(r.args.slice(-3), [
      "--check",
      command === "fmt" ? "src/a b.ts" : path.join(f.wt, "src/a b.ts"),
      command === "fmt" ? "other.ts" : path.join(f.wt, "other.ts"),
    ]);
    assert.deepEqual(r.config.ignorePatterns, ["dist/**", ".vp-worktree-*.json"]);
  }
  assert.deepEqual(f.routed(["fmt", "a.ts"]).config.overrides[0].files, ["src/**"]);
});

test("no paths means the worktree root, including from a nested cwd", (t) => {
  const f = fixture(t);
  const nested = path.join(f.wt, "apps/server");
  fs.mkdirSync(nested, { recursive: true });
  for (const args of [["fmt", "--check"], ["lint"], ["fmt", "--"]]) {
    assert.ok(f.routed(args, nested).args.includes(f.wt));
  }
  assert.equal(f.routed(["lint", "src/a.ts"], nested).args.at(-1), path.join(nested, "src/a.ts"));
  assert.equal(f.routed(["fmt", "a.ts"], nested).args.at(-1), "apps/server/a.ts");
});

test("argument classes: spaced/equals values, paths, globs, exclusions, separator", (t) => {
  const f = fixture(t);
  const rows = [
    [
      ["--threads", "1", "a.ts"],
      ["--threads=1", "a.ts"],
    ],
    [
      ["--threads=1", "a.ts"],
      ["--threads=1", "a.ts"],
    ],
    [
      ["-D", "no-debugger", "a.ts"],
      ["-D=no-debugger", "a.ts"],
    ],
    [
      ["--format", "json", "a.ts"],
      ["--format=json", "a.ts"],
    ],
    [
      ["--tsconfig=tsconfig.json", "a.ts"],
      [`--tsconfig=${f.wt}/tsconfig.json`, "a.ts"],
    ],
    [
      ["--ignore-path", ".gitignore", "a.ts"],
      [`--ignore-path=${f.wt}/.gitignore`, "a.ts"],
    ],
    [
      ["--", "-dash.ts"],
      ["--", "-dash.ts"],
    ],
  ];
  for (const [input, expected] of rows)
    assert.deepEqual(f.routed(["fmt", ...input]).args.slice(-expected.length), expected);
});

test("fmt delegates globs, exclusions and empty selections unchanged to Oxfmt", (t) => {
  const f = fixture(t);
  const result = f.routed(["fmt", "src/*.ts", "!src/skip.ts"]);
  assert.deepEqual(result.args.slice(-2), ["src/*.ts", "!src/skip.ts"]);
  for (const flags of [[], ["--no-error-on-unmatched-pattern"]]) {
    const unmatched = f.routed(["fmt", ...flags, "missing/*.ts"]);
    assert.equal(unmatched.args.at(-1), "missing/*.ts");
    assert.equal(unmatched.args.includes(f.wt), false);
  }
});

test("fmt normalizes nested cwd, parent segments, absolute globs, and exclusions without expanding", (t) => {
  const f = fixture(t);
  const nested = path.join(f.wt, "src");
  fs.mkdirSync(nested);
  const rows = [
    ["../shared/ok.ts", "shared/ok.ts"],
    ["../shared/./bad.ts", "shared/bad.ts"],
    ["./local/../ok.ts", "src/ok.ts"],
    [path.join(f.wt, "shared/*.ts"), "shared/*.ts"],
    ["../shared/**/*.ts", "shared/**/*.ts"],
    ["!../shared/ignored.ts", "!shared/ignored.ts"],
    ["../shared dir/*.ts", "shared dir/*.ts"],
    ["*.ts", "src/**/*.ts"],
    ["./*.ts", "src/**/*.ts"],
    ["!d*.ts", "!src/**/d*.ts"],
  ];
  for (const [input, expected] of rows) {
    assert.deepEqual(f.routed(["fmt", input, "ok.ts"], nested).args.slice(-2), [
      expected,
      "src/ok.ts",
    ]);
  }
  assert.deepEqual(f.routed(["fmt", "--", "../-dash.ts"], nested).args.slice(-2), [
    "--",
    "-dash.ts",
  ]);
});

// Compare the selected files and writes with the pinned tool, not a second JS glob implementation.
const selectionCases = [
  { name: "star includes dotfiles", paths: ["src/*.ts"] },
  { name: "recursive star", paths: ["src/**/*.ts"] },
  { name: "brace extensions", paths: ["src/*.{ts,tsx}"] },
  { name: "question mark", paths: ["src/o?.ts"] },
  { name: "character class", paths: ["src/[o]*.ts"] },
  { name: "directory discovery", paths: ["src"] },
  { name: "absolute explicit file", paths: ["$ROOT/src/.hidden.ts"] },
  { name: "negative glob", paths: ["src/*.ts", "!src/.*.ts"] },
  { name: "nested cwd", paths: ["*.ts"], cwd: "src" },
  { name: "unmatched glob errors", paths: ["missing/*.ts"] },
  {
    name: "unmatched glob permitted",
    paths: ["missing/*.ts"],
    flags: ["--no-error-on-unmatched-pattern"],
  },
  {
    name: "unmatched literal permitted",
    paths: ["missing.ts"],
    flags: ["--no-error-on-unmatched-pattern"],
  },
  {
    name: "mixed matched and unmatched",
    paths: ["missing/*.ts", "src/ok.ts"],
    flags: ["--no-error-on-unmatched-pattern"],
  },
  { name: "nested gitignore write", paths: ["src/*.ts"], write: true },
  { name: "nested cwd gitignore write", paths: ["*.ts"], cwd: "src", write: true },
  { name: "explicit ignored file write", paths: ["src/ignored.ts"], write: true },
  {
    name: "custom ignore path write",
    paths: ["src/*.ts"],
    flags: ["--ignore-path", "$ROOT/custom.ignore"],
    write: true,
  },
  {
    name: "parent-relative clean file",
    cwd: "src",
    paths: ["../shared/ok.ts"],
    nativePaths: ["shared/ok.ts"],
    expectedCount: "1",
    expectedStatus: 0,
  },
  {
    name: "parent-relative bad file",
    cwd: "src",
    paths: ["../shared/bad.ts"],
    nativePaths: ["shared/bad.ts"],
    expectedCount: "1",
    expectedStatus: 1,
  },
  { name: "parent-relative directory", cwd: "src", paths: ["../shared"], nativePaths: ["shared"] },
  {
    name: "parent-relative glob",
    cwd: "src",
    paths: ["../shared/*.ts"],
    nativePaths: ["shared/*.ts"],
  },
  {
    name: "absolute sibling glob",
    cwd: "src",
    paths: ["$ROOT/shared/*.ts"],
    nativePaths: ["shared/*.ts"],
  },
  {
    name: "absolute sibling glob with unmatched permitted",
    cwd: "src",
    paths: ["$ROOT/shared/*.ts"],
    nativePaths: ["shared/*.ts"],
    flags: ["--no-error-on-unmatched-pattern"],
    expectedCount: "3",
    expectedStatus: 1,
  },
  {
    name: "absolute sibling recursive glob",
    cwd: "src",
    paths: ["$ROOT/shared/**/*.ts"],
    nativePaths: ["shared/**/*.ts"],
  },
  {
    name: "absolute sibling file",
    cwd: "src",
    paths: ["$ROOT/shared/bad.ts"],
    nativePaths: ["shared/bad.ts"],
  },
  {
    name: "parent glob and exclusion",
    cwd: "src",
    paths: ["../shared/*.ts", "!../shared/.*.ts"],
    nativePaths: ["shared/*.ts", "!shared/.*.ts"],
  },
  {
    name: "absolute glob and exclusion",
    cwd: "src",
    paths: ["$ROOT/shared/*.ts", "!$ROOT/shared/.*.ts"],
    nativePaths: ["shared/*.ts", "!shared/.*.ts"],
  },
  {
    name: "parent directory with spaces",
    cwd: "src",
    paths: ["../shared dir/*.ts"],
    nativePaths: ["shared dir/*.ts"],
  },
  {
    name: "mixed local and sibling globs",
    cwd: "src",
    paths: ["*.ts", "../shared/*.ts"],
    nativePaths: ["src/**/*.ts", "shared/*.ts"],
  },
  {
    name: "parent glob nested ignore write",
    cwd: "src",
    paths: ["../shared/*.ts"],
    nativePaths: ["shared/*.ts"],
    write: true,
  },
  {
    name: "absolute glob nested ignore write",
    cwd: "src",
    paths: ["$ROOT/shared/*.ts"],
    nativePaths: ["shared/*.ts"],
    write: true,
  },
  {
    name: "absolute unmatched sibling glob",
    cwd: "src",
    paths: ["$ROOT/missing/*.ts"],
    nativePaths: ["missing/*.ts"],
    flags: ["--no-error-on-unmatched-pattern"],
    expectedCount: "0",
    expectedStatus: 0,
  },
  {
    name: "parent unmatched sibling glob",
    cwd: "src",
    paths: ["../missing/*.ts"],
    nativePaths: ["missing/*.ts"],
    flags: ["--no-error-on-unmatched-pattern"],
    expectedCount: "0",
    expectedStatus: 0,
  },
  { name: "nested dot-prefixed basename glob", cwd: "src", paths: ["./*.ts"] },
  { name: "nested basename question mark", cwd: "src", paths: ["o?.ts"] },
  { name: "nested basename brace", cwd: "src", paths: ["{ok,deep}.ts"] },
  { name: "nested basename character class", cwd: "src", paths: ["[od]*.ts"] },
  { name: "nested basename exclusion", cwd: "src", paths: ["*.ts", "!d*.ts"] },
  {
    name: "nested unmatched basename glob",
    cwd: "src",
    paths: ["missing*.ts"],
    flags: ["--no-error-on-unmatched-pattern"],
    expectedCount: "0",
    expectedStatus: 0,
  },
  {
    name: "nested normalized basename glob",
    cwd: "src",
    paths: ["./local/../*.ts"],
    nativePaths: ["src/**/*.ts"],
  },
  { name: "nested literal metacharacter filename", cwd: "src", paths: ["literal[1].ts"] },
];

for (const row of selectionCases) {
  test(
    `pinned Oxfmt selection: ${row.name}`,
    {
      skip:
        !process.env.VP_TEST_NODE_MODULES &&
        "set VP_TEST_NODE_MODULES to the pinned checkout's node_modules",
    },
    (t) => {
      const f = fixture(t, process.env.VP_TEST_NODE_MODULES);
      const bodies = {
        "src/ok.ts": "export const ok = 1;\n",
        "src/.hidden.ts": "export const hidden={a:1}\n",
        "src/nested/deep.ts": "export const deep={a:1}\n",
        "src/ignored.ts": "export const ignored={a:1}\n",
        "src/.gitignore": "ignored.ts\n",
        "src/literal[1].ts": "export const literal = 1;\n",
        "shared/ok.ts": "export const ok = 1;\n",
        "shared/bad.ts": "export const bad={a:1}\n",
        "shared/.hidden.ts": "export const hidden={a:1}\n",
        "shared/nested/deep.ts": "export const deep={a:1}\n",
        "shared/ignored.ts": "export const ignored={a:1}\n",
        "shared/.gitignore": "ignored.ts\n",
        "shared dir/bad.ts": "export const bad={a:1}\n",
        "custom.ignore": "src/.hidden.ts\n",
        "unselected.ts": "export const unselected={a:1}\n",
      };
      for (const base of [f.main, f.wt])
        for (const [name, body] of Object.entries(bodies)) {
          fs.mkdirSync(path.dirname(path.join(base, name)), { recursive: true });
          fs.writeFileSync(path.join(base, name), body);
        }
      const args = (base, paths = row.paths) =>
        [
          "fmt",
          row.write ? "--write" : "--check",
          "--threads=1",
          ...(row.flags ?? []),
          ...paths,
        ].map((value) => value.replaceAll("$ROOT", base));
      const native = f.native(
        args(f.main, row.nativePaths),
        path.join(f.main, row.nativePaths ? "" : (row.cwd ?? "")),
      );
      const routed = f.run(args(f.wt), path.join(f.wt, row.cwd ?? ""));
      assert.equal(
        routed.status,
        native.status,
        `native: ${native.stdout}${native.stderr}\nshim: ${routed.stdout}${routed.stderr}`,
      );
      for (const name of Object.keys(bodies)) {
        assert.equal(
          fs.readFileSync(path.join(f.wt, name), "utf8"),
          fs.readFileSync(path.join(f.main, name), "utf8"),
          name,
        );
      }
      const count = (output) => /on (\d+) files/.exec(output)?.[1];
      assert.equal(count(routed.stdout), count(native.stdout), "same number of checked files");
      if (row.expectedCount !== undefined) assert.equal(count(routed.stdout), row.expectedCount);
      if (row.expectedStatus !== undefined) assert.equal(routed.status, row.expectedStatus);
      if (row.name === "star includes dotfiles") {
        assert.equal(routed.status, 1);
        assert.match(routed.stdout, /\.hidden\.ts/);
      }
      if (row.name === "nested gitignore write")
        assert.equal(
          fs.readFileSync(path.join(f.wt, "src/ignored.ts"), "utf8"),
          bodies["src/ignored.ts"],
        );
      if (row.name === "unmatched glob permitted") {
        assert.equal(routed.status, 0);
        assert.equal(count(routed.stdout), "0");
      }
      assert.deepEqual(
        fs.readdirSync(f.wt).filter((name) => name.startsWith(".vp-worktree-")),
        [],
      );
    },
  );
}

test("worktree config and ignore additions/deletions no longer require copy equality", (t) => {
  const f = fixture(t);
  for (const name of [
    ".oxfmtrc.json",
    ".oxlintrc.json",
    "oxlint.config.ts",
    ".gitignore",
    ".prettierignore",
    ".eslintignore",
  ]) {
    const file = path.join(f.wt, name);
    fs.writeFileSync(file, "different\n");
    f.routed(["fmt", "a.ts"]);
    fs.unlinkSync(file);
    f.routed(["fmt", "a.ts"]);
  }
  fs.writeFileSync(
    path.join(f.wt, "vite.config.ts"),
    "export default {fmt:{printWidth:40},lint:{}};",
  );
  assert.equal(f.routed(["fmt", "a.ts"]).config.printWidth, 40);
  fs.writeFileSync(path.join(f.wt, "vite.config.ts"), "invalid config");
  const invalid = f.run(["fmt", "a.ts"]);
  assert.equal(invalid.status, 127);
  assert.match(invalid.stderr, /offbox run -- vp fmt/);
  assert.equal(invalid.stdout, "");
  fs.unlinkSync(path.join(f.wt, "vite.config.ts"));
  const missing = f.run(["lint", "a.ts"]);
  assert.equal(missing.status, 127);
  assert.match(missing.stderr, /vite.config.ts.*offbox run -- vp lint/);
  assert.equal(missing.stdout, "");
});

test("missing package in the worktree config refuses without running vp or loading main config", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.wt, "vite.config.ts"),
    'import "worktree-only-missing-package"; export default {fmt:{},lint:{}};',
  );
  const result = f.run(["fmt", "a.ts"]);
  assert.equal(result.status, 127);
  assert.match(result.stderr, /worktree-only-missing-package.*offbox run -- vp fmt/);
  assert.equal(result.stdout, "");
});

test("unrelated lockfile and package.json edits still reroute fmt and lint", (t) => {
  const f = fixture(t);
  const lock = fixtureLock();
  lock.importers["."].devDependencies.unrelated.version = "2.0.0";
  lock.snapshots["unrelated@2.0.0"] = {};
  fs.writeFileSync(path.join(f.wt, "pnpm-lock.yaml"), JSON.stringify(lock));
  fs.writeFileSync(
    path.join(f.wt, "package.json"),
    JSON.stringify({ scripts: { new: "echo new" } }),
  );
  f.routed(["fmt", "a.ts"]);
  f.routed(["lint", "a.ts"]);
});

for (const name of ["vite-plus", "oxfmt", "oxlint", binding, "@fixture/lint"]) {
  test(`toolchain version drift refuses: ${name}`, (t) => {
    const f = fixture(t);
    const lock = fixtureLock();
    if (name === "vite-plus" || name === "@fixture/lint")
      lock.importers["."].devDependencies[name].version = "2.0.0";
    else if (name === binding) lock.snapshots["oxfmt@1.0.0"].optionalDependencies[name] = "2.0.0";
    else lock.snapshots["vite-plus@1.0.0(peer@2.0.0)"].dependencies[name] = "2.0.0";
    fs.writeFileSync(path.join(f.wt, "pnpm-lock.yaml"), JSON.stringify(lock));
    const r = f.run(["lint", "a.ts"]);
    assert.equal(r.status, 127, r.stderr);
    assert.ok(r.stderr.includes(`config drift in ${name} (2.0.0 vs 1.0.0)`), r.stderr);
    assert.equal(r.stdout, "");
  });
}

test("missing lock resolutions and installed toolchain packages refuse by name", (t) => {
  const f = fixture(t);
  const lock = fixtureLock();
  delete lock.snapshots["vite-plus@1.0.0(peer@2.0.0)"].dependencies.oxfmt;
  fs.writeFileSync(path.join(f.wt, "pnpm-lock.yaml"), JSON.stringify(lock));
  assert.match(f.run(["fmt", "a.ts"]).stderr, /config drift in oxfmt \(unresolved vs 1.0.0\)/);
  fs.writeFileSync(path.join(f.wt, "pnpm-lock.yaml"), JSON.stringify(fixtureLock()));
  fs.rmSync(path.join(f.main, "node_modules", binding), { recursive: true });
  const r = f.run(["fmt", "a.ts"]);
  assert.equal(r.status, 127);
  assert.ok(r.stderr.includes(`config drift in ${binding} (1.0.0 vs unresolved)`), r.stderr);
});

test("unreadable installed package metadata refuses with the package and offbox hint", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.main, "node_modules/oxfmt/package.json"), "invalid");
  const r = f.run(["fmt", "a.ts"]);
  assert.equal(r.status, 127);
  assert.match(r.stderr, /config drift in oxfmt \(1.0.0 vs unresolved\).*offbox run -- vp fmt/);
});

test("package type changes still refuse, but unused package config keys do not", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.wt, "package.json"), JSON.stringify({ fmt: {}, lint: {} }));
  f.routed(["fmt", "a.ts"]);
  fs.writeFileSync(path.join(f.wt, "package.json"), JSON.stringify({ type: "module" }));
  assert.match(f.run(["fmt", "a.ts"]).stderr, /config drift in package.json#type/);
});

test("invalid or absent pnpm lockfiles refuse", (t) => {
  const f = fixture(t);
  for (const body of [
    "invalid yaml : [",
    JSON.stringify({ ...fixtureLock(), lockfileVersion: "6.0" }),
    "{}",
  ]) {
    fs.writeFileSync(path.join(f.wt, "pnpm-lock.yaml"), body);
    assert.match(f.run(["fmt", "a.ts"]).stderr, /config drift in pnpm-lock.yaml/);
  }
  fs.unlinkSync(path.join(f.wt, "pnpm-lock.yaml"));
  assert.match(f.run(["fmt", "a.ts"]).stderr, /config drift in pnpm-lock.yaml/);
});

test("only bindings for this platform are required", (t) => {
  const f = fixture(t);
  const lock = fixtureLock();
  const other = "@oxfmt/binding-other-arch";
  lock.snapshots["oxfmt@1.0.0"].optionalDependencies[other] = "2.0.0";
  lock.packages[`${other}@2.0.0`] = { os: ["other"] };
  fs.writeFileSync(path.join(f.wt, "pnpm-lock.yaml"), JSON.stringify(lock));
  f.routed(["fmt", "a.ts"]);
});

for (const section of ["dependencies", "optionalDependencies"]) {
  test(`toolchain roots can be in importer ${section}`, (t) => {
    const f = fixture(t);
    const lock = fixtureLock();
    lock.importers["."][section] = lock.importers["."].devDependencies;
    delete lock.importers["."].devDependencies;
    fs.writeFileSync(path.join(f.wt, "pnpm-lock.yaml"), JSON.stringify(lock));
    f.routed(["lint", "a.ts"]);
  });
}

test("npm aliases and nested peer contexts resolve the selected snapshot", (t) => {
  const f = fixture(t);
  const lock = fixtureLock();
  const ref = "@voidzero-dev/formatter@1.0.0(peer@2.0.0(nested@3.0.0))";
  lock.snapshots["vite-plus@1.0.0(peer@2.0.0)"].dependencies.oxfmt = ref;
  lock.snapshots[ref] = lock.snapshots["oxfmt@1.0.0"];
  fs.writeFileSync(path.join(f.wt, "pnpm-lock.yaml"), JSON.stringify(lock));
  const file = path.join(f.main, "node_modules/oxfmt/package.json");
  const pkg = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...pkg, name: "@voidzero-dev/formatter" }));
  f.routed(["fmt", "a.ts"]);
});

test("unused local plugin helper drift does not block the worktree config", (t) => {
  const f = fixture(t);
  for (const dir of [f.wt, f.main]) {
    fs.mkdirSync(path.join(dir, "oxlint-plugin-t3code/rules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "oxlint-plugin-t3code/rules/helper.ts"), "export {};\n");
  }
  assert.equal(f.run(["lint", "a.ts"]).status, 0);
  fs.appendFileSync(path.join(f.wt, "oxlint-plugin-t3code/rules/helper.ts"), "changed\n");
  f.routed(["lint", "a.ts"]);
});

test("unsafe or ambiguous argument forms refuse with an offbox hint", (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.main, path.join(f.wt, "outside"));
  for (const args of [
    ["--candidate=toolchain copy", f.main, "fmt"],
    ["--candidate=main checkout", f.main, "fmt"],
    ["test", "a.test.ts"],
    ["check", "a.ts"],
    ["i"],
    ["build"],
    ["fmt", "../main/a.ts"],
    ["fmt", "outside/a.ts"],
    ["fmt", "--config", "vite.config.ts"],
    ["lint", "--future-flag", "value"],
    ["fmt", "--ignore-path"],
    ["fmt", "--threads=", "a.ts"],
  ]) {
    const r = f.run(args);
    assert.equal(r.status, 127, args.join(" "));
    assert.match(r.stderr, /offbox run -- vp/);
    assert.equal(r.stdout, "");
  }
});

test("local vp wins, preserves cwd, argv, and exit status", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.wt, "node_modules/.bin"), { recursive: true });
  fs.copyFileSync(f.fake, path.join(f.wt, "node_modules/.bin/vp"));
  const nested = path.join(f.wt, "src");
  fs.mkdirSync(nested);
  const r = f.run(["test", "a b.test.ts", "--"], nested, { FAKE_EXIT: "23" });
  assert.equal(r.status, 23);
  assert.equal(r.stderr, "");
  assert.deepEqual(JSON.parse(r.stdout), {
    cwd: nested,
    args: ["test", "a b.test.ts", "--"],
    config: null,
  });
});

test("no global fallback, recursive candidates do not loop", (t) => {
  const f = fixture(t);
  const elsewhere = path.join(path.dirname(f.main), "elsewhere");
  fs.mkdirSync(elsewhere);
  assert.equal(f.run(["--version"], elsewhere).status, 127);
  fs.mkdirSync(path.join(f.wt, "node_modules/.bin"), { recursive: true });
  fs.symlinkSync(shim, path.join(f.wt, "node_modules/.bin/vp"));
  assert.equal(f.run(["--version"]).status, 127);
  assert.match(f.run([], f.wt, { REPO_VP_SHIM_ACTIVE: "1" }).stderr, /recursive shim/);
});

test("runs with only a minimal PATH and HOME", (t) => {
  const f = fixture(t);
  const r = spawnSync(shim, ["fmt", "a.ts"], {
    cwd: f.wt,
    encoding: "utf8",
    env: { HOME: path.dirname(f.main), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
  });
  assert.equal(r.status, 0, r.stderr);
});

function fixtureGit(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function toolchainFixture(t) {
  const f = fixture(t);
  const copy = path.join(path.dirname(f.main), "toolchain copy");
  fixtureGit(f.main, "update-ref", "refs/remotes/origin/main", "HEAD");
  fixtureGit(f.main, "worktree", "add", "-q", "--detach", copy, "origin/main");
  fs.cpSync(path.join(f.main, "node_modules"), path.join(copy, "node_modules"), {
    recursive: true,
  });
  fixtureGit(f.main, "config", "vp.toolchain", copy);
  const lock = path.join(fixtureGit(copy, "rev-parse", "--absolute-git-dir"), "vp-sync.lock");
  const cli = (...args) =>
    spawnSync(maintenance, args, { cwd: f.wt, encoding: "utf8", timeout: 10000 });
  return { ...f, copy, lock, cli };
}

function newerConfig(f) {
  const original = fs.readFileSync(path.join(f.wt, "vite.config.ts"));
  fs.writeFileSync(path.join(f.copy, "vite.config.ts"), "old config\n");
  fixtureGit(f.copy, "add", "vite.config.ts");
  fixtureGit(
    f.copy,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "old config",
  );
  const old = fixtureGit(f.copy, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(f.copy, "vite.config.ts"), original);
  fixtureGit(f.copy, "add", "vite.config.ts");
  fixtureGit(
    f.copy,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixed config",
  );
  const target = fixtureGit(f.copy, "rev-parse", "HEAD");
  fixtureGit(f.main, "update-ref", "refs/remotes/origin/main", target);
  fixtureGit(f.copy, "checkout", "-q", "--detach", old);
  return { old, target };
}

test("matching toolchain copy wins over drifted main for fmt and lint", (t) => {
  const f = toolchainFixture(t);
  fs.appendFileSync(path.join(f.main, "vite.config.ts"), "drift\n");
  for (const command of ["fmt", "lint"]) {
    const r = f.run([command, "a.ts"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(f.copy), r.stderr);
    assert.equal(JSON.parse(r.stdout).cwd, command === "fmt" ? f.wt : f.copy);
  }
  assert.match(fs.readFileSync(path.join(f.main, "vite.config.ts"), "utf8"), /drift/);
});

test("shim syncs stale toolchain to local origin/main without touching dependencies or main", (t) => {
  const f = toolchainFixture(t);
  const { target } = newerConfig(f);
  const mainHead = fixtureGit(f.main, "rev-parse", "HEAD");
  fs.appendFileSync(path.join(f.main, "vite.config.ts"), "owner drift\n");
  const vpBefore = fs.readFileSync(path.join(f.copy, "node_modules/.bin/vp"));
  const r = f.run(["fmt", "a.ts"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(f.copy));
  assert.equal(fixtureGit(f.copy, "rev-parse", "HEAD"), target);
  assert.equal(fixtureGit(f.main, "rev-parse", "HEAD"), mainHead);
  assert.match(fs.readFileSync(path.join(f.main, "vite.config.ts"), "utf8"), /owner drift/);
  assert.deepEqual(fs.readFileSync(path.join(f.copy, "node_modules/.bin/vp")), vpBefore);
  assert.equal(fs.existsSync(f.lock), false);
});

for (const mainDrift of [false, true]) {
  test(`held sync lock never waits; main drift=${mainDrift}`, (t) => {
    const f = toolchainFixture(t);
    const { old } = newerConfig(f);
    fs.mkdirSync(f.lock);
    if (mainDrift) fs.appendFileSync(path.join(f.main, "vite.config.ts"), "drift\n");
    const r = f.run(["fmt", "a.ts"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fixtureGit(f.copy, "rev-parse", "HEAD"), old);
    assert.equal(fs.existsSync(f.lock), true);
    assert.equal(JSON.parse(r.stdout).cwd, f.wt);
  });
}

test("sync reclaims an empty lock older than 60 seconds", (t) => {
  const f = toolchainFixture(t);
  const { target } = newerConfig(f);
  fs.mkdirSync(f.lock);
  const old = new Date(Date.now() - 61000);
  fs.utimesSync(f.lock, old, old);
  const r = f.run(["lint", "a.ts"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fixtureGit(f.copy, "rev-parse", "HEAD"), target);
  assert.equal(fs.existsSync(f.lock), false);
});

test("stale versions and main drift report both reasons and maintenance hint", (t) => {
  const f = toolchainFixture(t);
  const lock = fixtureLock();
  lock.importers["."].devDependencies["vite-plus"].version = "2.0.0";
  fs.writeFileSync(path.join(f.wt, "pnpm-lock.yaml"), JSON.stringify(lock));
  fs.appendFileSync(path.join(f.main, "vite.config.ts"), "drift\n");
  const r = f.run(["fmt", "a.ts"]);
  assert.equal(r.status, 127);
  assert.match(
    r.stderr,
    /toolchain copy.*vite-plus.*2.0.0 vs 1.0.0.*main checkout.*vite-plus.*2.0.0 vs 1.0.0/,
  );
  assert.match(r.stderr, /toolchain sync --install/);
  assert.match(r.stderr, /offbox local.*vp toolchain copy.*30m/);
  assert.match(r.stderr, /offbox run -- vp fmt/);
});

for (const kind of ["unset", "missing", "no vp", "self", "self symlink"]) {
  test(`candidate ${kind} preserves main fallback`, (t) => {
    const f = fixture(t);
    let candidate = path.join(path.dirname(f.main), "missing");
    if (kind === "no vp") fs.mkdirSync(candidate);
    if (kind === "self") candidate = f.wt;
    if (kind === "self symlink") fs.symlinkSync(f.wt, candidate);
    if (kind !== "unset") fixtureGit(f.main, "config", "vp.toolchain", candidate);
    f.routed(["fmt", "a.ts"]);
    f.routed(["lint", "a.ts"]);
  });
}

test("copy config dependencies are irrelevant when the worktree config loads", (t) => {
  const f = toolchainFixture(t);
  fs.mkdirSync(path.join(f.copy, "oxlint-local"));
  fs.writeFileSync(path.join(f.copy, "oxlint-local/helper.ts"), "different");
  const r = f.run(["lint", "a.ts"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).cwd, f.copy);
});

test("config pointing at main never syncs or changes its branch or files", (t) => {
  const f = toolchainFixture(t);
  const { target } = newerConfig(f);
  fixtureGit(f.main, "config", "vp.toolchain", f.main);
  const head = fixtureGit(f.main, "rev-parse", "HEAD");
  assert.notEqual(head, target);
  f.routed(["fmt", "a.ts"]);
  assert.equal(fixtureGit(f.main, "rev-parse", "HEAD"), head);
  assert.notEqual(fixtureGit(f.main, "symbolic-ref", "HEAD"), "");
});

test("status reports HEAD, local ref, version match and dependency size", (t) => {
  const f = toolchainFixture(t);
  let r = f.cli("status");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`path: ${f.copy}`));
  assert.match(r.stdout, /current: yes/);
  assert.match(r.stdout, /toolchain match: yes/);
  assert.match(r.stdout, /node_modules/);
  fs.rmSync(path.join(f.copy, "node_modules"), { recursive: true });
  r = f.cli("status");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /toolchain match: no/);
  assert.match(r.stdout, /node_modules: missing/);
});

test("explicit sync fetches and checks out without installing missing dependencies", (t) => {
  const f = toolchainFixture(t);
  const { target } = newerConfig(f);
  const bare = path.join(path.dirname(f.main), "origin.git");
  fixtureGit(f.main, "init", "-q", "--bare", bare);
  fixtureGit(f.main, "remote", "add", "origin", bare);
  fixtureGit(f.main, "push", "-q", "origin", `${target}:refs/heads/main`);
  fs.rmSync(path.join(f.copy, "node_modules"), { recursive: true });
  const r = f.cli("sync");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fixtureGit(f.copy, "rev-parse", "HEAD"), target);
  assert.equal(fs.existsSync(path.join(f.copy, "node_modules")), false);
  assert.match(r.stdout, /synced/);
});

test("maintenance command rejects unset config and invalid arguments", (t) => {
  const f = fixture(t);
  for (const args of [["status"], ["sync"], ["sync", "--bad"], ["status", "extra"]]) {
    const r = spawnSync(maintenance, args, { cwd: f.wt, encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /unset|usage:/);
  }
});

for (const state of ["matching", "missing", "wrong version"]) {
  test(`local JS plugin runtime dependencies: ${state}`, (t) => {
    const f = toolchainFixture(t);
    const lock = fixtureLock();
    lock.importers["oxlint-local"] = { dependencies: { "fixture-runtime": { version: "1.0.0" } } };
    lock.snapshots["fixture-runtime@1.0.0"] = {};
    for (const dir of [f.wt, f.main, f.copy]) {
      fs.mkdirSync(path.join(dir, "oxlint-local"));
      fs.writeFileSync(path.join(dir, "oxlint-local/package.json"), "{}");
      fs.writeFileSync(path.join(dir, "oxlint-local/index.ts"), "export {};\n");
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), JSON.stringify(lock));
    }
    for (const dir of [f.wt, f.main, f.copy])
      fs.writeFileSync(
        path.join(dir, "vite.config.ts"),
        'export default {lint:{jsPlugins:["./oxlint-local/index.ts"]}};',
      );
    for (const dir of [f.main, f.copy]) {
      const pkg = path.join(dir, "node_modules/fixture-runtime");
      if (dir === f.copy && state === "missing") continue;
      fs.mkdirSync(pkg);
      fs.writeFileSync(
        path.join(pkg, "package.json"),
        JSON.stringify({
          name: "fixture-runtime",
          version: dir === f.copy && state === "wrong version" ? "2.0.0" : "1.0.0",
        }),
      );
    }
    fs.appendFileSync(path.join(f.main, "vite.config.ts"), "drift\n");
    const r = f.run(["lint", "a.ts"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(state === "matching" ? f.copy : f.main));
    if (state !== "matching") {
      fs.rmSync(path.join(f.main, "node_modules/fixture-runtime"), { recursive: true });
      const refused = f.run(["lint", "a.ts"]);
      assert.equal(refused.status, 127, refused.stderr);
      assert.match(refused.stderr, /fixture-runtime.*toolchain sync --install/);
      assert.match(refused.stderr, /main checkout.*fixture-runtime/);
    }
  });
}

test("automatic sync never runs checkout hooks", (t) => {
  const f = toolchainFixture(t);
  const { target } = newerConfig(f);
  const hooks = path.join(path.dirname(f.main), "hooks");
  const marker = path.join(hooks, "called");
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, {
    mode: 0o755,
  });
  fixtureGit(f.main, "config", "core.hooksPath", hooks);
  const r = f.run(["fmt", "a.ts"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fixtureGit(f.copy, "rev-parse", "HEAD"), target);
  assert.equal(fs.existsSync(marker), false);
});

const nativeConfigTest = {
  skip:
    !process.env.VP_TEST_NODE_MODULES &&
    "set VP_TEST_NODE_MODULES to the pinned checkout's node_modules",
};
function writeConfig(base, config) {
  fs.writeFileSync(
    path.join(base, "vite.config.ts"),
    `export default ${JSON.stringify(config)};\n`,
  );
}
function writeRule(base, name, message) {
  const dir = path.join(base, "oxlint-local");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(dir, `${name}.ts`),
    `export default {create(context) {return {DebuggerStatement(node) {context.report({node, message: ${JSON.stringify(message)}});}};}};`,
  );
  fs.writeFileSync(
    path.join(dir, "index.ts"),
    `import rule from "./${name}.ts"; export default {meta:{name:"worktree"},rules:{${JSON.stringify(name)}:rule}};`,
  );
}

test(
  "native: lagging plugin index and rule list use worktree rules for fmt and lint",
  nativeConfigTest,
  (t) => {
    const f = fixture(t, process.env.VP_TEST_NODE_MODULES);
    writeRule(f.main, "copy-only", "COPY ONLY RULE");
    writeConfig(f.main, {
      fmt: {},
      lint: { jsPlugins: ["./oxlint-local/index.ts"], rules: { "worktree/copy-only": "error" } },
    });
    writeRule(f.wt, "old-rule", "OLD WORKTREE RULE");
    writeConfig(f.wt, {
      fmt: {},
      lint: { jsPlugins: ["./oxlint-local/index.ts"], rules: { "worktree/old-rule": "off" } },
    });
    const file = path.join(f.wt, "sample.ts");
    fs.writeFileSync(file, "export const value={a:1}\n");
    const bad = f.run(["fmt", "--check", "sample.ts"]);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    const fixed = f.run(["fmt", "--write", "sample.ts"]);
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
    assert.equal(fs.readFileSync(file, "utf8"), "export const value = { a: 1 };\n");
    const clean = f.run(["fmt", "--check", "sample.ts"]);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    fs.writeFileSync(file, "debugger;\n");
    const lint = f.run(["lint", "sample.ts"]);
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    assert.doesNotMatch(lint.stdout + lint.stderr, /COPY ONLY RULE/);
  },
);

test("native: newly added worktree plugin and its imported rule execute", nativeConfigTest, (t) => {
  const f = fixture(t, process.env.VP_TEST_NODE_MODULES);
  writeRule(f.wt, "new-rule", "NEW WORKTREE RULE EXECUTED");
  writeConfig(f.wt, {
    fmt: {},
    lint: { jsPlugins: ["./oxlint-local/index.ts"], rules: { "worktree/new-rule": "error" } },
  });
  fs.writeFileSync(path.join(f.wt, "sample.ts"), "debugger;\n");
  const lint = f.run(["lint", "sample.ts"]);
  assert.equal(lint.status, 1, lint.stdout + lint.stderr);
  assert.match(lint.stdout + lint.stderr, /NEW WORKTREE RULE EXECUTED/);
  assert.match(lint.stdout + lint.stderr, /worktree\(new-rule\)/);
});

test("native: worktree fmt settings and imported helper win over copy", nativeConfigTest, (t) => {
  const f = fixture(t, process.env.VP_TEST_NODE_MODULES);
  for (const base of [f.main, f.wt]) {
    fs.mkdirSync(path.join(base, "config"));
    fs.writeFileSync(
      path.join(base, "config/fmt.ts"),
      `import { defineConfig } from "vite-plus"; export default defineConfig({fmt:{semi:${base === f.main}}}).fmt;`,
    );
    fs.writeFileSync(
      path.join(base, "vite.config.ts"),
      'import fmt from "./config/fmt.ts"; export default {fmt,lint:{}};',
    );
  }
  fs.writeFileSync(path.join(f.wt, "sample.ts"), "export const value = 1;\n");
  const result = f.run(["fmt", "--write", "sample.ts"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(f.wt, "sample.ts"), "utf8"), "export const value = 1\n");
});

test(
  "native: missing package in imported worktree helper refuses with no format write",
  nativeConfigTest,
  (t) => {
    const f = fixture(t, process.env.VP_TEST_NODE_MODULES);
    fs.writeFileSync(
      path.join(f.wt, "helper.ts"),
      'import "worktree-only-missing-package"; export default {};',
    );
    fs.writeFileSync(
      path.join(f.wt, "vite.config.ts"),
      'import fmt from "./helper.ts"; export default {fmt};',
    );
    const body = "export const value={a:1}\n";
    fs.writeFileSync(path.join(f.wt, "sample.ts"), body);
    const result = f.run(["fmt", "--write", "sample.ts"]);
    assert.equal(result.status, 127, result.stdout + result.stderr);
    assert.match(result.stderr, /worktree-only-missing-package/);
    assert.match(result.stderr, /offbox run -- vp fmt/);
    assert.equal(fs.readFileSync(path.join(f.wt, "sample.ts"), "utf8"), body);
  },
);

for (const form of ["relative", "absolute", "import.meta.url"]) {
  test(`native: local plugin specifier ${form} uses worktree sources`, nativeConfigTest, (t) => {
    const f = fixture(t, process.env.VP_TEST_NODE_MODULES);
    writeRule(f.wt, "new-rule", "WORKTREE SPECIFIER RULE");
    const plugin =
      form === "import.meta.url"
        ? 'new URL("./oxlint-local/index.ts", import.meta.url).pathname'
        : JSON.stringify(
            form === "relative"
              ? "./oxlint-local/index.ts"
              : path.join(f.wt, "oxlint-local/index.ts"),
          );
    fs.writeFileSync(
      path.join(f.wt, "vite.config.ts"),
      `export default {lint:{jsPlugins:[${plugin}],rules:{"worktree/new-rule":"error"}}};`,
    );
    fs.writeFileSync(path.join(f.wt, "sample.ts"), "debugger;\n");
    const result = f.run(["lint", "sample.ts"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /WORKTREE SPECIFIER RULE/);
    assert.equal(fs.existsSync(path.join(f.wt, "node_modules")), false);
  });
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const shim = fileURLToPath(new URL("../bin/vp", import.meta.url));
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
    "vite.config.ts": 'export default {fmt:{ignorePatterns:["dist/**"]},lint:{}};\n',
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
    fs.symlinkSync(nativeModules, path.join(main, "node_modules"));
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
    export async function loadConfigFromFile() {
      return { dependencies: [], config: {
        fmt: { ignorePatterns: ["dist/**"], overrides: [{files:["src/**"],options:{semi:false}}] },
        lint: { ignorePatterns: ["dist/**"], jsPlugins: ["@fixture/lint/rules"] }
      }};
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

test("config drift, addition and deletion all refuse without running vp", (t) => {
  const f = fixture(t);
  for (const name of [
    "vite.config.ts",
    ".oxfmtrc.json",
    ".oxlintrc.json",
    "oxlint.config.ts",
    ".gitignore",
    ".prettierignore",
    ".eslintignore",
  ]) {
    const file = path.join(f.wt, name);
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    fs.writeFileSync(file, "different\n");
    const r = f.run(["fmt", "a.ts"]);
    assert.equal(r.status, 127);
    assert.match(r.stderr, /config drift.*offbox run -- vp fmt/);
    assert.equal(r.stdout, "");
    if (before) fs.writeFileSync(file, before);
    else fs.unlinkSync(file);
  }
  fs.unlinkSync(path.join(f.wt, "vite.config.ts"));
  assert.match(f.run(["lint", "a.ts"]).stderr, /config drift/);
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

test("drift in local plugin helpers refuses as well", (t) => {
  const f = fixture(t);
  for (const dir of [f.wt, f.main]) {
    fs.mkdirSync(path.join(dir, "oxlint-plugin-t3code/rules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "oxlint-plugin-t3code/rules/helper.ts"), "export {};\n");
  }
  assert.equal(f.run(["lint", "a.ts"]).status, 0);
  fs.appendFileSync(path.join(f.wt, "oxlint-plugin-t3code/rules/helper.ts"), "changed\n");
  assert.match(
    f.run(["lint", "a.ts"]).stderr,
    /config drift in oxlint-plugin-t3code\/rules\/helper.ts/,
  );
});

test("unsafe or ambiguous argument forms refuse with an offbox hint", (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.main, path.join(f.wt, "outside"));
  for (const args of [
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

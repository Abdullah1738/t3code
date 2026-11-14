import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const shim = fileURLToPath(new URL("../bin/vp", import.meta.url));
function fixture(t) {
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
    "vite.config.ts": "export default {};\n",
    "package.json": "{}\n",
    ".gitignore": "dist/\n",
  }))
    fs.writeFileSync(path.join(main, name), content);
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  git("worktree", "add", "-q", "--detach", wt);
  fs.mkdirSync(path.join(main, "node_modules/.bin"), { recursive: true });
  fs.mkdirSync(path.join(main, "node_modules/vite-plus"));
  fs.writeFileSync(
    path.join(main, "node_modules/vite-plus/package.json"),
    JSON.stringify({
      type: "module",
      exports: { ".": { import: "./index.js" } },
    }),
  );
  fs.writeFileSync(
    path.join(main, "node_modules/vite-plus/index.js"),
    `
    export async function loadConfigFromFile() {
      return { dependencies: [], config: {
        fmt: { ignorePatterns: ["dist/**"], overrides: [{files:["src/**"],options:{semi:false}}] },
        lint: { ignorePatterns: ["dist/**"], jsPlugins: [] }
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
    assert.equal(result.cwd, main);
    assert.match(r.stderr, /no node_modules in this worktree; running/);
    assert.equal(path.dirname(result.args[2]), wt);
    assert.equal(fs.existsSync(result.args[2]), false, "temporary config cleaned up");
    return result;
  }
  return { main, wt, run, routed, fake };
}

test("fmt and lint use main cwd, absolute paths, config rooted at the worktree", (t) => {
  const f = fixture(t);
  for (const command of ["fmt", "lint"]) {
    const r = f.routed([command, "--check", "src/a b.ts", path.join(f.wt, "other.ts")]);
    assert.deepEqual(r.args.slice(-3), [
      "--check",
      path.join(f.wt, "src/a b.ts"),
      path.join(f.wt, "other.ts"),
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
});

test("argument classes: spaced/equals values, paths, globs, exclusions, separator", (t) => {
  const f = fixture(t);
  const rows = [
    [
      ["--threads", "1", "a.ts"],
      ["--threads=1", path.join(f.wt, "a.ts")],
    ],
    [
      ["--threads=1", "a.ts"],
      ["--threads=1", path.join(f.wt, "a.ts")],
    ],
    [
      ["-D", "no-debugger", "a.ts"],
      ["-D=no-debugger", path.join(f.wt, "a.ts")],
    ],
    [
      ["--format", "json", "a.ts"],
      ["--format=json", path.join(f.wt, "a.ts")],
    ],
    [
      ["--tsconfig=tsconfig.json", "a.ts"],
      [`--tsconfig=${f.wt}/tsconfig.json`, `${f.wt}/a.ts`],
    ],
    [
      ["--ignore-path", ".gitignore", "a.ts"],
      [`--ignore-path=${f.wt}/.gitignore`, `${f.wt}/a.ts`],
    ],
    [
      ["--", "-dash.ts"],
      ["--", `${f.wt}/-dash.ts`],
    ],
  ];
  for (const [input, expected] of rows)
    assert.deepEqual(f.routed(["fmt", ...input]).args.slice(-expected.length), expected);
});

test("quoted globs expand in original cwd; exclusions stay relative to worktree config", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.wt, "src"));
  for (const name of ["a.ts", "skip.ts"])
    fs.writeFileSync(path.join(f.wt, "src", name), "export {};\n");
  const result = f.routed(["fmt", "src/*.ts", "!src/skip.ts"]);
  assert.deepEqual(result.args.slice(-2).sort(), [`${f.wt}/src/a.ts`, `${f.wt}/src/skip.ts`]);
  assert.equal(result.config.ignorePatterns.at(-1), "src/skip.ts");
  assert.match(f.run(["fmt", "missing/*.ts"]).stderr, /no files match.*offbox/);
});

test("config drift, addition and deletion all refuse without running vp", (t) => {
  const f = fixture(t);
  for (const name of [
    "vite.config.ts",
    "package.json",
    ".oxfmtrc.json",
    ".oxlintrc.json",
    "oxlint.config.ts",
    ".gitignore",
    ".prettierignore",
    ".eslintignore",
    "pnpm-lock.yaml",
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

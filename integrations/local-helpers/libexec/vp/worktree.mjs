import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  checkToolchain,
  loadToolchain,
  syncToolchain,
  ToolchainMismatch,
} from "./toolchain-state.mjs";

const [root, ...input] = process.argv.slice(2);
const candidates = [];
while (input[0]?.startsWith("--candidate=")) {
  const kind = input.shift().slice("--candidate=".length);
  candidates.push({ kind, dir: input.shift() });
}
if (input.shift() !== "--") throw new Error("missing candidate separator");
const [command, ...args] = input;
let main;
const hint = `run offbox run -- vp ${[command, ...args].filter(Boolean).join(" ")}`;
function refuse(reason) {
  throw new Error(reason);
}

function absolute(value) {
  const result = path.resolve(value);
  // Resolve the existing prefix too: a worktree symlink must not redirect writes to main.
  let prefix = result;
  while (!fs.existsSync(prefix)) prefix = path.dirname(prefix);
  const real = fs.realpathSync(prefix);
  if (real !== root && !real.startsWith(`${root}/`)) refuse("path is outside this worktree");
  return path.join(real, path.relative(prefix, result));
}

const valueFlags = new Set([
  "--threads",
  "--allow",
  "--warn",
  "--deny",
  "-A",
  "-W",
  "-D",
  "--format",
  "-f",
  "--debug",
  "--max-warnings",
  "--report-unused-disable-directives-severity",
  "--ignore-pattern",
]);
const pathFlags = new Set(["--ignore-path", "--tsconfig", "--stdin-filepath"]);
const switches = new Set([
  "--check",
  "--write",
  "--list-different",
  "--with-node-modules",
  "--no-error-on-unmatched-pattern",
  "--fix",
  "--fix-suggestions",
  "--fix-dangerously",
  "--no-ignore",
  "--quiet",
  "--deny-warnings",
  "--silent",
  "--print-config",
  "--rules",
  "--type-aware",
  "--type-check",
  "--help",
  "-h",
  "--report-unused-disable-directives",
  "--disable-unicorn-plugin",
  "--disable-oxc-plugin",
  "--disable-typescript-plugin",
  ...[
    "import",
    "react",
    "jsdoc",
    "jest",
    "vitest",
    "jsx-a11y",
    "nextjs",
    "react-perf",
    "promise",
    "node",
    "vue",
  ].map((name) => `--${name}-plugin`),
]);

function argv() {
  const result = [];
  let paths = 0;
  let positional = false;
  let stdin = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!positional && arg === "--") {
      positional = true;
      result.push(arg);
    } else if (!positional && arg.startsWith("-")) {
      const [flag] = arg.split("=");
      const takesPath = pathFlags.has(flag);
      if (takesPath || valueFlags.has(flag)) {
        const equal = arg.indexOf("=");
        const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
        if (!value || value.startsWith("--")) refuse(`missing value for ${flag}`);
        result.push(`${flag}=${takesPath ? absolute(value) : value}`);
        stdin ||= flag === "--stdin-filepath";
      } else if (switches.has(arg) || /^-[AWD].+/.test(arg)) {
        result.push(arg);
      } else {
        refuse(`unsupported worktree option ${arg}`);
      }
    } else {
      const negative = command === "fmt" && arg.startsWith("!");
      const pattern = negative ? arg.slice(1) : arg;
      const target = absolute(pattern);
      if (command === "fmt") {
        // Oxfmt rejects '..' paths and skips absolute globs. Root patterns at the worktree,
        // while leaving discovery to Oxfmt so dotfiles and nested ignores keep their semantics.
        let relative = path.relative(root, target) || ".";
        // A basename-only glob matches recursively; adding the cwd prefix must preserve that.
        if (
          !fs.existsSync(target) &&
          path.dirname(path.normalize(pattern)) === "." &&
          /[*?{[]/.test(pattern) &&
          path.dirname(relative) !== "."
        ) {
          relative = path.join(path.dirname(relative), "**", path.basename(relative));
        }
        result.push(`${negative ? "!" : ""}${relative}`);
        if (!negative) paths++;
      } else if (/[*?{[]/.test(arg)) {
        const matches = fs.globSync(arg);
        if (!matches.length) refuse(`no files match ${arg}`);
        result.push(...matches.map(absolute));
        paths++;
      } else {
        result.push(target);
        paths++;
      }
    }
  }
  if (!paths && !stdin) {
    const separator = result.indexOf("--");
    result.splice(separator < 0 ? result.length : separator, 0, root);
  }
  return result;
}

function checkConfig() {
  const configName =
    /^(vite\.config\.|\.oxfmtrc|\.oxlintrc|oxfmt|oxlint|\.gitignore$|\.prettierignore$|\.eslintignore$)/;
  const names = new Set(
    [...fs.readdirSync(root), ...fs.readdirSync(main)].filter((name) => configName.test(name)),
  );
  for (const name of names) {
    const a = path.join(root, name);
    const b = path.join(main, name);
    sameConfig(a, b, name);
  }
}

function sameConfig(a, b, label) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) refuse(`config drift in ${label}`);
  if (fs.statSync(a).isDirectory() && fs.statSync(b).isDirectory()) {
    const names = new Set([...fs.readdirSync(a), ...fs.readdirSync(b)]);
    for (const name of names) {
      if (name !== "node_modules")
        sameConfig(path.join(a, name), path.join(b, name), `${label}/${name}`);
    }
  } else if (
    !fs.statSync(a).isFile() ||
    !fs.statSync(b).isFile() ||
    !fs.readFileSync(a).equals(fs.readFileSync(b))
  ) {
    refuse(`config drift in ${label}`);
  }
}

let temporary;
try {
  if (command !== "fmt" && command !== "lint") refuse("no node_modules in this worktree");
  const forwarded = argv();
  const failures = [];
  let selectedConfig;
  let staleToolchain = false;
  for (const candidate of candidates) {
    main = fs.realpathSync(candidate.dir);
    if (main === root) continue;
    try {
      if (candidate.kind === "toolchain copy") syncToolchain(root, main);
      checkConfig();
      process.chdir(main);
      const requireMain = createRequire(path.join(main, "package.json"));
      const loaded = await loadToolchain(main);
      const config = loaded?.config[command];
      if (!config) refuse(`main vite.config.ts has no ${command} config`);
      checkToolchain(root, main, loaded);
      // Imported config helpers and local lint plugins are configuration too.
      const dependencies = [...loaded.dependencies];
      if (command === "lint") {
        config.jsPlugins = config.jsPlugins?.map((plugin) => {
          if (typeof plugin !== "string") refuse("unsupported JS plugin config");
          const resolved = requireMain.resolve(plugin);
          if (plugin.startsWith(".")) dependencies.push(resolved);
          return resolved;
        });
      }
      for (const file of dependencies) {
        const relative = path.relative(main, file);
        if (relative.startsWith("../") || relative.split(path.sep).includes("node_modules"))
          continue;
        const counterpart = path.join(root, relative);
        if (
          !fs.existsSync(counterpart) ||
          !fs.readFileSync(file).equals(fs.readFileSync(counterpart))
        ) {
          refuse(`config drift in ${relative}`);
        }
      }
      selectedConfig = config;
      break;
    } catch (error) {
      if (candidate.kind === "toolchain copy" && error instanceof ToolchainMismatch)
        staleToolchain = true;
      failures.push(
        candidates.length === 1 && candidate.kind === "main checkout"
          ? error.message
          : `${candidate.kind} (${main}): ${error.message}`,
      );
    }
  }
  if (!selectedConfig)
    refuse(
      `${failures.join("; ")}${staleToolchain ? '; run: ~/.local/libexec/vp/toolchain sync --install (uses offbox local --reason "vp toolchain copy" --ttl 30m before installing)' : ""}`,
    );
  const config = selectedConfig;
  // Both tools anchor ignores and overrides to the config directory, not the file arguments.
  // Keep both the snapshot and fmt's native glob discovery rooted at the worktree.
  temporary = path.join(root, `.vp-worktree-${randomUUID()}.json`);
  config.ignorePatterns = [...(config.ignorePatterns ?? []), ".vp-worktree-*.json"];
  fs.writeFileSync(temporary, JSON.stringify(config), { flag: "wx", mode: 0o600 });
  const defaults = command === "fmt" ? [".gitignore", ".prettierignore"] : [".eslintignore"];
  const ignores = args.some((arg) => arg === "--ignore-path" || arg.startsWith("--ignore-path="))
    ? []
    : defaults
        .filter((name) => fs.existsSync(path.join(root, name)))
        .map((name) => `--ignore-path=${path.join(root, name)}`);
  console.error(
    command === "fmt"
      ? `vp: no node_modules in this worktree; running fmt with ${main}'s dependencies and the worktree config`
      : `vp: no node_modules in this worktree; running lint from ${main} with absolute paths`,
  );
  const child = spawnSync(
    path.join(main, "node_modules/.bin/vp"),
    [command, "--config", temporary, ...ignores, ...forwarded],
    {
      cwd: command === "fmt" ? root : main,
      stdio: "inherit",
    },
  );
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} catch (error) {
  console.error(`vp: ${error.message.replaceAll("\n", " ")}; ${hint}`);
  process.exitCode = 127;
} finally {
  if (temporary) fs.unlinkSync(temporary);
}

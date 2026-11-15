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
import { configSnapshot } from "./config-snapshot.mjs";

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

let temporary;
const snapshots = [];
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
      process.chdir(root);
      const snapshot = await configSnapshot(root, main);
      snapshots.push(snapshot.directory);
      const loaded = await loadToolchain(main, snapshot.directory);
      const config = loaded?.config[command];
      if (!config) refuse(`worktree vite.config.ts has no ${command} config`);
      // Validate local plugin dependencies at the corresponding installed package scope.
      // The rules themselves come exclusively from the worktree snapshot.
      const lint = loaded.config.lint;
      if (lint?.jsPlugins) {
        const plugins = [];
        for (const plugin of lint.jsPlugins) {
          if (typeof plugin !== "string") refuse("unsupported JS plugin config");
          if (plugin.startsWith(".") || path.isAbsolute(plugin)) {
            const file = path.resolve(root, plugin);
            const original = file.startsWith(`${snapshot.directory}${path.sep}`)
              ? path.join(root, path.relative(snapshot.directory, file))
              : file;
            plugins.push(await snapshot.stage(original));
          } else plugins.push(plugin);
        }
        lint.jsPlugins = plugins;
      }
      checkToolchain(root, main, loaded, snapshot.directory);
      if (command === "lint") {
        const requireConfig = createRequire(path.join(snapshot.directory, "package.json"));
        config.jsPlugins = config.jsPlugins?.map((plugin) => requireConfig.resolve(plugin));
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
  for (const directory of snapshots) fs.rmSync(directory, { recursive: true, force: true });
}

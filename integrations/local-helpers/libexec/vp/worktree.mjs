import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as NodeOS from "node:os";

const [root, main, command, ...args] = process.argv.slice(2);
const hint = `run offbox run -- vp ${[command, ...args].filter(Boolean).join(" ")}`;
function refuse(reason) {
  throw new Error(`${reason}; ${hint}`);
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

function installedPackage(name, requireFrom) {
  // Search package roots directly: plugins may not export their package.json.
  for (const dir of requireFrom.resolve.paths(name) ?? []) {
    const file = path.join(dir, name, "package.json");
    if (fs.existsSync(file)) {
      try {
        const real = fs.realpathSync(file);
        return { file: real, metadata: JSON.parse(fs.readFileSync(real, "utf8")) };
      } catch {
        return;
      }
    }
  }
}

function checkToolchain(requireMain, vpFile, loaded) {
  const requireVp = createRequire(fs.realpathSync(vpFile));
  const { parse } = requireVp("yaml");
  let lock;
  try {
    lock = parse(fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
    if (Number(lock?.lockfileVersion) !== 9 || !lock.importers?.["."] || !lock.snapshots)
      throw new Error("expected pnpm lockfile v9");
  } catch {
    refuse("config drift in pnpm-lock.yaml (missing or invalid v9 lockfile)");
  }
  const importer = lock.importers["."];
  const rootReference = (name) =>
    (
      importer.dependencies?.[name] ??
      importer.devDependencies?.[name] ??
      importer.optionalDependencies?.[name]
    )?.version;
  const toolchainName = (name) =>
    /^(vite-plus$|vite$|oxfmt$|oxlint$|oxlint-tsgolint$|@oxfmt\/|@oxlint\/|@oxlint-tsgolint\/|@voidzero-dev\/)/.test(
      name,
    );
  const visited = new Set();
  const libc =
    NodeOS.platform() === "linux"
      ? process.report.getReport().header.glibcVersionRuntime
        ? "glibc"
        : "musl"
      : undefined;
  function visit(name, reference, requireFrom) {
    const installed = installedPackage(name, requireFrom);
    // pnpm appends peer contexts, and npm aliases carry the actual package name.
    const alias =
      typeof reference === "string" && /^((?:@[^/()]+\/)?[^@()]+)@(.+)$/.exec(reference);
    const identity = alias ? alias[1] : name;
    const resolved = alias ? alias[2] : reference;
    const version = typeof resolved === "string" ? resolved.split("(")[0] : undefined;
    if (
      !version ||
      !installed?.metadata.version ||
      installed.metadata.name !== identity ||
      version !== installed.metadata.version
    )
      refuse(
        `config drift in ${name} (${version ?? "unresolved"} vs ${installed?.metadata.version ?? "unresolved"})`,
      );
    const snapshotKey = `${identity}@${resolved}`;
    const key = `${installed.file}:${snapshotKey}`;
    if (visited.has(key)) return;
    visited.add(key);
    const snapshot = lock.snapshots[snapshotKey];
    if (!snapshot) refuse(`config drift in ${name} (unresolved lockfile snapshot vs ${version})`);
    const dependencies = { ...snapshot.dependencies, ...snapshot.optionalDependencies };
    const declared = {
      ...installed.metadata.dependencies,
      ...installed.metadata.optionalDependencies,
    };
    const childRequire = createRequire(installed.file);
    const children = new Set([...Object.keys(declared), ...Object.keys(dependencies)]);
    if (name === "vite-plus") {
      children.add("oxfmt");
      children.add("oxlint");
    }
    for (const child of children) {
      if (!toolchainName(child)) continue;
      if (
        installed.metadata.optionalDependencies?.[child] ||
        snapshot.optionalDependencies?.[child]
      ) {
        const ref = dependencies[child];
        const pkg = lock.packages?.[`${child}@${typeof ref === "string" ? ref.split("(")[0] : ""}`];
        const accepts = (values, current) =>
          !values ||
          (!values.includes(`!${current}`) &&
            (values.every((v) => v.startsWith("!")) || values.includes(current)));
        if (
          pkg &&
          (!accepts(pkg.os, NodeOS.platform()) ||
            !accepts(pkg.cpu, NodeOS.arch()) ||
            (libc && !accepts(pkg.libc, libc)))
        )
          continue;
      }
      visit(child, dependencies[child], childRequire);
    }
  }
  visit("vite-plus", rootReference("vite-plus"), requireMain);
  for (const plugin of loaded.config.lint?.jsPlugins ?? []) {
    if (typeof plugin !== "string") refuse("unsupported JS plugin config");
    if (plugin.startsWith(".") || path.isAbsolute(plugin)) continue;
    const name = /^(?:@[^/]+\/)?[^/]+/.exec(plugin)?.[0];
    visit(name, rootReference(name), requireMain);
  }
  // vp fmt/lint use the explicit Vite config snapshot, not package.json config keys.
  // Only `type` affects how Vite loads that config; scripts and dependencies do not.
  const packageType = (base) =>
    JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8")).type;
  if (packageType(root) !== packageType(main)) refuse("config drift in package.json#type");
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
  checkConfig();
  process.chdir(main);
  const requireMain = createRequire(path.join(main, "package.json"));
  const vpPackage = path.join(main, "node_modules/vite-plus");
  const metadata = JSON.parse(fs.readFileSync(path.join(vpPackage, "package.json"), "utf8"));
  const { loadConfigFromFile } = await import(
    pathToFileURL(path.join(vpPackage, metadata.exports["."].import))
  );
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    path.join(main, "vite.config.ts"),
  );
  const config = loaded?.config[command];
  if (!config) refuse(`main vite.config.ts has no ${command} config`);
  checkToolchain(requireMain, path.join(vpPackage, "package.json"), loaded);
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
    if (relative.startsWith("../") || relative.split(path.sep).includes("node_modules")) continue;
    const counterpart = path.join(root, relative);
    if (
      !fs.existsSync(counterpart) ||
      !fs.readFileSync(file).equals(fs.readFileSync(counterpart))
    ) {
      refuse(`config drift in ${relative}`);
    }
  }
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
  console.error(`vp: ${error.message.replaceAll("\n", " ")}`);
  process.exitCode = 127;
} finally {
  if (temporary) fs.unlinkSync(temporary);
}

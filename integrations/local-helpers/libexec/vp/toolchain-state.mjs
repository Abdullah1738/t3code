import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import * as NodeOS from "node:os";

export class ToolchainMismatch extends Error {}
function refuse(reason) {
  throw new ToolchainMismatch(reason);
}

export async function loadToolchain(main) {
  const vpPackage = path.join(main, "node_modules/vite-plus");
  const metadata = JSON.parse(fs.readFileSync(path.join(vpPackage, "package.json"), "utf8"));
  const { loadConfigFromFile } = await import(
    pathToFileURL(path.join(vpPackage, metadata.exports["."].import))
  );
  return loadConfigFromFile(
    { command: "serve", mode: "development" },
    path.join(main, "vite.config.ts"),
  );
}

export function git(dir, args, timeout = 10000) {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message ?? result.stderr.trim());
  return result.stdout.trim();
}

export function toolchainPath(root, candidate) {
  const real = fs.realpathSync(candidate);
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (
    real === fs.realpathSync(path.dirname(common)) ||
    real !== fs.realpathSync(git(real, ["rev-parse", "--show-toplevel"])) ||
    fs.realpathSync(git(real, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !==
      fs.realpathSync(common)
  )
    throw new Error("toolchain copy must be a separate worktree of this repo");
  // Force checkout is safe only in the board-owned, detached copy.
  if (git(real, ["rev-parse", "--abbrev-ref", "HEAD"]) !== "HEAD")
    throw new Error("toolchain copy must have a detached HEAD");
  return real;
}

export function syncToolchain(root, candidate) {
  const dir = toolchainPath(root, candidate);
  const target = git(root, ["rev-parse", "refs/remotes/origin/main"]);
  if (git(dir, ["rev-parse", "HEAD"]) === target) return "current";
  const lock = path.join(git(dir, ["rev-parse", "--absolute-git-dir"]), "vp-sync.lock");
  try {
    try {
      fs.mkdirSync(lock);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - fs.statSync(lock).mtimeMs <= 60000) return "locked";
      // rmdir is atomic and refuses unexpected lock contents.
      fs.rmdirSync(lock);
      fs.mkdirSync(lock);
    }
  } catch {
    return "locked";
  }
  try {
    // A post-checkout hook could install or fetch; the shim must stay git-only.
    git(dir, ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", "--force", target]);
    return "synced";
  } finally {
    fs.rmdirSync(lock);
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

export function checkToolchain(root, main, loaded) {
  const requireMain = createRequire(path.join(main, "package.json"));
  const vpFile = path.join(main, "node_modules/vite-plus/package.json");
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
    if (plugin.startsWith(".") || path.isAbsolute(plugin)) {
      const file = requireMain.resolve(plugin);
      let dir = path.dirname(file);
      while (dir.startsWith(`${main}/`) && !fs.existsSync(path.join(dir, "package.json")))
        dir = path.dirname(dir);
      const local = lock.importers[path.relative(main, dir)];
      if (local) {
        const requirePlugin = createRequire(file);
        for (const [name, entry] of Object.entries(local.dependencies ?? {}))
          visit(name, entry.version, requirePlugin);
      }
      continue;
    }
    const name = /^(?:@[^/]+\/)?[^/]+/.exec(plugin)?.[0];
    visit(name, rootReference(name), requireMain);
  }
  // vp fmt/lint use the explicit Vite config snapshot, not package.json config keys.
  // Only `type` affects how Vite loads that config; scripts and dependencies do not.
  const packageType = (base) =>
    JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8")).type;
  if (packageType(root) !== packageType(main)) refuse("config drift in package.json#type");
}

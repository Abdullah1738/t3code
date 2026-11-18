import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runChild } from "./child.mjs";
import { brokenToolchainPath, danglingNotice, hasToolchain, logEvent } from "./events.mjs";

const started = Date.now();
const cwd = process.cwd();
const args = process.argv.slice(2);
const command = ["fmt", "lint"].includes(args[0]) ? args[0] : "other";
const here = path.dirname(fileURLToPath(import.meta.url));
const git = (...argv) => {
  const result = spawnSync("git", argv, { encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : "";
};
const root = git("rev-parse", "--show-toplevel");
const reasons = [];
const skipped = [];
const candidate = null;
let outcome = "refused";
let delegated = false;
let exitCode = 127;
try {
  const guard = spawnSync(
    "/bin/sh",
    [
      "-c",
      '. "$1"; shift; repo_shared_deps_check vp "$@"',
      "vp",
      path.join(here, "../repo-node-pin/shared-deps.sh"),
      ...args,
    ],
    { stdio: "inherit" },
  );
  if (guard.status !== 0) {
    reasons.push({ candidate: null, reason: "shared-dependencies", diagnosis: null, file: null });
    exitCode = guard.status ?? 1;
  } else if (process.env.REPO_VP_SHIM_ACTIVE === "1") {
    console.error("vp: recursive shim; run offbox run -- vp instead");
    reasons.push({ candidate: null, reason: "recursive-shim", diagnosis: null, file: null });
  } else {
    process.env.REPO_VP_SHIM_ACTIVE = "1";
    let brokenLocal = false;
    for (let directory = cwd; ; directory = path.dirname(directory)) {
      const binary = path.join(directory, "node_modules/.bin/vp");
      let executable = false;
      let present = false;
      try {
        fs.lstatSync(binary);
        present = true;
      } catch {}
      try {
        fs.accessSync(binary, fs.constants.X_OK);
        executable = true;
      } catch {}
      if (present) {
        if (executable && hasToolchain(directory)) {
          exitCode = await runChild(binary, args);
          outcome = "ran";
          break;
        }
        if (hasToolchain(directory)) break;
        brokenLocal = true;
        console.error(danglingNotice("local checkout", directory));
        const reason = {
          candidate: null,
          reason: "dangling-vite-plus",
          diagnosis: null,
          file: path.join(directory, "node_modules/vite-plus/bin/vp"),
        };
        reasons.push(reason);
        skipped.push({ ...reason, directory, brokenRealpath: brokenToolchainPath(directory) });
      }
      if (directory === root || directory === path.dirname(directory)) break;
    }
    if (outcome !== "ran") {
      const candidates = [];
      if (root && (!fs.existsSync(path.join(root, "node_modules")) || brokenLocal)) {
        const main = git("rev-parse", "--path-format=absolute", "--git-common-dir").replace(
          /\/\.git$/,
          "",
        );
        const toolchain = git("config", "--get", "vp.toolchain");
        if (toolchain && toolchain !== root)
          candidates.push("--candidate=toolchain copy", toolchain);
        if (main && main !== root) candidates.push("--candidate=main checkout", main);
      }
      if (candidates.length) {
        let record;
        exitCode = await runChild(
          process.execPath,
          [path.join(here, "worktree.mjs"), root, ...candidates, "--", ...args],
          {
            stdio: ["inherit", "inherit", "inherit", "ipc"],
            env: {
              ...process.env,
              VP_SHIM_STARTED: String(started),
              VP_SHIM_REASONS: JSON.stringify(reasons),
              VP_SHIM_SKIPPED: JSON.stringify(skipped),
            },
          },
          (message) => {
            if (message?.type === "vp-shim-outcome") record = message.record;
          },
        );
        if (record) {
          logEvent({ ...record, exitCode });
          delegated = true;
        } else {
          reasons.push({
            candidate: null,
            reason: "worktree-interrupted",
            diagnosis: null,
            file: null,
          });
        }
      } else {
        reasons.push({
          candidate: null,
          reason: "no-working-toolchain",
          diagnosis: null,
          file: null,
        });
        console.error(
          `vp: no checkout-local node_modules/.bin/vp resolves; run offbox run -- vp ${args.join(" ")}`,
        );
      }
    }
  }
} catch (error) {
  console.error(`vp: ${error.message}; run offbox run -- vp instead`);
} finally {
  if (!delegated)
    logEvent({
      event: skipped.length ? "dangling-toolchain" : "outcome",
      command,
      root,
      cwd,
      outcome,
      candidate,
      exitCode,
      reasons,
      skipped,
      toolchainHead: null,
      durationMs: Date.now() - started,
    });
}
process.exitCode = exitCode;

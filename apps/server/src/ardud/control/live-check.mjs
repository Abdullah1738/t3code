import * as NodeChildProcess from "node:child_process";

const DEFAULT_REPO = "/Volumes/ExternalSSD/t3code-fork";

function liveGit(args, { signal, ...options }) {
  return new Promise((resolve) => {
    const child = NodeChildProcess.execFile("git", args, options, (error, stdout) => {
      signal.removeEventListener("abort", stop);
      resolve({ status: error ? error.code : 0, stdout, error });
    });
    // A killed child can stay in the kernel. It must not hold the CLI open.
    const stop = () => {
      child.kill("SIGKILL");
      child.unref();
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    signal.addEventListener("abort", stop, { once: true });
    child.stdin?.destroy();
  });
}

/** Check whether a ref is an ancestor of the build reported by health. */
export async function checkLive(
  commit,
  { health, repo = DEFAULT_REPO, git = liveGit, timeoutMs = 20_000, onStage = () => {} },
) {
  const start = performance.now();
  const deadline = start + timeoutMs;
  const stages = {};
  let buildCommit = null;
  let currentStage = "health";
  const answer = (live, reason) => ({
    commit: commit ?? null,
    buildCommit,
    live,
    reason,
    stages,
    elapsedMs: Math.round(performance.now() - start),
  });
  const timedOut = () => new DOMException("Stage deadline", "TimeoutError");
  const stage = async (name, run, capMs = Infinity) => {
    currentStage = name;
    const started = performance.now();
    const remaining = Math.ceil(deadline - started);
    if (remaining <= 0) throw timedOut();
    const limit = Math.min(remaining, capMs);
    onStage(name);
    const controller = new AbortController();
    let timer;
    let status = "ok";
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => run({ signal: controller.signal, timeoutMs: limit })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(timedOut());
            controller.abort();
          }, limit);
        }),
      ]);
      if (performance.now() >= started + limit) throw timedOut();
      return value;
    } catch (error) {
      status = error?.name === "TimeoutError" ? "timeout" : "error";
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      stages[name] = { status, ms: Math.round(performance.now() - started) };
    }
  };

  const gitEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
  ])
    delete gitEnv[key];
  const runGit = async (args, { signal }) => {
    const remaining = Math.ceil(deadline - performance.now());
    if (signal.aborted || remaining <= 0) throw timedOut();
    const result = await git(args, {
      cwd: repo,
      env: gitEnv,
      encoding: "utf8",
      timeout: remaining,
      killSignal: "SIGKILL",
      signal,
    });
    if (result.error?.code === "ETIMEDOUT" || result.error?.signal === "SIGKILL") throw timedOut();
    return result;
  };
  const objectId = async (prefix, options) => {
    const result = await runGit(["rev-parse", `--disambiguate=${prefix.toLowerCase()}`], options);
    const matches = result.stdout?.trim().split("\n").filter(Boolean) ?? [];
    return result.status === 0 &&
      matches.length === 1 &&
      (await runGit(["cat-file", "-t", matches[0]], options)).stdout?.trim() === "commit"
      ? matches[0]
      : null;
  };
  try {
    const response = await stage("health", health, 10_000);
    if (
      response?.ok !== true ||
      !["healthy", "degraded", "recovered-unverified"].includes(response?.status)
    ) {
      return answer(null, "invalid health response");
    }
    const reportedBuild = response.buildCommit;
    if (
      typeof reportedBuild !== "string" ||
      reportedBuild.trim() !== reportedBuild ||
      !/^[0-9a-f]{7,40}$/.test(reportedBuild)
    ) {
      return answer(null, "build commit unavailable");
    }
    buildCommit = reportedBuild;
    if (typeof commit !== "string" || !commit || commit.startsWith("-")) {
      return answer(null, "invalid commit or ref");
    }
    const target = await stage("target", async (options) => {
      if (/^[0-9a-f]{7,40}$/i.test(commit)) return objectId(commit, options);
      const result = await runGit(
        ["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`],
        options,
      );
      return result.status === 0 ? result.stdout.trim() : null;
    });
    if (target === null) return answer(null, "commit or ref unavailable");
    const build = await stage("build", (options) => objectId(buildCommit, options));
    if (build === null) return answer(null, "build commit unavailable in repo");
    const result = await stage("ancestry", (options) =>
      runGit(["merge-base", "--is-ancestor", target, build], options),
    );
    if (result.status === 0) return answer(true, "ancestor of build");
    if (result.status === 1) {
      const shallow = await stage("shallow", (options) =>
        runGit(["rev-parse", "--is-shallow-repository"], options),
      );
      if (shallow.status === 0 && shallow.stdout.trim() === "false") {
        return answer(false, "not ancestor of build");
      }
      return answer(null, "ancestry incomplete or unavailable");
    }
    return answer(null, "git ancestry check failed");
  } catch (error) {
    // Error messages can contain server bodies, credentials or git output.
    return answer(
      null,
      error?.name === "TimeoutError" ? `${currentStage} timed out` : `${currentStage} unavailable`,
    );
  }
}

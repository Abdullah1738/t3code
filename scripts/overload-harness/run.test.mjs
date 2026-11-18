import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

it.each([false, true])(
  "keeps the process alive through unref'd cleanup (failure=%s)",
  async (failure) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "overload-runner-"));
    const loader = NodePath.join(directory, "loader.mjs");
    const runner = NodeURL.fileURLToPath(new URL("./run.mjs", import.meta.url));
    const harness = new URL("../../apps/server/scripts/overload-harness.ts", import.meta.url).href;
    try {
      await NodeFSP.writeFile(
        loader,
        `
      import { registerHooks } from 'node:module';
      registerHooks({ load(url, context, next) {
        if (url !== ${JSON.stringify(harness)}) return next(url, context);
        return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
          await new Promise(resolve => setImmediate(resolve).unref());
          ${failure ? "throw new Error('fixture cleanup failed');" : "process.stdout.write('cleanup finished');"}
        `)} };
      }});
    `,
      );
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        ["--import", loader, runner, `--out=${directory}`],
        {
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(failure ? 1 : 0);
      expect(result.stderr).not.toContain("unsettled top-level await");
      if (failure) expect(result.stderr).toContain("fixture cleanup failed");
      else expect(result.stdout).toBe("cleanup finished");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);

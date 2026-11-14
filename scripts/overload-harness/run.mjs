import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { profileMarkdown } from "./profile.mjs";
import * as NodeModule from "node:module";
import * as NodeCrypto from "node:crypto";

// Observe the real private queue without shipping a performance-only product API.
const needle = "const jobs = yield* Queue.unbounded<Job>();";
const probe = `${needle}\nObject.defineProperty(globalThis, '__overloadDispatcherQueue', { value: () => Effect.map(Queue.size(jobs), size => Math.max(0, size)), configurable: true });`;
globalThis.__overloadProbeHash = NodeCrypto.createHash("sha256").update(probe).digest("hex");
NodeModule.registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith("/ardud/kanban/engine/KanbanService.ts")) return loaded;
    const source =
      typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
    if (source.split(needle).length !== 2)
      throw new Error("Dispatcher queue probe no longer matches this revision");
    return { ...loaded, source: source.replace(needle, probe) };
  },
});
await import("../../apps/server/scripts/overload-harness.ts");

const destination =
  process.argv.find((arg) => arg.startsWith("--out="))?.slice(6) ?? "overload-result";
const profilePath = NodePath.join(destination, "middle.cpuprofile");
try {
  const profile = JSON.parse(await NodeFSP.readFile(profilePath, "utf8"));
  await NodeFSP.writeFile(
    NodePath.join(destination, "profile-shares.md"),
    profileMarkdown(profile),
  );
} catch (cause) {
  if (cause?.code !== "ENOENT") throw cause;
}

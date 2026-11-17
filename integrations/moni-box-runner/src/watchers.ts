import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { opaqueId } from "../../spectrum-bridge/src/remote-protocol.ts";
import type { BoxRunner } from "./runner.ts";

export type BoxWatch = { id: string; interval: number; check: string; context: string; expiresAt: number; maxFires: number };
const valid = (id: string) => /^[a-z0-9][a-z0-9-]{0,79}$/.test(id);
function save(path: string, value: unknown) {
  const tmp = `${path}.new`; writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); renameSync(tmp, path);
}
export class BoxWatchers {
  private busy = false;
  private readonly root: string;
  constructor(private readonly runner: BoxRunner, private readonly check: (watch: BoxWatch, run: string, ok: string, dir: string, retry: boolean) => Promise<{ code: number; stdout: string }> = boxCheck) {
    this.root = join(runner.config.root, "watchers"); mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  add(watch: BoxWatch) {
    if (!valid(watch.id) || !Number.isFinite(watch.interval) || watch.interval < 5 || watch.interval > 86400 || !Number.isFinite(watch.expiresAt)
      || watch.expiresAt <= this.runner.now() || typeof watch.check !== "string" || !watch.check || typeof watch.context !== "string"
      || !Number.isSafeInteger(watch.maxFires) || watch.maxFires < 0) throw new Error("Invalid watcher");
    const dir = join(this.root, watch.id); mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Never prime: existing wa new cursors and outboxes are adopted unchanged.
    save(join(dir, "watcher.json"), watch);
  }
  remove(id: string) {
    if (!valid(id)) throw new Error("Invalid watcher");
    const file = join(this.root, id, "disabled"); writeFileSync(file, "true", { mode: 0o600 });
  }
  async tick() {
    if (this.busy || !this.runner.active()) return;
    this.busy = true;
    try {
      for (const id of readdirSync(this.root).sort()) {
        const dir = join(this.root, id);
        if (!valid(id) || existsSync(join(dir, "disabled"))) continue;
        const watch: BoxWatch = JSON.parse(readFileSync(join(dir, "watcher.json"), "utf8"));
        const statePath = join(dir, "state.json");
        const state: { next: number; fires: number; run?: string; ok?: string; output?: string } = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { next: 0, fires: 0 };
        if (state.next > this.runner.now() || watch.expiresAt <= this.runner.now() || watch.maxFires && state.fires >= watch.maxFires) continue;
        if (!this.runner.active()) return;
        const retry = state.run !== undefined;
        state.run ??= opaqueId(`${id}:${this.runner.now()}`); save(statePath, state);
        try {
          if (state.output === undefined) {
            const result = await this.check(watch, state.run, state.ok ?? "", dir, retry);
            if (result.code !== 0) throw new Error("Watcher check failed");
            state.output = result.stdout; save(statePath, state);
          }
          if (!this.runner.active() || existsSync(join(dir, "disabled"))) continue;
          if (state.output.trim()) {
            this.runner.enqueue(opaqueId(`watch:${id}:${state.run}`), { text: `[Watcher ${id}, not typed by Moni.]\n${state.output}\nContext: ${watch.context}` });
            state.fires++;
          }
          writeFileSync(join(dir, ".run-ok"), state.run, { mode: 0o600 });
          state.ok = state.run; delete state.run; delete state.output;
          state.next = this.runner.now() + watch.interval * 1000;
        } catch { state.next = this.runner.now() + Math.max(watch.interval, 60) * 1000; }
        save(statePath, state);
      }
    } finally { this.busy = false; }
  }
}
async function boxCheck(watch: BoxWatch, run: string, ok: string, dir: string, retry: boolean) {
  const child = Bun.spawn(["/bin/bash", "-c", watch.check], { env: { HOME: process.env.HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`,
    PATH: `${process.env.HOME}/person/bin:${process.env.PATH}`, WATCH_DIR: dir, WATCH_ID: watch.id, WATCH_RUN: run, WATCH_OK: ok, WA_RETRY: retry ? "1" : "0" },
    stdout: "pipe", stderr: "ignore", timeout: 60_000, killSignal: "SIGKILL" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, code };
}

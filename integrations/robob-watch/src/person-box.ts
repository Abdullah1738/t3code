import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function assertMacWatcher(chat: unknown, configFile = process.env.SPECTRUM_BRIDGE_CONFIG ?? join(homedir(), ".config/spectrum-bridge/config.json")): void {
  if (chat !== "moni") return;
  let config;
  try { config = JSON.parse(readFileSync(configFile, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Cannot verify Moni watcher destination"); }
  if (config.chatBackends?.moni?.kind === "remote-box") throw new Error("Moni watchers run on her box. Use moni-agent watch there.");
}

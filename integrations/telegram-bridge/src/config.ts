import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const stateRoot = join(homedir(), ".config/telegram-bridge");
export const skillPath = join(homedir(), ".config/opencode/skills/telegram-notifications/SKILL.md");
// Read-only status of the conversation router, used to defer its in-chat attention.
export const spectrumBridgeSocket = join(homedir(), ".config/spectrum-bridge/bridge.sock");
export interface Config {
  owner: string;
  timezone: string;
  enabled: boolean;
}

export async function loadConfig(): Promise<Config> {
  const directory = await lstat(stateRoot);
  const credentials = await lstat(join(stateRoot, "credentials.env"));
  const uid = process.getuid?.();
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077)
    || !credentials.isFile() || credentials.uid !== uid || (credentials.mode & 0o077)) {
    throw new Error("Private configuration permissions required");
  }
  const config = JSON.parse(await readFile(join(stateRoot, "config.json"), "utf8")) as Config;
  if ((config.owner !== "" && !/^\d{1,16}$/.test(config.owner)) || typeof config.enabled !== "boolean"
    || typeof config.timezone !== "string") throw new Error("Invalid bridge configuration");
  new Intl.DateTimeFormat("en-US", { timeZone: config.timezone });
  return config;
}

export async function backendConnection(): Promise<{ baseUrl: string; headers: Record<string, string> }> {
  const settings = JSON.parse(await readFile(join(homedir(), ".config/openchamber/settings.json"), "utf8"));
  const port = settings.desktopLocalPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OpenChamber local port unavailable");
  const token = settings.desktopLocalClientToken;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    headers: typeof token === "string" && token ? { Authorization: `Bearer ${token}` } : {},
  };
}

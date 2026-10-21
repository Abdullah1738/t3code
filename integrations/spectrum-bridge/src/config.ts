import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const stateRoot = join(homedir(), ".config/spectrum-bridge");
export const skillPath = join(homedir(), ".config/opencode/skills/imessage-notifications/SKILL.md");
export const alertSkillPath = join(homedir(), ".config/opencode/skills/telegram-notifications/SKILL.md");
// iMessage chats live in their own Robob project, outside the shared Chats root.
export const imessageChatRoot = join(homedir(), ".robob/imessage");
// Read-only lookup of telegram-delivered notifications for /notification references.
export const telegramBridgeSocket = join(homedir(), ".config/telegram-bridge/bridge.sock");
// Public tailnet URLs are assigned at runtime by publish.ts; only the local side is configured.
export const APPS_DEFAULTS = {
  appsRoot: join(homedir(), ".local/share/imessage-apps"),
  appsPort: 18791,
} as const;
export interface Config {
  owner: string;
  timezone: string;
  enabled: boolean;
  appsRoot: string;
  appsPort: number;
  /** "openchamber" (default) or "robob"; BRIDGE_BACKEND overrides it. */
  backend?: string;
  /** Registered Robob project root for iMessage chat folders. */
  robobChatRoot?: string;
  /** "photon" (default, the rollback) or "sendblue". */
  transport?: "photon" | "sendblue";
  /** Our Sendblue line number, required when transport is "sendblue". */
  sendblueNumber?: string;
  /** OpenRouter model for the tool-less scoped third-party responder (guest-responder.ts). */
  guestModel?: string;
  /** OpenRouter reasoning effort for that model (default medium). */
  guestEffort?: "minimal" | "low" | "medium" | "high";
}

export function transportKind(config: { transport?: unknown }): "photon" | "sendblue" {
  if (config.transport === undefined || config.transport === "photon") return "photon";
  if (config.transport === "sendblue") return "sendblue";
  throw new Error("Invalid bridge configuration");
}

/** Fills and validates the optional mini-app server fields. */
export function appsConfig(raw: Partial<Pick<Config, "appsRoot" | "appsPort">>): Pick<Config, "appsRoot" | "appsPort"> {
  const appsRoot = raw.appsRoot ?? APPS_DEFAULTS.appsRoot;
  const appsPort = raw.appsPort ?? APPS_DEFAULTS.appsPort;
  if (typeof appsRoot !== "string" || !isAbsolute(appsRoot) || !Number.isInteger(appsPort) || appsPort < 1 || appsPort > 65535) {
    throw new Error("Invalid bridge configuration");
  }
  return { appsRoot, appsPort };
}

/** Mini-app settings for the CLI, which cannot read the private bridge config. */
export async function loadAppsConfig(root = stateRoot): Promise<Pick<Config, "appsRoot" | "appsPort">> {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(await readFile(join(root, "config.json"), "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid bridge configuration");
  }
  return appsConfig({
    ...(raw.appsRoot === undefined ? {} : { appsRoot: raw.appsRoot as string }),
    ...(raw.appsPort === undefined ? {} : { appsPort: raw.appsPort as number }),
  });
}

export async function loadConfig(): Promise<Config> {
  const directory = await lstat(stateRoot);
  const credentials = await lstat(join(stateRoot, "credentials.env"));
  const uid = process.getuid?.();
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077)
    || !credentials.isFile() || credentials.uid !== uid || (credentials.mode & 0o077)) {
    throw new Error("Private configuration permissions required");
  }
  // A legacy fixed appsPublicUrl is dropped here so it never reaches the router.
  const { appsPublicUrl: _legacy, ...config } = JSON.parse(await readFile(join(stateRoot, "config.json"), "utf8")) as Config & { appsPublicUrl?: unknown };
  if (!/^\+[1-9]\d{6,14}$/.test(config.owner) || typeof config.enabled !== "boolean"
    || typeof config.timezone !== "string") throw new Error("Invalid bridge configuration");
  new Intl.DateTimeFormat("en-US", { timeZone: config.timezone });
  return { ...config, ...appsConfig(config) };
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

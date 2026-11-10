import { backendConnection, imessageChatRoot, telegramBridgeSocket } from "./config.ts";
import { OpenChamber, type ChatBackend } from "./openchamber.ts";
import { RobobBackend } from "./robob.ts";
import { firstTurnAlert, socketPost } from "./telegram-fallback.ts";

export type BackendKind = "openchamber" | "robob";

/**
 * BRIDGE_BACKEND picks the backend, then `backend` in config.json; OpenChamber
 * stays the default until cutover. Anything else is a configuration error
 * rather than a silent fallback.
 */
export function backendKind(env: Record<string, string | undefined> = process.env, config: { backend?: unknown } = {}): BackendKind {
  const value = env.BRIDGE_BACKEND?.trim() || (typeof config.backend === "string" ? config.backend : "") || "openchamber";
  if (value !== "openchamber" && value !== "robob") throw new Error("Invalid bridge backend");
  return value;
}

export async function createBackend(kind: BackendKind, config: { robobChatRoot?: unknown } = {}, env: Record<string, string | undefined> = process.env): Promise<ChatBackend> {
  if (kind === "robob") {
    const chatRoot = env.ROBOB_IMESSAGE_CHAT_ROOT?.trim()
      || (typeof config.robobChatRoot === "string" ? config.robobChatRoot : "") || imessageChatRoot;
    const alert = firstTurnAlert(socketPost(telegramBridgeSocket, 3_000));
    return new RobobBackend({ chatRoot, env, alert });
  }
  const connection = await backendConnection();
  return new OpenChamber(connection.baseUrl, connection.headers, { chatRoot: imessageChatRoot });
}

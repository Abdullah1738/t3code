import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatContext } from "./chats.ts";
import { isTapback } from "./group-gate.ts";
import type { NormalizedInbound, Photon } from "./photon.ts";
import type { Store } from "./store.ts";

export const FAILED_INBOUND_REPLAY_MAX_AGE_MS = 6 * 60 * 60_000;
export const FAILED_INBOUND_ALERT_MAX_AGE_MS = 48 * 60 * 60_000;

/** Receipt acknowledgement must not wait for a busy router or the agent's first turn. */
export async function acknowledgeReceived(store: Store, context: ChatContext, payload: unknown): Promise<void> {
  if (context.chat.kind !== "owner" && context.chat.slug !== "moni") return;
  return acknowledgeInput(store, payload, id => context.react(id, "👀"));
}

/** Photon supports named reactions only; emphasize is its receipt acknowledgement. */
export async function acknowledgePhoton(store: Store, photon: Pick<Photon, "react">, chatGuid: string, payload: unknown): Promise<void> {
  return acknowledgeInput(store, payload, id => photon.react(chatGuid, id, "emphasize", `receipt:${id}`));
}

async function acknowledgeInput(store: Store, payload: unknown, react: (id: string) => Promise<unknown>): Promise<void> {
  const input = payload as NormalizedInbound;
  if (input.source !== "typed" || isTapback(input.text) || store.get<boolean>(`eyes:${input.id}`)) return;
  await react(input.id);
  store.set(`eyes:${input.id}`, true);
}

export function criticalWake(id: string, text: string): boolean {
  return id.startsWith("wake:") && (/^\[Watcher event from robob-watch money-cases\b/.test(text)
    || /^\[Watcher event from robob-watch inbox-triage\b/.test(text) && /\[urgent\]|security|new (?:login|sign.in)|withdrawal/i.test(wakeEventLines(text).join("\n")));
}

function wakeEventLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const event = lines.findIndex(line => line.trim() === "Event:");
  const body = event < 0 ? lines.filter(line => !line.startsWith("[Watcher event")) : lines.slice(event + 1);
  const context = body.findIndex(line => line.startsWith("Context saved when this watcher was set up"));
  return (context < 0 ? body : body.slice(0, context)).filter(line => line.trim());
}

export function wakeEventPreview(text: string): string {
  return wakeEventLines(text).slice(0, 2).join("\n").slice(0, 3000);
}

/** Exception bodies can contain request URLs or credentials; keep the reason, never their secrets. */
export function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, "$1 [redacted]")
    .replace(/((?:token|password|secret|api[-_]?key|authorization)["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)|[^\s,;"']+)/gi, "$1[redacted]")
    .replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

export async function notifyFailedInbound(text: string, key: string): Promise<boolean> {
  const child = Bun.spawn([join(homedir(), ".bun/bin/bun"), join(homedir(), ".local/share/telegram-bridge/src/cli.ts"),
    "notify", "--source", "iMessage bridge", "--severity", "attention", "--text", text, "--key", key],
  { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, BUN_INSPECT: undefined } });
  const timer = setTimeout(() => child.kill(), 10_000);
  try { return await child.exited === 0; } finally { clearTimeout(timer); }
}

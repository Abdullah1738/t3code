import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { ChatInfo } from "./chats.ts";

export type AgentPair = {
  from: string; to: string; approval: "none";
  needsOwner?: ("install" | "download")[];
  answer?: "full";
  audience?: "group";
};
export type NotifyRule = { id: number; text: string };
export type AgentPolicy = { pairs: AgentPair[]; notify: NotifyRule[] };
export const defaultAgentPolicy = (): AgentPolicy => ({
  pairs: [
    { from: "moni", to: "owner", approval: "none", needsOwner: ["install", "download"] },
    { from: "owner", to: "moni", approval: "none", answer: "full" },
    { from: "group:*", to: "owner", approval: "none", audience: "group" },
    { from: "group:*", to: "moni", approval: "none", audience: "group" },
  ],
  notify: [],
});
export const agentPolicyPath = (accessPath: string) => join(dirname(accessPath), "agent-policy.json");
const slug = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const validNotifyText = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0 && value.length <= 2000 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
export const validNotifyId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function validPolicy(value: unknown): value is AgentPolicy {
  if (!record(value) || Object.keys(value).some(key => !["pairs", "notify"].includes(key))
    || !Array.isArray(value.pairs) || !Array.isArray(value.notify)) return false;
  const pairs = new Set<string>();
  for (const pair of value.pairs) {
    if (!record(pair) || Object.keys(pair).some(key => !["from", "to", "approval", "needsOwner", "answer", "audience"].includes(key))
      || !(slug(pair.from) || pair.from === "group:*") || !slug(pair.to) || pair.from === pair.to
      || pair.approval !== "none" || (pair.answer !== undefined && pair.answer !== "full")
      || (pair.audience !== undefined && pair.audience !== "group")) return false;
    if (pair.needsOwner !== undefined && (!Array.isArray(pair.needsOwner)
      || pair.needsOwner.some(item => item !== "install" && item !== "download")
      || new Set(pair.needsOwner).size !== pair.needsOwner.length)) return false;
    // A hand-edited policy must not silently remove the Mac install/download exception.
    if (pair.from === "moni" && pair.to === "owner"
      && (!Array.isArray(pair.needsOwner) || !pair.needsOwner.includes("install") || !pair.needsOwner.includes("download"))) return false;
    if (pair.from === "group:*" && pair.audience !== "group") return false;
    const key = JSON.stringify([pair.from, pair.to]);
    if (pairs.has(key)) return false;
    pairs.add(key);
  }
  const ids = new Set<number>();
  return value.notify.every(rule => {
    if (!record(rule) || Object.keys(rule).some(key => !["id", "text"].includes(key))
      || !validNotifyId(rule.id) || !validNotifyText(rule.text) || ids.has(rule.id)) return false;
    ids.add(rule.id);
    return true;
  });
}

export const matchingAgentPair = (policy: AgentPolicy, from: ChatInfo, to: ChatInfo) =>
  policy.pairs.find(pair => pair.to === to.slug && pair.from === from.slug)
  ?? policy.pairs.find(pair => pair.to === to.slug && pair.from === "group:*" && from.kind === "group");

export class AgentPolicyFile {
  private lastSource: string | undefined;
  private policy = defaultAgentPolicy();
  private invalid = false;

  constructor(private readonly path: string | undefined, private readonly log: (event: string, code?: string) => void) {
    this.read();
  }

  read(): AgentPolicy {
    let source = "missing";
    try { if (this.path) source = `file:${readFileSync(this.path, "utf8")}`; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") source = "unreadable";
    }
    if (source === this.lastSource) return this.policy;
    this.lastSource = source;
    this.invalid = false;
    try {
      const next: unknown = source === "missing" ? defaultAgentPolicy() : JSON.parse(source.slice(5));
      if (!validPolicy(next)) throw new Error("Invalid policy");
      this.policy = next;
    } catch {
      this.invalid = true;
      this.policy = defaultAgentPolicy();
      this.log("agent-policy-invalid");
    }
    this.log("agent-policy-loaded", `pairs=${this.policy.pairs.length} rules=${this.policy.notify.length}`);
    return this.policy;
  }

  edit(edit: { action: "add"; text: string } | { action: "rm"; id: number }): NotifyRule | undefined {
    const current = this.read();
    if (this.invalid) throw new Error("Repair agent-policy.json before editing notify rules");
    if (!this.path) throw new Error("Agent policy path unavailable");
    const found = edit.action === "add" ? current.notify.find(rule => rule.text === edit.text)
      : current.notify.find(rule => rule.id === edit.id);
    if (edit.action === "add" && found) return found;
    if (edit.action === "rm" && !found) return undefined;
    const rule = edit.action === "add"
      ? { id: Math.max(Date.now(), ...current.notify.map(rule => rule.id + 1)), text: edit.text }
      : found!;
    if (!validNotifyId(rule.id)) throw new Error("Notify rule id exhausted");
    const next = { ...current, notify: edit.action === "add" ? [...current.notify, rule] : current.notify.filter(item => item.id !== rule.id) };
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(tmp, this.path);
    } finally {
      try { unlinkSync(tmp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.read();
    this.log(edit.action === "add" ? "notify-rule-added" : "notify-rule-removed", `${rule.id}`);
    return rule;
  }
}

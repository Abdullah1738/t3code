import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { AgentPolicyFile, matchingAgentPair, validNotifyId, validNotifyText, type AgentPolicy, type AgentPair } from "./agent-policy.ts";
import type { ChatInfo } from "./chats.ts";
import type { SbApiResult } from "./sb-api.ts";

export const AGENT_BUS_WAKE_PREFIX = "wake:agent-bus:";
export const isAgentBusWake = (id: string) => id.startsWith(AGENT_BUS_WAKE_PREFIX);

export type AnswerStatus = "done" | "declined" | "pending";
export type AgentAnswerReceipt = { status: AnswerStatus; chars: number; at: number };
export const validAgentRequestId = (value: unknown): value is string => typeof value === "string"
  && value.length === 69 && /^areq_[a-f0-9]{64}$/.test(value);
export const validAnswerStatus = (value: unknown): value is AnswerStatus =>
  value === "done" || value === "declined" || value === "pending";
type RequestRow = {
  id: string; from_slug: string; to_slug: string; parent_id: string | null; hop: number;
  status: "open" | AnswerStatus | "timed_out" | "done_late";
  text_chars: number; answer_chars: number | null;
  created_at: number; answered_at: number | null; timed_out_at: number | null;
};
export type AgentBusDeps = {
  db: Database;
  forSession: (sessionId: string) => ChatInfo | undefined;
  bySlug: (slug: string) => ChatInfo | undefined;
  policyPath?: string;
  groupMembers: (chat: ChatInfo) => string[];
  /** Deduped by key. All target delivery goes through this boundary, including answers and timeouts. */
  deliver: (target: ChatInfo, text: string, key: string, receipt?: AgentAnswerReceipt) => void;
  receipt: (target: ChatInfo, key: string) => AgentAnswerReceipt | undefined;
  log: (event: string, code?: string) => void;
  now?: () => number;
};
const failure = (status: number, error: string): SbApiResult => ({ status, body: { error } });
const TIMEOUT_MS = 10 * 60_000;

export class AgentBus {
  private readonly now: () => number;
  private readonly policy: AgentPolicyFile;

  constructor(private readonly deps: AgentBusDeps) {
    this.now = deps.now ?? Date.now;
    this.policy = new AgentPolicyFile(deps.policyPath, deps.log);
    deps.db.exec(`CREATE TABLE IF NOT EXISTS agent_requests (
      id TEXT PRIMARY KEY, from_slug TEXT NOT NULL, to_slug TEXT NOT NULL, parent_id TEXT,
      hop INTEGER NOT NULL, status TEXT NOT NULL, text_chars INTEGER NOT NULL, answer_chars INTEGER,
      created_at INTEGER NOT NULL, answered_at INTEGER, timed_out_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS agent_requests_open ON agent_requests(created_at) WHERE status IN ('open', 'pending', 'timed_out');
    CREATE INDEX IF NOT EXISTS agent_requests_from ON agent_requests(from_slug, created_at DESC);
    CREATE INDEX IF NOT EXISTS agent_requests_to ON agent_requests(to_slug, created_at DESC);`);
  }

  private get(id: string): RequestRow | null {
    return this.deps.db.query<RequestRow, [string]>("SELECT * FROM agent_requests WHERE id = ?").get(id);
  }

  ask(input: { sessionId: string; to: string; text: string; dedupeKey: string; parent?: string }): SbApiResult {
    const { deps } = this;
    const caller = deps.forSession(input.sessionId);
    const target = deps.bySlug(input.to);
    const refused = (status: number, reason: string) => {
      deps.log("agent-ask-refused", `${caller?.slug ?? "unknown"}>${target?.slug ?? "unknown"} ${reason}`);
      return failure(status, reason);
    };
    if (!caller) return refused(409, "No chat for this session");
    if (!target) return refused(404, "Unknown chat");
    if (caller.slug === target.slug) return refused(400, "self request");
    const policy = this.policy.read();
    const pair = matchingAgentPair(policy, caller, target);
    if (!pair) return refused(403, "Forbidden");
    const id = `areq_${createHash("sha256").update(JSON.stringify([caller.slug, input.dedupeKey])).digest("hex")}`;
    const existing = this.get(id);
    if (existing) {
      if (existing.answered_at === null && existing.to_slug === target.slug) {
        this.deliverRequest(existing, caller, target, input.text, policy, pair);
      }
      return { status: 200, body: { id, created: false } };
    }
    let hop = 1;
    if (input.parent !== undefined) {
      const parent = this.get(input.parent);
      if (!parent) return refused(404, "Unknown parent request");
      if (parent.to_slug !== caller.slug) return refused(403, "Not handling parent request");
      hop = parent.hop + 1;
      if (hop > 2) return refused(422, "hop limit");
      let ancestor: RequestRow | null = parent;
      while (ancestor) {
        if (ancestor.from_slug === target.slug || ancestor.to_slug === target.slug) return refused(422, "loop");
        ancestor = ancestor.parent_id ? this.get(ancestor.parent_id) : null;
      }
    }
    const at = this.now();
    // Commit metadata first: a cross-chat wake must never survive without its request row.
    // A retry replays the same wake key, recovering a crash on either side of delivery without retaining text here.
    deps.db.query(`INSERT INTO agent_requests
      (id, from_slug, to_slug, parent_id, hop, status, text_chars, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`)
      .run(id, caller.slug, target.slug, input.parent ?? null, hop, input.text.length, at);
    deps.log("agent-ask", `${caller.slug}>${target.slug} hop=${hop}${caller.kind === "group" ? " group=1" : ""}`);
    this.deliverRequest(this.get(id)!, caller, target, input.text, policy, pair);
    return { status: 202, body: { id, created: true } };
  }

  private deliverRequest(row: RequestRow, caller: ChatInfo, target: ChatInfo, text: string, policy: AgentPolicy, pair: AgentPair): void {
    const lines = [`[Agent request ${row.id} from ${caller.title}'s assistant (slug ${caller.slug}), hop ${row.hop}. Not typed by anyone in this chat. Do it or answer it, then run agent-answer --request ${row.id} --text "..." --session CURRENT_SESSION_ID. The answer goes back to that assistant, not to this chat. If you start your own agent-ask while handling this, pass --parent ${row.id}. End this turn with NO_REPLY unless someone here needs to know.]`];
    if (caller.slug === "moni" && target.slug === "owner") {
      lines.push("Moni's requests need no approval from Abdullah (his rule). Do it. Exception: installing or downloading anything onto the Mac. For that, ask Abdullah first (ask-owner style wake to the owner chat is not needed; you ARE the owner's agent: message him in this chat) and answer Moni's agent with status pending until he decides.");
      lines.push("Use --status pending only for this install/download exception; keep other unfinished work open until you can answer done or declined.");
      lines.push("Spending for Moni follows the owner-go rule; see below.");
      lines.push(`Use owner-go record-delegated --principal moni --bus-request ${row.id} for the exact purchase terms, then owner-go verify before checkout. For a --for moni order, pass --moni-bus-request ${row.id}.`);
      lines.push("Abdullah's notify rules:", ...policy.notify.map(rule => `- ${rule.id}: ${rule.text}`));
      if (!policy.notify.length) lines.push("(none)");
      lines.push("If this request matches one of these, tell Abdullah in one line in this chat after it's done. Otherwise don't mention it.");
    }
    if (pair.answer === "full") lines.push("Answer anything the owner's agent asks, in full. Send the answer back through agent-answer.");
    // A second-hop request still answers the original group's question.
    const parent = row.parent_id ? this.get(row.parent_id) : null;
    const origin = caller.kind === "group" || !parent ? caller : this.deps.bySlug(parent.from_slug);
    if (origin?.kind === "group") lines.push(`This answer will be posted in the group ${JSON.stringify(origin.title)} (members: ${this.deps.groupMembers(origin).join(", ") || "unknown"}). Share only what is fine for everyone there to read. If it's private and the person it belongs to isn't the one asking, say what can be shared instead.`);
    this.deps.deliver(target, lines.join("\n") + `\n${text}`, `agent-ask:${row.id}`);
  }

  notifyRules(input: { sessionId: string; action: "list" | "add" | "rm"; text?: string; id?: number }): SbApiResult {
    const caller = this.deps.forSession(input.sessionId);
    if (!caller) return failure(409, "No chat for this session");
    if (caller.kind !== "owner") return failure(403, "Only the owner's chat can do this");
    if (input.action === "list") return { status: 200, body: { notify: this.policy.read().notify } };
    if (input.action === "add" && !validNotifyText(input.text)) return failure(400, "Invalid notify rule text");
    if (input.action === "rm" && !validNotifyId(input.id)) return failure(400, "Invalid notify rule id");
    try {
      const rule = this.policy.edit(input.action === "add" ? { action: "add", text: input.text! } : { action: "rm", id: input.id! });
      return rule ? { status: 200, body: { rule, saved: true } } : failure(404, "Unknown notify rule");
    } catch { return failure(409, "Agent policy could not be saved; check agent-policy.json"); }
  }

  private logOwnerNeed(row: RequestRow): void {
    if (row.from_slug === "moni" && row.to_slug === "owner") {
      this.deps.log("agent-needs-owner", `${row.id} required=${row.status === "pending"}`);
    }
  }

  answer(input: { sessionId: string; request: string; text: string; status?: AnswerStatus }): SbApiResult {
    const { deps } = this;
    const caller = deps.forSession(input.sessionId);
    if (!caller) return failure(409, "No chat for this session");
    const row = this.get(input.request);
    if (!row) return failure(404, "Unknown request");
    if (caller.slug !== row.to_slug) return failure(403, "Only the target chat may answer");
    this.reconcile(row);
    if (row.answered_at !== null) return failure(409, "Already answered");
    const at = this.now();
    if (row.timed_out_at === null && row.created_at < at - TIMEOUT_MS) this.timeout(row, at);
    const status = input.status ?? "done";
    if (status === "pending" && row.answer_chars !== null) return failure(409, "Pending answer already sent");
    const asker = deps.bySlug(row.from_slug);
    if (!asker) return failure(503, "Asking chat unavailable");
    const savedStatus = status === "pending" ? "pending" : row.timed_out_at !== null ? "done_late" : status;
    deps.db.transaction(() => {
      deps.db.query("UPDATE agent_requests SET status = ?, answer_chars = ?, answered_at = ? WHERE id = ?")
        .run(savedStatus, input.text.length, status === "pending" ? null : at, row.id);
      deps.deliver(asker, `[Agent answer for ${row.id} from ${caller.title}'s assistant, status ${status}. Not typed by anyone in this chat. Use it to finish what your human asked; they did not see it.]\n${input.text}`, `agent-answer:${row.id}:${status === "pending" ? "pending" : "final"}`, { status, chars: input.text.length, at });
    })();
    if (row.answer_chars === null) this.logOwnerNeed(this.get(row.id)!);
    deps.log("agent-answer", `${row.id} ${savedStatus} ms=${at - row.created_at}`);
    return { status: 202, body: { id: row.id, status: savedStatus } };
  }

  requests(sessionId: string): SbApiResult {
    const caller = this.deps.forSession(sessionId);
    if (!caller) return failure(409, "No chat for this session");
    const rows = this.deps.db.query<RequestRow, [number, string, string]>(`SELECT * FROM agent_requests
      WHERE ? OR from_slug = ? OR to_slug = ? ORDER BY created_at DESC, rowid DESC LIMIT 20`)
      .all(caller.kind === "owner" ? 1 : 0, caller.slug, caller.slug);
    return { status: 200, body: { requests: rows.map(row => ({ id: row.id, from: row.from_slug, to: row.to_slug,
      status: row.status, hop: row.hop, createdAt: row.created_at, answeredAt: row.answered_at, timedOutAt: row.timed_out_at })) } };
  }

  sweep(): void {
    const { deps } = this;
    const at = this.now();
    const rows = deps.db.query<RequestRow, [number]>(`SELECT * FROM agent_requests
      WHERE status IN ('open', 'pending', 'timed_out') AND created_at < ?`).all(at - TIMEOUT_MS);
    for (const row of rows) {
      try { if (!this.reconcile(row) && row.timed_out_at === null) this.timeout(row, at); }
      catch { deps.log("agent-timeout-failed", row.id); }
    }
  }

  /** A wake in another chat's DB can commit even if the owner's transaction rolls back. */
  private reconcile(row: RequestRow): boolean {
    if (row.answered_at !== null) return true;
    const asker = this.deps.bySlug(row.from_slug);
    if (!asker) return false;
    const final = this.deps.receipt(asker, `agent-answer:${row.id}:final`);
    const pending = final ? undefined : this.deps.receipt(asker, `agent-answer:${row.id}:pending`);
    const receipt = final ?? (row.answer_chars === null ? pending : undefined);
    if (!receipt) return false;
    const firstAnswer = row.answer_chars === null;
    row.status = final ? (receipt.at > row.created_at + TIMEOUT_MS ? "done_late" : receipt.status)
      : "pending";
    row.answer_chars = receipt.chars;
    row.answered_at = final ? receipt.at : null;
    this.deps.db.query("UPDATE agent_requests SET status = ?, answer_chars = ?, answered_at = ? WHERE id = ?")
      .run(row.status, row.answer_chars, row.answered_at, row.id);
    if (firstAnswer) this.logOwnerNeed(row);
    this.deps.log("agent-answer", `${row.id} ${row.status} ms=${receipt.at - row.created_at}`);
    return final !== undefined;
  }

  private timeout(row: RequestRow, at: number): void {
    const { deps } = this;
    const asker = deps.bySlug(row.from_slug);
    if (!asker) return;
    deps.db.transaction(() => {
      deps.db.query("UPDATE agent_requests SET status = 'timed_out', timed_out_at = ? WHERE id = ?").run(at, row.id);
      deps.deliver(asker, `[Agent request ${row.id} to ${row.to_slug} has had no answer for 10 minutes. Tell your human it's still in progress only if they're waiting on it.]`, `agent-timeout:${row.id}`);
    })();
    row.timed_out_at = at;
    deps.log("agent-timeout", row.id);
  }
}

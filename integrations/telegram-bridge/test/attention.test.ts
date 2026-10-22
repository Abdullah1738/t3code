import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Attention, type AttentionOptions } from "../src/attention.ts";
import { callbackToken, sessionNoticeId, Store, type SessionNotice } from "../src/store.ts";
import { OpenChamber, type BoardSnapshot, type JsonValue, type PermissionRequest, type QuestionRequest, type SessionRecord, type SessionStatus } from "../src/openchamber.ts";

const now = Date.parse("2026-09-10T12:00:00Z");
const stores: Store[] = [];
const servers: Server[] = [];
const directories: string[] = [];

class FakeBackend extends OpenChamber {
  board: BoardSnapshot | undefined;
  permissionRequests: PermissionRequest[] = [];
  questionRequests: QuestionRequest[] = [];
  sessions = new Map<string, SessionRecord>();
  /** Running sessions only, as `GET /api/session/active` reports them. */
  sessionStatuses: Record<string, SessionStatus> = {};
  autoAccepting: boolean | undefined = false;
  readonly permissionReplies: Array<[string, string, "once" | "reject"]> = [];
  readonly questionReplies: Array<[string, string, string[][]]> = [];
  failReplies = false;
  permissionReads = 0;
  questionReads = 0;

  constructor() { super("http://127.0.0.1:1"); }

  override async sessionBoard(): Promise<BoardSnapshot> { return this.board!; }
  override async permissions(): Promise<PermissionRequest[]> { this.permissionReads++; return [...this.permissionRequests]; }
  override async questions(): Promise<QuestionRequest[]> { this.questionReads++; return [...this.questionRequests]; }
  override async statuses(): Promise<Record<string, SessionStatus>> { return { ...this.sessionStatuses }; }
  override async getSession(id: string): Promise<SessionRecord> {
    const session = this.sessions.get(id);
    if (!session || session.id !== id) throw new Error("missing");
    return session;
  }
  override async isSessionAutoAccepting(): Promise<boolean | undefined> { return this.autoAccepting; }
  override async permissionReply(_sessionId: string, id: string, _directory: string, reply: "once" | "reject"): Promise<boolean> {
    if (this.failReplies) throw new Error("PRIVATE_FAILURE");
    this.permissionReplies.push([id, "/Chats", reply]);
    this.permissionRequests = this.permissionRequests.filter(request => request.id !== id);
    return true;
  }
  override async questionReply(request: QuestionRequest, _directory: string, answers: string[][]): Promise<boolean> {
    if (this.failReplies) throw new Error("PRIVATE_FAILURE");
    this.questionReplies.push([request.id, "/Chats", answers]);
    this.questionRequests = this.questionRequests.filter(candidate => candidate.id !== request.id);
    return true;
  }
}

type Edit = { chatId: number; messageId: number; text: string; keyboard?: unknown };

function setup(spectrumSocket = "/nonexistent/router.sock", path = ":memory:") {
  setSystemTime(now);
  const store = new Store(path);
  stores.push(store);
  const backend = new FakeBackend();
  backend.sessions.set("ses_1", { id: "ses_1", directory: "/Chats", title: "  Deployment\nreview  ", time: { created: now, updated: now } });
  const edits: Edit[] = [];
  const answers: Array<[string, string | undefined]> = [];
  const transport = {
    async editMessageText(chatId: number, messageId: number, text: string, keyboard?: unknown) {
      edits.push({ chatId, messageId, text, keyboard });
      if (chatId === -1) throw new Error("PRIVATE_TRANSPORT_FAILURE");
    },
    async answerCallback(callbackId: string, text?: string) {
      answers.push([callbackId, text]);
      if (callbackId === "bad") throw new Error("PRIVATE_TRANSPORT_FAILURE");
    },
  };
  const state = { chat: 100 as number | undefined };
  const options: AttentionOptions = { chatId: () => state.chat, spectrumSocket };
  const attention = new Attention(store, backend, transport, options);
  const message = (messageId: number, text: string, replyToMessageId?: number) => ({ type: "message" as const, messageId, chatId: 100, fromUserId: 7, text, ...(replyToMessageId !== undefined ? { replyToMessageId } : {}) });
  const callback = (messageId: number, data: string, callbackId = "cb") =>
    ({ type: "callback" as const, callbackId, chatId: 100, messageId, fromUserId: 7, data });
  return { store, backend, transport, edits, answers, state, attention, message, callback };
}

async function spectrumResponder(status: unknown): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "attention-spectrum-"));
  directories.push(directory);
  const path = join(directory, "router.sock");
  const server = createServer((request, response) => {
    expect(request.url).toBe("/router");
    response.end(JSON.stringify(status));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return path;
}

beforeEach(() => { setSystemTime(now); });
afterEach(async () => {
  setSystemTime();
  for (const store of stores.splice(0)) store.close();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const permission = (): PermissionRequest => ({
  id: "perm_1", sessionID: "ses_1", action: "bash", resources: ["rm -rf *"],
  metadata: {}, save: [],
});

const question = (custom = true, multiple = false): QuestionRequest => ({
  id: "q_1", sessionID: "ses_1", title: "Questions",
  questions: [{ key: "q0", question: "Proceed?", header: "Choice", multiple, custom,
    options: [{ label: "A", value: "A", description: "first" }, { label: "B", value: "B", description: "second" }] }],
});

// OpenCode 2 wire events from `/api/event`: `{ id, type, created, location, data }`.
const wire = (type: string, data: { [key: string]: JsonValue }, directory: string | undefined = "/Chats"): JsonValue => ({
  id: `evt_${type}`, type, created: now, ...(directory ? { location: { directory } } : {}), data,
});

const askedEvent = (kind: "question" | "approval", requestId: string, sessionId = "ses_1") => kind === "approval"
  ? wire("permission.asked", { id: requestId, sessionID: sessionId, action: "bash", resources: [] })
  : wire("form.created", { form: { id: requestId, sessionID: sessionId, title: "Questions", fields: [] } });

const resolvedEvent = (kind: "question" | "approval", requestId: string, sessionId = "ses_1") => kind === "approval"
  ? wire("permission.replied", { sessionID: sessionId, requestID: requestId, reply: "once" })
  : wire("form.replied", { id: requestId, sessionID: sessionId, answer: {} });

const statusEvent = (status: "busy" | "idle", sessionId = "ses_1") =>
  wire(status === "busy" ? "session.execution.started" : "session.execution.succeeded", { sessionID: sessionId });

async function promptFor(attention: Attention, backend: FakeBackend, request: PermissionRequest | QuestionRequest, kind: "approval" | "question") {
  attention.processEvent(askedEvent(kind, request.id));
  // 20s clears the 5s delay and the 15s auto-accept grace.
  setSystemTime(now + 20_000);
  await attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", kind, request.id);
  return { id, notice: attention["store" as never] as never, operation: undefined as never };
}

test("asked permission prompts with approve/reject buttons after the delay", async () => {
  const h = setup();
  h.backend.permissionRequests = [permission()];
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  // Fresh requests are held for the 5s attention delay.
  setSystemTime(now + 4_000);
  await h.attention.tick();
  expect(h.store.pendingOutbox()).toEqual([]);
  setSystemTime(now + 6_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "approval", "perm_1");
  const op = h.store.getOperation(id);
  expect(op).toMatchObject({ id, kind: "control", state: "pending" });
  expect(op?.text).toContain("[OpenChamber] Deployment review needs your approval.");
  expect(op?.text).toContain("Permission perm_1: bash");
  expect(op?.text).toContain("rm -rf *");
  expect(op?.text).toContain("Tap Approve once or Reject.");
  const token = callbackToken(id);
  expect(op?.keyboard).toEqual({ rows: [[{ text: "Approve once", data: `a:${token}:once` }, { text: "Reject", data: `a:${token}:reject` }]] });
  expect(h.store.get<string>(`callback:${token}`)).toBe(id);
  expect(h.store.get<string>("request-notice:perm_1")).toBe(id);
  const notice = h.store.sessionNotice(id);
  expect(notice).toMatchObject({ state: "queued", signature: expect.any(String) });
  await expect(h.attention.beforeSend({ id })).resolves.toBe("send");
  // Simulate delivery, then the notice is sent and interactive.
  h.store.outboxState(id, "sent", 901);
  await h.attention.tick();
  expect(h.store.sessionNotice(id)?.state).toBe("sent");
});

test("auto-accepting sessions hold prompts through the grace window, then surface them", async () => {
  const h = setup();
  h.backend.autoAccepting = true;
  h.backend.permissionRequests = [permission()];
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  setSystemTime(now + 10_000);
  await h.attention.tick();
  expect(h.store.pendingOutbox()).toEqual([]);
  setSystemTime(now + 20_000);
  await h.attention.tick();
  expect(h.store.getOperation(sessionNoticeId("/Chats", "ses_1", "approval", "perm_1"))).toMatchObject({ state: "pending" });
});

test("router-owned requests stay silent on Telegram while the iMessage chat owns them", async () => {
  const owned = await spectrumResponder({
    route: { id: "ses_1", directory: "/Chats", generation: 1 },
    pending: [{ id: "perm_1", kind: "permission", state: "pending", operationState: "sent" }],
  });
  const h = setup(owned);
  h.backend.permissionRequests = [permission()];
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  expect(h.store.pendingOutbox()).toEqual([]);
  await expect(h.attention.beforeSend({ id: sessionNoticeId("/Chats", "ses_1", "approval", "perm_1") })).resolves.toBe("wait");
  // Ownership requires the same route id; a different session frees it.
  const otherRoute = await spectrumResponder({
    route: { id: "ses_2", directory: "/Chats", generation: 1 },
    pending: [{ id: "perm_1", kind: "permission", state: "pending", operationState: "sent" }],
  });
  const other = setup(otherRoute);
  other.backend.permissionRequests = [permission()];
  other.attention.processEvent(askedEvent("approval", "perm_1"));
  setSystemTime(now + 20_000);
  await other.attention.tick();
  expect(other.store.pendingOutbox().map(op => op.kind)).toEqual(["control"]);
});

test("the iMessage router also owns requests it names for a subagent session", async () => {
  const child = await spectrumResponder({
    route: { id: "ses_parent", directory: "/Chats", generation: 1 },
    pending: [{ id: "perm_1", kind: "permission", state: "pending", operationState: "pending", sessionId: "ses_1", directory: "/Chats" }],
  });
  const h = setup(child);
  h.backend.permissionRequests = [permission()];
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  expect(h.store.pendingOutbox()).toEqual([]);
  // A differently named session does not transfer ownership.
  const elsewhere = await spectrumResponder({
    route: { id: "ses_1", directory: "/Chats", generation: 1 },
    pending: [{ id: "perm_1", kind: "permission", state: "pending", operationState: "sent", sessionId: "ses_other", directory: "/Chats" }],
  });
  const other = setup(elsewhere);
  other.backend.permissionRequests = [permission()];
  other.attention.processEvent(askedEvent("approval", "perm_1"));
  setSystemTime(now + 20_000);
  await other.attention.tick();
  expect(other.store.pendingOutbox().map(op => op.kind)).toEqual(["control"]);
});

test("expired router states and answered operations release ownership", async () => {
  const status = await spectrumResponder({
    route: { id: "ses_1", directory: "/Chats", generation: 1 },
    pending: [{ id: "perm_1", kind: "permission", state: "answered", operationState: "sent" },
      { id: "q_1", kind: "question", state: "pending", operationState: "failed" }],
  });
  const h = setup(status);
  h.backend.permissionRequests = [permission()];
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "approval", "perm_1");
  expect(h.store.getOperation(id)).toMatchObject({ state: "pending" });
});

test("tapping Approve once answers once, marks the notice, and retires the buttons", async () => {
  const h = setup();
  h.backend.permissionRequests = [permission()];
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "approval", "perm_1");
  h.store.outboxState(id, "sent", 901);
  await h.attention.tick();
  const token = callbackToken(id);
  await h.attention.handleUpdate(h.callback(901, `a:${token}:once`));
  expect(h.backend.permissionReplies).toEqual([["perm_1", "/Chats", "once"]]);
  expect(h.store.sessionNotice(id)?.state).toBe("answered");
  expect(h.answers).toEqual([["cb", "Approved once."]]);
  expect(h.edits).toEqual([{ chatId: 100, messageId: 901,
    text: `${h.store.getOperation(id)!.text}\n\n[Approved once]`, keyboard: { remove: true } }]);
  // Replaying the same tap cannot reply twice.
  await h.attention.handleUpdate(h.callback(901, `a:${token}:once`));
  expect(h.backend.permissionReplies).toHaveLength(1);
  expect(h.answers.at(-1)).toEqual(["cb", "This prompt already resolved."]);
});

test("tapping Reject answers reject; transport failures keep the prompt actionable", async () => {
  const h = setup();
  h.backend.permissionRequests = [permission()];
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "approval", "perm_1");
  h.store.outboxState(id, "sent", 901);
  await h.attention.tick();
  const token = callbackToken(id);
  h.backend.failReplies = true;
  await h.attention.handleUpdate(h.callback(901, `a:${token}:reject`));
  expect(h.backend.permissionReplies).toEqual([]);
  expect(h.answers).toEqual([["cb", "The reply failed; try again."]]);
  expect(h.store.sessionNotice(id)?.state).toBe("sent");
  h.backend.failReplies = false;
  await h.attention.handleUpdate(h.callback(901, `a:${token}:reject`));
  expect(h.backend.permissionReplies).toEqual([["perm_1", "/Chats", "reject"]]);
  expect(h.edits).toEqual([{ chatId: 100, messageId: 901,
    text: `${h.store.getOperation(id)!.text}\n\n[Rejected]`, keyboard: { remove: true } }]);
});

test("buttons only work on the message that carried them and unknown tokens expire", async () => {
  const h = setup();
  h.backend.permissionRequests = [permission()];
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "approval", "perm_1");
  h.store.outboxState(id, "sent", 901);
  await h.attention.tick();
  const token = callbackToken(id);
  await h.attention.handleUpdate(h.callback(999, `a:${token}:once`));
  expect(h.backend.permissionReplies).toEqual([]);
  expect(h.answers).toEqual([["cb", "This prompt expired."]]);
  await h.attention.handleUpdate(h.callback(901, "a:ffffffffffffffff:once"));
  expect(h.answers.at(-1)).toEqual(["cb", "This prompt expired."]);
  await h.attention.handleUpdate(h.callback(901, "x" + token.slice(1)));
  expect(h.answers.at(-1)).toEqual(["cb", "This prompt expired."]);
  expect(h.store.sessionNotice(id)?.state).toBe("sent");
});

test("single-choice questions answer immediately from a tap", async () => {
  const h = setup();
  h.backend.questionRequests = [question()];
  h.attention.processEvent(askedEvent("question", "q_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "question", "q_1");
  const op = h.store.getOperation(id);
  expect(op?.text).toContain("Question q_1:");
  expect(op?.text).toContain("Reply to this message with your own text.");
  expect(op?.keyboard).toEqual({ rows: [[{ text: "A", data: `q:${callbackToken(id)}:0:0` }, { text: "B", data: `q:${callbackToken(id)}:0:1` }]] });
  h.store.outboxState(id, "sent", 901);
  await h.attention.tick();
  await h.attention.handleUpdate(h.callback(901, `q:${callbackToken(id)}:0:1`));
  expect(h.backend.questionReplies).toEqual([["q_1", "/Chats", [["B"]]]]);
  expect(h.store.sessionNotice(id)?.state).toBe("answered");
  expect(h.answers).toEqual([["cb", "Answered."]]);
  expect(h.edits).toEqual([{ chatId: 100, messageId: 901,
    text: `${h.store.getOperation(id)!.text}\n\n[Answered]`, keyboard: { remove: true } }]);
});

test("multiple-choice questions accumulate selections, show checks, and submit atomically", async () => {
  const h = setup();
  h.backend.questionRequests = [question(true, true)];
  h.attention.processEvent(askedEvent("question", "q_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "question", "q_1");
  const token = callbackToken(id);
  expect(h.store.getOperation(id)?.keyboard).toEqual({ rows: [
    [{ text: "A", data: `q:${token}:0:0` }, { text: "B", data: `q:${token}:0:1` }],
    [{ text: "Submit", data: `q:${token}:send` }],
  ] });
  h.store.outboxState(id, "sent", 901);
  await h.attention.tick();
  await h.attention.handleUpdate(h.callback(901, `q:${token}:0:0`));
  expect(h.store.get<Record<string, number[]>>(`selection:${id}`)).toEqual({ 0: [0] });
  expect(h.edits.at(-1)?.keyboard).toEqual({ rows: [
    [{ text: "✓ A", data: `q:${token}:0:0` }, { text: "B", data: `q:${token}:0:1` }],
    [{ text: "Submit", data: `q:${token}:send` }],
  ] });
  expect(h.answers.at(-1)).toEqual(["cb", "Selected."]);
  await h.attention.handleUpdate(h.callback(901, `q:${token}:0:1`));
  expect(h.store.get<Record<string, number[]>>(`selection:${id}`)).toEqual({ 0: [0, 1] });
  expect(h.answers.at(-1)).toEqual(["cb", "Selected."]);
  // Deselect toggles off.
  await h.attention.handleUpdate(h.callback(901, `q:${token}:0:0`));
  expect(h.store.get<Record<string, number[]>>(`selection:${id}`)).toEqual({ 0: [1] });
  // Submit without a full selection is refused.
  await h.attention.handleUpdate(h.callback(901, `q:${token}:0:0`));
  await h.attention.handleUpdate(h.callback(901, `q:${token}:send`));
  expect(h.backend.questionReplies).toEqual([["q_1", "/Chats", [["A", "B"]]]]);
  expect(h.store.sessionNotice(id)?.state).toBe("answered");
  expect(h.store.get(`selection:${id}`)).toBeNull();
});

const form = (options: { multiple?: boolean; custom?: boolean } = {}): QuestionRequest => ({
  id: "q_3", sessionID: "ses_1", title: "Setup", questions: [
    { key: "q0", question: "Which region?", header: "Region", multiple: options.multiple ?? false, custom: true,
      options: [{ label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" }] },
    { key: "q1", question: "Which size?", header: "Size", custom: true,
      options: [{ label: "C", value: "c" }, { label: "D", value: "d" }] },
    { key: "q2", question: "Which tier?", header: "Tier", custom: options.custom ?? true,
      options: [{ label: "E", value: "e" }, { label: "F", value: "f" }] },
  ],
});

async function formPrompt(h: ReturnType<typeof setup>, request: QuestionRequest) {
  h.backend.questionRequests = [request];
  h.attention.processEvent(askedEvent("question", request.id));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "question", request.id);
  h.store.outboxState(id, "sent", 901);
  await h.attention.tick();
  return { id, token: callbackToken(id) };
}

const buttons = (token: string, step: number, labels: string[]) =>
  [labels.map((text, option) => ({ text, data: `q:${token}:${step}:${option}` }))];

test("multi-question prompts ask one question at a time and submit every answer together", async () => {
  const h = setup();
  const { id, token } = await formPrompt(h, form());
  const op = h.store.getOperation(id)!;
  expect(op.text).toContain("[OpenChamber] Deployment review has 3 questions for you.");
  expect(op.text).toContain("Question 1 of 3 (Region):\nWhich region?\n1. A\n2. B\n3. C");
  expect(op.text).toContain("Or reply to this message with your own text.");
  expect(op.text).not.toContain("/answer");
  expect(op.text).not.toContain("Which size?");
  expect(op.keyboard).toEqual({ rows: buttons(token, 0, ["A", "B", "C"]) });
  await h.attention.handleUpdate(h.callback(901, `q:${token}:0:1`));
  expect(h.backend.questionReplies).toEqual([]);
  expect(h.answers.at(-1)).toEqual(["cb", "Recorded. Question 2 of 3 is next."]);
  expect(h.edits.at(-1)?.messageId).toBe(901);
  expect(h.edits.at(-1)?.text).toContain("Question 2 of 3 (Size):\nWhich size?");
  expect(h.edits.at(-1)?.keyboard).toEqual({ rows: buttons(token, 1, ["C", "D"]) });
  // A replayed tap on an earlier question cannot change or skip anything.
  await h.attention.handleUpdate(h.callback(901, `q:${token}:0:0`));
  expect(h.answers.at(-1)).toEqual(["cb", "That question was already answered."]);
  await h.attention.handleUpdate(h.callback(901, `q:${token}:2:0`));
  expect(h.answers.at(-1)).toEqual(["cb", "Answer question 2 first."]);
  await h.attention.handleUpdate(h.callback(901, `q:${token}:1:0`));
  expect(h.edits.at(-1)?.text).toContain("Question 3 of 3 (Tier):");
  expect(h.backend.questionReplies).toEqual([]);
  await h.attention.handleUpdate(h.callback(901, `q:${token}:2:1`));
  expect(h.backend.questionReplies).toEqual([["q_3", "/Chats", [["B"], ["C"], ["F"]]]]);
  expect(h.store.sessionNotice(id)?.state).toBe("answered");
  expect(h.answers.at(-1)).toEqual(["cb", "Answered."]);
  expect(h.edits.at(-1)).toEqual({ chatId: 100, messageId: 901, keyboard: { remove: true },
    text: "[OpenChamber] Deployment review has 3 questions for you.\n1. Which region?\nB\n2. Which size?\nC\n3. Which tier?\nF\n\n[Answered]" });
  expect(h.store.get(`sequence:${id}`)).toBeNull();
  await h.attention.handleUpdate(h.callback(901, `q:${token}:2:1`));
  expect(h.backend.questionReplies).toHaveLength(1);
  expect(h.answers.at(-1)).toEqual(["cb", "This prompt already resolved."]);
  await h.attention.handleUpdate(h.message(950, "/help"));
  expect(h.store.getOperation("ack:950")?.text).not.toContain("/answer");
});

test("multi-question prompts accept custom text replies for the current question", async () => {
  const h = setup();
  const { id, token } = await formPrompt(h, form({ custom: false }));
  await h.attention.handleUpdate(h.callback(901, `q:${token}:0:0`));
  await h.attention.handleUpdate(h.message(902, " my own size ", 901));
  expect(h.store.getOperation("ack:902")).toMatchObject({ text: "Recorded. Question 3 of 3 is next.", replyTo: 902 });
  expect(h.edits.at(-1)?.text).toContain("Question 3 of 3 (Tier):");
  expect(h.edits.at(-1)?.text).not.toContain("your own text");
  expect(h.backend.questionReplies).toEqual([]);
  // The last question lists options only, so typed text is refused.
  await h.attention.handleUpdate(h.message(903, "anything", 901));
  expect(h.store.getOperation("ack:903")?.text).toContain("does not accept custom text");
  expect(h.store.get<{ answers: string[][] }>(`sequence:${id}`)?.answers).toEqual([["A"], ["my own size"]]);
  await h.attention.handleUpdate(h.callback(901, `q:${token}:2:0`));
  expect(h.backend.questionReplies).toEqual([["q_3", "/Chats", [["A"], ["my own size"], ["E"]]]]);
  expect(h.store.sessionNotice(id)?.state).toBe("answered");
});

test("multi-select questions in a sequence toggle options with checks and continue on Done", async () => {
  const h = setup();
  const { id, token } = await formPrompt(h, form({ multiple: true }));
  const done = [{ text: "Done", data: `q:${token}:done:0` }];
  expect(h.store.getOperation(id)?.keyboard).toEqual({ rows: [...buttons(token, 0, ["A", "B", "C"]), done] });
  expect(h.store.getOperation(id)?.text).toContain("Tap each option that applies, then Done.");
  await h.attention.handleUpdate(h.callback(901, `q:${token}:done:0`));
  expect(h.answers.at(-1)).toEqual(["cb", "Select at least one option first."]);
  await h.attention.handleUpdate(h.callback(901, `q:${token}:0:0`));
  expect(h.answers.at(-1)).toEqual(["cb", "Selected."]);
  expect(h.edits.at(-1)?.keyboard).toEqual({ rows: [...buttons(token, 0, ["✓ A", "B", "C"]), done] });
  await h.attention.handleUpdate(h.callback(901, `q:${token}:0:2`));
  await h.attention.handleUpdate(h.callback(901, `q:${token}:0:0`));
  expect(h.answers.at(-1)).toEqual(["cb", "Cleared."]);
  await h.attention.handleUpdate(h.callback(901, `q:${token}:0:1`));
  expect(h.edits.at(-1)?.keyboard).toEqual({ rows: [...buttons(token, 0, ["A", "✓ B", "✓ C"]), done] });
  await h.attention.handleUpdate(h.callback(901, `q:${token}:done:0`));
  expect(h.edits.at(-1)?.text).toContain("Question 2 of 3");
  expect(h.edits.at(-1)?.keyboard).toEqual({ rows: buttons(token, 1, ["C", "D"]) });
  await h.attention.handleUpdate(h.callback(901, `q:${token}:done:0`));
  expect(h.answers.at(-1)).toEqual(["cb", "That question was already answered."]);
  await h.attention.handleUpdate(h.callback(901, `q:${token}:1:1`));
  await h.attention.handleUpdate(h.callback(901, `q:${token}:2:0`));
  expect(h.backend.questionReplies).toEqual([["q_3", "/Chats", [["B", "C"], ["D"], ["E"]]]]);
});

test("a multi-question request that expires or changes mid-sequence is retired without answering", async () => {
  const h = setup();
  const { id, token } = await formPrompt(h, form());
  await h.attention.handleUpdate(h.callback(901, `q:${token}:0:0`));
  h.backend.questionRequests = [];
  await h.attention.handleUpdate(h.callback(901, `q:${token}:1:0`));
  expect(h.backend.questionReplies).toEqual([]);
  expect(h.answers.at(-1)).toEqual(["cb", "That question is no longer needed."]);
  expect(h.store.sessionNotice(id)?.state).toBe("cancelled");
  expect(h.edits.at(-1)?.text).toContain("Question 2 of 3");
  expect(h.edits.at(-1)?.text).toEndWith("\n\n[No longer needed]");
  expect(h.edits.at(-1)?.keyboard).toEqual({ remove: true });
  expect(h.store.get(`sequence:${id}`)).toBeNull();

  // A resolution event mid-sequence retires the current step the same way.
  const other = setup();
  const second = await formPrompt(other, form());
  await other.attention.handleUpdate(other.callback(901, `q:${second.token}:0:0`));
  other.backend.questionRequests = [];
  other.attention.processEvent(resolvedEvent("question", "q_3"));
  await other.attention.tick();
  expect(other.store.sessionNotice(second.id)?.state).toBe("cancelled");
  expect(other.edits.at(-1)?.text).toContain("Question 2 of 3");
  expect(other.edits.at(-1)?.text).toEndWith("\n\n[No longer needed]");

  // A changed request is refused before the final submit.
  const changed = setup();
  const third = await formPrompt(changed, form());
  await changed.attention.handleUpdate(changed.callback(901, `q:${third.token}:0:0`));
  await changed.attention.handleUpdate(changed.callback(901, `q:${third.token}:1:0`));
  const edited = form();
  edited.questions[2]!.question = "Which plan?";
  changed.backend.questionRequests = [edited];
  await changed.attention.handleUpdate(changed.callback(901, `q:${third.token}:2:0`));
  expect(changed.backend.questionReplies).toEqual([]);
  expect(changed.answers.at(-1)).toEqual(["cb", "That request changed and was not answered."]);
  expect(changed.edits.at(-1)?.text).toEndWith("\n\n[Request changed]");
});

test("a restart mid-sequence resumes from the stored answers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "attention-restart-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite");
  const h = setup("/nonexistent/router.sock", path);
  const { id, token } = await formPrompt(h, form({ multiple: true }));
  await h.attention.handleUpdate(h.callback(901, `q:${token}:0:2`));
  await h.attention.handleUpdate(h.callback(901, `q:${token}:done:0`));
  await h.attention.handleUpdate(h.callback(901, `q:${token}:1:1`));
  h.attention.stop();
  stores.splice(stores.indexOf(h.store), 1);
  h.store.close();
  const store = new Store(path);
  stores.push(store);
  const restarted = new Attention(store, h.backend, h.transport, { chatId: () => 100, spectrumSocket: "/nonexistent/router.sock" });
  await restarted.handleUpdate(h.callback(901, `q:${token}:1:0`));
  expect(h.answers.at(-1)).toEqual(["cb", "That question was already answered."]);
  expect(h.edits.at(-1)?.text).toContain("Question 3 of 3");
  expect(h.backend.questionReplies).toEqual([]);
  await restarted.handleUpdate(h.callback(901, `q:${token}:2:1`));
  expect(h.backend.questionReplies).toEqual([["q_3", "/Chats", [["C"], ["D"], ["F"]]]]);
  expect(store.sessionNotice(id)?.state).toBe("answered");
});

test("custom replies answer single custom questions through reply-to", async () => {
  const h = setup();
  h.backend.questionRequests = [question()];
  h.attention.processEvent(askedEvent("question", "q_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "question", "q_1");
  h.store.outboxState(id, "sent", 901);
  await h.attention.tick();
  await h.attention.handleUpdate(h.message(902, " my own text ", 901));
  expect(h.backend.questionReplies).toEqual([["q_1", "/Chats", [["my own text"]]]]);
  expect(h.store.sessionNotice(id)?.state).toBe("answered");
  const ack = h.store.getOperation("ack:902");
  expect(ack).toMatchObject({ kind: "control", text: "Answered.", replyTo: 902 });
  expect(h.edits.at(-1)?.text).toContain("[Answered]");
  // Replying to something else never answers.
  await h.attention.handleUpdate(h.message(903, "again", 404));
  expect(h.backend.questionReplies).toHaveLength(1);
  expect(h.store.getOperation("ack:903")?.text).toContain("Reply to a current question prompt");
});

test("custom text is refused for listed-options-only questions and stale requests", async () => {
  const h = setup();
  h.backend.questionRequests = [question(false)];
  h.attention.processEvent(askedEvent("question", "q_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "question", "q_1");
  h.store.outboxState(id, "sent", 901);
  await h.attention.tick();
  await h.attention.handleUpdate(h.message(902, "arbitrary", 901));
  expect(h.backend.questionReplies).toEqual([]);
  expect(h.store.getOperation("ack:902")?.text).toContain("does not accept custom text");
});

test("/answer answers from exact JSON arrays after revalidating the live request", async () => {
  const h = setup();
  h.backend.questionRequests = [question(true, true)];
  h.attention.processEvent(askedEvent("question", "q_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "question", "q_1");
  h.store.outboxState(id, "sent", 901);
  await h.attention.tick();
  await h.attention.handleUpdate(h.message(902, "/answer q_1 [[\"A\",\"B\"]]"));
  expect(h.backend.questionReplies).toEqual([["q_1", "/Chats", [["A", "B"]]]]);
  expect(h.store.sessionNotice(id)?.state).toBe("answered");
  expect(h.store.getOperation("ack:902")?.text).toBe("Answer sent for request q_1.");
  // Wrong shapes, unknown ids, and unknown requests are refused without replies.
  let bad = 903;
  for (const text of ["/answer q_1 [[\"A\"],]", "/answer", "/answer q_1 notjson"]) {
    await h.attention.handleUpdate(h.message(bad, text));
    expect(h.store.getOperation(`ack:${bad}`)?.text).toContain("Use /answer REQUESTID");
    bad++;
  }
  expect(h.backend.questionReplies).toHaveLength(1);
  await h.attention.handleUpdate(h.message(bad, "/answer OTHER [[\"A\"]]"));
  expect(h.store.getOperation(`ack:${bad}`)?.text).toContain("No matching current prompt.");
  const second = question(true, true);
  second.id = "q_9";
  h.backend.questionRequests = [second];
  setSystemTime(now);
  h.attention.processEvent(askedEvent("question", "q_9"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const secondId = sessionNoticeId("/Chats", "ses_1", "question", "q_9");
  h.store.outboxState(secondId, "sent", 905);
  await h.attention.tick();
  await h.attention.handleUpdate(h.message(907, "/answer q_9 [[\"A\",\"A\"]]"));
  expect(h.backend.questionReplies).toHaveLength(1);
  expect(h.store.getOperation("ack:907")?.text).toContain("Choose one answer per question");
});

test("resolved requests cancel unsent prompts and retire sent ones", async () => {
  const h = setup();
  h.backend.permissionRequests = [permission()];
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "approval", "perm_1");
  h.store.outboxState(id, "sent", 901);
  await h.attention.tick();
  h.backend.permissionRequests = [];
  h.attention.processEvent(resolvedEvent("approval", "perm_1"));
  await h.attention.tick();
  expect(h.store.sessionNotice(id)?.state).toBe("cancelled");
  expect(h.edits).toEqual([{ chatId: 100, messageId: 901,
    text: `${h.store.getOperation(id)!.text}\n\n[Resolved elsewhere]`, keyboard: { remove: true } }]);
  // A queued-but-unsent prompt is cancelled before delivery ever sees it.
  await expect(h.attention.beforeSend({ id })).resolves.toBe("cancel");
});

test("requests resolved while still pending are cancelled without any send", async () => {
  const h = setup();
  h.backend.permissionRequests = [permission()];
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  h.attention.processEvent(resolvedEvent("approval", "perm_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "approval", "perm_1");
  expect(h.store.sessionNotice(id)?.state).toBe("cancelled");
  expect(h.store.getOperation(id)).toBeUndefined();
});

test("changed request signatures revalidate and cancel stale prompts", async () => {
  const h = setup();
  h.backend.permissionRequests = [permission()];
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "approval", "perm_1");
  h.store.outboxState(id, "sent", 901);
  await h.attention.tick();
  const token = callbackToken(id);
  h.backend.permissionRequests = [{ ...permission(), resources: ["new pattern"] }];
  await h.attention.handleUpdate(h.callback(901, `a:${token}:once`));
  expect(h.backend.permissionReplies).toEqual([]);
  expect(h.answers.at(-1)).toEqual(["cb", "That request changed and was not answered."]);
  expect(h.edits.at(-1)?.text).toContain("[Request changed]");
  expect(h.store.sessionNotice(id)?.state).toBe("cancelled");
});

test("tapping a request that vanished retires the prompt as no longer pending", async () => {
  const h = setup();
  h.backend.permissionRequests = [permission()];
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "approval", "perm_1");
  h.store.outboxState(id, "sent", 901);
  await h.attention.tick();
  h.backend.permissionRequests = [];
  const token = callbackToken(id);
  await h.attention.handleUpdate(h.callback(901, `a:${token}:once`));
  expect(h.backend.permissionReplies).toEqual([]);
  expect(h.answers.at(-1)).toEqual(["cb", "That request is no longer pending."]);
  expect(h.edits.at(-1)?.text).toContain("[No longer pending]");
  expect(h.store.sessionNotice(id)?.state).toBe("cancelled");
});

test("settled sessions are never announced, and leftover review notices are withdrawn", async () => {
  const h = setup();
  const entry = { sessionId: "ses_1", directory: "/Chats", title: "Deployment review", state: "waiting" as const,
    status: "idle", workRevision: 3, updatedAt: now };
  h.backend.board = { version: 1, revision: 1, activatedAt: 1, migrationComplete: true, entries: [{ ...entry, state: "running" as const, status: "busy", workRevision: 2 }] };
  await h.attention.tick();
  h.attention.processEvent(statusEvent("busy"));
  h.attention.processEvent(statusEvent("idle"));
  h.backend.board = { version: 1, revision: 2, activatedAt: 1, migrationComplete: true, entries: [entry] };
  setSystemTime(now + 61_000);
  await h.attention.tick();
  await h.attention.tick();
  expect(h.store.pendingSessionNotices()).toEqual([]);
  expect(h.store.pendingOutbox()).toEqual([]);
  // A review notice stored by an older bridge is cancelled, never sent.
  const notice: SessionNotice = { id: sessionNoticeId("/Chats", "ses_1", "review", 3), kind: "review", sessionId: "ses_1",
    directory: "/Chats", workRevision: 3, firstSeen: now, state: "pending" };
  h.store.saveSessionNotice(notice);
  await h.attention.tick();
  expect(h.store.getOperation(notice.id)).toBeUndefined();
  expect(h.store.sessionNotice(notice.id)?.state).toBe("cancelled");
});

test("iMessage conversations and their subagents never prompt on Telegram, even with the iMessage bridge down", async () => {
  const h = setup();
  const imessage = { openchamber: { origin: "imessage", assist: { recap: "r" } } };
  h.backend.sessions.set("ses_1", { ...h.backend.sessions.get("ses_1")!, metadata: imessage });
  // Created before its root was marked: only the parent names the origin.
  h.backend.sessions.set("ses_sub", { id: "ses_sub", parentID: "ses_1", directory: "/Chats", title: "Sub", time: { created: now, updated: now } });
  h.backend.permissionRequests = [permission(), { ...permission(), id: "perm_sub", sessionID: "ses_sub" }];
  h.backend.questionRequests = [question(), { ...question(), id: "q_sub", sessionID: "ses_sub" }];
  for (const [kind, id, sessionId] of [["approval", "perm_1", "ses_1"], ["approval", "perm_sub", "ses_sub"],
    ["question", "q_1", "ses_1"], ["question", "q_sub", "ses_sub"]] as const) {
    h.attention.processEvent(askedEvent(kind, id, sessionId));
  }
  setSystemTime(now + 20_000);
  await h.attention.tick();
  expect(h.store.pendingOutbox()).toEqual([]);
  for (const [kind, id, sessionId] of [["approval", "perm_1", "ses_1"], ["approval", "perm_sub", "ses_sub"],
    ["question", "q_1", "ses_1"], ["question", "q_sub", "ses_sub"]] as const) {
    expect(h.store.sessionNotice(sessionNoticeId("/Chats", sessionId, kind, id))?.state).toBe("cancelled");
  }
});

test("many requests under one iMessage conversation read its record once per tick", async () => {
  const h = setup();
  h.backend.sessions.set("ses_1", { ...h.backend.sessions.get("ses_1")!, metadata: { openchamber: { origin: "imessage" } } });
  const reads: string[] = [];
  const getSession = h.backend.getSession.bind(h.backend);
  h.backend.getSession = async (id: string) => { reads.push(id); return getSession(id); };
  const children = ["ses_a", "ses_b", "ses_c"];
  for (const id of children) {
    h.backend.sessions.set(id, { id, parentID: "ses_1", directory: "/Chats", title: id, time: { created: now, updated: now } });
  }
  h.backend.permissionRequests = children.map(id => ({ ...permission(), id: `perm_${id}`, sessionID: id }));
  for (const id of children) h.attention.processEvent(askedEvent("approval", `perm_${id}`, id));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  expect(h.store.pendingOutbox()).toEqual([]);
  expect(reads.filter(id => id === "ses_1")).toHaveLength(1);
});

test("an unmarked session with other metadata still prompts on Telegram", async () => {
  const h = setup();
  h.backend.sessions.set("ses_1", { ...h.backend.sessions.get("ses_1")!, metadata: { openchamber: { assist: {} }, origin: "imessage" } });
  h.backend.permissionRequests = [permission()];
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  expect(h.store.getOperation(sessionNoticeId("/Chats", "ses_1", "approval", "perm_1"))).toMatchObject({ state: "pending" });
});

test("owner commands: help, status, reminders, cancel, and snooze with durable acknowledgements", async () => {
  const h = setup();
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  h.store.createReminder({ id: "R1", text: "stretch", dueAt: now + 60_000, timezone: "UTC" });
  await h.attention.handleUpdate(h.message(1, "/start"));
  expect(h.store.getOperation("ack:1")?.text).toContain("OpenChamber alert bridge.");
  Object.assign(h.backend, { brand: { app: "Robob", board: "the Board" } });
  await h.attention.handleUpdate(h.message(2, "/help"));
  expect(h.store.getOperation("ack:2")?.text).toStartWith("Robob alert bridge.");
  expect(h.store.getOperation("ack:2")?.text).toContain("/reminders");
  await h.attention.handleUpdate(h.message(3, "/status"));
  expect(JSON.parse(h.store.getOperation("ack:3")!.text)).toEqual({
    pendingNotices: 1, byKind: { approval: 1 }, remindersScheduled: 1,
  });
  await h.attention.handleUpdate(h.message(4, "/reminders"));
  expect(h.store.getOperation("ack:4")?.text).toContain("R1: scheduled");
  await h.attention.handleUpdate(h.message(5, "/snooze R1 1h"));
  expect(h.store.getOperation("ack:5")?.text).toBe(`Snoozed reminder R1 until ${new Date(now + 3_600_000).toISOString()}.`);
  await h.attention.handleUpdate(h.message(6, "/cancel R1"));
  expect(h.store.getOperation("ack:6")?.text).toBe("Cancelled reminder R1.");
  await h.attention.handleUpdate(h.message(7, "/cancel R1"));
  expect(h.store.getOperation("ack:7")?.text).toBe("Cancelled reminder R1.");
  // An ambiguous in-flight delivery refuses mutations until it is resolved.
  h.store.createReminder({ id: "R2", text: "check", dueAt: now + 60_000, timezone: "UTC" });
  h.store.enqueueDueReminders(now + 60_000);
  h.store.outboxState("reminder:R2:1", "sending");
  await h.attention.handleUpdate(h.message(8, "/snooze R2 1h"));
  expect(h.store.getOperation("ack:8")?.text).toBe("Reminder command failed. Check the ID with /reminders; an uncertain notification delivery must be resolved first.");
  await h.attention.handleUpdate(h.message(9, "/snooze R1 1x"));
  expect(h.store.getOperation("ack:9")?.text).toContain("at most 365 days");
  for (const [messageId, text] of [[10, "/unknown"], [11, "hello there"]] as const) {
    await h.attention.handleUpdate(h.message(messageId, text));
    const op = h.store.getOperation(`ack:${messageId}`);
    expect(op?.kind).toBe("control");
    expect(op?.replyTo).toBe(messageId);
  }
  expect(h.store.getOperation("ack:10")?.text).toContain("alerts-only");
  expect(h.store.getOperation("ack:11")?.text).toContain("alerts-only");
});

test("status events only clear prompts through explicit resolution and never auto-answer", async () => {
  const h = setup();
  h.backend.permissionRequests = [permission()];
  h.attention.processEvent(askedEvent("approval", "perm_1"));
  h.attention.processEvent(statusEvent("busy"));
  h.attention.processEvent(statusEvent("idle"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "approval", "perm_1");
  expect(h.store.getOperation(id)).toMatchObject({ state: "pending" });
  expect(h.store.sessionNotice(id)?.state).toBe("queued");
});

test("updates are serialized in arrival order", async () => {
  const h = setup();
  const order: number[] = [];
  const original = h.attention.handleUpdate.bind(h.attention);
  void original;
  h.store.createReminder({ id: "R1", text: "x", dueAt: now + 1000, timezone: "UTC" });
  const first = h.attention.handleUpdate(h.message(1, "/status"));
  const second = h.attention.handleUpdate(h.message(2, "/status"));
  const third = h.attention.handleUpdate(h.message(3, "/status"));
  await Promise.all([first, second, third]);
  order.push(1, 2, 3);
  expect(order).toEqual([1, 2, 3]);
  expect(h.store.getOperation("ack:1")).toBeDefined();
  expect(h.store.getOperation("ack:2")).toBeDefined();
  expect(h.store.getOperation("ack:3")).toBeDefined();
});

test("status() counts pending notices and scheduled reminders only", () => {
  const h = setup();
  h.store.saveSessionNotice({ id: "n1", kind: "question", sessionId: "s", directory: "/d", firstSeen: now, state: "pending" });
  h.store.saveSessionNotice({ id: "n2", kind: "approval", sessionId: "s", directory: "/d", firstSeen: now, state: "pending" });
  h.store.saveSessionNotice({ id: "n3", kind: "review", sessionId: "s", directory: "/d", firstSeen: now, state: "cancelled" });
  h.store.createReminder({ id: "R1", text: "a", dueAt: now, timezone: "UTC" });
  h.store.createReminder({ id: "R2", text: "b", dueAt: now, timezone: "UTC" });
  h.store.cancelReminder("R2");
  expect(h.attention.status()).toEqual({ pendingNotices: 2, byKind: { question: 1, approval: 1 }, remindersScheduled: 1 });
});

test("forms a chat reply cannot answer are surfaced without buttons and never answered", async () => {
  const h = setup();
  h.backend.questionRequests = [{ id: "frm_9", sessionID: "ses_1", title: "Deploy settings", questions: [], unsupported: true }];
  h.attention.processEvent(askedEvent("question", "frm_9"));
  setSystemTime(now + 20_000);
  await h.attention.tick();
  const id = sessionNoticeId("/Chats", "ses_1", "question", "frm_9");
  const op = h.store.getOperation(id);
  expect(op?.text).toContain("Form frm_9: Deploy settings");
  expect(op?.text).toContain("Please answer it in OpenChamber.");
  expect(op?.keyboard).toBeUndefined();
  h.store.outboxState(id, "sent", 901);
  await h.attention.tick();
  await h.attention.handleUpdate(h.message(902, "some text", 901));
  await h.attention.handleUpdate(h.message(903, "/answer frm_9 [[\"x\"]]"));
  expect(h.backend.questionReplies).toEqual([]);
  expect(h.store.getOperation("ack:902")?.text).toContain("does not accept custom text");
  expect(h.store.getOperation("ack:903")?.text).toContain("Choose one answer per question");
});

test("a request that opens while the tick's read is in flight is checked against a newer read, never cancelled", async () => {
  const h = setup();
  let reads = 0;
  const late = permission();
  Object.assign(h.backend, { pendingRequests: async () => {
    reads++;
    const permissions = [...h.backend.permissionRequests];
    if (reads === 1) {
      // The event lands after this read was taken, and the tick runs on past the alert delay.
      h.backend.permissionRequests.push(late);
      h.attention.processEvent(askedEvent("approval", late.id));
      setSystemTime(now + 20_000);
    }
    return { permissions: async () => permissions, questions: async () => [] };
  } });
  h.attention.processEvent(statusEvent("busy"));
  await h.attention.tick();
  expect(reads).toBe(2);
  expect(h.store.pendingOutbox().map(entry => entry.text)).toEqual([expect.stringContaining("needs your approval")]);
});

test("a backend read per folder keeps polling every tick, and a failed read is retried on the next", async () => {
  const h = setup();
  h.backend.board = { version: 1, revision: 1, activatedAt: 1, migrationComplete: true,
    entries: [{ sessionId: "ses_1", directory: "/Chats", title: "Deployment review", state: "running", status: "busy", workRevision: 1, updatedAt: now }] };
  const permissions = h.backend.permissions.bind(h.backend);
  let fail = true;
  h.backend.permissions = async () => { if (fail) { h.backend.permissionReads++; throw new Error("down"); } return permissions(); };
  await h.attention.tick();
  expect(h.backend.permissionReads).toBe(1);
  fail = false;
  h.backend.permissionRequests = [permission()];
  setSystemTime(now + 5_000);
  await h.attention.tick();
  expect(h.backend.permissionReads).toBe(2);
  expect(h.store.pendingSessionNotices()).toHaveLength(1);
  setSystemTime(now + 10_000);
  h.backend.permissionRequests = [];
  await h.attention.tick();
  expect(h.backend.permissionReads).toBeGreaterThanOrEqual(3);
});

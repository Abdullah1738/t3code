import { createHash } from "node:crypto";
import { IMESSAGE_ORIGIN, sessionOrigin, type AlertBackend, type BoardEntry, type BoardSnapshot, type JsonValue, type PermissionRequest, type QuestionRequest, type SessionRecord } from "./openchamber.ts";
import { parseNotificationEvent, type NotificationEvent } from "./notification-events.ts";
import { spectrumRouterStatus, type RouterStatus } from "./spectrum-status.ts";
import { callbackToken, sessionNoticeId, type KeyboardSpec, type SessionNotice, type Store } from "./store.ts";
import type { Telegram, TelegramUpdate } from "./telegram.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// OpenCode 2 session titles are optional until generated.
const label = (title: string | undefined) => (title ?? "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, 180) || "Session";
const ATTENTION_DELAY = 5_000;
const AUTO_ACCEPT_GRACE = 15_000;
type Selection = Record<string, number[]>;
/** Durable progress of a multi-question prompt asked one question at a time. */
type Sequence = { answers: string[][]; selected: number[]; text?: string };
const sequenceKey = (noticeId: string) => `sequence:${noticeId}`;

const helpText = (app: string) => `${app} alert bridge. This bot delivers alerts, reminders, and approval/question prompts with tap buttons. Conversations stay on iMessage. Commands: /status, /reminders, /cancel ID, /snooze ID 5m|1h|2d.`;
const INVALID_ANSWERS = "Choose one answer per question, or one or more distinct answers where multiple choices are allowed. Use exact option labels; other text is accepted only when custom answers are allowed.";
const ALERTS_ONLY = "This bridge is alerts-only. Conversations happen over iMessage. Use /help for commands.";

export type AttentionOptions = {
  chatId: () => number | undefined;
  spectrumSocket: string;
  log?: (event: string, code?: string) => void;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Observes the server-owned board and owns every alert delivery. Never announces settled sessions. */
export class Attention {
  private ticking?: Promise<void>;
  private epoch = 0;
  private readonly boardEntries = new Map<string, string>();
  private readonly sessionEpochs = new Map<string, number>();
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private readonly activeSessions = new Set<string>();
  /** Session to directory, learned from located events; execution events carry none. */
  private readonly sessionDirectories = new Map<string, string>();
  private stopped = false;
  private handling?: Promise<void>;

  constructor(
    private readonly store: Store,
    private readonly backend: AlertBackend,
    private readonly transport: Pick<Telegram, "editMessageText" | "answerCallback">,
    private readonly options: AttentionOptions,
  ) {}

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.ticking ??= this.run().finally(() => { this.ticking = undefined; });
  }

  private get app(): string { return this.backend.brand?.app ?? "OpenChamber"; }

  invalidate(): void { this.epoch++; }

  stop(): void {
    this.stopped = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.activeSessions.clear();
    this.sessionEpochs.clear();
    this.boardEntries.clear();
    this.sessionDirectories.clear();
    this.invalidate();
  }

  private wake(): void {
    if (this.stopped || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      void this.tick().catch(() => {});
    }, 250);
    this.wakeTimer.unref?.();
  }

  status(): Record<string, unknown> {
    const notices = this.store.pendingSessionNotices();
    const reminders = this.store.listReminders();
    return {
      pendingNotices: notices.length,
      byKind: notices.reduce<Record<string, number>>((counts, notice) => {
        counts[notice.kind] = (counts[notice.kind] ?? 0) + 1;
        return counts;
      }, {}),
      remindersScheduled: reminders.filter(reminder => reminder.status === "scheduled").length,
    };
  }

  /** Consume the backend wake stream without trusting it as a state snapshot. */
  processEvent(input: JsonValue): void {
    if (this.stopped) return;
    const event = parseNotificationEvent(input, this.sessionDirectories);
    if (event) this.processNotification(event);
  }

  /** Same as processEvent, for backends that decode their own stream (Robob's control events). */
  processNotification(event: NotificationEvent): void {
    if (this.stopped) return;
    if (event.type === "invalidate") {
      this.invalidate(); this.wake(); return;
    }
    if (event.type === "board") {
      const next = new Map(event.entries.map(entry => [entry.identity, entry.fingerprint]));
      for (const identity of new Set([...this.boardEntries.keys(), ...next.keys()])) {
        if (this.boardEntries.get(identity) !== next.get(identity)) {
          this.sessionEpochs.set(identity, (this.sessionEpochs.get(identity) ?? 0) + 1);
        }
      }
      this.boardEntries.clear();
      for (const [identity, fingerprint] of next) this.boardEntries.set(identity, fingerprint);
      this.wake();
      return;
    }
    if (event.type === "wake") { this.wake(); return; }
    const { sessionId, directory } = event;
    const sessionKey = `${directory}\0${sessionId}`;
    this.sessionEpochs.set(sessionKey, (this.sessionEpochs.get(sessionKey) ?? 0) + 1);
    if (event.type === "asked") {
      const entry: BoardEntry = { sessionId, directory, title: sessionId, state: "running", workRevision: 0, updatedAt: Date.now() };
      this.remember(entry, event.kind, event.requestId);
      this.wake();
      return;
    }
    if (event.type === "status") {
      const status = event.status;
      if (status === "busy") this.activeSessions.add(sessionKey);
      else this.activeSessions.delete(sessionKey);
      this.wake();
      return;
    }
    if (event.type === "resolved") {
      const { kind, requestId } = event;
      const noticeId = sessionNoticeId(directory, sessionId, kind, requestId);
      this.cancel(this.store.sessionNotice(noticeId) ?? {
        id: noticeId, kind, sessionId, directory, requestId, firstSeen: Date.now(), state: "pending",
      });
      this.wake();
      return;
    }
    this.wake();
  }

  /** Serialize owner interactions; every update is queued in arrival order. */
  handleUpdate(update: TelegramUpdate): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const run = async () => {
      try {
        if (update.type === "callback") await this.handleCallback(update);
        else await this.handleMessage(update);
      } catch { this.options.log?.("update-handling-failed"); }
      await sleep(50);
    };
    // Chain onto the in-flight task: no update is ever dropped or reordered.
    this.handling = this.handling ? this.handling.then(run, run) : run();
    return this.handling;
  }

  private remember(entry: BoardEntry, kind: SessionNotice["kind"], requestId?: string): void {
    const id = sessionNoticeId(entry.directory, entry.sessionId, kind, requestId ?? entry.workRevision);
    if (this.store.sessionNotice(id)) return;
    this.store.saveSessionNotice({ id, kind, sessionId: entry.sessionId, directory: entry.directory,
      ...(requestId ? { requestId } : { workRevision: entry.workRevision }), firstSeen: Date.now(), state: "pending" });
  }

  private cancel(notice: SessionNotice, reason?: string): void {
    const existing = this.store.sessionNotice(notice.id);
    const suffix = reason ?? (this.store.get<Sequence | null>(sequenceKey(notice.id)) ? "[No longer needed]" : "[Resolved elsewhere]");
    if (existing?.state === "answered") return;
    if (notice.kind === "review" && existing?.state === "sent") return;
    this.store.saveSessionNotice({ ...notice, state: "cancelled" });
    const operation = this.store.getOperation(notice.id);
    if (operation && ["pending", "failed", "uncertain"].includes(operation.state)) this.store.outboxState(notice.id, "cancelled");
    const text = this.promptText(notice.id);
    if (notice.kind === "question") this.store.set(sequenceKey(notice.id), null);
    const chatId = this.options.chatId();
    if (existing?.state === "sent" && chatId !== undefined && notice.kind !== "review" && operation?.providerId !== undefined && text !== undefined) {
      // The prompt is already visible; retire its buttons with the final suffix.
      void this.transport.editMessageText(chatId, operation.providerId,
        `${text}\n\n${suffix}`, { remove: true }).catch(() => {});
    }
  }

  /** The prompt text currently shown: a multi-question prompt is edited in place per step. */
  private promptText(noticeId: string): string | undefined {
    return this.store.get<Sequence | null>(sequenceKey(noticeId))?.text ?? this.store.getOperation(noticeId)?.text;
  }

  private markAnswered(notice: SessionNotice): void {
    this.store.db.transaction(() => {
      this.store.saveSessionNotice({ ...notice, state: "answered" });
      this.store.set(`selection:${notice.id}`, null);
      this.store.set(sequenceKey(notice.id), null);
    }).immediate();
  }

  private signature(request: PermissionRequest | QuestionRequest): string {
    return hash(JSON.stringify("questions" in request
      ? [request.id, request.sessionID, request.title, request.questions, request.unsupported === true, request.tool]
      : [request.id, request.sessionID, request.action, request.resources, request.save, request.source]));
  }

  /** True when the iMessage conversation router owns this request in-chat. */
  private async routerOwns(directory: string, sessionId: string, requestId: string): Promise<boolean> {
    const status: RouterStatus | undefined = await spectrumRouterStatus(this.options.spectrumSocket);
    if (!status) return false;
    if (!status.route) return false;
    const route = status.route;
    return status.pending.some(entry => entry.id === requestId
      && (entry.sessionId ?? route.id) === sessionId && (entry.directory ?? route.directory) === directory
      && (entry.state === "pending" || entry.state === "submitting")
      && ["pending", "sending", "sent", "uncertain"].includes(entry.operationState ?? ""));
  }

  private async run(): Promise<void> {
    const epoch = this.epoch;
    const boardVersions = new Map(this.sessionEpochs);
    const board = await this.backend.sessionBoard().catch(() => undefined);
    if (epoch !== this.epoch || this.stopped) return;
    if (board?.migrationComplete) this.observeBoard(board, boardVersions);
    // Settled sessions are not announced: agents use `notify` when they need the owner.
    const directories = new Set((board?.entries ?? [])
      .filter(entry => entry.attention || entry.state === "running")
      .map(entry => entry.directory));
    for (const identity of this.activeSessions) directories.add(identity.split("\0")[0]!);
    for (const directory of directories) {
      const revision = new Map(this.sessionEpochs);
      const results = await Promise.allSettled([this.backend.permissions(directory), this.backend.questions(directory)]);
      if (epoch !== this.epoch || this.stopped) return;
      for (const [index, kind] of (["approval", "question"] as const).entries()) {
        const result = results[index]!;
        if (result.status !== "fulfilled" || !result.value) continue;
        for (const request of result.value) {
          const identity = `${directory}\0${request.sessionID}`;
          if (revision.get(identity) !== this.sessionEpochs.get(identity)) continue;
          if (await this.routerOwns(directory, request.sessionID, request.id)) continue;
          const entry = board?.entries.find(candidate => candidate.sessionId === request.sessionID && candidate.directory === directory)
            ?? { sessionId: request.sessionID, directory, title: request.sessionID, state: "running", workRevision: 0, updatedAt: Date.now() } satisfies BoardEntry;
          this.remember(entry, kind, request.id);
        }
      }
    }
    const parents = new Map<string, Promise<SessionRecord | undefined>>();
    for (const notice of this.store.pendingSessionNotices()) {
      try {
        const op = this.store.getOperation(notice.id);
        if (op?.state === "sent") { this.store.saveSessionNotice({ ...notice, state: "sent" }); continue; }
        const sessionEpoch = this.sessionEpochs.get(`${notice.directory}\0${notice.sessionId}`);
        const result = await this.check(notice, parents);
        if (epoch !== this.epoch || this.stopped) return;
        if (sessionEpoch !== this.sessionEpochs.get(`${notice.directory}\0${notice.sessionId}`)) continue;
        if (result === "cancel") { this.cancel(notice); continue; }
        if (result === "wait" || notice.state === "queued") continue;
        this.claim({ ...notice, signature: result.signature }, result.text, result.keyboard);
      } catch { /* Failed reads are unknown, never an empty pending list. */ }
    }
  }

  private claim(notice: SessionNotice, text: string, keyboard?: KeyboardSpec): void {
    const token = callbackToken(notice.id);
    this.store.db.transaction(() => {
      this.store.set(`callback:${token}`, notice.id);
      if (notice.requestId) this.store.set(`request-notice:${notice.requestId}`, notice.id);
      this.store.enqueueSessionNotice(notice, text, keyboard);
    }).immediate();
  }

  /** Stops polling sessions the board shows as settled; a snapshot older than a newer event never wins. */
  private observeBoard(board: BoardSnapshot, versions: ReadonlyMap<string, number>): void {
    for (const entry of board.entries) {
      const key = `${entry.directory}\0${entry.sessionId}`;
      if (entry.state === "waiting" && entry.status === "idle" && versions.get(key) === this.sessionEpochs.get(key)) {
        this.activeSessions.delete(key);
      }
    }
  }

  private async session(notice: SessionNotice): Promise<SessionRecord> {
    const session = await this.backend.getSession(notice.sessionId, notice.directory);
    if (!session || session.id !== notice.sessionId || session.directory !== notice.directory) throw new Error("Session identity unavailable");
    return session;
  }

  /**
   * True for an iMessage conversation or any subagent under one: the iMessage
   * bridge asks those in-chat. OpenCode copies metadata onto children; the
   * parent walk covers a child created before its root was marked. A parent
   * that cannot be read ends the walk. Parent reads are shared within one
   * tick (`parents`), so many notices under one conversation read it once.
   */
  private async imessageFamily(session: SessionRecord, parents?: Map<string, Promise<SessionRecord | undefined>>): Promise<boolean> {
    const seen = new Set<string>();
    let current: SessionRecord | undefined = session;
    while (current && !seen.has(current.id) && seen.size < 32) {
      if (sessionOrigin(current) === IMESSAGE_ORIGIN) return true;
      seen.add(current.id);
      const parentID: string | undefined = current.parentID;
      if (!parentID) return false;
      const key: string = `${current.directory}\0${parentID}`;
      let read: Promise<SessionRecord | undefined> | undefined = parents?.get(key);
      if (!read) {
        read = this.backend.getSession(parentID, current.directory).catch(() => undefined);
        parents?.set(key, read);
      }
      current = await read;
      if (current?.id !== parentID) return false;
    }
    return false;
  }

  private contextOf(session: SessionRecord, parent: SessionRecord | undefined): string {
    return parent?.id === session.parentID && parent?.directory === session.directory
      ? `Subsession ${label(session.title)} in ${label(parent.title)}`
      : session.parentID ? `Subsession ${label(session.title)}` : label(session.title);
  }

  private async check(notice: SessionNotice, parents?: Map<string, Promise<SessionRecord | undefined>>): Promise<"cancel" | "wait" | { text: string; keyboard?: KeyboardSpec; signature: string }> {
    const age = Date.now() - notice.firstSeen;
    // Ready-for-review notices were retired; withdraw any left in the store.
    if (notice.kind === "review") return "cancel";
    if (age < ATTENTION_DELAY) return "wait";
    if (!notice.requestId) return "cancel";
    if (await this.routerOwns(notice.directory, notice.sessionId, notice.requestId)) return "wait";
    const requests = notice.kind === "approval" ? await this.backend.permissions(notice.directory) : await this.backend.questions(notice.directory);
    if (!requests) return "wait";
    if (!requests.some(request => request.id === notice.requestId && request.sessionID === notice.sessionId)) return "cancel";
    const session = await this.session(notice);
    // The iMessage bridge asks these over iMessage, even when it is not running.
    if (await this.imessageFamily(session, parents)) return "cancel";
    if (notice.kind === "approval") {
      const automatic = await this.backend.isSessionAutoAccepting(notice.sessionId, notice.directory);
      // Give the responder time, then report a request that is still pending.
      // A configured policy alone is never proof of a successful reply.
      if (automatic !== false && age < AUTO_ACCEPT_GRACE) return "wait";
    }
    const parent = session.parentID ? await this.backend.getSession(session.parentID, session.directory).catch(() => undefined) : undefined;
    const context = this.contextOf(session, parent);
    const freshRequests = notice.kind === "approval" ? await this.backend.permissions(notice.directory) : await this.backend.questions(notice.directory);
    if (!freshRequests) return "wait";
    const request = freshRequests.find(row => row.id === notice.requestId && row.sessionID === notice.sessionId);
    if (!request) return "cancel";
    const signature = this.signature(request);
    const token = callbackToken(notice.id);
    if (notice.kind === "approval" && "action" in request) {
      const text = `[${this.app}] ${context} needs your approval.\nPermission ${request.id}: ${request.action.slice(0, 200)}\n${request.resources.join("\n").slice(0, 2_000)}\n\nTap Approve once or Reject.`;
      const keyboard: KeyboardSpec = { rows: [
        [{ text: "Approve once", data: `a:${token}:once` }, { text: "Reject", data: `a:${token}:reject` }],
      ] };
      return { text, keyboard, signature };
    }
    if (notice.kind !== "question" || !("questions" in request)) return "cancel";
    if (request.unsupported) {
      // Still surfaced so a blocked session is never silent, but without buttons.
      return { text: `[${this.app}] ${context} has a form for you.\nForm ${request.id}: ${label(request.title)}\n\nIt has fields a chat reply cannot answer. Please answer it in ${this.app}.`, signature };
    }
    if (request.questions.length > 1) {
      // Multiple questions are asked one at a time by editing this message.
      const header = `[${this.app}] ${context} has ${request.questions.length} questions for you.`;
      const keyboard = this.stepKeyboard(request, token, 0, []);
      return { text: this.stepText(header, request, 0), ...("rows" in keyboard ? { keyboard } : {}), signature };
    }
    const body = request.questions.map((question, questionIndex) =>
      `${questionIndex + 1}. ${question.question} (${question.multiple === true ? "choose one or more" : "choose one"}${question.custom === false ? "; listed options only" : "; custom text allowed"})\n${this.optionList(question)}`
    ).join("\n").slice(0, 3_500);
    const single = request.questions.length === 1 && request.questions[0]!.multiple !== true;
    const hint = request.questions.length === 1 && request.questions[0]!.custom !== false
      ? "\nReply to this message with your own text." : "";
    const text = `[${this.app}] ${context} has a question for you.\nQuestion ${request.id}:\n${body}${single ? "" : "\n\nTap each option that applies, then Submit."}${hint}`;
    return { text, keyboard: this.questionKeyboard(request, token), signature };
  }

  private optionList(question: QuestionRequest["questions"][number]): string {
    return question.options.map((option, optionIndex) => `${optionIndex + 1}. ${option.label}${option.description ? `: ${option.description}` : ""}`).join("\n");
  }

  private questionKeyboard(request: QuestionRequest, token: string, selection?: Selection): KeyboardSpec {
    const rows: Array<Array<{ text: string; data: string }>> = [];
    const needsSubmit = request.questions.length > 1 || request.questions.some(question => question.multiple === true);
    request.questions.forEach((question, questionIndex) => {
      const chosen = selection?.[questionIndex] ?? [];
      rows.push(question.options.map((option, optionIndex) => ({
        text: `${chosen.includes(optionIndex) ? "✓ " : ""}${option.label}`.slice(0, 64),
        data: `q:${token}:${questionIndex}:${optionIndex}`,
      })));
    });
    if (needsSubmit) rows.push([{ text: "Submit", data: `q:${token}:send` }]);
    return { rows };
  }

  private stepText(header: string, request: QuestionRequest, step: number): string {
    const question = request.questions[step]!;
    const title = question.header.trim() && question.header.trim() !== question.question.trim() ? ` (${label(question.header)})` : "";
    const body = `${question.question}${question.options.length ? `\n${this.optionList(question)}` : ""}`.slice(0, 3_300);
    const how = !question.options.length ? "Reply to this message with your answer."
      : `${question.multiple === true ? "Tap each option that applies, then Done." : "Tap one option."}${question.custom !== false ? "\nOr reply to this message with your own text." : ""}`;
    return `${header}\nQuestion ${step + 1} of ${request.questions.length}${title}:\n${body}\n\n${how}`;
  }

  private stepKeyboard(request: QuestionRequest, token: string, step: number, selected: number[]): KeyboardSpec {
    const question = request.questions[step]!;
    if (!question.options.length) return { remove: true };
    const rows = [question.options.map((option, optionIndex) => ({
      text: `${selected.includes(optionIndex) ? "✓ " : ""}${option.label}`.slice(0, 64),
      data: `q:${token}:${step}:${optionIndex}`,
    }))];
    if (question.multiple === true) rows.push([{ text: "Done", data: `q:${token}:done:${step}` }]);
    return { rows };
  }

  /** Called again at the final dispatch boundary, including outbox retries. */
  async beforeSend(item: { id: string }): Promise<"send" | "wait" | "cancel"> {
    if (this.stopped) return "wait";
    if (!item.id.startsWith("session-notice:")) return "send";
    const notice = this.store.sessionNotice(item.id);
    if (!notice || notice.state === "cancelled" || notice.state === "sent" || notice.state === "answered") return "cancel";
    const epoch = this.epoch;
    const sessionEpoch = this.sessionEpochs.get(`${notice.directory}\0${notice.sessionId}`);
    try {
      const result = await this.check(notice);
      if (epoch !== this.epoch || this.stopped || sessionEpoch !== this.sessionEpochs.get(`${notice.directory}\0${notice.sessionId}`)) return "wait";
      if (result === "cancel") this.cancel(notice);
      if (result === "cancel") return "cancel";
      if (result === "wait") return "wait";
      return "send";
    } catch { return "wait"; }
  }

  private ack(messageId: number, text: string): void {
    this.store.enqueue({ id: `ack:${messageId}`, kind: "control", text, replyTo: messageId });
  }

  private async handleMessage(update: Extract<TelegramUpdate, { type: "message" }>): Promise<void> {
    const text = update.text.trim();
    const command = text.split(/\s/, 1)[0];
    if (command === "/start" || command === "/help") {
      this.ack(update.messageId, helpText(this.app));
      return;
    }
    if (text === "/status") {
      this.ack(update.messageId, JSON.stringify(this.status()));
      return;
    }
    if (text === "/reminders" || command === "/cancel" || command === "/snooze") {
      // Mutation and acknowledgement commit together, so a replay cannot snooze twice.
      try {
        this.store.db.transaction(() => {
          if (text === "/reminders") {
            const reminders = this.store.listReminders();
            this.ack(update.messageId, reminders.length ? reminders.slice(0, 50).map(r =>
              `${r.id}: ${r.status}, ${new Date(r.dueAt).toISOString()} (${r.timezone}) - ${r.text.slice(0, 200)}`,
            ).join("\n") + (reminders.length > 50 ? "\nShowing first 50 reminders." : "") : "No reminders.");
          } else if (/^\/cancel\s+\S+$/.test(text)) {
            const id = text.split(/\s+/)[1]!;
            this.store.cancelReminder(id);
            this.ack(update.messageId, `Cancelled reminder ${id}.`);
          } else if (command === "/snooze") {
            const match = /^\/snooze\s+(\S+)\s+([1-9]\d*)([mhd])$/.exec(text);
            const duration = match ? Number(match[2]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[match[3] as "m" | "h" | "d"]) : NaN;
            if (!Number.isSafeInteger(duration) || duration > 365 * 86_400_000) {
              this.ack(update.messageId, "Use /snooze ID 5m, 1h, or 2d (positive whole minutes, hours, or days; at most 365 days).");
              return;
            }
            const id = match![1]!;
            const reminder = this.store.snoozeReminder(id, Date.now() + duration);
            this.ack(update.messageId, `Snoozed reminder ${id} until ${new Date(reminder.dueAt).toISOString()}.`);
          } else {
            this.ack(update.messageId, "Use /reminders, /cancel ID, or /snooze ID 5m|1h|2d (at most 365 days).");
          }
        }).immediate();
      } catch {
        this.ack(update.messageId, "Reminder command failed. Check the ID with /reminders; an uncertain notification delivery must be resolved first.");
      }
      return;
    }
    if (command === "/answer") {
      await this.answerCommand(update);
      return;
    }
    if (update.replyToMessageId !== undefined) {
      await this.customReply(update);
      return;
    }
    this.ack(update.messageId, ALERTS_ONLY);
  }

  private async handleCallback(update: Extract<TelegramUpdate, { type: "callback" }>): Promise<void> {
    const match = /^([aq]):([0-9a-f]{16}):(?:(once|reject)|(send)|(\d+):(\d+)|done:(\d+))$/.exec(update.data);
    const fail = async (reason: string) => { await this.transport.answerCallback(update.callbackId, reason).catch(() => {}); };
    if (!match) return fail("This prompt expired.");
    const token = match[2]!;
    const noticeId = this.store.get<string>(`callback:${token}`);
    if (!noticeId) return fail("This prompt expired.");
    const notice = this.store.sessionNotice(noticeId);
    if (!notice || (notice.state !== "sent" && notice.state !== "queued")) return fail("This prompt already resolved.");
    // Buttons are only valid on the message that carried them.
    if (this.store.byProviderId(update.messageId)?.id !== noticeId) return fail("This prompt expired.");
    if (!notice.requestId) return fail("This prompt expired.");
    const requests = notice.kind === "approval" ? await this.backend.permissions(notice.directory) : await this.backend.questions(notice.directory);
    if (!requests) return fail("The backend is unavailable; try again.");
    const request = requests.find(row => row.id === notice.requestId && row.sessionID === notice.sessionId);
    if (!request) {
      await fail(notice.kind === "question" ? "That question is no longer needed." : "That request is no longer pending.");
      this.cancel(notice, notice.kind === "question" ? "[No longer needed]" : "[No longer pending]");
      return;
    }
    if (this.signature(request) !== notice.signature) {
      await fail("That request changed and was not answered.");
      this.cancel({ ...notice, signature: this.signature(request) }, "[Request changed]");
      return;
    }
    if (match[1] === "a") {
      await this.replyApproval(update, notice, request as PermissionRequest, match[3] === "once" ? "once" : "reject");
      return;
    }
    const questionRequest = request as QuestionRequest;
    if (questionRequest.questions.length > 1 && !questionRequest.unsupported && match[4] !== "send") {
      if (match[7] !== undefined) await this.stepDone(update, notice, questionRequest, Number(match[7]));
      else await this.stepOption(update, notice, questionRequest, Number(match[5]), Number(match[6]));
      return;
    }
    if (match[4] === "send") {
      await this.submitSelection(update, notice, questionRequest);
      return;
    }
    if (match[7] !== undefined) return fail("This prompt expired.");
    await this.selectOption(update, notice, questionRequest, Number(match[5]), Number(match[6]));
  }

  private sequence(noticeId: string): Sequence {
    return this.store.get<Sequence | null>(sequenceKey(noticeId)) ?? { answers: [], selected: [] };
  }

  /** The prompt's first line; every step of a multi-question prompt repeats it. */
  private sequenceHeader(noticeId: string): string {
    return (this.store.getOperation(noticeId)?.text ?? `[${this.app}] Questions for you.`).split("\n", 1)[0]!;
  }

  private async showStep(messageId: number, notice: SessionNotice, request: QuestionRequest, sequence: Sequence): Promise<boolean> {
    const chatId = this.options.chatId();
    const step = sequence.answers.length;
    const text = sequence.text ?? this.stepText(this.sequenceHeader(notice.id), request, step);
    if (chatId === undefined) return false;
    return this.transport.editMessageText(chatId, messageId, text,
      this.stepKeyboard(request, callbackToken(notice.id), step, sequence.selected)).then(() => true, () => false);
  }

  private async stepOption(
    update: Extract<TelegramUpdate, { type: "callback" }>,
    notice: SessionNotice,
    request: QuestionRequest,
    questionIndex: number,
    optionIndex: number,
  ): Promise<void> {
    const answer = (text: string) => this.transport.answerCallback(update.callbackId, text).catch(() => {});
    const sequence = this.sequence(notice.id);
    if (questionIndex !== sequence.answers.length) {
      // A stale tap, such as a replayed update; redraw the current question.
      await this.showStep(update.messageId, notice, request, sequence);
      return answer(questionIndex < sequence.answers.length ? "That question was already answered."
        : `Answer question ${sequence.answers.length + 1} first.`);
    }
    const question = request.questions[questionIndex];
    const option = question?.options[optionIndex];
    if (!question || !option) return answer("That option is no longer current.");
    if (question.multiple !== true) {
      await this.advance(update.messageId, notice, request, sequence, [option.label], answer);
      return;
    }
    const cleared = sequence.selected.includes(optionIndex);
    const selected = cleared
      ? sequence.selected.filter(value => value !== optionIndex)
      : [...sequence.selected, optionIndex].sort((a, b) => a - b);
    const next = { ...sequence, selected };
    this.store.set(sequenceKey(notice.id), next);
    await this.showStep(update.messageId, notice, request, next);
    await answer(cleared ? "Cleared." : "Selected.");
  }

  private async stepDone(
    update: Extract<TelegramUpdate, { type: "callback" }>,
    notice: SessionNotice,
    request: QuestionRequest,
    step: number,
  ): Promise<void> {
    const answer = (text: string) => this.transport.answerCallback(update.callbackId, text).catch(() => {});
    const sequence = this.sequence(notice.id);
    const question = request.questions[step];
    if (step !== sequence.answers.length || question?.multiple !== true) {
      await this.showStep(update.messageId, notice, request, sequence);
      return answer("That question was already answered.");
    }
    const labels = sequence.selected.map(optionIndex => question.options[optionIndex]?.label).filter(label => label !== undefined);
    if (!labels.length) return answer("Select at least one option first.");
    await this.advance(update.messageId, notice, request, sequence, labels, answer);
  }

  /** Records one answer, then shows the next question or submits every answer together. */
  private async advance(
    messageId: number,
    notice: SessionNotice,
    request: QuestionRequest,
    sequence: Sequence,
    selected: string[],
    respond: (text: string) => Promise<unknown>,
  ): Promise<void> {
    const answers = [...sequence.answers, selected];
    if (answers.length < request.questions.length) {
      const text = this.stepText(this.sequenceHeader(notice.id), request, answers.length);
      const next: Sequence = { answers, selected: [], text };
      this.store.set(sequenceKey(notice.id), next);
      await this.showStep(messageId, notice, request, next);
      await respond(`Recorded. Question ${answers.length + 1} of ${request.questions.length} is next.`);
      return;
    }
    const result = await this.submit(notice, request, answers);
    if (result === "invalid") return void await respond(INVALID_ANSWERS);
    if (result === "failed") return void await respond("The reply failed; try again.");
    await respond("Answered.");
    const chatId = this.options.chatId();
    if (chatId === undefined) return;
    await this.transport.editMessageText(chatId, messageId, this.summaryText(notice.id, request, answers), { remove: true }).catch(() => {});
  }

  private summaryText(noticeId: string, request: QuestionRequest, answers: string[][]): string {
    const lines = request.questions.map((question, index) => `${index + 1}. ${question.question}\n${(answers[index] ?? []).join(", ")}`);
    return `${this.sequenceHeader(noticeId)}\n${lines.join("\n")}`.slice(0, 3_900) + "\n\n[Answered]";
  }

  private validAnswers(request: QuestionRequest, answers: string[][]): boolean {
    return !request.unsupported && answers.length === request.questions.length && request.questions.every((question, questionIndex) => {
      const selected = answers[questionIndex] ?? [];
      return selected.length > 0 && (question.multiple === true || selected.length === 1)
        && new Set(selected).size === selected.length
        && selected.every(value => value.trim() && (question.custom !== false || question.options.some(option => option.label === value)));
    });
  }

  /** The single reply path; callers have already revalidated the live request and signature. */
  private async submit(notice: SessionNotice, request: QuestionRequest, answers: string[][]): Promise<"ok" | "invalid" | "failed"> {
    if (!this.validAnswers(request, answers)) return "invalid";
    try {
      const result = await this.backend.questionReply(request, notice.directory, answers);
      if (result !== true) throw new Error();
    } catch {
      return "failed";
    }
    this.markAnswered(notice);
    return "ok";
  }

  private async replyApproval(
    update: Extract<TelegramUpdate, { type: "callback" }>,
    notice: SessionNotice,
    request: PermissionRequest,
    decision: "once" | "reject",
  ): Promise<void> {
    const answer = (text: string) => this.transport.answerCallback(update.callbackId, text).catch(() => {});
    try {
      const result = await this.backend.permissionReply(request.sessionID, request.id, notice.directory, decision);
      if (result !== true) throw new Error();
    } catch {
      await answer("The reply failed; try again.");
      return;
    }
    this.store.saveSessionNotice({ ...notice, state: "answered" });
    await answer(decision === "once" ? "Approved once." : "Rejected.");
    await this.finishPrompt(update, notice, decision === "once" ? "[Approved once]" : "[Rejected]");
  }

  private async selectOption(
    update: Extract<TelegramUpdate, { type: "callback" }>,
    notice: SessionNotice,
    request: QuestionRequest,
    questionIndex: number,
    optionIndex: number,
  ): Promise<void> {
    const answer = (text: string) => this.transport.answerCallback(update.callbackId, text).catch(() => {});
    if (request.unsupported) return answer(`Answer this form in ${this.app}.`);
    const question = request.questions[questionIndex];
    if (!question || !question.options[optionIndex]) return answer("That option is no longer current.");
    if (request.questions.length === 1 && question.multiple !== true) {
      await this.answerQuestion(update, notice, request, [[question.options[optionIndex]!.label]]);
      return;
    }
    const key = `selection:${notice.id}`;
    const selection = (this.store.get<Selection>(key) ?? {});
    const current = selection[questionIndex] ?? [];
    const next = current.includes(optionIndex)
      ? current.filter(value => value !== optionIndex)
      : [...current, optionIndex].sort((a, b) => a - b);
    if (next.length) selection[questionIndex] = next;
    else delete selection[questionIndex];
    this.store.set(key, selection);
    const chatId = this.options.chatId();
    if (chatId === undefined) return answer("Selection recorded.");
    const token = callbackToken(notice.id);
    const text = this.store.getOperation(notice.id)?.text;
    if (text === undefined) return answer("Selection recorded.");
    await this.transport.editMessageText(chatId, update.messageId, text, this.questionKeyboard(request, token, selection))
      .then(() => answer(current.includes(optionIndex) ? "Cleared." : "Selected."))
      .catch(() => answer("Selection recorded."));
  }

  private async submitSelection(
    update: Extract<TelegramUpdate, { type: "callback" }>,
    notice: SessionNotice,
    request: QuestionRequest,
  ): Promise<void> {
    const answer = (text: string) => this.transport.answerCallback(update.callbackId, text).catch(() => {});
    const selection = this.store.get<Selection>(`selection:${notice.id}`) ?? {};
    const missing = request.questions.findIndex((_, questionIndex) => !(selection[questionIndex]?.length));
    if (missing >= 0) return answer(`Select an option for question ${missing + 1} first.`);
    const answers = request.questions.map((question, questionIndex) =>
      (selection[questionIndex] ?? []).map(optionIndex => question.options[optionIndex]?.label).filter(label => label !== undefined));
    await this.answerQuestion(update, notice, request, answers);
  }

  private async answerQuestion(
    update: Extract<TelegramUpdate, { type: "callback" }>,
    notice: SessionNotice,
    request: QuestionRequest,
    answers: string[][],
  ): Promise<void> {
    const answer = (text: string) => this.transport.answerCallback(update.callbackId, text).catch(() => {});
    const result = await this.submit(notice, request, answers);
    if (result === "invalid") return answer(INVALID_ANSWERS);
    if (result === "failed") return answer("The reply failed; try again.");
    await answer("Answered.");
    await this.finishPrompt(update, notice, "[Answered]");
  }

  private async customReply(update: Extract<TelegramUpdate, { type: "message" }>): Promise<void> {
    const referenced = this.store.byProviderId(update.replyToMessageId!);
    const notice = referenced ? this.store.sessionNotice(referenced.id) : undefined;
    if (!referenced || !notice || notice.kind !== "question"
      || (notice.state !== "sent" && notice.state !== "queued") || !notice.requestId) {
      this.ack(update.messageId, "Reply to a current question prompt to answer it with your own text.");
      return;
    }
    const requests = await this.backend.questions(notice.directory);
    const request = requests?.find(row => row.id === notice.requestId && row.sessionID === notice.sessionId);
    if (requests && !request) {
      this.ack(update.messageId, "That question is no longer needed. No answer was sent.");
      this.cancel(notice, "[No longer needed]");
      return;
    }
    const current = request?.questions[request.questions.length > 1 ? this.sequence(notice.id).answers.length : 0];
    if (!request || this.signature(request) !== notice.signature || request.unsupported || !current || current.custom === false) {
      this.ack(update.messageId, "That question is no longer current or does not accept custom text.");
      return;
    }
    const text = update.text.trim();
    if (!text) {
      this.ack(update.messageId, "Send a nonempty answer.");
      return;
    }
    if (request.questions.length > 1) {
      // Typed text joins any options already toggled on a multi-select question.
      const sequence = this.sequence(notice.id);
      const toggled = current.multiple === true
        ? sequence.selected.map(optionIndex => current.options[optionIndex]?.label).filter(label => label !== undefined) : [];
      await this.advance(referenced.providerId ?? update.replyToMessageId!, notice, request, sequence, [...new Set([...toggled, text])],
        async reply => this.ack(update.messageId, reply));
      return;
    }
    const result = await this.submit(notice, request, [[text]]);
    if (result !== "ok") {
      this.ack(update.messageId, result === "invalid" ? INVALID_ANSWERS : "The reply failed; try again.");
      return;
    }
    this.ack(update.messageId, "Answered.");
    const chatId = this.options.chatId();
    const prompt = this.store.getOperation(notice.id);
    if (chatId !== undefined && prompt?.providerId !== undefined) {
      await this.transport.editMessageText(chatId, prompt.providerId, `${prompt.text}\n\n[Answered]`, { remove: true }).catch(() => {});
    }
  }

  private async answerCommand(update: Extract<TelegramUpdate, { type: "message" }>): Promise<void> {
    const match = /^\/answer\s+(\S+)\s+(\[[\s\S]+)$/.exec(update.text.trim());
    if (!match) {
      this.ack(update.messageId, 'Use /answer REQUESTID with a JSON array of string arrays, for example [["choice"]].');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[2]!);
      if (!Array.isArray(parsed) || !parsed.every(value => Array.isArray(value) && value.every(item => typeof item === "string"))) throw new Error();
    } catch {
      this.ack(update.messageId, 'Use /answer REQUESTID with a JSON array of string arrays, for example [["choice"]].');
      return;
    }
    const noticeId = this.store.get<string>(`request-notice:${match[1]!}`);
    const notice = noticeId ? this.store.sessionNotice(noticeId) : undefined;
    if (!notice || (notice.state !== "sent" && notice.state !== "queued") || !notice.requestId || notice.requestId !== match[1]) {
      this.ack(update.messageId, "No matching current prompt. Use the exact request ID from the question prompt.");
      return;
    }
    const requests = await this.backend.questions(notice.directory);
    const request = requests?.find(row => row.id === notice.requestId && row.sessionID === notice.sessionId);
    if (!request || this.signature(request) !== notice.signature) {
      this.ack(update.messageId, "That request is no longer current or has changed. No answer was sent.");
      return;
    }
    const answers = parsed as string[][];
    const text = this.promptText(notice.id);
    const result = await this.submit(notice, request, answers);
    if (result !== "ok") {
      this.ack(update.messageId, result === "invalid" ? INVALID_ANSWERS : "The reply failed; try again.");
      return;
    }
    this.ack(update.messageId, `Answer sent for request ${request.id}.`);
    const chatId = this.options.chatId();
    const prompt = this.store.getOperation(notice.id);
    if (chatId !== undefined && prompt?.providerId !== undefined && text !== undefined) {
      await this.transport.editMessageText(chatId, prompt.providerId, `${text}\n\n[Answered]`, { remove: true }).catch(() => {});
    }
  }

  private async finishPrompt(
    update: Extract<TelegramUpdate, { type: "callback" }>,
    notice: SessionNotice,
    suffix: string,
  ): Promise<void> {
    const chatId = this.options.chatId();
    const text = this.store.getOperation(notice.id)?.text;
    if (chatId === undefined || text === undefined) return;
    await this.transport.editMessageText(chatId, update.messageId, `${text}\n\n${suffix}`, { remove: true }).catch(() => {});
  }
}

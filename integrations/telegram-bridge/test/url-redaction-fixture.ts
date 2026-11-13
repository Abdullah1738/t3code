import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { KeyboardSpec } from "../src/store.ts";
import { urlRedactionCases } from "./url-redaction-cases.ts";

const sent: string[] = [];
mock.module("grammy", () => ({
  Bot: class {
    api = {
      sendMessage: async (_chat: number, text: string, _options: unknown) => {
        sent.push(text);
        return { message_id: sent.length };
      },
      editMessageText: async (_chat: number, _message: number, text: string) => { sent.push(text); },
      answerCallbackQuery: async (_id: string, options: { text: string }) => { sent.push(options.text); },
      sendDocument: async (_chat: number, _file: unknown, options: { caption: string }) => {
        sent.push(options.caption);
        return { message_id: sent.length };
      },
    };
  },
  GrammyError: class extends Error {},
  HttpError: class extends Error {},
  InputFile: class {},
}));
const { Telegram } = await import("../src/telegram.ts");
const { Store } = await import("../src/store.ts");
const { Delivery } = await import("../src/delivery.ts");
const { createApi } = await import("../src/api.ts");
const { parseCommand } = await import("../src/cli.ts");
const transport = new Telegram("offline-dummy", "1");
for (const row of urlRedactionCases) {
  const store = new Store(":memory:");
  try {
    const api = createApi({ store, enabled: () => true, chatId: () => 100, timezone: "UTC", health: () => ({}) });
    const command = parseCommand(["notify", "--source", "tests", "--text", row.input, "--key", row.label]);
    const response = await api(new Request("http://bridge/notify", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(command.body) }));
    assert.equal(response.status, 202, row.label);
    const delivery = new Delivery(store, transport, { enabled: () => true, chatId: () => 100, sleep: async () => {} });
    await delivery.tick();
    assert.equal(sent.at(-1), "[tests] " + row.expected, row.label);

    // Resume a two-chunk legacy operation with chunk zero already accepted.
    const prefix = "x".repeat(3899) + "\n";
    const keyboard: KeyboardSpec = { rows: [[{ text: "Continue", data: "offline" }]] };
    store.enqueue({ id: "legacy", kind: "notification", text: prefix + row.input + " safe-tail", keyboard });
    store.outboxState("legacy", "sending");
    store.outboxState("legacy", "pending");
    store.set("firstAttempt:legacy", Date.now());
    store.set("chunk:legacy:0", { accepted: true, providerId: 500 });
    await delivery.tick();
    const legacy = sent.at(-1)!;
    assert(!legacy.includes("SECRET"), row.label);
    assert(legacy.includes("safe-tail"), row.label);
    assert.equal(store.getOperation("legacy")?.state, "sent", row.label);

    // Direct sends, edits, callback text and captions also redact without the outbox.
    await transport.sendMessage({ chatId: 100, text: row.input });
    assert.equal(sent.at(-1), row.expected, row.label);
    await transport.editMessageText(100, 1, row.input);
    assert.equal(sent.at(-1), row.expected, row.label);
    await transport.answerCallback("offline", row.input);
    assert.equal(sent.at(-1), row.expected, row.label);
    await transport.sendDocument({ chatId: 100, data: new Uint8Array([1]), name: "test.txt",
      mimeType: "text/plain", caption: row.input });
    assert.equal(sent.at(-1), row.expected, row.label);
  } finally { store.close(); }
}
console.log(JSON.stringify({ cases: urlRedactionCases.length, calls: sent.length }));

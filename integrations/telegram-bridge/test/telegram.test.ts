import { expect, test } from "bun:test";
import { GrammyError, HttpError } from "grammy";
import { MAX_TEXT, Telegram, TransportError, classifySendFailure } from "../src/telegram.ts";

test("constructor validates credentials and owner without network access", () => {
  expect(() => new Telegram("", "1")).toThrow(TransportError);
  expect(() => new Telegram(" token with newline\n", "1")).toThrow(TransportError);
  expect(() => new Telegram("123:abc", "abc")).toThrow(TransportError);
  expect(() => new Telegram("123:abc", "1234567890123456789")).toThrow(TransportError);
  const discovery = new Telegram("123:abc", "");
  expect(discovery.ownerId).toBe("");
  const pinned = new Telegram("123:abc", "123456789");
  expect(pinned.ownerId).toBe("123456789");
  expect(MAX_TEXT).toBe(4_096);
});

test("TransportError classification carries retryability and ambiguity verbatim", () => {
  expect(classifySendFailure(new TransportError("telegramNetwork", true, true)))
    .toEqual({ retryable: true, uncertain: true, code: "telegramNetwork" });
  expect(classifySendFailure(new TransportError("blocked", false, false)))
    .toEqual({ retryable: false, uncertain: false, code: "blocked" });
});

test("GrammyError 429 uses the server-provided retry_after and is never ambiguous", () => {
  const flood = new GrammyError("flood", { ok: false, error_code: 429, description: "Too Many Requests",
    parameters: { retry_after: 7 } }, "sendMessage", {});
  expect(classifySendFailure(flood)).toEqual({ retryable: true, uncertain: false, code: "floodWait", retryAfterMs: 7_500 });
  const floodWithoutHint = new GrammyError("flood", { ok: false, error_code: 429, description: "Too Many Requests" }, "sendMessage", {});
  expect(classifySendFailure(floodWithoutHint)).toEqual({ retryable: true, uncertain: false, code: "floodWait", retryAfterMs: 1_500 });
});

test("GrammyError codes map to conflict, retryable-uncertain 5xx, permanent 4xx, and unknown", () => {
  const conflict = new GrammyError("c", { ok: false, error_code: 409, description: "Conflict" }, "getUpdates", {});
  expect(classifySendFailure(conflict)).toEqual({ retryable: true, uncertain: false, code: "telegramConflict" });
  const serverError = new GrammyError("s", { ok: false, error_code: 502, description: "Bad Gateway" }, "sendMessage", {});
  expect(classifySendFailure(serverError)).toEqual({ retryable: true, uncertain: true, code: "telegramHttp502" });
  const permanent = new GrammyError("p", { ok: false, error_code: 400, description: "Bad Request" }, "sendMessage", {});
  expect(classifySendFailure(permanent)).toEqual({ retryable: false, uncertain: false, code: "telegramHttp400" });
  const odd = new GrammyError("o", { ok: false, error_code: 301, description: "Moved" }, "sendMessage", {});
  expect(classifySendFailure(odd)).toEqual({ retryable: true, uncertain: true, code: "unknownSendFailure" });
});

test("network-level failures and unknown throws are retryable and uncertain", () => {
  expect(classifySendFailure(new HttpError("fetch failed", new Error("PRIVATE_NETWORK_DETAIL"))))
    .toEqual({ retryable: true, uncertain: true, code: "telegramNetwork" });
  expect(classifySendFailure(new Error("PRIVATE_DETAIL")))
    .toEqual({ retryable: true, uncertain: true, code: "unknownSendFailure" });
});

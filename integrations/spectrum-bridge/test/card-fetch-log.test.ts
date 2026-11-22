import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardPreviewImage } from "../src/card-preview.ts";
import { renderCardId } from "../src/log-card-fetch.ts";
import { summarizeLog } from "../src/log-rollup.ts";
import { createToolLog, type LogLine } from "../src/toollog.ts";
import { captureLogs } from "./log-fixture.ts";

const pageUrl = "https://cards.abdullah.fund/s/PRIVATE_PATH/?token=PRIVATE_QUERY#PRIVATE_FRAGMENT";
const privateError = () => new Error(`PRIVATE_CONTENT ${pageUrl}`);
const errorCode = (code: string) => Object.assign(privateError(), { code });
const fakeFetch = (action: () => Promise<Response>) => Object.assign(action, { preconnect: fetch.preconnect });

// Both Bun's direct codes and Node's nested fetch causes occur on supported render hosts.
const transportCases = [
  ["timeout", new DOMException("PRIVATE_CONTENT", "TimeoutError")],
  ["timeout", new DOMException("PRIVATE_CONTENT", "AbortError")],
  ...["Timeout", "ETIMEDOUT", "ABORT_ERR", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].map(code => ["timeout", errorCode(code)] as const),
  ...["ENOTFOUND", "EAI_AGAIN", "DNSResolveFailed", "DNSResolutionFailed"].map(code => ["dns", errorCode(code)] as const),
  ...["ECONNREFUSED", "ECONNRESET", "ConnectionRefused", "ConnectionClosed", "FailedToOpenSocket", "UND_ERR_SOCKET"].map(code => ["connect", errorCode(code)] as const),
  ...["TLSHandshakeFailed", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER"].map(code => ["tls", errorCode(code)] as const),
  ["dns", new TypeError("fetch failed", { cause: errorCode("ENOTFOUND") })],
  ["connect", new TypeError("fetch failed", { cause: new AggregateError([errorCode("ECONNREFUSED")]) })],
  ["other", privateError()],
  ["other", errorCode("PRIVATE_CODE")],
  ["other", Object.defineProperty({}, "code", { get() { throw privateError(); } })],
] as const;

test.each(transportCases)("page fetch logs %s for transport error %#", async (fetchCause, error) => {
  let request: RequestInit | undefined;
  const fetchFn = Object.assign(async (_url: unknown, init?: RequestInit) => { request = init; throw error; }, { preconnect: fetch.preconnect });
  const rows = await captureLogs(async () => {
    await expect(cardPreviewImage(async () => { throw new Error("must not upload"); }, fetchFn, "owner")(pageUrl))
      .rejects.toMatchObject({ code: "card_preview_unavailable", retryable: true, uncertain: false });
  });
  const row = rows.find(row => row.name === "card.render")!;
  expect(row).toMatchObject({ component: "cards", kind: "perf", ok: false, ids: { chat: "owner", cardId: renderCardId(pageUrl) },
    props: { failureCode: "page_fetch", cardKind: "other", outcome: "failed", attempt: 1, fetchCause, urlClass: "cards.abdullah.fund", bytesReceived: 0 } });
  expect(row.props?.httpStatus).toBeUndefined();
  expect(Number(row.props?.elapsedMs)).toBeGreaterThanOrEqual(0);
  expect(Number(row.props?.elapsedMs)).toBeLessThanOrEqual(row.durationMs!);
  expect(request?.redirect).toBe("follow");
  expect(request?.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|https:\/\/|\/s\//);
});

test.each([404, 503, 530])("HTTP %s logs status and keeps page_http", async httpStatus => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: httpStatus });
  const rows = await captureLogs(async () => {
    await expect(cardPreviewImage(async () => "", fakeFetch(async () => response))(pageUrl)).rejects.toThrow();
  });
  expect(cancelled).toBe(true);
  expect(rows.find(row => row.name === "card.render")?.props).toMatchObject({ failureCode: "page_http", fetchCause: "http_status", httpStatus, bytesReceived: 0 });
});

test("status on a thrown fetch error is retained", async () => {
  const rows = await captureLogs(async () => {
    await expect(cardPreviewImage(async () => "", fakeFetch(async () => { throw Object.assign(privateError(), { status: 530 }); }))(pageUrl)).rejects.toThrow();
  });
  expect(rows.find(row => row.name === "card.render")?.props).toMatchObject({ failureCode: "page_fetch", fetchCause: "http_status", httpStatus: 530 });
});

test.each([false, true])("page body failures keep partial byte count; timeout=%s", async timeout => {
  let reads = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode("PRIVATE_CONTENT"));
      else controller.error(timeout ? new DOMException("PRIVATE_CONTENT", "TimeoutError") : privateError());
    },
  }), { headers: { "content-type": "text/html" } });
  const rows = await captureLogs(async () => {
    await expect(cardPreviewImage(async () => "", fakeFetch(async () => response))(pageUrl)).rejects.toThrow();
  });
  expect(rows.find(row => row.name === "card.render")?.props).toMatchObject({ failureCode: "page_body", fetchCause: timeout ? "timeout" : "body_read", httpStatus: 200, bytesReceived: 15 });
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|https:\/\/|\/s\//);
});

test.each([null, "", new Uint8Array(512 * 1024 + 1)])("empty and over-limit bodies remain page_body (%#)", async body => {
  const rows = await captureLogs(async () => {
    await expect(cardPreviewImage(async () => "", fakeFetch(async () => new Response(body, { headers: { "content-type": "text/html" } })))(pageUrl)).rejects.toThrow();
  });
  expect(rows.find(row => row.name === "card.render")?.props).toMatchObject({ failureCode: "page_body", fetchCause: "body_read", httpStatus: 200, bytesReceived: body?.length ?? 0 });
});

test("non-HTML page preserves page_type", async () => {
  const rows = await captureLogs(async () => {
    await expect(cardPreviewImage(async () => "", fakeFetch(async () => new Response("PRIVATE_CONTENT")))(pageUrl)).rejects.toThrow();
  });
  expect(rows.find(row => row.name === "card.render")?.props).toMatchObject({ failureCode: "page_type", fetchCause: "other", httpStatus: 200, bytesReceived: 0 });
});

test.each([
  ["cards.abdullah.fund", "cards.abdullah.fund"],
  ["PRIVATE_HOST.trycloudflare.com", "trycloudflare.com"],
  ["PRIVATE_HOST.example", "other"],
])("only safe host classes enter rows (%s)", async (host, urlClass) => {
  const url = `https://${host}:8443/s/PRIVATE_PATH/?token=PRIVATE_QUERY#PRIVATE_FRAGMENT`;
  const rows = await captureLogs(async () => {
    await expect(cardPreviewImage(async () => "", fakeFetch(async () => { throw privateError(); }))(url)).rejects.toThrow();
  });
  expect(rows.find(row => row.name === "card.render")?.props?.urlClass).toBe(urlClass);
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|8443|https:\/\/|\/s\//);
});

test.each([false, true])("new fields survive sanitization and reject private values, defer=%s", async defer => {
  const root = mkdtempSync(join(tmpdir(), "card-fetch-log-"));
  try {
    const log = createToolLog({ root, defer, now: () => Date.parse("2026-11-22T12:00:00Z") });
    log.write({ component: "cards", kind: "perf", name: "card.render", ok: false, ids: { cardId: pageUrl },
      props: { failureCode: "page_fetch", fetchCause: "PRIVATE_CAUSE", urlClass: pageUrl, httpStatus: 999, elapsedMs: -1, bytesReceived: Infinity } });
    log.write({ component: "cards", kind: "perf", name: "card.render", ok: false, ids: { cardId: renderCardId(pageUrl) },
      props: { failureCode: "page_fetch", fetchCause: "timeout", urlClass: "cards.abdullah.fund", httpStatus: 530, elapsedMs: 250.5, bytesReceived: 42 } });
    log.flush();
    await log.settled();
    const raw = readFileSync(join(root, "2026-11-22.ndjson"), "utf8");
    const rows = raw.trim().split("\n").map(line => JSON.parse(line));
    expect(rows[0].props).toEqual({ failureCode: "page_fetch" });
    expect(rows[0].ids.cardId).toBeUndefined();
    expect(rows[1]).toMatchObject({ ids: { cardId: renderCardId(pageUrl) }, props: {
      failureCode: "page_fetch", fetchCause: "timeout", urlClass: "cards.abdullah.fund", httpStatus: 530, elapsedMs: 250.5, bytesReceived: 42 } });
    expect(raw).not.toMatch(/PRIVATE|https:\/\/|\/s\//);
    const rollup = await log.rollup("2026-11-22");
    expect(rollup?.cardRenderFetchFailures).toContainEqual({ failureCode: "page_fetch", fetchCause: "timeout", httpStatus: 530, count: 1, cardIds: [renderCardId(pageUrl)] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rollup keeps legacy totals and splits page causes/status with distinct card ids", async () => {
  const id1 = renderCardId(pageUrl), id2 = renderCardId(`${pageUrl}2`);
  const row = (failureCode: string, fetchCause?: string, httpStatus?: number, cardId?: string, ok = false): LogLine => ({
    ts: "2026-11-22T12:00:00Z", tool: "imessage", component: "cards", name: "card.render", kind: "perf", ok,
    ids: cardId ? { cardId } : {}, props: { failureCode, ...(fetchCause ? { fetchCause } : {}), ...(httpStatus ? { httpStatus } : {}) },
  });
  async function* lines() {
    yield row("page_fetch", "timeout", undefined, id1);
    yield row("page_fetch", "timeout", undefined, id1);
    yield row("page_fetch", "dns", undefined, id2);
    yield row("page_fetch"); // Older rows have no cause; don't invent one.
    yield row("page_fetch", "http_status", 530, id2);
    yield row("page_fetch", "http_status", 503, id1);
    yield row("page_http", "http_status", 530, id2);
    yield row("page_body", "body_read", 200, id2);
    yield row("image_fetch");
    yield row("none", undefined, undefined, undefined, true);
  }
  const result = await summarizeLog(lines());
  expect(result.cardRenderFailures).toEqual({ page_fetch: 6, page_http: 1, page_body: 1, image_fetch: 1 });
  expect(result.cardRenderFetchFailures).toHaveLength(7);
  expect(result.cardRenderFetchFailures).toContainEqual({ failureCode: "page_fetch", fetchCause: "timeout", count: 2, cardIds: [id1] });
  expect(result.cardRenderFetchFailures).toContainEqual({ failureCode: "page_fetch", fetchCause: "unknown", count: 1, cardIds: [] });
  for (const httpStatus of [503, 530]) expect(result.cardRenderFetchFailures).toContainEqual({ failureCode: "page_fetch", fetchCause: "http_status", httpStatus, count: 1, cardIds: [httpStatus === 503 ? id1 : id2] });
  expect(result.cardRenderFetchFailures.reduce((sum, item) => sum + item.count, 0)).toBe(8);
});

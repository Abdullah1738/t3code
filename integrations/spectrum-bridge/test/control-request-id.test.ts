import { expect, spyOn, test } from "bun:test";
import { ControlClient, CONTROL_REQUEST_ID_HEADER } from "../src/control.ts";
import { toolLog } from "../src/toollog.ts";
import { captureLogs } from "./log-fixture.ts";

const fetchPreconnect = globalThis.fetch.preconnect;
const fetchMock = (implementation: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch =>
  Object.assign(implementation, { preconnect: fetchPreconnect });

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const client = () => new ControlClient({ url: "http://127.0.0.1:3773", token: "PRIVATE_TOKEN" });
const ok = () => new Response(JSON.stringify({ ok: true }));

test("two requests in one batch send distinct per-call IDs and retain them next to thread/batch IDs", async () => {
  const sent: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(fetchMock(async (_url, init) => {
    const id = new Headers(init?.headers).get(CONTROL_REQUEST_ID_HEADER)!;
    sent.push(id);
    return new Response(JSON.stringify({ ok: false }), { status: 409, headers: { [CONTROL_REQUEST_ID_HEADER]: id } });
  }));
  try {
    const rows = await captureLogs(async () => {
      toolLog.beginRun("id-thread", "id-message");
      await client().request("POST", "/threads/id-thread/send?text=PRIVATE_QUERY", { text: "PRIVATE_MESSAGE" }).catch(() => {});
      await client().request("POST", "/threads/id-thread/send?text=PRIVATE_QUERY", { text: "PRIVATE_MESSAGE" }).catch(() => {});
    });
    const details = rows.filter(row => row.name === "turn.robob_call");
    expect(details).toHaveLength(2);
    expect(details.map(row => row.ids?.requestId)).toEqual(sent);
    expect(new Set(sent).size).toBe(2);
    expect(details[0].ids?.callBatchId).toBe(details[1].ids?.callBatchId);
    expect(details[0].ids?.callBatchId).toBeTruthy();
    for (const row of details) {
      expect(row.ids?.requestId).toMatch(uuid);
      expect(row.ids?.requestId).not.toBe(row.ids?.callBatchId);
      expect(row.ids?.threadId).toBe("id-thread");
      expect(row.ids?.serverRequestId).toBeUndefined();
      expect(row.props?.route).toBe("/threads/:id/send");
    }
    for (const summary of rows.filter(row => row.name === "turn.robob_calls")) {
      expect(summary.ids?.requestId).toBeUndefined();
      expect(summary.ids?.serverRequestId).toBeUndefined();
    }
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
  } finally { fetcher.mockRestore(); }
});

test.each(["fetch", "body"])("timed-out %s calls retain their sent ID even when the server cannot finish responding", async stage => {
  let sent: string | null = null;
  const serverId = "91274f60-34f8-4298-bf6d-a96a95f36503";
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(fetchMock(async () => ok()));
  try {
    const rows = await captureLogs(async () => {
      const api = client();
      await api.request("GET", "/health");
      fetcher.mockImplementation(fetchMock(async (_url, init) => {
        sent = new Headers(init?.headers).get(CONTROL_REQUEST_ID_HEADER);
        const failure = new DOMException("PRIVATE_MESSAGE", "TimeoutError");
        if (stage === "fetch") throw failure;
        return { ok: true, status: 200, headers: new Headers({ [CONTROL_REQUEST_ID_HEADER]: serverId }), json: async () => { throw failure; } } as unknown as Response;
      }));
      await api.request("GET", "/threads/id-thread/messages?query=PRIVATE_QUERY").catch(() => {});
      fetcher.mockImplementation(fetchMock(async () => ok()));
      await api.request("GET", "/health");
    });
    const failed = rows.find(row => row.name === "turn.robob_call" && row.ok === false)!;
    expect(sent).toMatch(uuid);
    expect(failed.ids?.requestId).toBe(sent!);
    expect(failed.ids?.serverRequestId).toBe(stage === "body" ? serverId : undefined);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
  } finally { fetcher.mockRestore(); }
});

test("the first five retained outage failures carry the corresponding request IDs", async () => {
  const sent: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(fetchMock(async () => ok()));
  try {
    const rows = await captureLogs(async () => {
      const api = client();
      await api.request("GET", "/health");
      fetcher.mockImplementation(fetchMock(async (_url, init) => {
        sent.push(new Headers(init?.headers).get(CONTROL_REQUEST_ID_HEADER)!);
        throw Object.assign(new TypeError("PRIVATE_MESSAGE"), { code: "ECONNREFUSED" });
      }));
      for (let i = 0; i < 10; i++) await api.request("GET", "/threads/id-thread/messages").catch(() => {});
      fetcher.mockImplementation(fetchMock(async () => ok()));
      await api.request("GET", "/health");
    });
    const failures = rows.filter(row => row.name === "turn.robob_call" && row.ok === false);
    expect(failures.map(row => row.ids?.requestId)).toEqual(sent.slice(0, 5));
    expect(new Set(sent).size).toBe(10);
  } finally { fetcher.mockRestore(); }
});

test.each([undefined, "same", "91274f60-34f8-4298-bf6d-a96a95f36503", "PRIVATE_MESSAGE", "PRIVATE_TOKEN"])("server echo %s is logged separately only when it is a different UUID", async echo => {
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(fetchMock(async (_url, init) => {
    const id = new Headers(init?.headers).get(CONTROL_REQUEST_ID_HEADER)!;
    return new Response(JSON.stringify({ ok: false }), { status: 409,
      headers: echo ? { [CONTROL_REQUEST_ID_HEADER]: echo === "same" ? id : echo } : {} });
  }));
  try {
    const rows = await captureLogs(async () => { await client().request("GET", "/threads/id-thread").catch(() => {}); });
    const row = rows.find(row => row.name === "turn.robob_call")!;
    expect(row.ids?.serverRequestId).toBe(echo?.match(uuid) ? echo : undefined);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
  } finally { fetcher.mockRestore(); }
});

import * as DateTime from "effect/DateTime";

interface Delivery {
  readonly responseDelivery: "finished" | "closed";
  readonly responseElapsedMs: number;
}

export interface HttpRequestLifecycle {
  readonly receivedAt: string;
  readonly elapsedMs: () => number;
  readonly onSettled: (record: (fields: Delivery) => void) => void;
}

const requests = new WeakMap<object, HttpRequestLifecycle>();

export const forRequest = (source: object) => requests.get(source);

export function observe(
  request: object,
  response: {
    readonly once: (event: "finish" | "close", listener: () => void) => unknown;
    readonly off: (event: "finish" | "close", listener: () => void) => unknown;
  },
  now = () => performance.now(),
) {
  const started = now();
  const listeners = new Set<(fields: Delivery) => void>();
  let settled: Delivery | undefined;
  const elapsedMs = () => Math.max(0, now() - started);
  const settle = (responseDelivery: "finished" | "closed") => {
    if (settled) return;
    settled = { responseDelivery, responseElapsedMs: elapsedMs() };
    response.off("finish", finished);
    response.off("close", closed);
    for (const listener of listeners) listener(settled);
    listeners.clear();
  };
  const finished = () => settle("finished");
  const closed = () => settle("closed");
  const lifecycle: HttpRequestLifecycle = {
    receivedAt: DateTime.formatIso(DateTime.makeUnsafe(performance.timeOrigin + started)),
    elapsedMs,
    onSettled: (record) => {
      if (settled) record(settled);
      else listeners.add(record);
    },
  };
  requests.set(request, lifecycle);
  // finish means Node handed bytes to the socket, not that the client read them.
  response.once("finish", finished);
  response.once("close", closed);
}

export const STREAM_END_KINDS = ["errorFrame", "clean", "thrown", "aborted"] as const;
export type StreamEndKind = typeof STREAM_END_KINDS[number];
export const STREAM_ERROR_CODE = /^[a-z0-9_.-]{1,40}$/;
export const STREAM_ERROR_CODE_LIMIT = 20;

export interface StreamTelemetry {
  streamConnects: number;
  streamEndsByKind: Record<StreamEndKind, number>;
  streamLastConnectedMs: number | null;
  streamMinConnectedMs: number | null;
  streamMaxConnectedMs: number | null;
  streamErrorCodes: Record<string, number>;
  lastStreamEndAt: string | null;
  lastStreamEndKind: StreamEndKind | null;
}

export function streamErrorCode(value: unknown): string {
  return typeof value === "string" && STREAM_ERROR_CODE.test(value) ? value : "none";
}

export function countStreamError(codes: Record<string, number>, value: unknown, count = 1): string {
  const code = streamErrorCode(value);
  const key = Object.hasOwn(codes, code) || (code !== "other" && Object.keys(codes).filter(key => key !== "other").length < STREAM_ERROR_CODE_LIMIT)
    ? code : "other";
  // __proto__ and constructor also satisfy the server's code grammar.
  Object.defineProperty(codes, key, { value: (Object.hasOwn(codes, key) ? codes[key]! : 0) + count, enumerable: true, configurable: true, writable: true });
  return key;
}

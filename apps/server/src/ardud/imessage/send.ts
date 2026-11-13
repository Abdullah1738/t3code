/**
 * Pure pieces of the `imessage_send` MCP tool: the default dedupe key, the
 * bridge CLI argv, and reading the CLI's reply. The service wires them to the
 * calling thread and the CLI runner.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no sync sha256 helper.
import * as NodeCrypto from "node:crypto";

import type { ImessageSendMcpInput } from "@t3tools/contracts";

/** What the bridge CLI is asked to do; text is omitted when blank. */
export interface ImessageSendRequest {
  readonly text: string | undefined;
  readonly file: string | undefined;
  readonly to: string | undefined;
  readonly effect: ImessageSendMcpInput["effect"];
  readonly session: string;
  readonly key: string;
}

export const MAX_ERROR_CHARS = 500;

/**
 * The default dedupe key: the same call retried in the same run never sends
 * twice, while the same text in a later run (a new turn) does send.
 */
export const defaultSendKey = (input: {
  readonly threadId: string;
  readonly providerSessionId: string;
  readonly runId: string | null;
  readonly to: string | undefined;
  readonly text: string | undefined;
  readonly file: string | undefined;
}) =>
  "mcp:" +
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        input.threadId,
        input.providerSessionId,
        input.runId ?? "",
        input.to ?? "",
        input.text ?? "",
        input.file ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 40);

/**
 * The CLI's arguments. Every value goes in `--name=value` form so a value
 * that starts with `-` is never read as an option.
 */
export const bridgeCliArgs = (request: ImessageSendRequest): ReadonlyArray<string> => {
  const option = (name: string, value: string) => `--${name}=${value}`;
  if (request.file !== undefined) {
    return [
      "send-file",
      option("file", request.file),
      ...(request.text === undefined ? [] : [option("text", request.text)]),
      option("session", request.session),
      option("key", request.key),
    ];
  }
  return [
    "send",
    option("text", request.text ?? ""),
    option("session", request.session),
    option("key", request.key),
    ...(request.to === undefined ? [] : [option("to", request.to)]),
    ...(request.effect === undefined ? [] : [option("effect", request.effect)]),
  ];
};

const lastLine = (output: string) =>
  output
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.length > 0);

const parseRecord = (line: string | undefined): Record<string, unknown> | undefined => {
  if (line === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/** The queue acknowledgement the CLI prints on success, or undefined when it is not one. */
export const parseBridgeAck = (
  stdout: string,
  kind: "send" | "file",
): { readonly id: string; readonly created: boolean } | undefined => {
  const record = parseRecord(lastLine(stdout));
  if (record === undefined) return undefined;
  const { id, created } = record;
  if (typeof id !== "string" || !new RegExp(`^${kind}:[a-f0-9]{64}$`).test(id)) return undefined;
  if (typeof created !== "boolean") return undefined;
  return { id, created };
};

const sanitize = (text: string) =>
  text
    // eslint-disable-next-line no-control-regex -- the CLI's error line must not carry control characters.
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, MAX_ERROR_CHARS);

/**
 * The CLI's own error line (`{"error": "..."}` on stderr), cleaned and capped.
 * Nothing else from its output is passed on.
 */
export const bridgeCliError = (stderr: string, exitCode: number | null): string => {
  const record = parseRecord(lastLine(stderr));
  const detail = typeof record?.error === "string" ? sanitize(record.error) : "";
  return detail.length > 0
    ? detail
    : `iMessage bridge CLI failed${exitCode === null ? "" : ` (exit ${exitCode})`}`;
};

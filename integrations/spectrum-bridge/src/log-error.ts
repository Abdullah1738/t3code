import { safeLineFailureCode } from "./line.ts";
import { constants as osConstants } from "node:os";
import { builtinModules } from "node:module";

export type ErrorDetail = {
  name: string; message: string; code?: string | number; errno?: string | number; status?: number; stack?: string[]; causeKey?: string;
};

const NAMES = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError",
  "IMessageError", "APIError", "FetchError", "HTTPError", "NetworkError", "ZodError",
  "AbortError", "TimeoutError", "BoundedTimeout", "SystemError", "SQLiteError", "SqliteError", "DOMException",
  "JudgeError", "TransportError", "PublishError", "CliError", "SttError", "SecretError", "ShareError",
  "HttpError", "ApiError", "ControlError", "RobobLinkDown", "LineError", "SendblueError", "ValidationError", "UnknownError",
]);
const SYSTEM_CODES = new Set([
  ...Object.keys(osConstants.errno),
  "ENOENT", "EACCES", "EPERM", "EEXIST", "ENOTDIR", "EISDIR", "ENOTEMPTY", "EMFILE", "ENFILE", "ENOSPC",
  "EROFS", "EINVAL", "EIO", "EBADF", "EPIPE", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT",
  "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ERR_INVALID_URL", "ERR_INVALID_ARG_TYPE",
  "ERR_STREAM_PREMATURE_CLOSE", "ERR_SOCKET_CLOSED", "ABORT_ERR", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "HPE_INVALID_CONSTANT", "HPE_INVALID_CHUNK_SIZE", "UND_ERR_HEADERS_OVERFLOW",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH", "Z_DATA_ERROR",
  "invalidCredentials", "endpointOverride", "closed", "tokenNetwork", "invalidTokenResponse",
  "sharedPlanRequired", "invalidTokenLifetime", "invalidOperationId", "invalidOwner", "invalidOwnerChat",
  "unauthorized", "invalidAttachmentLimit", "invalidAttachment", "attachmentTooLarge", "catchupTimeout",
  "catchupIncomplete", "attachmentTimeout", "invalidEffect", "invalidPoll", "invalidApp", "unknownSendFailure",
  "unauthenticated", "tokenExpired", "tokenBlocked", "dailyLimitExceeded", "recipientLimitExceeded",
  "uploadRateExceeded", "contentDuplicateExceeded", "recipientCoolingDown", "recipientLocked",
  "sendReceiveRatioExceeded", "duplicateMessage", "chatNotFound", "messageNotFound", "attachmentNotFound",
  "addressNotFound", "sharedFriendLocationNotFound", "groupIconNotFound", "pollNotFound", "invalidArgument",
  "preconditionFailed", "operationNotSupported", "attachmentNotReady", "privateApiUnavailable",
  "serviceUnavailable", "timeout", "internalError", "databaseError", "networkError",
  "invalidServerUrl", "emptyAudio", "audioTooLarge", "keyUnavailable", "conversionFailed", "invalidResponse",
  "jevFailed", "upload_url", "upload_failed", "unavailable", "internal", "not_found", "conflict", "invalid_request", "forbidden",
  "SQLITE_ERROR", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_READONLY", "SQLITE_CANTOPEN", "SQLITE_CONSTRAINT",
]);
// Bun exposes fixed HTTP error names as well as Node errno codes. Never accept arbitrary PascalCase strings.
// https://github.com/oven-sh/bun/blob/main/src/http/error.rs
const FETCH_CODE_ALIASES = new Map([
  ["ConnectionRefused", "ECONNREFUSED"], ["Timeout", "ETIMEDOUT"],
  ["Malformed_HTTP_Response", "HPE_INVALID_CONSTANT"], ["InvalidHTTPResponse", "HPE_INVALID_CHUNK_SIZE"],
  ["ResponseHeadersTooLarge", "UND_ERR_HEADERS_OVERFLOW"], ["InvalidContentLength", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH"],
  ["ZlibError", "Z_DATA_ERROR"],
]);
const FETCH_CODES = new Set(`CompressionFailed Aborted WriteFailed HTTP2RefusedStream HTTP2ContentLengthMismatch
HTTP2FrameSizeError HTTP2ProtocolError HTTP2FlowControlError HTTP2EnhanceYourCalm HTTP2HeaderListTooLarge
HTTP2StreamReset HTTP2GoAway HTTP2CompressionError AbortedBeforeConnecting InvalidURL ERR_TLS_CERT_ALTNAME_INVALID
ClientAborted HTTP2Unsupported ConnectionClosed DNSResolveFailed TooManyRedirects HTTP3Unsupported UnrequestedUpgrade
UnexpectedData UnsupportedTransferEncoding RequestBodyNotReusable RequestBodyLengthMismatch UnsupportedRedirectProtocol
RedirectURLTooLong RedirectURLInvalid InvalidRedirectURL UnexpectedRedirect ShortRead WantRead WantWrite HTTP3HandshakeFailed
HTTP3ProtocolError HTTP3HeaderEncodingError DNSResolutionFailed HTTP3StreamReset HTTP3ContentLengthMismatch FailedToOpenSocket
InvalidCRL UnsupportedProxyProtocol UnsupportedProtocol ProxyConnectFailed TLSHandshakeFailed`.split(/\s+/));
// Stack strings can be provider-controlled. Only code-owned filenames/modules may survive.
const SOURCE_FILES = new Set(`bounded.ts prompt-probe.ts log-prompt-probes.ts access.ts api.ts apps.ts backend.ts card-preview.ts card-text.ts chats.ts cli.ts commands.ts config.ts
control.ts robob-link-gate.ts delivery.ts formatting.ts group-gate.ts group-judge.ts guest-calendar.ts guest-desk.ts guest-evidence.ts
guest-flight.ts guest-providers.ts guest-responder.ts guests.ts inbound-failure.ts inbound-files.ts ingress.ts line.ts
local-attachments.ts lock.ts log-calls.ts log-directory.ts log-error.ts log-rollup.ts main.ts meds-fold.ts openchamber.ts opencode-steps.ts
origin-backfill.ts photon.ts poll-match.ts preferred-model.ts publish.ts replyCheck.ts robob.ts router.ts runtime.ts
sb-api.ts sb-ingress.ts sb-main.ts sb-transport.ts secret-crypto.ts secrets.ts sendblue.ts session.ts share.ts store.ts
stt.ts swipe.ts telegram-fallback.ts telegram-lookup.ts toollog.ts watcherlog.ts`.split(/\s+/));
const TEST_FILES = new Set(["toollog.test.ts", "toollog-redaction.test.ts"]);
const NODE_MODULES = new Set([...builtinModules.map(name => name.replace(/^node:/, "")),
  "internal/process/task_queues", "internal/timers", "internal/fs/promises", "internal/deps/undici/undici",
  "internal/streams/readable", "internal/streams/writable", "internal/process/execution",
]);

function safeErrorCode(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 65535) return value;
  if (typeof value !== "string") return;
  const fetchCode = FETCH_CODE_ALIASES.get(value);
  if (fetchCode) return fetchCode;
  if (/^http_[1-5]\d{2}/.test(value)) return safeLineFailureCode(value);
  if (/^(?:http|tokenHttp)[1-5]\d{2}$/.test(value)) return value;
  if (SYSTEM_CODES.has(value) || FETCH_CODES.has(value) || safeLineFailureCode(value) === value) return value;
}

// Free prose can itself be a message body or form value. Keep only fixed diagnostic
// prefixes; redact the entire remainder rather than guessing which words are private.
function message(value: unknown): string {
  if (typeof value !== "string" || !value) return "[redacted]";
  const fixed = /^(?:fetch failed|Failed to fetch|The operation was aborted\.?|This operation was aborted|The operation timed out\.?|Load failed|database is locked|database is busy|disk I\/O error|out of memory)$/;
  if (fixed.test(value)) return value.slice(0, 200);
  const prefix = /^(?:(?:ENOENT: no such file or directory|EACCES: permission denied|EPERM: operation not permitted|EEXIST: file already exists|ENOTDIR: not a directory|EISDIR: illegal operation on a directory|ENOSPC: no space left on device)(?=,| \[redacted\]$|$)|(?:connect|read|write|send|recv|getaddrinfo) (?:ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)(?=\s|$)|(?:HTTP|Request failed with status code) [1-5]\d{2}(?=\s|:|$)|Unexpected end of JSON input(?=\s|$))/.exec(value);
  return (prefix ? `${prefix[0]}${prefix[0] === value ? "" : " [redacted]"}` : "[redacted]").slice(0, 200);
}

function lineNumber(value: string): string | undefined {
  // Source positions are small positive integers, never arbitrary digit strings from a provider.
  if (/^[1-9]\d{0,5}$/.test(value) && Number(value) <= 100_000) return value;
}

function location(value: string): string | undefined {
  const source = /(?:^|\/spectrum-bridge\/)(src|test)\/([a-zA-Z0-9_.-]+\.ts):(\d+)(?::\d+)?\)?$/.exec(value);
  if (source) {
    const line = lineNumber(source[3]!);
    if (!line) return;
    return (source[1] === "src" ? SOURCE_FILES : TEST_FILES).has(source[2]!)
      ? `${source[1]}/${source[2]}:${line}` : `<external>:${line}`;
  }
  const internal = /\b(node:[a-zA-Z0-9_/-]+):(\d+)(?::\d+)?\)?$/.exec(value);
  if (internal) {
    const line = lineNumber(internal[2]!);
    if (!line) return;
    return NODE_MODULES.has(internal[1]!.slice(5)) ? `${internal[1]}:${line}` : `<external>:${line}`;
  }
  const external = /^(?:<external>):(\d+)$/.exec(value) ?? /:(\d+):\d+\)?$/.exec(value);
  if (external && lineNumber(external[1]!)) return `<external>:${external[1]}`;
}

export function errorFrames(stack: unknown): string[] {
  if (typeof stack !== "string") return [];
  // The first line is message text, never a frame.
  return stack.split("\n").slice(1).filter(line => /^\s+at /.test(line))
    .map(location).filter((frame): frame is string => frame !== undefined).slice(0, 2);
}

export function logSite(): string | undefined {
  return new Error().stack?.split("\n").slice(1)
    .filter(line => !/\/(?:toollog|log-error)\.ts:\d+/.test(line))
    .map(location).find(frame => frame?.startsWith("src/") || frame?.startsWith("test/"));
}

export function cleanSite(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:src|test)\/[a-zA-Z0-9_.-]+\.ts:\d+$/.test(value)) return;
  const site = location(value);
  if (site && !site.startsWith("<external>")) return site;
}

export function errorDetail(cause: unknown, fallback: Partial<ErrorDetail> = {}): ErrorDetail {
  const result: ErrorDetail = { name: "UnknownError", message: "[redacted]" };
  try {
    const source = cause && typeof cause === "object" ? cause as Record<string, unknown> : {};
    const name = source.name ?? fallback.name;
    // Several bridge Error subclasses leave .name as Error.
    const constructorName = cause instanceof Error ? cause.constructor.name : undefined;
    result.name = typeof name === "string" && NAMES.has(name) && name !== "Error" ? name
      : typeof constructorName === "string" && NAMES.has(constructorName) ? constructorName : "UnknownError";
    if (result.name === "UnknownError" && name === "Error") result.name = "Error";
    result.message = message(source.message ?? fallback.message);
    const nested = source.cause && typeof source.cause === "object" ? source.cause as Record<string, unknown> : {};
    const errorCode = [source.code, nested.code, fallback.code].map(safeErrorCode).find(value => value !== undefined);
    if (errorCode !== undefined) result.code = errorCode;
    const errno = [source.errno, nested.errno, fallback.errno].map(safeErrorCode).find(value => value !== undefined);
    if (errno !== undefined) result.errno = errno;
    const response = source.response && typeof source.response === "object" ? source.response as Record<string, unknown> : {};
    const codeStatus = typeof errorCode === "string" ? /^(?:http_?|tokenHttp)([1-5]\d{2})/.exec(errorCode)?.[1] : undefined;
    const status = source.status ?? source.statusCode ?? response.status ?? fallback.status ?? (codeStatus ? Number(codeStatus) : undefined);
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) result.status = status;
    let stack = source.stack;
    // Strip the complete message header, including newlines, before looking for frames.
    const header = `${source.name}: ${source.message}`;
    if (typeof stack === "string" && stack.startsWith(header)) stack = stack.slice(header.length);
    const frames = errorFrames(stack);
    // On the deferred write's second cleaning pass, accept only our reduced format.
    if (!frames.length && Array.isArray(fallback.stack)) {
      frames.push(...fallback.stack.filter((frame): frame is string => typeof frame === "string")
        .map(location).filter((frame): frame is string => frame !== undefined).slice(0, 2));
    }
    if (frames.length) result.stack = frames;
  } catch { /* Hostile getters must not prevent the catch record or change caller behavior. */ }
  return result;
}

// Only reduced diagnostics, never an exception message, determine a cause bucket.
export function causeKey(detail: ErrorDetail, tag: string): string {
  const http = typeof detail.code === "string" ? /^(?:http_?|tokenHttp)([1-5])\d{2}/.exec(detail.code) : undefined;
  if (http) return `http.${http[1]}xx`;
  if (detail.code !== undefined) return `code.${detail.code}`;
  if (detail.errno !== undefined) return `errno.${detail.errno}`;
  if (detail.status !== undefined) return `http.${Math.floor(detail.status / 100)}xx`;
  if (tag === "router.catch1") return "prompt_acceptance_probe";
  if (tag === "router.catch49") return "background_watch";
  return "callsite_failure";
}

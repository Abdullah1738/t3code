import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve, win32 } from "node:path";
import { parseArgs } from "node:util";
import { resolveAppFile } from "./apps.ts";
import { loadAppsConfig } from "./config.ts";
import { type Exec, publish, PUBLISH_MAX, PUBLISH_MIN, PublishError, unpublish } from "./publish.ts";
import { CARD_FIELDS, parseFieldSpec, SECRET_FIELD_TYPES, type SecretField, validFieldName, validToken } from "./secrets.ts";

type Body = Record<string, string | boolean | string[] | SecretField[]>;
type Command = { method: "GET" | "POST"; path: string; body?: Body };
/** Tailnet publishing runs in the CLI process itself; it never goes through the bridge socket. */
export type LocalCommand =
  | { command: "publish"; localPort: number }
  | { command: "publish"; app: string }
  | { command: "unpublish"; port: number };

class CliError extends Error {}
/** A secret value printed verbatim, with no JSON wrapping or trailing newline. */
class RawOutput {
  constructor(readonly value: string) {}
}

const COMMANDS_HELP = "Expected health, send, send-file, poll, app, react, wake, secret-request, secret, publish, or unpublish."
  + " Sendblue mode adds location-request, location, ask-owner, chats, allow, allow-group,"
  + " guest-allow, guest-revoke, guests, guest-send, and share-contact."
  + " Alerts and reminders moved to the telegram bridge CLI.";
const LOCAL_COMMANDS = ["publish", "unpublish"];

// Mirrors photon.ts EFFECTS; the CLI must not load the SDK just to validate arguments.
export const EFFECT_NAMES = ["slam", "loud", "gentle", "invisible", "confetti", "fireworks", "balloons", "heart",
  "lasers", "celebration", "sparkles", "spotlight", "echo"] as const;

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const validFileName = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= 255
  && value !== "." && value !== ".." && basename(value) === value && win32.basename(value) === value
  && !/[\x00-\x1f\x7f-\x9f]/.test(value);
export const validMimeType = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 100 && !/[^\x21-\x7e]/.test(value)
  && /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(value);
export const validAppUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 2048 || /[^\x21-\x7e]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && !url.username && !url.password;
  } catch { return false; }
};
const control = /[\x00-\x1f\x7f-\x9f]/;

const OPTIONS_BY_COMMAND: Record<string, string[]> = {
  health: [],
  "send-file": ["file", "key", "text", "session", "mime"],
  react: ["target", "kind"],
  send: ["text", "session", "key", "effect", "subject", "to"],
  poll: ["title", "option", "session", "key"],
  wake: ["text", "source", "key", "chat", "session"],
  "location-request": ["session", "key", "chat"],
  location: ["session", "chat"],
  "ask-owner": ["text", "session", "key"],
  chats: ["session"],
  allow: ["address", "name", "admin", "session"],
  "allow-group": ["id", "name", "session"],
  "guest-allow": ["address", "name", "purpose", "provider", "action", "fact", "expires", "evidence", "session"],
  "guest-revoke": ["address", "session"],
  guests: ["session"],
  "guest-send": ["address", "text", "session", "key"],
  "share-contact": ["address", "chat", "session"],
  app: ["url", "caption", "subcaption", "trailing", "trailing-subcaption", "summary", "session", "key"],
  "secret-request": ["purpose", "field", "card", "session", "key"],
  secret: ["token", "field", "forget"],
  publish: ["port", "app"],
  unpublish: ["port"],
};
const REPEATABLE = ["option", "field", "action", "provider", "fact", "evidence"];
const BOOLEAN_OPTIONS = ["forget", "card", "admin"];

function parseOptions(args: string[]) {
  const command = args[0];
  if (!command || !Object.hasOwn(OPTIONS_BY_COMMAND, command)) throw new CliError(COMMANDS_HELP);
  // secret uses --field once; secret-request repeats it.
  const repeatable = command === "secret" ? [] : REPEATABLE;
  let parsed;
  try {
    parsed = parseArgs({
      args: args.slice(1),
      options: Object.fromEntries(OPTIONS_BY_COMMAND[command]!.map(name => [name, BOOLEAN_OPTIONS.includes(name)
        ? { type: "boolean" as const } : { type: "string" as const, multiple: repeatable.includes(name) }])),
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
  } catch {
    // parseArgs errors can quote arbitrary argument values.
    throw new CliError("Invalid command arguments");
  }
  const { positionals, tokens } = parsed;
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option" || repeatable.includes(token.name)) continue;
    if (seen.has(token.name)) throw new CliError("Duplicate command option");
    seen.add(token.name);
  }
  if (positionals.length !== 0) {
    throw new CliError("Unexpected positional arguments");
  }
  return {
    command,
    values: parsed.values as Record<string, string | undefined>,
    lists: parsed.values as Record<string, string[] | undefined>,
    flags: parsed.values as Record<string, boolean | undefined>,
  };
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new CliError(`${label} is required and must not be empty`);
  return value;
}

function portOption(value: string | undefined, label: string): number {
  const port = Number(required(value, label));
  if (!/^\d{1,5}$/.test(value!) || !Number.isInteger(port) || port < 1 || port > 65535) throw new CliError(`${label} must be a port from 1 to 65535`);
  return port;
}

export const validAppSlug = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value);

export const isLocalCommand = (args: string[]): boolean => LOCAL_COMMANDS.includes(args[0] ?? "");

export function parseLocalCommand(args: string[]): LocalCommand {
  if (!isLocalCommand(args)) throw new CliError(COMMANDS_HELP);
  const { command, values } = parseOptions(args);
  if (command === "unpublish") {
    const port = portOption(values.port, "--port");
    if (port < PUBLISH_MIN || port > PUBLISH_MAX) throw new CliError(`--port must be a tailnet port from ${PUBLISH_MIN} to ${PUBLISH_MAX}`);
    return { command, port };
  }
  if ((values.port === undefined) === (values.app === undefined)) throw new CliError("publish needs exactly one of --port or --app");
  if (values.app !== undefined) {
    if (!validAppSlug(values.app)) throw new CliError("--app must be 1-64 characters of a-z, 0-9, or -");
    return { command: "publish", app: values.app };
  }
  return { command: "publish", localPort: portOption(values.port, "--port") };
}

export async function runLocalCommand(command: LocalCommand, options: { exec?: Exec; apps?: () => Promise<{ appsRoot: string; appsPort: number }> } = {}): Promise<unknown> {
  const deps = options.exec ? { exec: options.exec } : {};
  try {
    if (command.command === "unpublish") return await unpublish(command.port, deps);
    if ("localPort" in command) {
      const { url, port, created } = await publish(command.localPort, deps);
      return { url, port, created };
    }
    const { appsRoot, appsPort } = await (options.apps ?? loadAppsConfig)();
    const index = await resolveAppFile(appsRoot, `/${command.app}/index.html`);
    if (!index) throw new CliError(`No app at ${appsRoot}/${command.app}/index.html`);
    const { url, port, created } = await publish(appsPort, deps);
    return { url: `${url}/${command.app}/`, port, created };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(error instanceof PublishError ? error.message : "Tailnet publish failed");
  }
}

export function parseCommand(args: string[]): Command {
  if (isLocalCommand(args)) throw new CliError("publish and unpublish run locally; use parseLocalCommand");
  const { command, values, lists, flags } = parseOptions(args);
  function session(): { dedupeKey: string; sessionId: string } {
    const dedupeKey = required(values.key, "--key");
    if (dedupeKey.length > 200) throw new CliError("--key must be at most 200 characters");
    const sessionId = required(values.session, "--session");
    if (sessionId.length > 200 || /\s/.test(sessionId) || control.test(sessionId)) throw new CliError("Invalid --session");
    return { dedupeKey, sessionId };
  }
  function label(value: string | undefined, name: string, max: number): string | undefined {
    if (value === undefined) return;
    if (!value.trim() || value.length > max || control.test(value)) {
      throw new CliError(`${name} must be 1 to ${max} characters on one line`);
    }
    return value;
  }
  function optionalSession(value: string | undefined): string | undefined {
    if (value === undefined) return;
    if (!value.trim() || value.length > 200 || /\s/.test(value) || control.test(value)) throw new CliError("Invalid --session");
    return value;
  }
  function sessionOnly(value: string | undefined): string | undefined {
    return optionalSession(required(value, "--session"));
  }
  function chatSlug(value: string): string {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(value)) throw new CliError("Invalid chat slug; list them with chats");
    return value;
  }

  switch (command) {
    case "health":
      return { method: "GET", path: "/health" };
    case "send-file": {
      const file = required(values.file, "--file");
      if (!isAbsolute(file) || /[\x00-\x1f\x7f-\x9f]/.test(file) || !validFileName(basename(file))) {
        throw new CliError("--file must be an absolute path with a valid filename");
      }
      const dedupeKey = required(values.key, "--key");
      if (dedupeKey.length > 200) throw new CliError("--key must be at most 200 characters");
      const session = required(values.session, "--session");
      if (session.length > 200 || /\s|[\x00-\x1f\x7f-\x9f]/.test(session)) throw new CliError("Invalid --session");
      const text = values.text ?? "";
      if (text.length > 12_000) throw new CliError("--text must be at most 12000 characters");
      const body: Record<string, string> = { file, dedupeKey, text, sessionId: session };
      if (values.mime !== undefined) {
        if (!validMimeType(values.mime)) throw new CliError("Invalid --mime");
        body.mimeType = values.mime;
      }
      return { method: "POST", path: "/files", body };
    }
    case "react": {
      const kind = required(values.kind, "--kind");
      // Sendblue mode also takes one emoji; the bridge checks it, since only it knows the transport.
      const tapback = ["like", "love", "dislike", "laugh", "emphasize", "question"].includes(kind);
      if (!tapback && (/^[\x00-\x7f]+$/.test(kind) || kind.length > 32 || /\s/.test(kind) || control.test(kind))) {
        throw new CliError("--kind must be like, love, dislike, laugh, emphasize, question, or one emoji");
      }
      return { method: "POST", path: "/react", body: { target: required(values.target, "--target"), kind } };
    }
    case "send": {
      const text = required(values.text, "--text");
      if (text.length > 12_000) throw new CliError("--text must be at most 12000 characters");
      if (values.to !== undefined) {
        if (values.effect !== undefined || values.subject !== undefined) throw new CliError("--to does not take --effect or --subject");
        return { method: "POST", path: "/send", body: { text, to: chatSlug(values.to), ...session() } };
      }
      const body: Record<string, string> = { text, ...session() };
      if (values.effect !== undefined) {
        if (!(EFFECT_NAMES as readonly string[]).includes(values.effect)) {
          throw new CliError(`--effect must be one of ${EFFECT_NAMES.join(", ")}`);
        }
        body.effect = values.effect;
      }
      const subject = label(values.subject, "--subject", 256);
      if (subject !== undefined) body.subject = subject;
      return { method: "POST", path: "/send", body };
    }
    case "wake": {
      const text = required(values.text, "--text");
      if (text.length > 12_000) throw new CliError("--text must be at most 12000 characters");
      if (values.chat !== undefined) {
        const source = label(values.source, "--source", 100);
        return { method: "POST", path: "/wake",
          body: { text, chat: chatSlug(values.chat), ...session(), ...(source === undefined ? {} : { source }) } };
      }
      if (values.session !== undefined) throw new CliError("Invalid command arguments");
      const source = label(required(values.source, "--source"), "--source", 100)!;
      const dedupeKey = required(values.key, "--key");
      if (dedupeKey.length > 200) throw new CliError("--key must be at most 200 characters");
      return { method: "POST", path: "/wake", body: { text, source, dedupeKey } };
    }
    case "location-request":
      return { method: "POST", path: "/location-request",
        body: { ...session(), ...(values.chat === undefined ? {} : { chat: chatSlug(values.chat) }) } };
    case "location":
      return { method: "POST", path: "/location",
        body: { sessionId: sessionOnly(values.session)!, ...(values.chat === undefined ? {} : { chat: chatSlug(values.chat) }) } };
    case "ask-owner": {
      const text = required(values.text, "--text");
      if (text.length > 12_000) throw new CliError("--text must be at most 12000 characters");
      return { method: "POST", path: "/ask-owner", body: { text, ...session() } };
    }
    case "chats": {
      const sessionId = optionalSession(values.session);
      return { method: "POST", path: "/chats", body: sessionId === undefined ? {} : { sessionId } };
    }
    case "allow": {
      const address = label(required(values.address, "--address"), "--address", 200)!;
      const name = label(required(values.name, "--name"), "--name", 100)!;
      const sessionId = optionalSession(values.session);
      return { method: "POST", path: "/allow",
        body: { address, name, admin: flags.admin === true, ...(sessionId === undefined ? {} : { sessionId }) } };
    }
    case "allow-group": {
      const id = label(required(values.id, "--id"), "--id", 200)!;
      const name = label(values.name, "--name", 100);
      const sessionId = optionalSession(values.session);
      return { method: "POST", path: "/allow-group",
        body: { id, ...(name === undefined ? {} : { name }), ...(sessionId === undefined ? {} : { sessionId }) } };
    }
    case "guest-allow": {
      const address = label(required(values.address, "--address"), "--address", 200)!;
      const name = label(required(values.name, "--name"), "--name", 100)!;
      const purpose = label(required(values.purpose, "--purpose"), "--purpose", 300)!;
      const evidence = lists.evidence ?? [];
      if (!evidence.length || evidence.length > 4) throw new CliError("--evidence is required (up to 4)");
      for (const ref of evidence) label(required(ref, "--evidence"), "--evidence", 220);
      // --action is the first version's name for --provider.
      const providers = [...lists.provider ?? [], ...lists.action ?? []];
      if (providers.length > 6) throw new CliError("At most 6 --provider values");
      for (const spec of providers) if (!/^(meeting|create-hold|flight-status|flight-updates)(:[A-Za-z0-9]{2}\d{1,4}(@\d{4}-\d{2}-\d{2})?)?$/.test(spec)) {
        throw new CliError("--provider must be meeting, create-hold, flight-status[:EK57] or flight-updates[:EK57]");
      }
      const facts = lists.fact ?? [];
      if (facts.length > 8) throw new CliError("At most 8 --fact values");
      for (const fact of facts) if (!/^[^=]{1,40}=.{1,300}$/s.test(fact)) throw new CliError("--fact must look like \"gate code=4821\"");
      const expires = label(values.expires, "--expires", 10);
      return { method: "POST", path: "/guest-allow", body: {
        address, name, purpose, evidence, providers, facts, sessionId: sessionOnly(values.session)!, ...(expires === undefined ? {} : { expires }),
      } };
    }
    case "guest-revoke": {
      const address = label(required(values.address, "--address"), "--address", 200)!;
      const sessionId = optionalSession(values.session);
      return { method: "POST", path: "/guest-revoke", body: { address, ...(sessionId === undefined ? {} : { sessionId }) } };
    }
    case "guests": {
      const sessionId = optionalSession(values.session);
      return { method: "POST", path: "/guests", body: sessionId === undefined ? {} : { sessionId } };
    }
    case "guest-send": {
      const address = label(required(values.address, "--address"), "--address", 200)!;
      const text = required(values.text, "--text");
      if (text.length > 2_000) throw new CliError("--text must be at most 2000 characters");
      return { method: "POST", path: "/guest-send", body: { address, text, ...session() } };
    }
    case "share-contact": {
      if ((values.address === undefined) === (values.chat === undefined)) throw new CliError("share-contact needs exactly one of --address or --chat");
      const sessionId = optionalSession(values.session);
      return { method: "POST", path: "/share-contact", body: {
        ...(values.address === undefined ? { chat: chatSlug(values.chat!) } : { address: label(values.address, "--address", 200)! }),
        ...(sessionId === undefined ? {} : { sessionId }),
      } };
    }
    case "poll": {
      const title = label(required(values.title, "--title"), "--title", 200)!;
      const options = lists.option ?? [];
      if (options.length < 2 || options.length > 12) throw new CliError("--option must be given 2 to 12 times");
      for (const option of options) label(option, "--option", 100);
      if (new Set(options.map(option => option.trim())).size !== options.length) throw new CliError("--option values must be distinct");
      return { method: "POST", path: "/poll", body: { title, options, ...session() } };
    }
    case "app": {
      const url = required(values.url, "--url");
      if (!validAppUrl(url)) throw new CliError("--url must be an absolute https URL");
      const body: Record<string, string> = { url, caption: label(required(values.caption, "--caption"), "--caption", 200)!, ...session() };
      for (const [option, field, max] of [["subcaption", "subcaption", 200], ["trailing", "trailingCaption", 200],
        ["trailing-subcaption", "trailingSubcaption", 200], ["summary", "summary", 500]] as const) {
        const value = label(values[option], `--${option}`, max);
        if (value !== undefined) body[field] = value;
      }
      return { method: "POST", path: "/app", body };
    }
    case "secret-request": {
      const purpose = label(required(values.purpose, "--purpose"), "--purpose", 200)!;
      const specs = lists.field ?? [];
      // --card adds the standard name, number, expiry and security code fields.
      const card = flags.card ? CARD_FIELDS.map(field => ({ ...field })) : [];
      if (specs.length + card.length < 1 || specs.length + card.length > 8) throw new CliError("--field must be given 1 to 8 times (--card counts as 4)");
      const fields = [...card, ...specs.map(spec => {
        try { return parseFieldSpec(spec); } catch (error) {
          throw new CliError(`--field must be name:Label[:type]. ${(error as Error).message}; type is ${SECRET_FIELD_TYPES.join(", ")}`);
        }
      })];
      if (new Set(fields.map(field => field.name)).size !== fields.length) throw new CliError("--field names must be distinct");
      return { method: "POST", path: "/secret-request", body: { purpose, fields, ...session() } };
    }
    case "secret": {
      const token = required(values.token, "--token");
      if (!validToken(token)) throw new CliError("Invalid --token");
      if (flags.forget) {
        if (values.field !== undefined) throw new CliError("--forget does not take --field");
        return { method: "POST", path: "/secret-forget", body: { token } };
      }
      const field = required(values.field, "--field");
      if (!validFieldName(field)) throw new CliError("Invalid --field");
      return { method: "POST", path: "/secret-read", body: { token, field } };
    }
    default:
      throw new CliError("Invalid command");
  }
}

/** Resolve local files only in the CLI. The API receives bytes, never a filesystem path. */
export async function loadCommandPayload(command: Command): Promise<Body | undefined> {
  if (command.path !== "/files") return command.body;
  const { file, dedupeKey, text = "", sessionId, mimeType } = (command.body ?? {}) as Record<string, string>;
  if (typeof file !== "string" || !isAbsolute(file) || /[\x00-\x1f\x7f-\x9f]/.test(file) || !validFileName(basename(file))) {
    throw new CliError("--file must be an absolute path with a valid filename");
  }
  const name = basename(file);
  const mimeTypes: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif", ".svg": "image/svg+xml",
    ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
    ".csv": "text/csv", ".zip": "application/zip", ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".mov": "video/quicktime",
  };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const protectedPaths = ["credentials.env", "state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "state.sqlite-journal"]
      .map(name => join(homedir(), ".config", "spectrum-bridge", name));
    if (protectedPaths.includes(resolve(file))) throw new CliError("Bridge credentials and state cannot be attached");
    const before = await lstat(file, { bigint: true });
    if (!before.isFile()) throw new CliError("Attachment must be a regular file, not a symlink");
    if (before.size === 0n || before.size > BigInt(MAX_FILE_BYTES)) throw new CliError("Attachment must contain 1 byte to 20 MiB");
    // Check identities too: a hard link, case alias, or parent symlink must not bypass the fixed exclusions.
    for (const path of protectedPaths) {
      const secret = await stat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (secret && secret.dev === before.dev && secret.ino === before.ino) throw new CliError("Bridge credentials and state cannot be attached");
    }
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const unchanged = (current: typeof before) => current.isFile() && current.dev === before.dev && current.ino === before.ino
      && current.size === before.size && current.mtimeNs === before.mtimeNs && current.ctimeNs === before.ctimeNs;
    if (!unchanged(await handle.stat({ bigint: true }))) throw new CliError("Attachment changed while reading");
    // One sentinel byte detects growth without allowing an expanding file to drive unbounded reads.
    const data = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, Math.min(64 * 1024, data.length - size), size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size !== Number(before.size) || !unchanged(await handle.stat({ bigint: true }))
      || !unchanged(await lstat(file, { bigint: true }))) throw new CliError("Attachment changed while reading");
    return { base64: data.subarray(0, size).toString("base64"), name,
      mimeType: mimeType ?? mimeTypes[extname(name).toLowerCase()] ?? "application/octet-stream",
      text, dedupeKey, ...(sessionId === undefined ? {} : { sessionId }) };
  } catch (error) {
    throw error instanceof CliError ? error : new CliError("Attachment could not be read safely");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function sendCommand(command: Command): Promise<unknown> {
  const socketPath = process.env.SPECTRUM_BRIDGE_SOCKET ?? join(homedir(), ".config", "spectrum-bridge", "bridge.sock");
  let socket;
  try {
    if (!isAbsolute(socketPath) || socketPath.includes("\0")) throw new Error();
    socket = await lstat(socketPath);
  } catch {
    throw new CliError("Bridge socket is unavailable");
  }
  // The daemon owns the private parent directory; never follow a socket symlink.
  if (!socket.isSocket()) throw new CliError("Bridge socket must be a Unix socket, not a file or symlink");

  const body = await loadCommandPayload(command);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  // Queued sends echo only an acknowledgement; never surface their response bodies.
  const queued = ["/files", "/send", "/poll", "/app", "/wake"].includes(command.path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const fail = () => reject(new CliError(controller.signal.aborted ? "Bridge request timed out" : "Bridge request failed"));
      const req = request({
        socketPath, method: command.method, path: command.path, agent: false,
        signal: controller.signal, maxHeaderSize: 16 * 1024,
        headers: {
          Accept: "application/json",
          ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
        },
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("error", fail);
        res.on("aborted", fail);
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 128 * 1024) {
            reject(new CliError("Bridge response exceeds 128 KB"));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (!res.complete || size > 128 * 1024) { fail(); return; }
          const status = res.statusCode ?? 0;
          const ok = status >= 200 && status < 300;
          let data: unknown;
          try {
            data = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
          } catch {
            reject(new CliError(ok ? "Bridge returned invalid JSON" : `Bridge request failed (HTTP ${status})`));
            return;
          }
          if (!ok) {
            // Only the daemon's sanitized error field may be surfaced, never the raw body.
            const detail = !queued && data && typeof data === "object" && !Array.isArray(data) && "error" in data && typeof data.error === "string"
              ? data.error.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 512) : "";
            reject(new CliError(`Bridge request failed (HTTP ${status})${detail ? `: ${detail}` : ""}`));
            return;
          }
          if (queued) {
            const prefix = command.path === "/files" ? "file" : command.path.slice(1);
            if (!data || typeof data !== "object" || Array.isArray(data) || !("id" in data) || typeof data.id !== "string"
              || data.id.length !== prefix.length + 65 || !new RegExp(`^${prefix}:[a-f0-9]{64}$`).test(data.id)
              || !("created" in data) || typeof data.created !== "boolean") {
              reject(new CliError(command.path === "/files" ? "Bridge returned an invalid file acknowledgement"
                : "Bridge returned an invalid acknowledgement"));
              return;
            }
            // Queue acknowledgement only, not proof of upload or delivery. Never print echoed file contents.
            resolve({ id: data.id, created: data.created });
            return;
          }
          const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
          if (command.path === "/secret-request") {
            if (!validToken(record.token) || !validAppUrl(record.url) || typeof record.expiresAt !== "number") {
              reject(new CliError("Bridge returned an invalid acknowledgement"));
              return;
            }
            resolve({ token: record.token, url: record.url, expiresAt: record.expiresAt });
            return;
          }
          if (command.path === "/secret-read") {
            if (typeof record.value !== "string") { reject(new CliError("Bridge returned an invalid secret")); return; }
            resolve(new RawOutput(record.value));
            return;
          }
          if (command.path === "/secret-forget") {
            resolve({ forgotten: record.forgotten === true });
            return;
          }
          resolve(data);
        });
      });
      req.on("error", fail);
      req.end(payload);
    });
  } finally {
    clearTimeout(timer);
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const result = isLocalCommand(args) ? await runLocalCommand(parseLocalCommand(args)) : await sendCommand(parseCommand(args));
    if (result instanceof RawOutput) process.stdout.write(result.value);
    else console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof CliError ? error.message : "Bridge request failed" }));
    process.exitCode = 1;
  }
}

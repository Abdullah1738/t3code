import { decryptForm, formScript, type FormKeys } from "./secret-crypto.ts";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Store } from "./store.ts";

export const SECRET_FIELD_TYPES = ["text", "email", "username", "password", "new-password", "otp", "secret",
  "card-name", "card-number", "card-expiry", "card-cvc", "postal-code", "tel"] as const;
export type SecretFieldType = typeof SECRET_FIELD_TYPES[number];
export type SecretField = { name: string; label: string; type: SecretFieldType };
export type SecretState = "open" | "submitted" | "expired" | "forgotten";
export type SecretRequest = {
  encryption?: FormKeys;
  sessionId: string;
  generation: number;
  purpose: string;
  fields: SecretField[];
  createdAt: number;
  expiresAt: number;
  state: SecretState;
  submittedAt?: number;
  valuesExpireAt?: number;
};
export type SecretDeps = { store: Store; stateRoot: string; now?: () => number };

export const SECRET_REQUEST_TTL_MS = 15 * 60_000;
export const SECRET_VALUE_TTL_MS = 30 * 60_000;
export const MAX_SECRET_FORM_BYTES = 16 * 1024;
const MAX_VALUE_LENGTH = 4_096;
// Records stay long enough for dedupe replays and stale-link pages, then disappear.
const RECORD_RETENTION_MS = 24 * 60 * 60_000;

const SECRET_ERRORS = { 404: "Not found", 409: "Form not submitted yet", 410: "Expired" } as const;
export class SecretError extends Error {
  constructor(readonly status: keyof typeof SECRET_ERRORS) { super(SECRET_ERRORS[status]); }
}
// Orphan files younger than this may belong to a submission that is still being recorded.
const ORPHAN_GRACE_MS = 60_000;

const control = /[\x00-\x1f\x7f-\x9f]/;
export const validFieldName = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9_]{1,32}$/.test(value);
export const validFieldLabel = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 100 && !control.test(value);
export const validToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export const newToken = (): string => randomBytes(32).toString("base64url");
export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
const recordKey = (token: string) => `secret-request:${token}`;
const secretsDir = (stateRoot: string) => join(stateRoot, "secrets");
const valuesPath = (stateRoot: string, token: string) => join(secretsDir(stateRoot), `${tokenHash(token)}.json`);

/** Parses `name:Label[:type]`; a trailing known type is split off, so labels may contain colons. */
export function parseFieldSpec(spec: string): SecretField {
  const parts = spec.split(":");
  const name = parts.shift();
  let type: SecretFieldType = "text";
  if (parts.length >= 2 && (SECRET_FIELD_TYPES as readonly string[]).includes(parts.at(-1)!)) type = parts.pop() as SecretFieldType;
  const label = parts.join(":");
  if (!validFieldName(name)) throw new Error("Field names must be 1-32 characters of a-z, 0-9, or _");
  if (!validFieldLabel(label)) throw new Error("Field labels must be 1-100 characters on one line");
  return { name, label, type };
}

/** The standard card fields, named so iOS offers a saved card from iCloud Keychain in one tap. */
export const CARD_FIELDS: readonly SecretField[] = Object.freeze([
  { name: "card_name", label: "Name on card", type: "card-name" },
  { name: "card_number", label: "Card number", type: "card-number" },
  { name: "card_expiry", label: "Expiry (MM/YY)", type: "card-expiry" },
  { name: "card_cvc", label: "Security code", type: "card-cvc" },
] as const satisfies readonly SecretField[]);

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Normalizes one submitted value, or returns undefined when it cannot be right. */
export function normalizeValue(type: SecretFieldType, raw: string, now = Date.now()): string | undefined {
  const trimmed = raw.trim();
  switch (type) {
    case "email": case "username": case "otp": case "card-name": case "postal-code": case "tel":
      return trimmed || undefined;
    case "card-number": {
      const digits = trimmed.replace(/[\s-]/g, "");
      return /^\d{12,19}$/.test(digits) && luhn(digits) ? digits : undefined;
    }
    case "card-expiry": {
      // Accept MM/YY, MM/YYYY, MMYY and the YYYY-MM that a month picker produces.
      const iso = /^(\d{4})-(\d{2})$/.exec(trimmed);
      const plain = /^(\d{1,2})\s*[/\-. ]?\s*(\d{2}|\d{4})$/.exec(trimmed);
      const month = Number(iso ? iso[2] : plain?.[1]);
      const year = iso ? iso[1]! : plain?.[2];
      if (!year || !(month >= 1 && month <= 12)) return;
      // A card is valid through the last day of its expiry month; reject expired
      // cards and implausibly distant years (usually a typo).
      const full = year.length === 2 ? 2000 + Number(year) : Number(year);
      const today = new Date(now);
      const current = today.getFullYear() * 12 + today.getMonth();
      const expires = full * 12 + (month - 1);
      if (expires < current || expires > current + 20 * 12) return;
      return `${String(month).padStart(2, "0")}/${year.slice(-2)}`;
    }
    case "card-cvc":
      return /^\d{3,4}$/.test(trimmed) ? trimmed : undefined;
    default:
      return raw.trim() ? raw : undefined;
  }
}

export function validFields(value: unknown): value is SecretField[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return false;
  const names = new Set<string>();
  for (const field of value) {
    if (!field || typeof field !== "object" || Array.isArray(field)
      || Object.keys(field).some(key => !["name", "label", "type"].includes(key))) return false;
    const { name, label, type } = field as Record<string, unknown>;
    if (!validFieldName(name) || !validFieldLabel(label) || !(SECRET_FIELD_TYPES as readonly unknown[]).includes(type)) return false;
    if (names.has(name)) return false;
    names.add(name);
  }
  return true;
}

export function getSecretRequest(store: Store, token: string): SecretRequest | undefined {
  return validToken(token) ? store.get<SecretRequest>(recordKey(token)) : undefined;
}

export function putSecretRequest(store: Store, token: string, request: SecretRequest): void {
  if (!validToken(token)) throw new Error("Invalid secret token");
  store.set(recordKey(token), request);
}

const isOpen = (request: SecretRequest | undefined, now: number): request is SecretRequest =>
  request?.state === "open" && now < request.expiresAt;

async function privateDir(stateRoot: string): Promise<string> {
  const dir = secretsDir(stateRoot);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error("Unsafe secrets directory");
  if (info.mode & 0o077) await chmod(dir, 0o700);
  return dir;
}

async function removeValues(stateRoot: string, token: string): Promise<void> {
  await unlink(valuesPath(stateRoot, token)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export type SubmitResult = { status: "ok" } | { status: "gone" } | { status: "invalid"; request: SecretRequest; message: string };

/** Stores owner-entered values outside the apps root and wakes the agent with a value-free notice. */
export async function submitSecret(deps: SecretDeps, token: string, form: URLSearchParams): Promise<SubmitResult> {
  const now = deps.now?.() ?? Date.now();
  const request = getSecretRequest(deps.store, token);
  if (!isOpen(request, now)) return { status: "gone" };
  const values: Record<string, string> = {};
  for (const field of request.fields) {
    const all = form.getAll(field.name);
    const raw = all.length === 1 ? all[0]! : "";
    const value = raw.length > MAX_VALUE_LENGTH || raw.includes("\0") ? undefined : normalizeValue(field.type, raw, now);
    if (value === undefined) {
      return { status: "invalid", request, message: field.type.startsWith("card-") ? `Please check the ${field.label.toLowerCase()}.` : "Please fill in every field." };
    }
    values[field.name] = value;
  }
  const path = join(await privateDir(deps.stateRoot), `${tokenHash(token)}.json`);
  let handle;
  try {
    // Exclusive creation also settles concurrent submissions: only one writer wins.
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { status: "gone" };
    throw error;
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify({ values }));
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
  await handle.close();
  let accepted = false;
  try {
    accepted = deps.store.db.transaction(() => {
      const current = getSecretRequest(deps.store, token);
      if (!isOpen(current, now)) return false;
      putSecretRequest(deps.store, token, { ...current, encryption: undefined, state: "submitted", submittedAt: now, valuesExpireAt: now + SECRET_VALUE_TTL_MS });
      const names = current.fields.map(field => field.name).join(", ");
      deps.store.acceptInbound(`secret:${tokenHash(token)}`, {
        id: `secret:${tokenHash(token)}`,
        text: `Filled in the secure form "${current.purpose}" (fields: ${names}). Read a value only with the bridge secret command; never print or repeat it.`,
        attachments: [], isAudioMessage: false, receivedAt: now,
      });
      return true;
    }).immediate();
  } finally {
    if (!accepted) await unlink(path).catch(() => {});
  }
  return accepted ? { status: "ok" } : { status: "gone" };
}

async function readValues(stateRoot: string, token: string): Promise<Record<string, string>> {
  let handle;
  try {
    handle = await open(valuesPath(stateRoot, token), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new SecretError(410);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.size > 64 * 1024) throw new SecretError(410);
    const parsed = JSON.parse(await handle.readFile("utf8")) as { values?: unknown };
    if (!parsed.values || typeof parsed.values !== "object" || Array.isArray(parsed.values)) throw new SecretError(410);
    return parsed.values as Record<string, string>;
  } catch (error) {
    throw error instanceof SecretError ? error : new SecretError(410);
  } finally {
    await handle.close();
  }
}

/** Expires one request's values if their time is up; returns the fresh record. */
async function settle(deps: SecretDeps, token: string, now: number): Promise<SecretRequest | undefined> {
  const request = getSecretRequest(deps.store, token);
  if (!request) return;
  const late = (request.state === "submitted" && now >= (request.valuesExpireAt ?? 0))
    || (request.state === "open" && now >= request.expiresAt);
  if (!late) return request;
  if (request.state === "submitted") await removeValues(deps.stateRoot, token);
  // Re-read: a submission may have been recorded during the unlink above.
  const latest = getSecretRequest(deps.store, token);
  if (!latest || latest.state !== request.state) return latest;
  const expired: SecretRequest = { ...latest, encryption: undefined, state: "expired" };
  putSecretRequest(deps.store, token, expired);
  return expired;
}

export async function readSecret(deps: SecretDeps, token: string, field: string): Promise<string> {
  const now = deps.now?.() ?? Date.now();
  if (!validToken(token) || !validFieldName(field)) throw new SecretError(404);
  const request = await settle(deps, token, now);
  if (!request || !request.fields.some(entry => entry.name === field)) throw new SecretError(404);
  if (request.state === "open") throw new SecretError(409);
  if (request.state !== "submitted") throw new SecretError(410);
  const value = (await readValues(deps.stateRoot, token))[field];
  if (typeof value !== "string") throw new SecretError(410);
  return value;
}

/** Deletes submitted values now, or closes a form that was never filled in. */
export async function forgetSecret(deps: SecretDeps, token: string): Promise<void> {
  const request = getSecretRequest(deps.store, token);
  if (!request) throw new SecretError(404);
  await removeValues(deps.stateRoot, token);
  if (request.state === "open" || request.state === "submitted") putSecretRequest(deps.store, token, { ...request, encryption: undefined, state: "forgotten" });
}

/** Expires stale requests, deletes their values, drops old records, and removes orphaned value files. */
export async function sweepSecrets(deps: SecretDeps): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const rows = deps.store.db.query<{ key: string }, []>("SELECT key FROM kv WHERE key LIKE 'secret-request:%'").all();
  const live = new Set<string>();
  for (const { key } of rows) {
    const token = key.slice("secret-request:".length);
    if (!validToken(token)) continue;
    const request = await settle(deps, token, now);
    if (!request) continue;
    if (request.state === "submitted") live.add(`${tokenHash(token)}.json`);
    const settledAt = Math.max(request.expiresAt, request.valuesExpireAt ?? 0);
    if (request.state !== "submitted" && request.state !== "open" && now - settledAt > RECORD_RETENTION_MS) {
      deps.store.db.query("DELETE FROM kv WHERE key = ?").run(key);
    }
  }
  let names: string[];
  try { names = await readdir(secretsDir(deps.stateRoot)); } catch { return; }
  for (const name of names) {
    // A crash between writing values and recording the submission leaves an orphan; never keep it.
    if (!/^[a-f0-9]{64}\.json$/.test(name) || live.has(name)) continue;
    const path = join(secretsDir(deps.stateRoot), name);
    const info = await lstat(path).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs >= ORPHAN_GRACE_MS) await unlink(path).catch(() => {});
  }
}

const escape = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export const SECRET_PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
} as const;

const STYLE = `:root{color-scheme:light dark;--bg:#f2f2f7;--card:#fff;--text:#1c1c1e;--muted:#6c6c70;--line:#d1d1d6;--accent:#0a84ff}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--text:#f2f2f7;--muted:#98989f;--line:#3a3a3c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:17px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
padding:max(24px,env(safe-area-inset-top)) 16px max(24px,env(safe-area-inset-bottom))}main{max-width:480px;margin:0 auto}
h1{font-size:22px;margin:0 0 6px}p{color:var(--muted);margin:0 0 20px}.error{color:#ff453a}
form{background:var(--card);border-radius:14px;padding:16px}label{display:block;font-weight:600;margin:0 0 6px}
input{display:block;width:100%;min-height:48px;margin:0 0 16px;padding:10px 12px;font:inherit;color:inherit;background:var(--bg);
border:1px solid var(--line);border-radius:10px}input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{display:block;width:100%;min-height:52px;border:0;border-radius:12px;background:var(--accent);color:#fff;font:600 17px/1 inherit;font-family:inherit}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${escape(title)}</title>`
    + `<style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function inputAttributes(field: SecretField): string {
  switch (field.type) {
    case "email": return `type="email" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false"`;
    case "username": return `type="text" autocomplete="username" autocapitalize="none" spellcheck="false"`;
    case "password": return `type="password" autocomplete="current-password"`;
    case "new-password": return `type="password" autocomplete="new-password" passwordrules="minlength: 12; required: lower; required: upper; required: digit;"`;
    // Safari only offers saved cards when the field looks like a card field by
    // autocomplete token AND name/id; a password-typed CVC makes it treat the
    // form as a login form and suppress card AutoFill, so CVC stays text.
    case "card-name": return `type="text" autocomplete="cc-name" autocapitalize="words" autocorrect="off" spellcheck="false"`;
    case "card-number": return `type="text" inputmode="numeric" autocomplete="cc-number" autocorrect="off" spellcheck="false" placeholder="1234 5678 9012 3456"`;
    case "card-expiry": return `type="text" inputmode="numeric" autocomplete="cc-exp" autocorrect="off" spellcheck="false" placeholder="MM/YY"`;
    case "card-cvc": return `type="text" inputmode="numeric" autocomplete="cc-csc" autocorrect="off" spellcheck="false" placeholder="123"`;
    case "postal-code": return `type="text" autocomplete="postal-code" autocapitalize="characters" spellcheck="false"`;
    case "tel": return `type="tel" inputmode="tel" autocomplete="tel"`;
    case "otp": return `type="text" inputmode="numeric" autocomplete="one-time-code" autocapitalize="none" spellcheck="false"`;
    case "secret": return `type="password" autocomplete="off" autocapitalize="none" spellcheck="false"`;
    default: return `type="text" autocomplete="off" spellcheck="false"`;
  }
}

const CARD_IDS: Record<string, string> = { "card-name": "cc-name", "card-number": "cc-number", "card-expiry": "cc-exp", "card-cvc": "cc-csc" };

export function renderSecretForm(request: SecretRequest, error?: string): string {
  const hasCard = request.fields.some(field => field.type.startsWith("card-"));
  const inputs = request.fields.map((field, index) => {
    // Card inputs get the standard cc-* ids so Safari's heuristics recognise them.
    const id = field.type.startsWith("card-") ? CARD_IDS[field.type] ?? `f${index}` : `f${index}`;
    return `<label for="${id}">${escape(field.label)}</label>`
      + `<input id="${id}" name="${field.name}" ${inputAttributes(field)} required maxlength="${MAX_VALUE_LENGTH}"${index === 0 && !hasCard ? " autofocus" : ""}>`;
  }).join("");
  return page("Secure form", `<h1>${escape(request.purpose)}</h1>`
    + `<p${error ? ` class="error"` : ""}>${escape(error ?? "What you enter here goes straight to your Mac, not into the chat.")}</p>`
    + `<form method="post" autocomplete="on"${hasCard ? ` name="payment" id="payment-form"` : ""}>${inputs}<button type="submit">Send securely</button></form>`);
}

export const renderSecretMessage = (title: string, text: string): string =>
  page(title, `<h1>${escape(title)}</h1><p>${escape(text)}</p>`);

async function readForm(request: Request): Promise<URLSearchParams | number> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") return 415;
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_SECRET_FORM_BYTES)) {
    void request.body?.cancel().catch(() => {});
    return 413;
  }
  if (!request.body) return new URLSearchParams();
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SECRET_FORM_BYTES) {
        void reader.cancel().catch(() => {});
        return 413;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return new URLSearchParams(text);
  } catch {
    return 400;
  } finally {
    reader.releaseLock();
  }
}

/** Serves /_secret/<token>. Values are never logged, echoed, or written under the apps root. */
export function createSecretHandler(deps: SecretDeps): (request: Request, token: string) => Promise<Response> {
  const html = (body: string, status = 200, head = false) =>
    new Response(head ? null : body, { status, headers: SECRET_PAGE_HEADERS });
  const gone = (head = false) => html(renderSecretMessage("Link expired", "This form is no longer available."), 410, head);
  const missing = (head = false) => html(renderSecretMessage("Not found", "This form is no longer available."), 404, head);
  return async (request, token) => {
    if (!["GET", "HEAD", "POST"].includes(request.method)) {
      return new Response("Method not allowed", { status: 405, headers: { ...SECRET_PAGE_HEADERS, "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD, POST" } });
    }
    const head = request.method === "HEAD";
    const now = deps.now?.() ?? Date.now();
    const current = getSecretRequest(deps.store, token);
    if (!current) {
      void request.body?.cancel().catch(() => {});
      return missing(head);
    }
    if (!isOpen(current, now)) {
      void request.body?.cancel().catch(() => {});
      return gone(head);
    }
    if (request.method !== "POST") {
      if (!current.encryption) return html(renderSecretForm(current), 200, head);
      const { script, hash } = formScript(current.encryption.publicKey);
      // No native plaintext fallback if JavaScript or WebCrypto is unavailable.
      const body = renderSecretForm(current).replace('<form method="post"', '<form method="dialog"')
        .replace('</body>', `<script>${script}</script></body>`);
      return new Response(head ? null : body, { headers: { ...SECRET_PAGE_HEADERS,
        "Content-Security-Policy": SECRET_PAGE_HEADERS["Content-Security-Policy"].replace("form-action 'self'", "form-action 'none'") + `; script-src 'sha256-${hash}'; connect-src 'self'` } });
    }
    let form = await readForm(request);
    if (typeof form === "number") {
      return html(renderSecretMessage("Could not send", "Please try again."), form);
    }
    if (current.encryption) {
      try { form = await decryptForm(current.encryption, form); }
      catch { return html(renderSecretMessage("Could not send", "Please try again."), 400); }
    }
    const result = await submitSecret(deps, token, form);
    if (result.status === "gone") return gone();
    if (result.status === "invalid") return html(current.encryption
      ? renderSecretMessage("Could not send", result.message) : renderSecretForm(result.request, result.message), 400);
    return html(renderSecretMessage("Sent", "Sent. You can close this."));
  };
}

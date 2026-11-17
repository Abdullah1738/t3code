import { constants, createCipheriv, createDecipheriv, createHash, privateDecrypt, publicEncrypt, randomBytes, timingSafeEqual } from "node:crypto";

export type Sealed = { version: 1; key: string; iv: string; tag: string; data: string };
export const opaqueId = (value: string) => createHash("sha256").update(value).digest("hex");
export const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function tokenMatches(header: string | null, token: string): boolean {
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(`Bearer ${token}`);
  return token.length >= 32 && a.length === b.length && timingSafeEqual(a, b);
}

// Only the box has the OAEP private key; SQLite/WAL on the relay never sees the content.
export function seal(publicKey: string, value: unknown): Sealed {
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  return { version: 1, key: publicEncrypt({ key: publicKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, key).toString("base64"),
    iv: iv.toString("base64"), data: Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString("base64"),
    ...{ tag: cipher.getAuthTag().toString("base64") } };
}
export function unseal(privateKey: string, value: Sealed): unknown {
  if (value.version !== 1) throw new Error("Invalid envelope");
  const key = privateDecrypt({ key: privateKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(value.key, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString());
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export async function jsonBody(request: Request, limit = 28 * 1024 * 1024): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > limit) throw new Error("Request too large");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Request too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString());
  if (!object(result)) throw new Error("Invalid request");
  return result;
}

export type Fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

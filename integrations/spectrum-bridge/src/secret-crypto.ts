import { createHash } from "node:crypto";

export type FormKeys = { publicKey: JsonWebKey; privateKey: JsonWebKey };
export async function newFormKeys(): Promise<FormKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  return { publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey), privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

// This function also runs in Safari, without imports or external scripts.
export async function encryptForm(publicKey: JsonWebKey, plaintext: string): Promise<URLSearchParams> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const peer = await crypto.subtle.importKey("jwk", publicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: peer }, pair.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  return new URLSearchParams({ ciphertext: b64(new Uint8Array(ciphertext)), iv: b64(iv),
    ephemeral: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey)) });
}

export async function decryptForm(keys: FormKeys, form: URLSearchParams): Promise<URLSearchParams> {
  if ([...form.keys()].length !== 3 || !form.has("ciphertext") || !form.has("iv") || !form.has("ephemeral")) throw new Error("Invalid envelope");
  const iv = Buffer.from(form.get("iv")!, "base64");
  if (iv.length !== 12) throw new Error("Invalid envelope");
  const privateKey = await crypto.subtle.importKey("jwk", keys.privateKey, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const peer = await crypto.subtle.importKey("jwk", JSON.parse(form.get("ephemeral")!), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: peer }, privateKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, Buffer.from(form.get("ciphertext")!, "base64"));
  return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
}

export function formScript(publicKey: JsonWebKey): { script: string; hash: string } {
  const script = `const encryptForm = ${encryptForm.toString()};
const form = document.querySelector('form');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button'); button.disabled = true;
  try {
    const values = new URLSearchParams();
    for (const [name, value] of new FormData(form)) values.append(name, value);
    const body = await encryptForm(${JSON.stringify(publicKey)}, values.toString());
    const response = await fetch(location.pathname, { method: 'POST', body, credentials: 'omit', redirect: 'error' });
    if (response.ok) { HTMLFormElement.prototype.reset.call(form); form.replaceChildren(); document.querySelector('h1').textContent = 'Sent'; document.querySelector('p').textContent = 'Sent. You can close this.'; }
    else { document.querySelector('p').textContent = response.status === 410 ? 'This form is no longer available.' : 'Could not send. Check the fields and try again.'; }
  } catch { document.querySelector('p').textContent = 'Could not send. Please try again.'; }
  finally { button.disabled = false; }
});`;
  return { script, hash: createHash("sha256").update(script).digest("base64") };
}

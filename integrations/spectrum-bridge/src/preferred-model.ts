import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The iMessage conversation preferences are deliberately separate from
 * OpenChamber's desktop default and OpenCode's global `model` default: they are
 * backed by the OpenCode config file under a private `imessage` key, so the
 * preferences stay with the config the OpenCode server already owns.
 *
 *   "imessage": { "model": "surplus/glm-5.3", "variant": "max", "prompt": "..." }
 *
 * The optional `prompt` replaces the router's built-in iMessage guidance so the
 * texting context and formatting rules can be reworded without a code change.
 *
 * The optional `instanceId` names the Robob provider instance that runs the
 * model. A `provider/model` ref without one runs on OpenCode ("opencode").
 * Any other instance ("claudeAgent", "codex") takes its own model id as is,
 * without a slash: `{ "instanceId": "claudeAgent", "model": "claude-opus-5-5" }`.
 * `providerID` is empty for such an id, and the id goes to Robob verbatim.
 */
export type PreferredModel = { providerID: string; modelID: string; variant?: string; instanceId?: string };
export type IMessagePreferences = { model?: PreferredModel; prompt?: string };

/** Longest accepted replacement guidance; keeps the config a small prompt, not a system prompt. */
export const MAX_PROMPT_CHARS = 2_000;

export const openCodeConfigRoot = join(homedir(), ".config/opencode");

const MAX_CONFIG_BYTES = 1_000_000;

/**
 * String-aware scanner: strips // and block comments and trailing commas
 * while leaving string contents byte-for-byte intact.
 */
export function stripJsonc(text: string): string {
  let result = "";
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index]!;
    if (inString) {
      result += char;
      if (char === "\\") {
        result += text[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index++;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      index++;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++;
      index = Math.min(index + 2, text.length);
      continue;
    }
    if (char === ",") {
      // A trailing comma may have comments between it and the closing brace.
      let lookahead = index + 1;
      while (lookahead < text.length) {
        const next = text[lookahead]!;
        if (/\s/.test(next)) { lookahead++; continue; }
        if (next === "/" && text[lookahead + 1] === "/") {
          while (lookahead < text.length && text[lookahead] !== "\n") lookahead++;
          continue;
        }
        if (next === "/" && text[lookahead + 1] === "*") {
          lookahead += 2;
          while (lookahead < text.length && !(text[lookahead] === "*" && text[lookahead + 1] === "/")) lookahead++;
          lookahead = Math.min(lookahead + 2, text.length);
          continue;
        }
        break;
      }
      const next = text[lookahead];
      if (next === "}" || next === "]") {
        index++;
        continue;
      }
    }
    result += char;
    index++;
  }
  return result;
}

/** The OpenCode provider instance, the one that takes `provider/model` refs. */
export const OPENCODE_INSTANCE = "opencode";

const MODEL_ID = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;

function readPreferred(imessage: object): PreferredModel | undefined {
  const { model, variant, instanceId } = imessage as { model?: unknown; variant?: unknown; instanceId?: unknown };
  if (typeof model !== "string") return undefined;
  if (instanceId !== undefined && (typeof instanceId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/i.test(instanceId))) return undefined;
  const instance = instanceId ?? OPENCODE_INSTANCE;
  let providerID = "";
  let modelID = model;
  // OpenCode needs `provider/model`; another instance's own id has no slash and is kept whole.
  if (instance === OPENCODE_INSTANCE || model.includes("/")) {
    const slash = model.indexOf("/");
    if (slash <= 0 || slash !== model.lastIndexOf("/") || slash === model.length - 1) return undefined;
    providerID = model.slice(0, slash);
    modelID = model.slice(slash + 1);
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(providerID)) return undefined;
  }
  if (!MODEL_ID.test(modelID)) return undefined;
  if (variant !== undefined) {
    if (typeof variant !== "string" || !variant.length || variant.length > 64 || /[\x00-\x1f\x7f]/.test(variant)) return undefined;
  }
  return { providerID, modelID, ...(variant === undefined ? {} : { variant }), instanceId: instance };
}

/**
 * A replacement guidance prompt must stay a short operator-authored text: a
 * non-empty trimmed string within the size cap, with no control characters
 * other than newlines. Every malformed shape resolves to undefined so the
 * router's built-in guidance keeps applying.
 */
function readPrompt(imessage: object): string | undefined {
  const { prompt } = imessage as { prompt?: unknown };
  if (prompt === undefined) return undefined;
  if (typeof prompt !== "string") return undefined;
  const trimmed = prompt.trim();
  if (!trimmed.length || trimmed.length > MAX_PROMPT_CHARS) return undefined;
  if (/[\x00-\x09\x0b-\x1f\x7f]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Reads the iMessage preferences from the OpenCode config. Any missing file,
 * unreadable content, or malformed key resolves to an empty preference set,
 * which keeps the bridge's current behavior: OpenCode's own default model
 * resolution and the router's built-in guidance.
 * The first existing config file wins; symlinks and oversized files are
 * refused like every other config the bridge reads.
 */
export async function imessagePreferences(configRoot = openCodeConfigRoot): Promise<IMessagePreferences> {
  if (typeof configRoot !== "string" || !configRoot.startsWith("/") || /[\x00-\x1f]/.test(configRoot)) return {};
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const path = join(configRoot, name);
    const info = await lstat(path).catch(() => undefined);
    if (!info || !info.isFile()) continue;
    if (info.size > MAX_CONFIG_BYTES) return {};
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) return {};
    let config: unknown;
    try {
      config = JSON.parse(stripJsonc(text));
    } catch {
      return {};
    }
    const imessage = (config as { imessage?: unknown } | null | undefined)?.imessage;
    if (!imessage || typeof imessage !== "object" || Array.isArray(imessage)) return {};
    // Each preference validates independently so a malformed prompt cannot
    // also discard a valid model, and vice versa.
    return { model: readPreferred(imessage), prompt: readPrompt(imessage) };
  }
  return {};
}

/**
 * The control API's model fields for a preference. The instance always goes
 * with the model: without it Robob keeps the default's instance (say
 * claudeAgent), which can't run an OpenCode `provider/model` ref.
 */
export function controlModelFields(model: PreferredModel): { model: string; variant?: string; providerInstanceId: string } {
  return {
    model: model.providerID ? `${model.providerID}/${model.modelID}` : model.modelID,
    ...(model.variant ? { variant: model.variant } : {}),
    providerInstanceId: model.instanceId ?? OPENCODE_INSTANCE,
  };
}

/** Backward-compatible model-only view of the iMessage preferences. */
export async function preferredModel(configRoot = openCodeConfigRoot): Promise<PreferredModel | undefined> {
  return (await imessagePreferences(configRoot)).model;
}

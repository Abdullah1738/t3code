import { toolError } from "./toollog.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";

const DEFAULT_SERVER = "https://openrouter.ai/api/v1/";
const DEFAULT_MODEL = "assemblyai/universal-3-5-pro";
const AUDIO_EXTENSIONS = [".caf", ".m4a", ".amr", ".opus", ".mp3", ".wav", ".aac"];
const WAV_TYPES = ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"];
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
// OpenRouter rejects request bodies over roughly 3.5 MB with 413, and its
// AssemblyAI route only takes WAV, so longer PCM audio is sent in pieces.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export class SttError extends Error {
  constructor(public readonly code: string) {
    super(`Transcription failed (${code})`);
    this.name = "SttError";
  }
}

export type SttInput = { data: Uint8Array; name: string; mimeType: string };
export type SttDeps = {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Resolves with the exit code; must stop the process when the signal aborts. */
  spawn?: (argv: string[], signal: AbortSignal) => Promise<number>;
  settingsPath?: string;
  keyFile?: string;
  tempRoot?: string;
  timeoutMs?: number;
  maxUploadBytes?: number;
};

export function isAudio(mimeType: string | undefined, name: string | undefined, isAudioMessage: boolean): boolean {
  if (isAudioMessage) return true;
  if (typeof mimeType === "string" && mimeType.trim().toLowerCase().startsWith("audio/")) return true;
  return typeof name === "string" && AUDIO_EXTENSIONS.includes(extname(name).toLowerCase());
}

async function defaultSpawn(argv: string[], signal: AbortSignal): Promise<number> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await child.exited;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function settings(path: string): Promise<{ server: string; model: string }> {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch { toolError("stt", "stt.catch1");}
  let server = DEFAULT_SERVER;
  if (typeof raw.sttServerUrl === "string" && raw.sttServerUrl.trim()) {
    let url: URL;
    try { url = new URL(raw.sttServerUrl.trim()); } catch { toolError("stt", "stt.catch2"); throw new SttError("invalidServerUrl"); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new SttError("invalidServerUrl");
    server = url.href.endsWith("/") ? url.href : `${url.href}/`;
  }
  const model = typeof raw.sttModel === "string" && raw.sttModel.trim() ? raw.sttModel.trim() : DEFAULT_MODEL;
  return { server, model };
}

/**
 * Splits a PCM WAV into self-contained WAV pieces of at most `maxBytes`,
 * cutting at the quietest 20 ms within the last ~2 s of each piece so words
 * are rarely split. Anything that is not plain PCM WAV is returned as is.
 */
export function splitWav(wav: Uint8Array<ArrayBuffer>, maxBytes: number): Uint8Array<ArrayBuffer>[] {
  if (wav.byteLength <= maxBytes) return [wav];
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
  if (wav.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return [wav];
  let fmt: { format: number; channels: number; rate: number; blockAlign: number; bits: number } | undefined;
  let dataStart = -1, dataEnd = -1;
  for (let at = 12; at + 8 <= wav.byteLength;) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt " && size >= 16) {
      fmt = { format: view.getUint16(at + 8, true), channels: view.getUint16(at + 10, true), rate: view.getUint32(at + 12, true),
        blockAlign: view.getUint16(at + 20, true), bits: view.getUint16(at + 22, true) };
    } else if (tag(at) === "data") {
      dataStart = at + 8;
      dataEnd = Math.min(wav.byteLength, dataStart + size);
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!fmt || fmt.format !== 1 || !fmt.blockAlign || !fmt.rate || dataStart < 0) return [wav];
  const { blockAlign, rate } = fmt;
  const perPiece = Math.floor((maxBytes - 44) / blockAlign) * blockAlign;
  if (perPiece <= 0) return [wav];
  const window = Math.floor(rate * 0.02) * blockAlign;
  const search = Math.min(Math.floor(perPiece / 4 / blockAlign) * blockAlign, rate * 2 * blockAlign);
  const energy = (from: number, to: number) => {
    let sum = 0;
    for (let at = from; at + 1 < to; at += 2) sum += Math.abs(view.getInt16(at, true));
    return sum;
  };
  const pieces: Uint8Array<ArrayBuffer>[] = [];
  for (let start = dataStart; start < dataEnd;) {
    let end = Math.min(dataEnd, start + perPiece);
    if (end < dataEnd && window > 0 && fmt.bits === 16) {
      let best = end, quietest = Infinity;
      for (let at = end - window; at >= end - search && at > start; at -= window) {
        const level = energy(at, at + window);
        if (level < quietest) { quietest = level; best = at + window; }
      }
      end = best;
    }
    const body = wav.subarray(start, end);
    const piece = new Uint8Array(44 + body.byteLength);
    const out = new DataView(piece.buffer);
    piece.set([82, 73, 70, 70], 0); out.setUint32(4, 36 + body.byteLength, true); piece.set([87, 65, 86, 69], 8);
    piece.set([102, 109, 116, 32], 12); out.setUint32(16, 16, true); out.setUint16(20, 1, true);
    out.setUint16(22, fmt.channels, true); out.setUint32(24, rate, true); out.setUint32(28, rate * blockAlign, true);
    out.setUint16(32, blockAlign, true); out.setUint16(34, fmt.bits, true);
    piece.set([100, 97, 116, 97], 36); out.setUint32(40, body.byteLength, true);
    piece.set(body, 44);
    pieces.push(piece);
    start = end;
  }
  return pieces;
}

/** Transcribes one audio file to text. The key is read per call and never logged or echoed. */
export async function transcribe(input: SttInput, deps: SttDeps = {}): Promise<string> {
  if (!(input.data instanceof Uint8Array) || input.data.byteLength === 0) throw new SttError("emptyAudio");
  if (input.data.byteLength > MAX_AUDIO_BYTES) throw new SttError("audioTooLarge");
  const { server, model } = await settings(deps.settingsPath ?? join(homedir(), ".config/spectrum-bridge/config.json"));
  const keyFile = deps.keyFile ?? process.env.SPECTRUM_STT_KEY_FILE ?? join(homedir(), ".config/opencode/openrouter-key");
  let key: string;
  try { key = (await readFile(keyFile, "utf8")).trim(); } catch { toolError("stt", "stt.catch3"); throw new SttError("keyUnavailable"); }
  if (!key || /[\s\x00-\x1f\x7f]/.test(key)) throw new SttError("keyUnavailable");

  const signal = AbortSignal.timeout(deps.timeoutMs ?? 60_000);
  const directory = await mkdtemp(join(deps.tempRoot ?? tmpdir(), "spectrum-stt-"));
  try {
    let wav = new Uint8Array(input.data);
    if (!WAV_TYPES.includes(input.mimeType.trim().toLowerCase())) {
      // Never pass the sender's filename to a subprocess; only a sanitized extension.
      const extension = extname(input.name).toLowerCase();
      const source = join(directory, `input${/^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".audio"}`);
      const target = join(directory, "output.wav");
      await writeFile(source, input.data, { mode: 0o600 });
      let exitCode: number;
      try {
        exitCode = await (deps.spawn ?? defaultSpawn)(
          ["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", source, target], signal);
      } catch { toolError("stt", "stt.catch4");
        throw new SttError(signal.aborted ? "timeout" : "conversionFailed");
      }
      if (signal.aborted) throw new SttError("timeout");
      if (exitCode !== 0) throw new SttError("conversionFailed");
      try { wav = new Uint8Array(await readFile(target)); } catch { toolError("stt", "stt.catch5"); throw new SttError("conversionFailed"); }
      if (wav.byteLength === 0) throw new SttError("conversionFailed");
    }
    const pieces = splitWav(wav, deps.maxUploadBytes ?? MAX_UPLOAD_BYTES);
    const texts: string[] = new Array(pieces.length).fill("");
    const send = async (index: number) => {
      const piece = pieces[index]!;
      const form = new FormData();
      form.append("model", model);
      form.append("file", new Blob([piece], { type: "audio/wav" }), "audio.wav");
      let response: Response;
      try {
        response = await (deps.fetch ?? fetch)(`${server}audio/transcriptions`, {
          method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, redirect: "error", signal,
        });
      } catch { toolError("stt", "stt.catch6");
        throw new SttError(signal.aborted ? "timeout" : "network");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => { toolError("stt", "stt.catch7");});
        throw new SttError(`http${response.status}`);
      }
      let result: unknown;
      try { result = await response.json(); } catch { toolError("stt", "stt.catch8"); throw new SttError(signal.aborted ? "timeout" : "invalidResponse"); }
      const text = result && typeof result === "object" ? (result as { text?: unknown }).text : undefined;
      if (typeof text !== "string") throw new SttError("invalidResponse");
      texts[index] = text.trim();
    };
    // A few pieces at a time keeps long memos inside the deadline.
    for (let at = 0; at < pieces.length; at += 4) {
      await Promise.all(pieces.slice(at, at + 4).map((_, offset) => send(at + offset)));
    }
    return texts.filter(Boolean).join(" ");
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => { toolError("stt", "stt.catch9");});
  }
}

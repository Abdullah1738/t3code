import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAudio, splitWav, SttError, transcribe, type SttDeps } from "../src/stt.ts";

const KEY = "sk-test-PRIVATE-KEY";
let root: string;
let deps: SttDeps & { fetch: ReturnType<typeof mock>; spawn: ReturnType<typeof mock> };
const argvs: string[][] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "spectrum-stt-test-"));
  await fs.writeFile(join(root, "key"), `${KEY}\n`);
  await fs.writeFile(join(root, "settings.json"), JSON.stringify({ sttServerUrl: "https://stt.test/api/v1", sttModel: "test/model" }));
  await fs.mkdir(join(root, "tmp"));
  argvs.length = 0;
  deps = {
    settingsPath: join(root, "settings.json"), keyFile: join(root, "key"), tempRoot: join(root, "tmp"),
    spawn: mock(async (argv: string[]) => {
      argvs.push(argv);
      expect((await fs.stat(argv.at(-2)!)).mode & 0o077).toBe(0);
      await fs.writeFile(argv.at(-1)!, new Uint8Array([82, 73, 70, 70]));
      return 0;
    }),
    fetch: mock(async (_url: string, _init: RequestInit) => Response.json({ text: "  hello world  " })),
  };
});
afterEach(async () => {
  mock.restore();
  await fs.rm(root, { recursive: true, force: true });
});

const audio = { data: new Uint8Array([1, 2, 3]), name: "Audio Message.caf", mimeType: "audio/x-caf" };

describe("transcribe", () => {
  test("converts to 16 kHz mono WAV, posts multipart with the configured model, and cleans up", async () => {
    expect(await transcribe(audio, deps)).toBe("hello world");
    expect(argvs).toHaveLength(1);
    const argv = argvs[0]!;
    expect(argv.slice(0, 7)).toEqual(["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1"]);
    expect(argv.at(-2)).toEndWith("input.caf");
    expect(argv.join(" ")).not.toContain("Audio Message");
    const [url, init] = deps.fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://stt.test/api/v1/audio/transcriptions");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const form = init.body as FormData;
    expect(form.get("model")).toBe("test/model");
    const file = form.get("file") as File;
    expect(file.type).toBe("audio/wav");
    expect(file.name).toBe("audio.wav");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]));
    expect(await fs.readdir(join(root, "tmp"))).toEqual([]);
  });

  test("WAV input skips conversion and is sent as is", async () => {
    await transcribe({ data: new Uint8Array([9, 9]), name: "a.wav", mimeType: "audio/wav" }, deps);
    expect(deps.spawn).not.toHaveBeenCalled();
    const file = (deps.fetch.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(new Uint8Array(await (file.get("file") as File).arrayBuffer())).toEqual(new Uint8Array([9, 9]));
  });

  test("defaults apply when settings are missing, and a trailing slash is normalized", async () => {
    await fs.rm(join(root, "settings.json"));
    await transcribe(audio, deps);
    expect(deps.fetch.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(((deps.fetch.mock.calls[0]![1] as RequestInit).body as FormData).get("model")).toBe("assemblyai/universal-3-5-pro");
    await fs.writeFile(join(root, "settings.json"), JSON.stringify({ sttServerUrl: "https://stt.test/v1/" }));
    await transcribe(audio, deps);
    expect(deps.fetch.mock.calls[1]![0]).toBe("https://stt.test/v1/audio/transcriptions");
  });

  test("SPECTRUM_STT_KEY_FILE overrides the default key path", async () => {
    const saved = process.env.SPECTRUM_STT_KEY_FILE;
    await fs.writeFile(join(root, "other-key"), "sk-other");
    process.env.SPECTRUM_STT_KEY_FILE = join(root, "other-key");
    try {
      const { keyFile: _unused, ...rest } = deps;
      await transcribe(audio, rest);
      expect(new Headers((deps.fetch.mock.calls[0]![1] as RequestInit).headers).get("authorization")).toBe("Bearer sk-other");
    } finally {
      if (saved === undefined) delete process.env.SPECTRUM_STT_KEY_FILE;
      else process.env.SPECTRUM_STT_KEY_FILE = saved;
    }
  });

  test.each([
    ["missing key", async () => { await fs.rm(join(root, "key")); }, "keyUnavailable"],
    ["empty key", async () => { await fs.writeFile(join(root, "key"), " \n"); }, "keyUnavailable"],
    ["bad server", async () => { await fs.writeFile(join(root, "settings.json"), JSON.stringify({ sttServerUrl: "ftp://x" })); }, "invalidServerUrl"],
    ["conversion exit", async () => { deps.spawn.mockResolvedValueOnce(1); }, "conversionFailed"],
    ["conversion crash", async () => { deps.spawn.mockRejectedValueOnce(new Error("spawn")); }, "conversionFailed"],
    ["network", async () => { deps.fetch.mockRejectedValueOnce(new Error(`private ${KEY}`)); }, "network"],
    ["http status", async () => { deps.fetch.mockResolvedValueOnce(new Response(`echo ${KEY}`, { status: 401 })); }, "http401"],
    ["invalid json", async () => { deps.fetch.mockResolvedValueOnce(new Response("nope")); }, "invalidResponse"],
    ["missing text", async () => { deps.fetch.mockResolvedValueOnce(Response.json({ error: KEY })); }, "invalidResponse"],
  ] as [string, () => Promise<void>, string][])("%s fails with a clear code, no key, and no temp files", async (_label, arrange, code) => {
    await arrange();
    const logs = [spyOn(console, "log"), spyOn(console, "error"), spyOn(console, "warn")];
    const error = await transcribe(audio, deps).catch(error => error);
    expect(error).toBeInstanceOf(SttError);
    expect(error.code).toBe(code);
    expect(error.message).toBe(`Transcription failed (${code})`);
    expect(error.message).not.toContain(KEY);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(await fs.readdir(join(root, "tmp"))).toEqual([]);
  });

  test("times out a hung request and reports timeout", async () => {
    deps.fetch.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    await expect(transcribe(audio, { ...deps, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
    expect(await fs.readdir(join(root, "tmp"))).toEqual([]);
  });

  test("long WAV is uploaded in valid pieces under the cap and the texts are joined in order", async () => {
    const samples = new Int16Array(16_000 * 5).map((_, i) => (Math.floor(i / 8_000) % 2 ? 0 : 4_000));
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + samples.byteLength, 4); header.write("WAVE", 8);
    header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(samples.byteLength, 40);
    const wav = new Uint8Array(Buffer.concat([header, Buffer.from(samples.buffer)]));
    const pieces = splitWav(wav, 50_000);
    expect(pieces.length).toBeGreaterThan(1);
    let total = 0;
    for (const piece of pieces) {
      const view = Buffer.from(piece);
      expect(piece.byteLength).toBeLessThanOrEqual(50_000);
      expect(view.toString("ascii", 0, 4)).toBe("RIFF");
      expect(view.readUInt32LE(40)).toBe(piece.byteLength - 44);
      total += piece.byteLength - 44;
    }
    expect(total).toBe(samples.byteLength);
    let n = 0;
    deps.fetch.mockImplementation(async () => Response.json({ text: ` part${n++} ` }));
    const text = await transcribe({ data: wav, name: "a.wav", mimeType: "audio/wav" }, { ...deps, maxUploadBytes: 50_000 });
    expect(deps.fetch).toHaveBeenCalledTimes(pieces.length);
    expect(text.split(" ")).toHaveLength(pieces.length);
  });

  test("rejects empty or oversize audio before any work", async () => {
    await expect(transcribe({ ...audio, data: new Uint8Array() }, deps)).rejects.toMatchObject({ code: "emptyAudio" });
    await expect(transcribe({ ...audio, data: new Uint8Array(25 * 1024 * 1024 + 1) }, deps)).rejects.toMatchObject({ code: "audioTooLarge" });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  test.skipIf(!existsSync("/usr/bin/afconvert"))("the default spawn runs afconvert on real audio", async () => {
    const source = join(root, "tone.wav");
    const samples = new Int16Array(8_000).map((_, i) => Math.round(Math.sin(i / 5) * 8_000));
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + samples.byteLength, 4); header.write("WAVE", 8);
    header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8_000, 24); header.writeUInt32LE(16_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(samples.byteLength, 40);
    await fs.writeFile(source, Buffer.concat([header, Buffer.from(samples.buffer)]));
    const { spawn: _unused, ...rest } = deps;
    await transcribe({ data: new Uint8Array(await fs.readFile(source)), name: "tone.wav", mimeType: "audio/x-unknown" }, rest);
    const file = ((deps.fetch.mock.calls[0]![1] as RequestInit).body as FormData).get("file") as File;
    const wav = Buffer.from(await file.arrayBuffer());
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(22)).toBe(1);
  });
});

test("isAudio recognizes audio MIME types, voice flags, and audio extensions", () => {
  expect(isAudio("audio/x-caf", "a.bin", false)).toBe(true);
  expect(isAudio("AUDIO/MPEG", undefined, false)).toBe(true);
  expect(isAudio("application/octet-stream", "Voice.CAF", false)).toBe(true);
  for (const name of ["a.m4a", "a.amr", "a.opus", "a.mp3", "a.wav", "a.aac"]) expect(isAudio("", name, false)).toBe(true);
  expect(isAudio("application/octet-stream", "a.bin", true)).toBe(true);
  expect(isAudio("image/png", "a.png", false)).toBe(false);
  expect(isAudio("video/mp4", "a.mp4", false)).toBe(false);
  expect(isAudio(undefined, undefined, false)).toBe(false);
});

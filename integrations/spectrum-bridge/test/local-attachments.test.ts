import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttachmentRecovery, type Exec } from "../src/local-attachments.ts";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NAME = "VIC EXCLUSIVE - WATCHES.pdf";
const BYTES = Buffer.from("%PDF-1.7\nwatches\n%%EOF");

function fixture(options: { present?: boolean; bubble?: boolean; downloadOnPress?: boolean; outside?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "spectrum-local-att-"));
  directories.push(root);
  const attachments = join(root, "Attachments");
  const folder = join(attachments, "15", "05", "GUID");
  mkdirSync(folder, { recursive: true });
  const path = options.outside ? join(root, NAME) : join(folder, NAME);
  if (options.present) writeFileSync(path, BYTES);
  const calls: string[][] = [];
  let clock = 1_000_000;
  const exec: Exec = async argv => {
    calls.push(argv);
    const [bin, command, ...rest] = argv;
    if (bin === "imsg" && command === "chats") {
      return { code: 0, stdout: [
        JSON.stringify({ id: 7, identifier: "Group", is_group: true }),
        JSON.stringify({ id: 1431, identifier: "+16287895365", is_group: false, last_message_at: new Date(clock).toISOString() }),
      ].join("\n") };
    }
    if (bin === "imsg" && command === "history") {
      const chat = rest[rest.indexOf("--chat-id") + 1];
      if (chat !== "1431") return { code: 0, stdout: "" };
      return { code: 0, stdout: JSON.stringify({ guid: "MSG-GUID", attachments: [
        { transfer_name: NAME, total_bytes: BYTES.length, missing: !options.present, original_path: path, mime_type: "application/pdf" },
      ] }) };
    }
    if (bin === "cua") {
      const tool = rest[0];
      if (tool === "launch_app") return { code: 0, stdout: JSON.stringify({ pid: 42 }) };
      if (tool === "list_windows") return { code: 0, stdout: JSON.stringify({ windows: [
        { window_id: 4004, title: "", layer: 0, bounds: { width: 53, height: 48 } },
        { window_id: 58, title: "Robob", layer: 0, bounds: { width: 1024, height: 768 } },
      ] }) };
      if (tool === "get_window_state") return { code: 0, stdout: JSON.stringify({ elements: options.bubble === false ? [] : [
        { role: "AXButton", label: `Your iMessage, ${NAME}, PDF Document`, element_token: "s1:122", actions: ["AXPress"] },
      ] }) };
      if (tool === "click") {
        if (options.downloadOnPress) writeFileSync(path, BYTES);
        return { code: 0, stdout: JSON.stringify({ status: "ok" }) };
      }
    }
    return { code: 1, stdout: "" };
  };
  const remembered: number[] = [];
  const recover = createAttachmentRecovery({
    exec, imsg: "imsg", cuaDriver: "cua", attachmentsRoot: attachments,
    rememberedChat: { get: () => remembered.at(-1), set: id => remembered.push(id) },
    sleep: async ms => { clock += ms; }, now: () => clock, downloadWaitMs: 9_000, pollMs: 3_000,
  });
  const request = { fileName: NAME, totalBytes: BYTES.length, mimeType: "application/pdf", receivedAt: clock, maxBytes: 100 * 1024 * 1024 };
  return { recover, request, calls, remembered };
}

test("copies a file Messages already has without touching the UI", async () => {
  const f = fixture({ present: true });
  const result = await f.recover(f.request);
  expect(Buffer.from(result.file!.data)).toEqual(BYTES);
  expect(result.file!.name).toBe(NAME);
  expect(result.detail).toMatchObject({ reason: "copied", chatId: 1431, messageGuid: "MSG-GUID" });
  expect(f.calls.some(argv => argv[0] === "cua")).toBe(false);
  // Group chats are skipped; the matched chat is remembered for next time.
  expect(f.calls.some(argv => argv.includes("7"))).toBe(false);
  expect(f.remembered).toEqual([1431]);
});

test("presses the attachment bubble in the largest titled window and waits for the iCloud download", async () => {
  const f = fixture({ downloadOnPress: true });
  const result = await f.recover(f.request);
  expect(result.detail.reason).toBe("copied");
  expect(Buffer.from(result.file!.data)).toEqual(BYTES);
  const launch = f.calls.find(argv => argv[2] === "launch_app")!;
  expect(JSON.parse(launch[3]!)).toEqual({ bundle_id: "com.apple.MobileSMS", urls: ["imessage:+16287895365"] });
  const click = f.calls.find(argv => argv[2] === "click")!;
  expect(JSON.parse(click[3]!)).toEqual({ pid: 42, window_id: 58, element_token: "s1:122", action: "press" });
});

test("reports why when the download never lands or the bubble is not on screen", async () => {
  const timedOut = fixture();
  expect((await timedOut.recover(timedOut.request))).toEqual({ detail: {
    chatId: 1431, messageGuid: "MSG-GUID", path: expect.any(String), missing: true, reason: "messagesDownloadTimedOut",
  } });
  const hidden = fixture({ bubble: false });
  expect((await hidden.recover(hidden.request)).detail.reason).toBe("bubbleNotFound");
  const unknown = fixture({ present: true });
  expect((await unknown.recover({ ...unknown.request, fileName: "other.pdf" })).detail).toEqual({ reason: "notFoundInMessages" });
});

test("never reads a path outside the Messages attachment store", async () => {
  const f = fixture({ present: true, outside: true, bubble: false });
  const result = await f.recover(f.request);
  expect(result.file).toBeUndefined();
  expect(result.detail.reason).toBe("bubbleNotFound");
});

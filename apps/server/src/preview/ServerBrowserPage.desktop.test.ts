// @effect-diagnostics nodeBuiltinImport:off - Owns an isolated Electron test subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { CDPSession } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { captureViewport, within } from "./ServerBrowserPage.ts";

const desktopRequire = NodeModule.createRequire(
  new URL("../../../desktop/package.json", import.meta.url),
);

// Linux integration runs need a display; the focused offbox command supplies Xvfb.
it
  .skipIf(HostProcess.Platform.defaultValue() === "linux" && !process.env.DISPLAY)
  .each(["navigated", "blank DOM/srcdoc"])(
  "captures fresh pixels from a background %s guest and releases painting",
  async (kind) => {
    // A separate browser debugger would compete with the production relay for this guest.
    const child = NodeChildProcess.spawn(
      desktopRequire("electron"),
      [
        "--no-sandbox",
        NodeURL.fileURLToPath(new URL("./testing/BackgroundPaint.fixture.mjs", import.meta.url)),
      ],
      { stdio: "pipe", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } },
    );
    const ready = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<void>();
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: unknown) => void }
    >();
    let id = 0;
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-8_000);
    });
    const lines = NodeReadline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let reply: { ready?: boolean; id?: number; result?: unknown; error?: string };
      try {
        reply = JSON.parse(line);
      } catch {
        return;
      }
      if (reply.ready) {
        ready.resolve();
        return;
      }
      if (reply.id === undefined) return;
      const request = pending.get(reply.id);
      pending.delete(reply.id);
      if (reply.error) request?.reject(new Error(reply.error));
      else request?.resolve(reply.result);
    });
    child.once("error", (error) => ready.reject(error));
    child.once("exit", () => {
      exited.resolve();
      const error = new Error(`Electron fixture exited: ${stderr}`);
      ready.reject(error);
      for (const request of pending.values()) request.reject(error);
    });
    const send = (method: string, params?: Record<string, unknown>) =>
      new Promise<unknown>((resolve, reject) => {
        const requestId = ++id;
        pending.set(requestId, { resolve, reject });
        child.stdin.write(JSON.stringify({ id: requestId, method, params }) + "\n");
      });
    try {
      await within(ready.promise, 5_000, "Electron fixture did not initialize").catch((error) => {
        throw new Error(`${error.message} ${stderr}`);
      });
      const cdp = { send } as unknown as CDPSession;
      const html =
        '<style>body{margin:0;background:rgb(0,0,255)}</style><h1>fresh</h1><iframe srcdoc="<p>child</p>"></iframe>';
      if (kind === "navigated")
        await send("probe.navigate", { url: `data:text/html,${encodeURIComponent(html)}` });
      await send("Runtime.evaluate", {
        expression: `document.body.innerHTML=${JSON.stringify(html)}`,
      });
      for (let i = 0; i < 2; i++) {
        await send("Runtime.evaluate", {
          expression: `document.body.style.backgroundColor='${i === 0 ? "rgb(0,0,255)" : "rgb(0,255,0)"}'`,
        });
        const data = await captureViewport(cdp, { format: "png", keepPaintable: true });
        const bytes = Buffer.from(data, "base64");
        expect(bytes.readUInt32BE(16)).toBe(390);
        expect(bytes.readUInt32BE(20)).toBe(844);
        expect(await send("probe.pixel", { png: data })).toEqual(
          i === 0 ? [255, 0, 0, 255] : [0, 255, 0, 255],
        );
      }
      await send("DOM.enable");
      const state = (await send("probe.inspect")) as { painting: boolean[]; requests: string[] };
      expect(state.painting.at(-1)).toBe(false);
      expect(
        state.requests.filter((method) => method === "Emulation.setFocusEmulationEnabled"),
      ).toHaveLength(4);
    } finally {
      child.stdin.end();
      await within(exited.promise, 2_000, "Electron fixture did not close").catch(() =>
        child.kill(),
      );
      lines.close();
    }
  },
  20_000,
);

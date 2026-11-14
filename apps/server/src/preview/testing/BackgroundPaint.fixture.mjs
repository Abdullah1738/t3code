import { app, BrowserWindow, nativeImage } from "electron";
import * as NodeReadline from "node:readline";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { make } from "../../../../desktop/src/preview/DesktopBrowserHost.ts";

app.commandLine.appendSwitch("force-device-scale-factor", "1");
console.error("paint fixture: waiting for Electron");
void app
  .whenReady()
  .then(async () => {
    console.error("paint fixture: opening host");
    const window = new BrowserWindow({
      width: 1000,
      height: 1000,
      show: true,
      webPreferences: { webviewTag: true },
    });
    const attached = new Promise((resolve) =>
      window.webContents.once("did-attach-webview", (_, guest) => resolve(guest)),
    );
    await window.loadURL(
      'data:text/html,<body style="background:white"><webview src="about:blank" style="position:fixed;left:-100000px;top:-100000px;width:390px;height:844px"></webview></body>',
    );
    console.error("paint fixture: host loaded");
    const guest = await attached;
    if (guest.isLoading()) await new Promise((resolve) => guest.once("did-stop-loading", resolve));
    guest.debugger.attach("1.3");
    console.error("paint fixture: guest attached");
    const host = await Effect.runPromise(make);
    const key = { threadId: "background-probe", tabId: "probe" };
    const pending = new Map();
    let id = 0;
    const requests = [];
    const painting = [];
    Effect.runFork(
      Stream.runForEach(host.events, (line) =>
        Effect.sync(() => {
          const event = JSON.parse(new TextDecoder().decode(line));
          if (event.type !== "cdp") return;
          const reply = JSON.parse(event.message);
          const waiter = pending.get(reply.id);
          if (!waiter) return;
          pending.delete(reply.id);
          if (reply.error) waiter.reject(new Error(reply.error.message));
          else waiter.resolve(reply.result);
        }),
      ),
    );
    Effect.runFork(
      Stream.runForEach(host.painting, ({ active }) =>
        Effect.promise(async () => {
          painting.push(active);
          await window.webContents.executeJavaScript(
            `(() => { const view=document.querySelector('webview'); view.style.left='${active ? 0 : -100000}px'; view.style.top='${active ? 0 : -100000}px'; view.style.zIndex='-1'; })()`,
          );
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    host.attach(key, { webContents: guest, debugger: guest.debugger });
    const sendRaw = (method, params, sessionId) =>
      new Promise((resolve, reject) => {
        const commandId = ++id;
        pending.set(commandId, { resolve, reject });
        requests.push(method);
        Effect.runSync(
          host.handleCommandLine(
            JSON.stringify({
              type: "cdp",
              ...key,
              message: JSON.stringify({ id: commandId, method, params, sessionId }),
            }),
          ),
        );
      });
    const { sessionId } = await sendRaw("Target.attachToTarget", {
      targetId: (await guest.debugger.sendCommand("Target.getTargetInfo")).targetInfo.targetId,
    });
    const commands = NodeReadline.createInterface({ input: process.stdin });
    commands.on("close", () => app.quit());
    commands.on("line", (line) => {
      const request = JSON.parse(line);
      const work = async () => {
        if (request.method === "probe.navigate") return guest.loadURL(request.params.url);
        if (request.method === "probe.inspect") return { painting, requests };
        if (request.method === "probe.pixel") {
          const image = nativeImage.createFromBuffer(Buffer.from(request.params.png, "base64"));
          const offset = (600 * image.getSize().width + 5) * 4;
          return [...image.toBitmap().subarray(offset, offset + 4)];
        }
        return sendRaw(request.method, request.params, sessionId);
      };
      void work().then(
        (result) => process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n"),
        (error) =>
          process.stdout.write(JSON.stringify({ id: request.id, error: String(error) }) + "\n"),
      );
    });
    process.stdout.write(JSON.stringify({ ready: true }) + "\n");
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

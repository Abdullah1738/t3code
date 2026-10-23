// Minimal Chrome DevTools Protocol client over --remote-debugging-pipe (fd 3 in, fd 4 out,
// NUL-delimited JSON). One headless browser, many pages. No npm dependencies.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const newest = (dir, leaf) => {
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir)
    .map((d) => join(dir, d, leaf))
    .filter(existsSync)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return hits.at(-1) || null;
};

// Same order the taste wrapper uses: Robob's bundled shell, then Playwright's.
export function findChrome(env = process.env) {
  if (env.CARD_CHECK_CHROME) return env.CARD_CHECK_CHROME;
  const home = homedir();
  const robob = newest(join(home, ".robob/tools/chrome-headless-shell/mac-arm64"), "chrome-headless-shell");
  if (robob) return robob;
  const cache = join(home, "Library/Caches/ms-playwright");
  if (existsSync(cache)) {
    const dirs = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-"));
    const hits = dirs
      .map((d) => join(cache, d, "chrome-headless-shell-mac-arm64/chrome-headless-shell"))
      .filter(existsSync)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (hits.length) return hits.at(-1);
  }
  return null;
}

export async function launch(chrome) {
  const profile = mkdtempSync(join(tmpdir(), "card-check-chrome-"));
  const proc = spawn(
    chrome,
    [
      "--headless",
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--font-render-hinting=none",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const out = proc.stdio[3];
  const inp = proc.stdio[4];
  let buf = "";
  let seq = 0;
  let dead = null;
  const pending = new Map();
  const listeners = new Set();
  const fail = (err) => {
    dead = err;
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  };
  proc.on("exit", (code) => fail(new Error(`chrome exited (${code})`)));
  proc.on("error", fail);
  inp.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject, method } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    }
  });

  const send = (method, params = {}, sessionId, timeout = 30000) =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeout} ms`));
      }, timeout);
      pending.set(id, {
        method,
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });

  const waitFor = (sessionId, method, timeout = 15000) =>
    new Promise((resolve, reject) => {
      const fn = (msg) => {
        if (msg.sessionId !== sessionId || msg.method !== method) return;
        listeners.delete(fn);
        clearTimeout(timer);
        resolve(msg.params);
      };
      const timer = setTimeout(() => {
        listeners.delete(fn);
        reject(new Error(`${method}: no event after ${timeout} ms`));
      }, timeout);
      listeners.add(fn);
    });

  async function newPage() {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const page = {
      targetId,
      send: (method, params, timeout) => send(method, params, sessionId, timeout),
      waitFor: (method, timeout) => waitFor(sessionId, method, timeout),
      async eval(expression, timeout = 15000) {
        const r = await send(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
          timeout,
        );
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          throw new Error(`page script: ${d.exception?.description || d.text}`);
        }
        return r.result.value;
      },
      async goto(url) {
        const loaded = waitFor(sessionId, "Page.loadEventFired", 20000);
        const nav = await send("Page.navigate", { url }, sessionId);
        if (nav.errorText) throw new Error(`navigate ${url}: ${nav.errorText}`);
        await loaded;
      },
      // Fonts, two frames and a beat for on-load layout scripts (card.js fit()).
      settle(ms = 80) {
        return page.eval(
          `document.fonts.ready.then(() => Promise.race([
             new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
             new Promise(r => setTimeout(r, 400)),
           ])).then(() => new Promise(r => setTimeout(r, ${ms})))`,
        );
      },
      close: () => send("Target.closeTarget", { targetId }).catch(() => {}),
    };
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    return page;
  }

  return {
    newPage,
    version: () => send("Browser.getVersion"),
    async close() {
      try {
        await send("Browser.close", {}, undefined, 3000);
      } catch {}
      proc.kill();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

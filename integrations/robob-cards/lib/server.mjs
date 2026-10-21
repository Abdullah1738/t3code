import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { enrollPage, extractDevice, manifestPlist, profileServiceConfig } from "./enroll.mjs";
import { notifyOwner, wakeThread } from "./notify.mjs";
import { provision } from "./provision.mjs";
import { loadConfig, readState, updateState } from "./state.mjs";

const ICON = join(dirname(fileURLToPath(import.meta.url)), "../ios/App/Assets.xcassets/Mark.imageset/mark.png");
const MAX_BODY = 256 * 1024;
export const QUICK_TUNNEL = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/;

function send(res, status, type, body, headers = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    "content-type": type,
    "content-length": buffer.length,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(res.req.method === "HEAD" ? undefined : buffer);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("enrollment response too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Everything lives under one unguessable /c/<token>/ path; any other request
// gets the same 404 so the tunnel exposes nothing else.
export function createHandler({ dir, onEnrolled }) {
  return async (req, res) => {
    try {
      const state = readState(dir);
      const url = new URL(req.url ?? "/", "http://local");
      const prefix = `/c/${state?.token}`;
      if (!state?.token || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) {
        return send(res, 404, "text/plain; charset=utf-8", "Not found\n");
      }
      const page = url.pathname.slice(prefix.length);
      const host = req.headers["x-forwarded-host"] ?? req.headers.host;
      const base = `${state.publicUrl ?? `https://${host}`}${prefix}/`;

      if (page === "") return send(res, 302, "text/plain", "", { location: `${prefix}/` });
      if (req.method === "POST" && page === "/enrolled") {
        const device = extractDevice(await readBody(req), state.token);
        const known = (state.devices ?? []).some((entry) => entry.udid.toLowerCase() === device.udid.toLowerCase());
        if (!known) {
          updateState(dir, {
            phase: "preparing",
            error: null,
            devices: [...(state.devices ?? []), { ...device, enrolledAt: new Date().toISOString() }],
          });
        }
        onEnrolled({ device, known });
        // iOS opens this in Safari once the profile step is done.
        return send(res, 301, "text/plain", "", { location: base });
      }
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain", "Method not allowed\n");

      if (page === "/") {
        const phase = state.phase ?? "waiting";
        return send(res, 200, "text/html; charset=utf-8", enrollPage({ phase, manifestUrl: `${base}manifest.plist` }));
      }
      if (page === "/profile.mobileconfig") {
        return send(
          res,
          200,
          "application/x-apple-aspen-config",
          profileServiceConfig({ callbackUrl: `${base}enrolled`, token: state.token }),
          { "content-disposition": 'attachment; filename="robob-cards.mobileconfig"' },
        );
      }
      if (page === "/icon.png") return send(res, 200, "image/png", readFileSync(ICON));

      const ipa = join(dir, "RobobCards.ipa");
      if (state.phase !== "ready" || !existsSync(ipa)) return send(res, 404, "text/plain", "Not ready yet\n");
      if (page === "/manifest.plist") {
        return send(
          res,
          200,
          "application/xml",
          manifestPlist({
            ipaUrl: `${base}RobobCards.ipa`,
            iconUrl: `${base}icon.png`,
            bundleId: state.build?.bundleId ?? "com.abdullah.robob.cards",
            version: state.build?.version ?? "1.0",
            title: "Robob Cards",
          }),
        );
      }
      if (page === "/RobobCards.ipa") {
        if (req.method === "GET") updateState(dir, { lastDownloadAt: new Date().toISOString(), downloads: (state.downloads ?? 0) + 1 });
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": statSync(ipa).size,
          "cache-control": "no-store",
        });
        if (req.method === "HEAD") return res.end();
        return createReadStream(ipa).pipe(res);
      }
      return send(res, 404, "text/plain; charset=utf-8", "Not found\n");
    } catch (error) {
      return send(res, 400, "text/plain; charset=utf-8", `${error.message}\n`);
    }
  };
}

// Provisioning runs one at a time; a phone that registers while a run is in
// flight is picked up by one more run afterwards.
export function provisionQueue(run) {
  let running = null;
  let again = false;
  const kick = () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await run().catch(() => {});
      } while (again);
      running = null;
    })();
    return running;
  };
  return kick;
}

function startTunnel(port, log) {
  const child = spawn("/opt/homebrew/bin/cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = new Promise((resolve, reject) => {
    const scan = (chunk) => {
      log(chunk);
      const found = chunk.toString().match(QUICK_TUNNEL)?.[0];
      if (found) resolve(found);
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("exit", (code) => reject(new Error(`cloudflared exited (${code}) before giving a URL`)));
  });
  return { child, url };
}

async function main(dir) {
  const config = loadConfig();
  const initial = readState(dir);
  const { name, thread } = initial;
  const hours = initial.hours ?? 24;
  const log = (chunk) => process.stderr.write(chunk);
  const link = () => `${readState(dir).publicUrl}/c/${initial.token}/`;

  const kick = provisionQueue(async () => {
    try {
      const state = await provision({ dir, name, config });
      const text = `Robob Cards for ${name} is ready. The page at ${link()} now shows an Install button. Tell ${name} to go back to it in Safari (it refreshes by itself), tap Install, then Install in the pop-up. Version ${state.build.version}.`;
      notifyOwner({ name, key: `ready:${state.build.profileId}`, severity: "info", text });
      wakeThread(thread, text);
    } catch (error) {
      const text = `Robob Cards for ${name} failed while preparing the app: ${error.message}. ${name}'s page says something went wrong. Fix it, then run: integrations/robob-cards/bin/robob-cards-enroll install ${name}`;
      notifyOwner({ name, key: `failed:${Date.now()}`, severity: "attention", text });
      wakeThread(thread, text);
      throw error;
    }
  });

  const server = createServer(
    createHandler({
      dir,
      onEnrolled: ({ device, known }) => {
        const phone = [device.deviceName, device.product, device.osVersion && `iOS ${device.osVersion}`].filter(Boolean).join(", ");
        if (!known) {
          const text = `${name}'s iPhone registered for Robob Cards (${phone}). Preparing the app now, about a minute.`;
          notifyOwner({ name, key: `registered:${device.udid}`, severity: "info", text });
          wakeThread(thread, text);
        }
        const state = readState(dir);
        if (!known || state.phase !== "ready") kick();
      },
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const tunnel = startTunnel(port, log);
  const stop = (reason) => {
    tunnel.child.kill("SIGTERM");
    updateState(dir, { pid: null, tunnelPid: null, port: null, publicUrl: null, stoppedAt: new Date().toISOString(), stopReason: reason });
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("stopped"));
  process.on("SIGINT", () => stop("stopped"));
  tunnel.child.on("exit", () => stop("tunnel closed"));
  updateState(dir, {
    pid: process.pid,
    tunnelPid: tunnel.child.pid,
    port,
    publicUrl: null,
    startedAt: new Date().toISOString(),
    stopReason: null,
  });
  const publicUrl = await tunnel.url.catch((error) => {
    updateState(dir, { error: error.message });
    stop("tunnel failed");
  });
  updateState(dir, { publicUrl, expiresAt: new Date(Date.now() + hours * 3_600_000).toISOString() });
  setTimeout(() => stop("expired"), hours * 3_600_000);
  // A phone that registered while no server was running is picked up here.
  const state = readState(dir);
  if ((state.devices ?? []).length > 0 && state.phase !== "ready") kick();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(1);
  });
}

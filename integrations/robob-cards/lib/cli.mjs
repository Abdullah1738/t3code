import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { stepsText, TOKEN } from "./enroll.mjs";
import { provision } from "./provision.mjs";
import {
  builtApp,
  enrollDir,
  enrollNames,
  loadConfig,
  readState,
  serverAlive,
  tunnelAlive,
  updateState,
  writeState,
} from "./state.mjs";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");
const UDID = /^[0-9A-Fa-f-]{24,40}$/;

const USAGE = `usage:
  robob-cards-enroll <name> [--thread ID] [--hours N]
      Start (or reuse) a public enrollment page for <name>'s iPhone and print
      the link plus the steps to send. When the phone registers, the device is
      added to the team, the app is re-signed for it and the same page turns
      into an Install page. --thread wakes that Robob thread at each step.
  robob-cards-enroll status [name]      phase, link and devices
  robob-cards-enroll steps <name>       the steps text with the current link
  robob-cards-enroll install <name> [--udid UDID]
      Re-run registration and signing now (after a failure or a new build),
      optionally adding a UDID you already have, then print the link.
  robob-cards-enroll stop <name>        close the public page

Needs ~/.config/robob-cards/config.json and a build from bin/robob-cards-build.`;

const link = (state) => (state?.publicUrl ? `${state.publicUrl}/c/${state.token}/` : null);

function fail(message) {
  process.stderr.write(`robob-cards-enroll: ${message}\n`);
  process.exit(1);
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const value = predicate();
      if (value || Date.now() - started > timeoutMs) return resolve(value);
      setTimeout(tick, 500);
    };
    tick();
  });
}

async function ensureServer(name, dir) {
  let state = readState(dir);
  if (serverAlive(state, dir) && state.publicUrl) return state;
  const log = openSync(join(dir, "server.log"), "a", 0o600);
  const child = spawn(process.execPath, [SERVER, dir], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  closeSync(log);
  state = await waitFor(() => {
    const current = readState(dir);
    return current?.publicUrl && current.pid === child.pid ? current : null;
  }, 60_000);
  if (!state) fail(`the public tunnel did not come up within a minute; see ${join(dir, "server.log")}`);
  return state;
}

function describe(name) {
  const dir = enrollDir(name);
  const state = readState(dir);
  if (!state) return `${name}: not enrolled`;
  const alive = serverAlive(state, dir);
  const lines = [
    `${name}: ${state.phase ?? "waiting"}${state.error ? ` (${state.error})` : ""}`,
    `  page: ${alive && link(state) ? link(state) : "closed"}${alive && state.expiresAt ? ` until ${state.expiresAt}` : ""}`,
  ];
  for (const device of state.devices ?? []) {
    lines.push(`  device: ${[device.deviceName, device.product, device.osVersion].filter(Boolean).join(", ")} ${device.udid}`);
  }
  if (state.build) lines.push(`  build: ${state.build.version} signed ${state.build.signedAt}, profile ${state.build.profileUuid}`);
  if (state.downloads) lines.push(`  installs started: ${state.downloads}, last ${state.lastDownloadAt}`);
  return lines.join("\n");
}

async function start(name, { thread, hours }) {
  if (!existsSync(builtApp())) fail(`no build at ${builtApp()}; run bin/robob-cards-build first`);
  loadConfig();
  const dir = enrollDir(name);
  const previous = readState(dir);
  writeState(dir, {
    ...previous,
    name,
    token: TOKEN.test(previous?.token ?? "") ? previous.token : randomBytes(24).toString("base64url"),
    thread: thread ?? previous?.thread ?? null,
    hours,
    phase: previous?.phase ?? "waiting",
    devices: previous?.devices ?? [],
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const state = await ensureServer(name, dir);
  process.stdout.write(`${link(state)}\n\n${stepsText(link(state))}\n`);
}

async function install(name, { udid }) {
  const dir = enrollDir(name);
  if (!readState(dir)) fail(`${name} is not enrolled; start with: robob-cards-enroll ${name}`);
  if (udid) {
    if (!UDID.test(udid)) fail(`"${udid}" is not a UDID`);
    const state = readState(dir);
    if (!state.devices.some((device) => device.udid.toLowerCase() === udid.toLowerCase())) {
      updateState(dir, { devices: [...state.devices, { udid, product: null, osVersion: null, deviceName: null, enrolledAt: new Date().toISOString() }] });
    }
  }
  const state = await provision({ dir, name, config: loadConfig() });
  const running = await ensureServer(name, dir);
  process.stdout.write(`ready: version ${state.build.version}, ${state.devices.length} device(s)\n${link(running)}\n`);
}

function stop(name) {
  const dir = enrollDir(name);
  const state = readState(dir);
  const server = serverAlive(state, dir);
  const tunnel = tunnelAlive(state);
  if (server) process.kill(state.pid, "SIGTERM");
  if (tunnel) process.kill(state.tunnelPid, "SIGTERM");
  if (!server && state) updateState(dir, { pid: null, tunnelPid: null, publicUrl: null, stopReason: "stopped" });
  process.stdout.write(`${name}: ${server || tunnel ? "page closed" : "page already closed"}\n`);
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      thread: { type: "string" },
      hours: { type: "string", default: "24" },
      udid: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, name] = positionals;
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command === "status") {
    const names = name ? [name] : enrollNames();
    process.stdout.write(`${names.length ? names.map(describe).join("\n") : "no enrollments"}\n`);
    return;
  }
  if (command === "steps") {
    if (!name) fail("steps needs a name");
    const state = readState(enrollDir(name));
    if (!serverAlive(state, enrollDir(name)) || !link(state)) fail(`${name}'s page is closed; start it with: robob-cards-enroll ${name}`);
    process.stdout.write(`${stepsText(link(state))}\n`);
    return;
  }
  if (command === "install") {
    if (!name) fail("install needs a name");
    return install(name, values);
  }
  if (command === "stop") {
    if (!name) fail("stop needs a name");
    return stop(name);
  }
  if (name) fail(`unknown command "${command}"\n${USAGE}`);
  const hours = Number(values.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 72) fail("--hours must be between 0 and 72");
  return start(command, { thread: values.thread, hours });
}

main(process.argv.slice(2)).catch((error) => fail(error.message));

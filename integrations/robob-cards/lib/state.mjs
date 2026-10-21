import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function stateHome(env = process.env) {
  return env.ROBOB_CARDS_HOME ?? join(homedir(), ".local/share/robob-cards");
}

export function builtApp(env = process.env) {
  return join(stateHome(env), "build", "RobobCards.app");
}

export function enrollDir(name, env = process.env) {
  if (!NAME.test(name)) throw new Error(`invalid name "${name}" (lowercase letters, digits, dashes)`);
  return join(stateHome(env), "enroll", name);
}

export function enrollNames(env = process.env) {
  try {
    return readdirSync(join(stateHome(env), "enroll")).filter((name) => NAME.test(name)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function readState(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// The server and a foreground `install` can both write; a rename keeps every
// reader on a whole file.
export function writeState(dir, state) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `state.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(dir, "state.json"));
  return state;
}

export function updateState(dir, patch) {
  return writeState(dir, { ...readState(dir), ...patch, updatedAt: new Date().toISOString() });
}

const CONFIG_HELP = `{"asc": {"keyId", "issuerId", "keyPath"}, "signing": {"keyPath", "certPath"}}`;

export function configPath(env = process.env) {
  return env.ROBOB_CARDS_CONFIG ?? join(homedir(), ".config/robob-cards/config.json");
}

export function parseConfig(raw) {
  const asc = raw?.asc;
  const signing = raw?.signing;
  const strings = [asc?.keyId, asc?.issuerId, asc?.keyPath, signing?.keyPath, signing?.certPath];
  if (!strings.every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error(`robob-cards config needs ${CONFIG_HELP}`);
  }
  return {
    asc: { keyId: asc.keyId, issuerId: asc.issuerId, keyPath: asc.keyPath },
    signing: { keyPath: signing.keyPath, certPath: signing.certPath },
  };
}

export function loadConfig(env = process.env) {
  const path = configPath(env);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}. It holds ${CONFIG_HELP}`);
  }
  return parseConfig(raw);
}

function commandOf(pid) {
  if (!Number.isInteger(pid)) return null;
  try {
    process.kill(pid, 0);
    return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
  } catch {
    return null;
  }
}

// A pid file can outlive its process and the pid can be reused, so only a live
// process still running our server for this directory counts.
export function serverAlive(state, dir) {
  const command = commandOf(state?.pid);
  return Boolean(command?.includes("robob-cards") && command.includes("server.mjs") && command.includes(dir));
}

// cloudflared outlives a server that was killed hard; it is ours only while it
// still forwards to the port this enrollment recorded.
export function tunnelAlive(state) {
  const command = commandOf(state?.tunnelPid);
  return Boolean(command?.includes("cloudflared") && command.includes(`127.0.0.1:${state.port}`));
}

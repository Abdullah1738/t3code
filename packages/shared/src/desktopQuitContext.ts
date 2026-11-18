// @effect-diagnostics nodeBuiltinImport:off -- Read once at process boundaries, including synchronous quit callbacks.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type QuitInitiator =
  | "installer"
  | "watchdog"
  | "guard"
  | "menu/user"
  | "os-shutdown"
  | "signal"
  | "unknown";
export interface NativeQuitContext {
  readonly appleEventSenderPid?: number;
  readonly appleEventSenderBundleId?: string;
  readonly osShutdownInProgress: boolean;
}
export interface QuitContext extends NativeQuitContext {
  readonly initiator: QuitInitiator;
  readonly restartReason?: string;
  readonly requesterPid?: number;
  readonly signalParent?: { readonly pid: number; readonly name?: string };
}

export function readSmallJson(file: string): unknown {
  try {
    const fd = NodeFS.openSync(file, "r");
    try {
      const size = NodeFS.fstatSync(fd).size;
      if (size > 16384) return undefined;
      const bytes = Buffer.alloc(size);
      NodeFS.readSync(fd, bytes, 0, size, 0);
      return JSON.parse(bytes.toString("utf8"));
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

const object = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const pid = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const text = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 512;

export function classifyQuit(input: {
  readonly trigger: string;
  readonly pid: number;
  readonly processStartedAt: number;
  readonly now: number;
  readonly toolRequest?: unknown;
  readonly native: NativeQuitContext;
  readonly signalParent?: QuitContext["signalParent"];
}): QuitContext {
  const native = input.native;
  if (
    input.trigger === "os-shutdown" ||
    native.osShutdownInProgress ||
    native.appleEventSenderBundleId === "com.apple.loginwindow"
  ) {
    return { ...native, initiator: "os-shutdown", osShutdownInProgress: true };
  }
  if (input.trigger === "menu" || native.appleEventSenderBundleId === "com.apple.dock")
    return { ...native, initiator: "menu/user" };
  if (input.trigger === "quitAndInstall")
    return { ...native, initiator: "installer", restartReason: "quitAndInstall" };
  const request = input.toolRequest;
  if (
    object(request) &&
    (request.initiator === "installer" ||
      request.initiator === "watchdog" ||
      request.initiator === "guard") &&
    request.targetPid === input.pid &&
    typeof request.at === "number" &&
    request.at >= input.processStartedAt &&
    input.now >= request.at &&
    input.now - request.at <= 90_000 &&
    pid(request.requesterPid) &&
    text(request.reason)
  ) {
    return {
      ...native,
      initiator: request.initiator,
      restartReason: request.reason,
      requesterPid: request.requesterPid,
      ...(input.trigger === "signal" && input.signalParent
        ? { signalParent: input.signalParent }
        : {}),
    };
  }
  if (input.trigger === "signal")
    return {
      ...native,
      initiator: "signal",
      ...(input.signalParent ? { signalParent: input.signalParent } : {}),
    };
  return { ...native, initiator: "unknown" };
}

/** A single handoff record, not a clean/unclean shutdown journal. */
export function previousQuit(logDir: string, previousBootAt: number, now: number) {
  const value = readSmallJson(NodePath.join(logDir, "desktop-last-quit.json"));
  if (
    !object(value) ||
    !text(value.at) ||
    !pid(value.pid) ||
    !text(value.trigger) ||
    !["installer", "watchdog", "guard", "menu/user", "os-shutdown", "signal", "unknown"].includes(
      String(value.initiator),
    )
  )
    return null;
  const at = Date.parse(value.at);
  if (!Number.isFinite(at) || at < previousBootAt || at > now) return null;
  return {
    at: value.at,
    pid: value.pid,
    trigger: value.trigger,
    initiator: value.initiator as QuitInitiator,
    osShutdownInProgress: value.osShutdownInProgress === true,
    ...(text(value.restartReason) ? { restartReason: value.restartReason } : {}),
    ...(pid(value.requesterPid) ? { requesterPid: value.requesterPid } : {}),
    ...(pid(value.appleEventSenderPid) ? { appleEventSenderPid: value.appleEventSenderPid } : {}),
    ...(text(value.appleEventSenderBundleId)
      ? { appleEventSenderBundleId: value.appleEventSenderBundleId }
      : {}),
    ...(text(value.signal) ? { signal: value.signal } : {}),
    ...(object(value.signalParent) && pid(value.signalParent.pid)
      ? {
          signalParent: {
            pid: value.signalParent.pid,
            ...(text(value.signalParent.name) ? { name: value.signalParent.name } : {}),
          },
        }
      : {}),
  };
}

export function guardLaunchContext(value: string | undefined, previousBootAt: number, now: number) {
  if (!value || !/^guard:\d{13}$/.test(value)) return null;
  const at = Number(value.slice(6));
  return at >= previousBootAt && at <= now && now - at <= 90_000
    ? // @effect-diagnostics-next-line globalDate:off -- ISO text for an epoch-ms value the desktop caller passes in; not Effect code.
      { initiator: "guard", requestedAt: new Date(at).toISOString() }
    : null;
}

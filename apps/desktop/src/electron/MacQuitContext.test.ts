import { assert, afterEach, it, vi } from "vite-plus/test";
import {
  loadMacAppleEventReader,
  readMacQuitContext,
  registerMacQuitContext,
} from "./MacQuitContext.ts";

const native = vi.hoisted(() => ({
  event: 10n,
  eventId: 0x71756974,
  sender: 42,
  bundle: true,
  fail: false,
  selectors: new Map<bigint, string>(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  powerMonitor: { on: native.on, removeListener: native.removeListener },
}));
vi.mock("ffi-rs", () => ({
  DataType: { BigInt: 1, String: 2, I32: 3 },
  open: () => {
    if (native.fail) throw new Error("native library unavailable");
  },
  load: ({
    funcName,
    paramsValue,
  }: {
    funcName: string;
    paramsValue: Array<string | number | bigint>;
  }) => {
    if (funcName === "sel_registerName") {
      const id = BigInt(native.selectors.size + 100);
      native.selectors.set(id, String(paramsValue[0]));
      return id;
    }
    if (funcName === "objc_getClass") return 1n;
    const method = native.selectors.get(paramsValue[1] as bigint);
    switch (method) {
      case "sharedAppleEventManager":
        return 2n;
      case "currentAppleEvent":
        return native.event;
      case "eventID":
        return native.eventId;
      case "attributeDescriptorForKeyword:":
        return 3n;
      case "int32Value":
        return native.sender;
      case "runningApplicationWithProcessIdentifier:":
        return native.bundle ? 4n : 0n;
      case "bundleIdentifier":
        return 5n;
      case "UTF8String":
        return "com.apple.osascript";
      default:
        throw new Error("unexpected selector");
    }
  },
}));

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
  native.fail = false;
  native.event = 10n;
  native.eventId = 0x71756974;
  native.sender = 42;
  native.bundle = true;
  vi.clearAllMocks();
});

it("captures the current quit sender and keeps its PID when the sender has exited", async () => {
  const read = await loadMacAppleEventReader();
  assert.deepEqual(read(), {
    appleEventSenderPid: 42,
    appleEventSenderBundleId: "com.apple.osascript",
  });
  native.bundle = false;
  assert.deepEqual(read(), { appleEventSenderPid: 42 });
});

it("does not attribute unrelated events or missing sender metadata", async () => {
  const read = await loadMacAppleEventReader();
  native.event = 0n;
  assert.deepEqual(read(), {});
  native.event = 10n;
  native.eventId = 0x6f617070;
  assert.deepEqual(read(), {});
  native.eventId = 0x71756974;
  native.sender = 0;
  assert.deepEqual(read(), {});
});

it.each([false, true])(
  "records shutdown synchronously even if FFI is unavailable: %s",
  async (fail) => {
    native.fail = fail;
    const observed: Array<ReturnType<typeof readMacQuitContext>> = [];
    release = await registerMacQuitContext(() => observed.push(readMacQuitContext()));
    const listener = native.on.mock.calls.find(([name]) => name === "shutdown")?.[1];
    assert.isFunction(listener);
    listener();
    assert.equal(observed.length, 1);
    assert.isTrue(observed[0]?.osShutdownInProgress);
    release();
    release = undefined;
    assert.deepEqual(readMacQuitContext(), { osShutdownInProgress: false });
    assert.equal(native.removeListener.mock.calls.length, 1);
  },
);

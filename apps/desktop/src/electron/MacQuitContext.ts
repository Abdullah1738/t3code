import type { NativeQuitContext } from "@t3tools/shared/desktopQuitContext";

let read = (): NativeQuitContext => ({ osShutdownInProgress: false });
export const readMacQuitContext = () => read();

/** Preload FFI while the app is alive; before-quit must remain synchronous. */
export async function loadMacAppleEventReader() {
  const { DataType, load, open } = await import("ffi-rs");
  const library = "robob-quit-objc";
  open({ library, path: "/usr/lib/libobjc.A.dylib" });
  const cls = (name: string) =>
    load({
      library,
      funcName: "objc_getClass",
      retType: DataType.BigInt,
      paramsType: [DataType.String],
      paramsValue: [name],
    }) as bigint;
  const selector = (name: string) =>
    load({
      library,
      funcName: "sel_registerName",
      retType: DataType.BigInt,
      paramsType: [DataType.String],
      paramsValue: [name],
    }) as bigint;
  const pointer = (receiver: bigint, name: string) =>
    load({
      library,
      funcName: "objc_msgSend",
      retType: DataType.BigInt,
      paramsType: [DataType.BigInt, DataType.BigInt],
      paramsValue: [receiver, selector(name)],
    }) as bigint;
  const integer = (receiver: bigint, name: string) =>
    load({
      library,
      funcName: "objc_msgSend",
      retType: DataType.I32,
      paramsType: [DataType.BigInt, DataType.BigInt],
      paramsValue: [receiver, selector(name)],
    }) as number;
  const argument = (receiver: bigint, name: string, value: number) =>
    load({
      library,
      funcName: "objc_msgSend",
      retType: DataType.BigInt,
      paramsType: [DataType.BigInt, DataType.BigInt, DataType.I32],
      paramsValue: [receiver, selector(name), value],
    }) as bigint;
  return (): Omit<NativeQuitContext, "osShutdownInProgress"> => {
    try {
      const manager = pointer(cls("NSAppleEventManager"), "sharedAppleEventManager");
      const event = pointer(manager, "currentAppleEvent");
      // kAEQuitApplication / keySenderPIDAttr. An unrelated current event is not quit evidence.
      if (!event || integer(event, "eventID") !== 0x71756974) return {};
      const descriptor = argument(event, "attributeDescriptorForKeyword:", 0x73706964);
      const senderPid = descriptor ? integer(descriptor, "int32Value") : 0;
      if (senderPid <= 0) return {};
      const app = argument(
        cls("NSRunningApplication"),
        "runningApplicationWithProcessIdentifier:",
        senderPid,
      );
      const bundle = app ? pointer(app, "bundleIdentifier") : 0n;
      const bundleId = bundle
        ? (load({
            library,
            funcName: "objc_msgSend",
            retType: DataType.String,
            paramsType: [DataType.BigInt, DataType.BigInt],
            paramsValue: [bundle, selector("UTF8String")],
          }) as string)
        : undefined;
      return {
        appleEventSenderPid: senderPid,
        ...(bundleId ? { appleEventSenderBundleId: bundleId } : {}),
      };
    } catch {
      return {};
    }
  };
}

export async function registerMacQuitContext(onQuit: () => void) {
  const { powerMonitor } = await import("electron");
  let shutdown = false;
  let appleEvent = (): Omit<NativeQuitContext, "osShutdownInProgress"> => ({});
  read = () => ({ ...appleEvent(), osShutdownInProgress: shutdown });
  const onShutdown = () => {
    shutdown = true;
    onQuit();
  };
  powerMonitor.on("shutdown", onShutdown);
  try {
    appleEvent = await loadMacAppleEventReader();
  } catch {
    /* OS shutdown logging remains available without FFI. */
  }
  return () => {
    powerMonitor.removeListener("shutdown", onShutdown);
    read = () => ({ osShutdownInProgress: false });
  };
}

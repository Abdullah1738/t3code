import * as NodeNet from "node:net";

// Like outboundHttp.ts, ignore macOS peer-reset EINVAL for undici's optional QoS hint.
export function ignoreMacosTypeOfServiceEinval(
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node CLI; no Effect runtime.
  platform = process.platform,
  socketPrototype = NodeNet.Socket.prototype,
) {
  if (platform !== "darwin") return;
  const setTypeOfService = socketPrototype.setTypeOfService;
  if (typeof setTypeOfService !== "function") return;
  socketPrototype.setTypeOfService = function (...args) {
    try {
      return setTypeOfService.apply(this, args);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EINVAL") return this;
      throw error;
    }
  };
}

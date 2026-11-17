// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

// After an event-loop stall Node fires an expired keep-alive timer before it reads the
// socket, so a request that arrived during the stall was reset unread (client ECONNRESET).
// A server "timeout" listener replaces Node's destroy: close one turn later, only if idle.
export function deferIdleSocketClose<T extends NodeHttp.Server>(
  server: T,
  onClose?: (socket: NodeNet.Socket, outcome: "closed" | "rescued") => void,
  isActive: (socket: NodeNet.Socket) => boolean = () => false,
): T {
  server.on("timeout", (socket: NodeNet.Socket) => {
    const bytesRead = socket.bytesRead;
    setImmediate(() => {
      if (socket.destroyed) return;
      // A stale timeout can run after the parser has already dispatched the next
      // request. Its bytes then stay unchanged while the handler waits to save.
      if (isActive(socket) || socket.bytesRead !== bytesRead) {
        onClose?.(socket, "rescued");
        return;
      }
      onClose?.(socket, "closed");
      socket.destroy();
    });
  });
  return server;
}

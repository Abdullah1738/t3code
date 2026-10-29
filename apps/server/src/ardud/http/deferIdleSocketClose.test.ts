// Drives a raw Node HTTP server through a blocked event loop.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { deferIdleSocketClose } from "./deferIdleSocketClose.ts";

const servers: NodeHttp.Server[] = [];
const clients: NodeNet.Socket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

// Blocks the event loop the way a long synchronous task in the server does.
const stall = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const post = (body: string) =>
  `POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${body.length}\r\n\r\n${body}`;

async function keptAliveClient() {
  const handled: string[] = [];
  const server = deferIdleSocketClose(
    NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        handled.push(body);
        response.end(`ok:${body}`);
      });
    }),
  );
  server.keepAliveTimeout = 200;
  server.keepAliveTimeoutBuffer = 0;
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;
  const client = NodeNet.connect(port, "127.0.0.1");
  clients.push(client);
  client.on("error", () => {});
  let received = "";
  client.on("data", (chunk) => (received += chunk));
  const closed = new Promise<"closed">((resolve) => client.on("close", () => resolve("closed")));
  const answered = (text: string) =>
    new Promise<"answered">((resolve) => {
      const check = () => {
        if (received.includes(text)) resolve("answered");
      };
      client.on("data", check);
      check();
    });
  return { handled, client, closed, answered };
}

describe("deferIdleSocketClose", () => {
  it("answers a request that reached a kept-alive socket during a stall", async () => {
    const { handled, client, closed, answered } = await keptAliveClient();
    client.write(post("one"));
    await answered("ok:one");
    stall(400);
    client.write(post("two"));
    stall(50);
    expect(await Promise.race([answered("ok:two"), closed])).toBe("answered");
    expect(handled).toEqual(["one", "two"]);
  });

  it("still closes a kept-alive socket that stays idle", async () => {
    const { handled, client, closed, answered } = await keptAliveClient();
    client.write(post("one"));
    await answered("ok:one");
    expect(await closed).toBe("closed");
    expect(handled).toEqual(["one"]);
  });
});

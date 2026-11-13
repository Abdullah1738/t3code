import { startServer } from "./server.mjs";

startServer().on("error", () => {
  process.stderr.write("robob-widgets: server failed to start\n");
  process.exitCode = 1;
});

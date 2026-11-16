import { readFileSync } from "node:fs";
import { opaqueId } from "../../spectrum-bridge/src/remote-protocol.ts";

export async function runnerCommand(path: string, body: unknown) {
  const config = JSON.parse(readFileSync(process.env.MONI_RUNNER_CONFIG!, "utf8"));
  const token = readFileSync(config.tokenFile, "utf8").trim();
  const response = await fetch(`http://127.0.0.1:${config.port}${path}`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("Runner request failed");
  return response.json();
}
if (import.meta.main) {
  const [command, key] = process.argv.slice(2);
  if (!key) throw new Error("A stable operation key is required");
  const body = JSON.parse(await new Response(Bun.stdin.stream()).text());
  if (["events", "resolve"].includes(command)) { console.log(JSON.stringify(await runnerCommand(`/${command}`, body))); process.exit(0); }
  if (command === "watch") { console.log(JSON.stringify(await runnerCommand("/watch", body))); process.exit(0); }
  if (!["send", "files", "react", "agent-ask", "agent-answer", "agent-requests", "share", "unshare", "shares"].includes(command)) throw new Error("Unknown command");
  const share = ["share", "unshare", "shares"].includes(command);
  console.log(JSON.stringify(await runnerCommand(share ? `/${command}` : "/action", share ? body : { id: opaqueId(`${command}:${key}`), path: `/${command}`, body })));
}

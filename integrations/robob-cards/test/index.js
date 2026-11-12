import { readdirSync } from "node:fs";

// Node resolves an explicit test/ argument as a module, not as a test discovery root.
for (const file of readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".test.mjs")).sort()) {
  await import(new URL(file, import.meta.url));
}

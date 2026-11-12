cat > /Users/ardud/tmp/dia-inventory-712/wire.py <<'PY'
from pathlib import Path
root=Path('/Users/ardud/checkouts/dia-inventory-fallback/dia-agent-bridge/src')
p=root/'inventory.js';s=p.read_text();start=s.index('export const inventoryCall');end=s.index('export function inventoryNote',start);block=s[start:end];(root/'inventory-context.js').write_text('import { AsyncLocalStorage } from "node:async_hooks";\n'+block.replace('const isScriptError = error => /osascript|Dia scripting|invalid JSON/.test(error?.message || "");\n',''))
s=s.replace('import { AsyncLocalStorage } from "node:async_hooks";\n','');s=s[:s.index('export const inventoryCall')]+s[s.index('export function inventoryNote'):];s='import { inventoryCall, isScriptTimeout, logInventory } from "./inventory-context.js";\nexport { inventoryCall, isScriptTimeout } from "./inventory-context.js";\nconst isScriptError = error => /osascript|Dia scripting|invalid JSON/.test(error?.message || "");\n'+s
s=s.replace('if (fallback) return fallback;', 'if (fallback) {\n      const call = inventoryCall.getStore();\n      if (call) call.stale = fallback;\n      return fallback;\n    }')
s=s.replace('} catch (error) { return { error, durationMs: now() - started }; }','} catch (error) {\n        if (/bulk_to_walk/.test(error.message)) log({ tool, durationMs: now() - started, event: "bulk_to_walk", recovered: false });\n        return { error, durationMs: now() - started };\n      }')
p.write_text(s)
p=root/'dia.js';s=p.read_text();s='import { logInventory } from "./inventory-context.js";\n'+s;s=s.replace('timeoutMs = OSASCRIPT_TIMEOUT_MS) {','timeoutMs = OSASCRIPT_TIMEOUT_MS, operation = "osascript") {\n  const started = Date.now();')
s=s.replace('throw new Error(`osascript timed out after ${timeoutMs}ms (Dia may be unresponsive or showing a modal dialog)`);','if (operation !== "read profile inventory") logInventory({ operation, durationMs: Date.now() - started, event: "timeout", recovered: false });\n      throw new Error(`osascript timed out after ${timeoutMs}ms (Dia may be unresponsive or showing a modal dialog)`);')
# deadline creates an Error first, then catch must recognize it too
s=s.replace('error?.name === "AbortError")', 'error?.name === "AbortError" || /osascript timed out/.test(error?.message || ""))')
s=s.replace('8 * 1024 * 1024);','8 * 1024 * 1024, OSASCRIPT_TIMEOUT_MS, operation);').replace('2 * 1024 * 1024);','2 * 1024 * 1024, OSASCRIPT_TIMEOUT_MS, operation);')
s=s.replace('result = { inventory: (function () { ${JXA_INVENTORY_WALK', 'try { result = { inventory: (function () { ${JXA_INVENTORY_WALK').replace('})(), bulkFallback: true };','})(), bulkFallback: true }; } catch (error) { throw new Error("bulk_to_walk: " + error.message); }')
p.write_text(s)
p=root/'server.js';s=p.read_text();s='import { inventoryCall, inventoryNote, readInventory, createMappedStateReader } from "./inventory.js";\n'+s
s=s.replace('  getDiaInventory,\n','')
s=s.replace('  try { return textResult(await withDeadline(Promise.resolve().then(fn), TOOL_TIMEOUT_MS, label)); } catch (error) { return errorResult(error); }','''  return inventoryCall.run({ tool: label, stale: null }, async () => {
    try {
      const value = await withDeadline(Promise.resolve().then(fn), TOOL_TIMEOUT_MS, label);
      return textResult({ ...inventoryNote(inventoryCall.getStore().stale || {}), ...value });
    } catch (error) { return errorResult(error); }
  });''')
start=s.index('async function readMappedState()');end=s.index('server.tool("dia_profiles"',start)
s=s[:start]+'const { readMappedState, tabTarget } = createMappedStateReader();\n\n'+s[end:]
s=s.replace('active: mainId ? await getDiaActiveProfile(mainId) : null,','active: mainId ? { windowId: mainId, profile: state.inventory.find(w => w.id === mainId).activeProfile, tabId: state.inventory.find(w => w.id === mainId).activeTabId } : null,')
s=s.replace('await getDiaInventory()', '(await readInventory({ retry: true })).inventory')
# windows alone is allowed to use stale; profiles already mapped
start=s.index('server.tool("dia_windows"');end=s.index('server.tool("dia_window_close"',start);section=s[start:end].replace('readInventory({ retry: true })','readInventory({ allowStale: true })');s=s[:start]+section+s[end:]
# mutating CDP calls may retry only inventory, never whole tool
for name in ['dia_tab_close','dia_tab_activate']:
 start=s.index('server.tool("'+name+'"');end=s.index('\nserver.tool(',start+1);section=s[start:end].replace('tabTarget({ profileName, tabId, targetId })','tabTarget({ profileName, tabId, targetId }, { mutation: true })').replace('tabTarget({ profileName, targetId })','tabTarget({ profileName, targetId }, { mutation: true })').replace('safelyCdp(', 'safely(');s=s[:start]+section+s[end:]
# preflight focus even with explicit window; native focus must never be retried
start=s.index('server.tool("dia_profile_focus"');end=s.index('server.tool("dia_tab_execute"',start)
section=s[start:end].replace('async () => focusDiaProfile(profileName, windowId || mainWindowId((await readInventory({ retry: true })).inventory, readRegistry()))','async () => { const { inventory } = await readInventory({ retry: true }); return focusDiaProfile(profileName, windowId || mainWindowId(inventory, readRegistry())); }').replace('() => focusDiaTab(tabId)','async () => { await readInventory({ retry: true }); return focusDiaTab(tabId); }');s=s[:start]+section+s[end:]
# Creation cleanup will be handled in extracted helper
start=s.index('async function createAgentWindow(');end=s.index('async function closeSeed',start)
old=s[start:end];Path('/Users/ardud/tmp/dia-inventory-712/create-window-old.txt').write_text(old)
s=s[:start]+'''const createAgentWindow = createAgentWindowFactory({ readInventory, readRegistry, sweepAgentWindows,
  closeDiaWindow, createWindowTarget, closeTarget, registerWindow });

'''+s[end:]
start=s.index('async function findWindowWithUrl');end=s.index('// Dia\'s native tab creation',start);s=s[:start]+s[end:]
s='import { createAgentWindowFactory } from "./agent-window.js";\n'+s
p.write_text(s)
PY
python3 /Users/ardud/tmp/dia-inventory-712/wire.py
import { hook as toolLogHook } from "../lib/toollog";
// OpenCode 2 port of the Better Stack scope plugin.
// Every MCP tool call asks permission with action `<server>_<tool>`, so the
// permission evaluate hook can deny betterstack_* outside CRPKO directories.

const crpkoRoots = [
  "/Users/ardud/CrpkoArchitectureBroker",
  "/Volumes/ExternalSSD/CrpkoArchitectureBroker",
  "/Users/ardud/crpko-devops",
  "/Volumes/ExternalSSD/crpko-devops",
  "/Users/ardud/crpko-web-prototype",
  "/Users/ardud/crpko-mobile-prototype",
  "/Users/ardud/crpko-review",
  "/Users/ardud/crpko-worktrees",
  "/Users/ardud/crypko-frontend",
  "/Users/ardud/backoffice-core",
  "/Users/ardud/backoffice-frontend",
  "/Users/ardud/clickhouse-ingestor",
  "/Users/ardud/compliance-kyc",
  "/Users/ardud/custody-transfer",
  "/Users/ardud/edge-api",
  "/Users/ardud/foundationdb-explorer",
  "/Users/ardud/market-data-mock",
  "/Users/ardud/registry",
  "/Users/ardud/reporting",
  "/Users/ardud/rewards",
  "/Users/ardud/risk-liquidation",
  "/Users/ardud/trading-core",
  "/Users/ardud/venue-router-adapters-mock",
  "/Users/ardud/ws-gateway",
]

const message = "Better Stack is restricted to CRPKO work. Open the relevant CRPKO project before using this MCP."

export const isCrpkoDirectory = (directory: string) =>
  crpkoRoots.some(
    (root) => directory === root || directory.startsWith(`${root}/`) || directory.startsWith(`${root}-`),
  )

type Evaluation = { action: string; sessionID?: string; effect: "allow" | "deny" | "ask"; message?: string }

export default {
  id: "betterstack-scope",
  setup: async (ctx: any) => {
    const directory = String(ctx.location?.directory ?? "")
    const allowed = isCrpkoDirectory(directory)
    await ctx.permission.hook("evaluate", (event: Evaluation) => {
      if (!event.action.startsWith("betterstack_")) return
      toolLogHook('betterstack-scope', allowed ? 'allowed' : 'denied', 'betterstack-scope', performance.now(), undefined, undefined, {sessionId:event.sessionID}, {cwd:directory})
      if (allowed) return
      event.effect = "deny"
      event.message = message
    })
  },
}

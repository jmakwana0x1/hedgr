/**
 * Hedgr MCP server over stdio.
 *
 * Paper mode (default): in-memory or Supabase store, no chain calls, open
 * payment gate. Live behavior is opt-in via environment:
 *   HEDGR_X402=1   gate place_hedge behind x402 payment (X402_PAY_TO etc.)
 *   HEDGR_LIVE=1   execute real venue legs (HEDGR_PRIVATE_KEY, BASE_RPC_URL)
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getStore } from "@/lib/store";
import { seedCuratedPairs } from "@/lib/matching/curated";
import { createHedgrServer, type HedgrServerOptions } from "./tools";

async function main() {
  const store = getStore();
  await seedCuratedPairs(store);

  const options: HedgrServerOptions = {};
  if (process.env.HEDGR_X402 === "1") {
    const { x402GateFromEnv } = await import("@/lib/x402/gate");
    options.gate = x402GateFromEnv();
  }
  if (process.env.HEDGR_LIVE === "1") {
    const { liveExecutorFromEnv } = await import("@/lib/execution/live");
    options.executor = liveExecutorFromEnv(store);
  }

  const server = createHedgrServer(store, options);
  await server.connect(new StdioServerTransport());
  console.error("hedgr mcp server ready on stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

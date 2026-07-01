/**
 * Hedgr MCP server over stdio.
 *
 * Paper mode (default): in-memory or Supabase store, no chain calls, open
 * payment gate.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getStore } from "@/lib/store";
import { seedCuratedPairs } from "@/lib/matching/curated";
import { createHedgrServer, type HedgrServerOptions } from "./tools";

async function main() {
  const store = getStore();
  await seedCuratedPairs(store);

  const options: HedgrServerOptions = {};

  const server = createHedgrServer(store, options);
  await server.connect(new StdioServerTransport());
  console.error("hedgr mcp server ready on stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

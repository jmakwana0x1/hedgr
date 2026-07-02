/**
 * One-shot backfill: fetch the tracked Polymarket markets and Uniswap legs,
 * normalize, and persist markets plus price_history ticks.
 *
 * Usage: POLYMARKET_IDS=253591,253592 npm run ingest
 */
import { getStore } from "@/lib/store";
import { persistMarket } from "@/lib/ingestion/types";
import { PolymarketAdapter } from "@/lib/ingestion/polymarket";
import { UniswapAdapter, type UniswapLegConfig } from "@/lib/ingestion/uniswap";

export const DEFAULT_UNISWAP_LEGS: UniswapLegConfig[] = [
  {
    venueId: "base-weth-usdc-500",
    question: "Spot price of WETH in USDC on Base",
    rulesText:
      "Uniswap V3 WETH/USDC 0.05% pool on Base, QuoterV2 exact input of 1 WETH.",
    token: "0x4200000000000000000000000000000000000006",
    tokenDecimals: 18,
    feeTier: 500,
  },
];

async function main() {
  const store = getStore();
  const polymarketIds = (process.env.POLYMARKET_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (polymarketIds.length > 0) {
    const polymarket = new PolymarketAdapter(polymarketIds);
    for (const market of await polymarket.fetchMarkets()) {
      await persistMarket(store, market);
      console.log(`persisted ${market.id}: ${market.question}`);
    }
  } else {
    console.log("POLYMARKET_IDS not set, skipping polymarket backfill");
  }

  const uniswap = new UniswapAdapter(DEFAULT_UNISWAP_LEGS);
  for (const market of await uniswap.fetchMarkets()) {
    await persistMarket(store, market);
    console.log(`persisted ${market.id}: spot ${market.outcomes[0]?.price}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

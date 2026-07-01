import type { Store } from "@/lib/store/types";
import { seedCuratedPairs } from "@/lib/matching/curated";
import { refreshOpportunities } from "@/lib/engine/opportunities";
import { placeHedge } from "@/lib/execution";

/**
 * Demo-mode data for the dashboard when no database is configured: curated
 * pairs plus plausible venue prices and two paper positions. Live ingestion
 * overwrites all of this; idempotent by construction.
 */
const DEMO_PM_PRICES: Record<string, number> = {
  "polymarket:253591": 0.3,
  "polymarket:253612": 0.18,
  "polymarket:253640": 0.22,
  "polymarket:254001": 0.34,
  "polymarket:254012": 0.09,
  "polymarket:254030": 0.28,
  "polymarket:253655": 0.26,
  "polymarket:253701": 0.11,
  "polymarket:254044": 0.41,
  "polymarket:253720": 0.15,
};

const DEMO_SPOTS: Record<string, number> = {
  "uniswap:base-weth-usdc-500": 3500,
  "uniswap:base-cbbtc-usdc-500": 118_000,
};

export async function ensureDemoData(store: Store): Promise<void> {
  if ((await store.listPairs()).length > 0) return;
  await seedCuratedPairs(store);

  for (const market of await store.listMarkets()) {
    if (market.venue === "polymarket") {
      const yes = DEMO_PM_PRICES[market.id] ?? 0.5;
      await store.upsertMarket({
        ...market,
        outcomes: market.outcomes.map((o) => ({
          ...o,
          price: o.name === "YES" ? yes : 1 - yes,
        })),
      });
    } else {
      const spot = DEMO_SPOTS[market.id];
      if (spot) {
        await store.upsertMarket({
          ...market,
          outcomes: market.outcomes.map((o) => ({ ...o, price: spot })),
        });
      }
    }
  }

  await placeHedge(store, {
    idempotencyKey: "demo-position-0001",
    pairId: "pair-eth-4000-dec31",
  });
  await placeHedge(store, {
    idempotencyKey: "demo-position-0002",
    pairId: "pair-btc-150k-eoy",
    polymarketShares: 50,
    uniswapNotionalUsd: 500,
  });

  await refreshOpportunities(store);
}

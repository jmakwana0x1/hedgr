import type { Market } from "@/lib/types";
import type { MarketStore, PriceHistoryStore } from "@/lib/store/types";

export interface VenueAdapter {
  /** Fetch current state for the configured markets, normalized. */
  fetchMarkets(): Promise<Market[]>;
}

/**
 * Upsert a market and append one price_history tick per outcome.
 * All adapters persist through this single path.
 */
export async function persistMarket(
  store: MarketStore & PriceHistoryStore,
  market: Market,
  pairId?: string,
): Promise<void> {
  await store.upsertMarket(market);
  for (const outcome of market.outcomes) {
    await store.appendTick({
      pairId,
      marketId: market.id,
      outcome: outcome.name,
      price: outcome.price,
      ts: market.updatedAt,
    });
  }
}

import type { HedgePlan, Market, Opportunity, Pair } from "@/lib/types";
import type { Store } from "@/lib/store/types";
import { isTradable } from "@/lib/matching/engine";
import { computeFees, DEFAULT_FEES, type FeeModel } from "./fees";
import {
  expectedValueUsd,
  maxLossUsd,
  pairPayoffInputs,
  payoffMatrix,
} from "./payoff";

export interface Sizing {
  polymarketShares: number;
  uniswapNotionalUsd: number;
}

export const DEFAULT_SIZING: Sizing = {
  polymarketShares: 100,
  uniswapNotionalUsd: 1_000,
};

export function outcomePrice(market: Market, name: string): number {
  const outcome = market.outcomes.find((o) => o.name === name);
  if (!outcome) throw new Error(`market ${market.id} has no ${name} outcome`);
  return outcome.price;
}

/**
 * Construct the hedge for a pair: hold the token leg long and buy the
 * Polymarket side that pays when the event is adverse for the token. For an
 * upside market (token higher on YES) the insurance side is NO; for a
 * downside market it is YES.
 */
export function suggestPlan(pair: Pair, sizing: Sizing = DEFAULT_SIZING): HedgePlan {
  if (pair.priceIfYes == null || pair.priceIfNo == null) {
    throw new Error(`pair ${pair.id} is missing modeled conditional prices`);
  }
  return {
    pairId: pair.id,
    polymarketSide: pair.priceIfYes < pair.priceIfNo ? "YES" : "NO",
    polymarketShares: sizing.polymarketShares,
    uniswapDirection: "long",
    uniswapNotionalUsd: sizing.uniswapNotionalUsd,
  };
}

export function computeOpportunity(
  pair: Pair,
  polymarket: Market,
  uniswap: Market,
  feeModel: FeeModel = DEFAULT_FEES,
  sizing: Sizing = DEFAULT_SIZING,
  now = new Date(),
): Opportunity {
  const plan = suggestPlan(pair, sizing);
  const yesPrice = outcomePrice(polymarket, "YES");
  const noPrice = outcomePrice(polymarket, "NO");
  const spot = outcomePrice(uniswap, "SPOT");
  if (spot <= 0) throw new Error(`uniswap leg ${uniswap.id} has no spot price yet`);

  const inputs = pairPayoffInputs(pair, yesPrice, noPrice, spot);
  const entryPrice = plan.polymarketSide === "YES" ? yesPrice : noPrice;
  const fees = computeFees(plan, entryPrice, feeModel);
  const scenarios = payoffMatrix(plan, inputs, fees.totalUsd);

  return {
    id: `opp:${pair.id}`,
    pairId: pair.id,
    evUsd: expectedValueUsd(scenarios),
    maxLossUsd: maxLossUsd(scenarios),
    feesUsd: fees.totalUsd,
    plan,
    scenarios,
    computedAt: now.toISOString(),
  };
}

/**
 * Recompute and persist ranked opportunities for every tradable pair.
 * Runs on tick. Pairs that are not confirmed are skipped outright, as are
 * pairs whose legs have not been priced yet.
 */
export async function refreshOpportunities(
  store: Store,
  feeModel: FeeModel = DEFAULT_FEES,
  sizing: Sizing = DEFAULT_SIZING,
): Promise<Opportunity[]> {
  const pairs = await store.listPairs({ status: "confirmed" });
  const opportunities: Opportunity[] = [];
  for (const pair of pairs) {
    if (!isTradable(pair)) continue;
    const polymarket = await store.getMarket(pair.marketAId);
    const uniswap = await store.getMarket(pair.marketBId);
    if (!polymarket || !uniswap) continue;
    try {
      opportunities.push(computeOpportunity(pair, polymarket, uniswap, feeModel, sizing));
    } catch {
      // Legs without live prices yet are skipped, not ranked with garbage.
    }
  }
  opportunities.sort((a, b) => b.evUsd - a.evUsd);
  await store.replaceOpportunities(opportunities);
  return opportunities;
}

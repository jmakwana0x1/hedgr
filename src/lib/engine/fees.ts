import type { HedgePlan } from "@/lib/types";

/**
 * Fee model for a two-leg hedge. All rates are basis points on notional.
 * A wrong constant here silently poisons every ranking; any change requires
 * hand-computed expected values in tests/engine.test.ts.
 */
export interface FeeModel {
  /** Polymarket fee on traded notional. Most markets are currently 0. */
  polymarketFeeBps: number;
  /** Uniswap pool fee per swap (a 0.05% tier is 5 bps, 0.3% is 30 bps). */
  uniswapPoolFeeBps: number;
  /** Flat gas estimate per on-chain transaction, in USD. */
  gasPerTxUsd: number;
}

export const DEFAULT_FEES: FeeModel = {
  polymarketFeeBps: 0,
  uniswapPoolFeeBps: 5,
  gasPerTxUsd: 0.05,
};

/**
 * Transactions per hedge lifecycle: Polymarket entry, Uniswap entry swap,
 * Uniswap exit swap. Polymarket settlement redemption is folded into the
 * polymarket fee rate rather than counted as a fourth transaction.
 */
export const TXS_PER_HEDGE = 3;

export interface FeeBreakdown {
  polymarketUsd: number;
  uniswapUsd: number;
  gasUsd: number;
  totalUsd: number;
}

/**
 * Total fees for a hedge plan.
 * - Polymarket: fee rate on entry notional (shares x entry price).
 * - Uniswap: pool fee on notional, paid on entry and again on exit.
 * - Gas: flat per-transaction estimate x TXS_PER_HEDGE.
 */
export function computeFees(
  plan: Pick<HedgePlan, "polymarketShares" | "uniswapNotionalUsd">,
  polymarketEntryPrice: number,
  model: FeeModel = DEFAULT_FEES,
): FeeBreakdown {
  const polymarketNotional = plan.polymarketShares * polymarketEntryPrice;
  const polymarketUsd = (polymarketNotional * model.polymarketFeeBps) / 10_000;
  const uniswapUsd =
    (plan.uniswapNotionalUsd * model.uniswapPoolFeeBps * 2) / 10_000;
  const gasUsd = model.gasPerTxUsd * TXS_PER_HEDGE;
  return {
    polymarketUsd,
    uniswapUsd,
    gasUsd,
    totalUsd: polymarketUsd + uniswapUsd + gasUsd,
  };
}

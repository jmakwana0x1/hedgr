import type { HedgePlan, Pair } from "@/lib/types";

export interface CurvePoint {
  /** Token price at resolution, USDC. */
  x: number;
  /** Combined net payoff, USD. */
  y: number;
}

export interface PayoffCurve {
  /** Net payoff vs token price when the event resolves YES. */
  yes: CurvePoint[];
  /** Net payoff vs token price when the event resolves NO. */
  no: CurvePoint[];
  /** Modeled resolution points, one per branch. */
  markers: { branch: "yes" | "no"; x: number; y: number }[];
  domain: { min: number; max: number };
}

/**
 * Combined payoff of the two-leg hedge as a function of the token price at
 * resolution, split by resolution branch. The Polymarket leg is a constant
 * within a branch; the token leg is linear in price.
 */
export function buildPayoffCurve(
  plan: HedgePlan,
  pair: Pair,
  entry: { polymarketPrice: number; spot: number },
  feesUsd: number,
  samples = 61,
): PayoffCurve {
  if (pair.priceIfYes == null || pair.priceIfNo == null) {
    throw new Error(`pair ${pair.id} is missing modeled conditional prices`);
  }
  const { spot } = entry;
  const cost = plan.polymarketShares * entry.polymarketPrice;
  const pmYes = (plan.polymarketSide === "YES" ? plan.polymarketShares : 0) - cost;
  const pmNo = (plan.polymarketSide === "NO" ? plan.polymarketShares : 0) - cost;

  const tokenNet = (price: number) => {
    const move = price / spot - 1;
    return plan.uniswapDirection === "long"
      ? plan.uniswapNotionalUsd * move
      : plan.uniswapNotionalUsd * -move;
  };

  const min = Math.min(pair.priceIfNo, pair.priceIfYes, spot) * 0.92;
  const max = Math.max(pair.priceIfNo, pair.priceIfYes, spot) * 1.08;
  const step = (max - min) / (samples - 1);

  const branch = (pmNet: number): CurvePoint[] =>
    Array.from({ length: samples }, (_, i) => {
      const x = min + i * step;
      return { x, y: pmNet + tokenNet(x) - feesUsd };
    });

  return {
    yes: branch(pmYes),
    no: branch(pmNo),
    markers: [
      { branch: "yes", x: pair.priceIfYes, y: pmYes + tokenNet(pair.priceIfYes) - feesUsd },
      { branch: "no", x: pair.priceIfNo, y: pmNo + tokenNet(pair.priceIfNo) - feesUsd },
    ],
    domain: { min, max },
  };
}

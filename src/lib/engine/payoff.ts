import type { HedgePlan, Pair, ScenarioPayoff } from "@/lib/types";

/** Inputs the payoff matrix needs beyond the plan itself. */
export interface PayoffInputs {
  /** Current YES price on the Polymarket leg (implied probability). */
  yesPrice: number;
  /** Current NO price on the Polymarket leg. */
  noPrice: number;
  /** Current token spot on the Uniswap leg (USDC). */
  spot: number;
  /** Modeled token spot under each resolution, from the reviewed pair. */
  priceIfYes: number;
  priceIfNo: number;
  /** Prior probability the venues settle inconsistently. */
  divergenceProb: number;
}

export function pairPayoffInputs(
  pair: Pair,
  yesPrice: number,
  noPrice: number,
  spot: number,
): PayoffInputs {
  if (pair.priceIfYes == null || pair.priceIfNo == null) {
    throw new Error(`pair ${pair.id} is missing modeled conditional prices`);
  }
  return {
    yesPrice,
    noPrice,
    spot,
    priceIfYes: pair.priceIfYes,
    priceIfNo: pair.priceIfNo,
    divergenceProb: pair.divergenceProb,
  };
}

function polymarketNet(plan: HedgePlan, inputs: PayoffInputs, resolvedYes: boolean): number {
  const entryPrice = plan.polymarketSide === "YES" ? inputs.yesPrice : inputs.noPrice;
  const cost = plan.polymarketShares * entryPrice;
  const won = (plan.polymarketSide === "YES") === resolvedYes;
  return (won ? plan.polymarketShares : 0) - cost;
}

function tokenNet(plan: HedgePlan, inputs: PayoffInputs, conditionalPrice: number): number {
  const move = conditionalPrice / inputs.spot - 1;
  return plan.uniswapDirection === "long"
    ? plan.uniswapNotionalUsd * move
    : plan.uniswapNotionalUsd * -move;
}

/**
 * Gross payoff matrix across resolution scenarios, before fees.
 *
 * The divergence scenario is the resolution-divergence discount: the venues
 * settle inconsistently and the hedge's protection fails. It is modeled
 * conservatively as the Polymarket leg losing outright while the token leg
 * takes its worse conditional outcome.
 */
export function payoffMatrix(
  plan: HedgePlan,
  inputs: PayoffInputs,
  feesUsd: number,
): ScenarioPayoff[] {
  const d = inputs.divergenceProb;
  const pYes = inputs.yesPrice;

  const grossYes =
    polymarketNet(plan, inputs, true) + tokenNet(plan, inputs, inputs.priceIfYes);
  const grossNo =
    polymarketNet(plan, inputs, false) + tokenNet(plan, inputs, inputs.priceIfNo);

  const pmEntry =
    plan.polymarketSide === "YES" ? inputs.yesPrice : inputs.noPrice;
  const pmLoss = -plan.polymarketShares * pmEntry;
  const worstToken = Math.min(
    tokenNet(plan, inputs, inputs.priceIfYes),
    tokenNet(plan, inputs, inputs.priceIfNo),
  );
  const grossDivergence = pmLoss + worstToken;

  return [
    {
      scenario: "yes",
      probability: pYes * (1 - d),
      grossUsd: grossYes,
      netUsd: grossYes - feesUsd,
    },
    {
      scenario: "no",
      probability: (1 - pYes) * (1 - d),
      grossUsd: grossNo,
      netUsd: grossNo - feesUsd,
    },
    {
      scenario: "divergence",
      probability: d,
      grossUsd: grossDivergence,
      netUsd: grossDivergence - feesUsd,
    },
  ];
}

export function expectedValueUsd(scenarios: ScenarioPayoff[]): number {
  return scenarios.reduce((ev, s) => ev + s.probability * s.netUsd, 0);
}

export function maxLossUsd(scenarios: ScenarioPayoff[]): number {
  return Math.min(...scenarios.map((s) => s.netUsd));
}

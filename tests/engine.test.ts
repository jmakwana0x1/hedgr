import { describe, expect, it } from "vitest";
import type { Market, Pair } from "@/lib/types";
import { MemoryStore } from "@/lib/store/memory";
import { computeFees, DEFAULT_FEES, type FeeModel } from "@/lib/engine/fees";
import {
  expectedValueUsd,
  maxLossUsd,
  pairPayoffInputs,
  payoffMatrix,
} from "@/lib/engine/payoff";
import {
  computeOpportunity,
  refreshOpportunities,
  suggestPlan,
} from "@/lib/engine/opportunities";

/**
 * Every expected value in this file is computed by hand in the comments,
 * never copied from engine output. See CLAUDE.md.
 */

const FEES: FeeModel = {
  polymarketFeeBps: 200,
  uniswapPoolFeeBps: 30,
  gasPerTxUsd: 0.05,
};

function pmMarket(yes: number, no: number, id = "253591"): Market {
  return {
    id: `polymarket:${id}`,
    venue: "polymarket",
    venueId: id,
    question: "Will ETH close above $4,000 on December 31?",
    rulesText: "Coinbase ETH-USD close at or above $4,000.00.",
    outcomes: [
      { name: "YES", price: yes },
      { name: "NO", price: no },
    ],
    status: "active",
    updatedAt: new Date().toISOString(),
  };
}

function uniMarket(spot: number): Market {
  return {
    id: "uniswap:base-weth-usdc-500",
    venue: "uniswap",
    venueId: "base-weth-usdc-500",
    question: "Spot price of WETH in USDC on Base",
    rulesText: "Uniswap V3 WETH/USDC pool.",
    outcomes: [{ name: "SPOT", price: spot }],
    status: "active",
    updatedAt: new Date().toISOString(),
  };
}

function upside(overrides: Partial<Pair> = {}): Pair {
  return {
    id: "pair-eth-4000",
    marketAId: "polymarket:253591",
    marketBId: "uniswap:base-weth-usdc-500",
    status: "confirmed",
    divergenceProb: 0.02,
    priceIfYes: 4100,
    priceIfNo: 3400,
    reviewedBy: "curation-v1",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("fee math", () => {
  it("computes each component against hand-computed values", () => {
    // pm notional = 100 shares x 0.70 = $70; 200 bps -> $1.40
    // uniswap = $1000 x 30 bps x 2 swaps -> $6.00
    // gas = $0.05 x 3 txs -> $0.15
    const fees = computeFees(
      { polymarketShares: 100, uniswapNotionalUsd: 1000 },
      0.7,
      FEES,
    );
    expect(fees.polymarketUsd).toBeCloseTo(1.4, 10);
    expect(fees.uniswapUsd).toBeCloseTo(6.0, 10);
    expect(fees.gasUsd).toBeCloseTo(0.15, 10);
    expect(fees.totalUsd).toBeCloseTo(7.55, 10);
  });

  it("default model: zero polymarket fee, 5 bps pool, $0.05 gas", () => {
    // uniswap = $1000 x 5 bps x 2 = $1.00; gas = $0.15; pm = $0
    const fees = computeFees(
      { polymarketShares: 100, uniswapNotionalUsd: 1000 },
      0.5,
      DEFAULT_FEES,
    );
    expect(fees.polymarketUsd).toBe(0);
    expect(fees.uniswapUsd).toBeCloseTo(1.0, 10);
    expect(fees.totalUsd).toBeCloseTo(1.15, 10);
  });
});

describe("payoff matrix and EV", () => {
  // Worked example used throughout:
  //   YES 0.30 / NO 0.70, spot 3500, priceIfYes 4100, priceIfNo 3400, d 0.02
  //   plan: upside market -> buy NO 100 shares @0.70 (cost $70), long $1000
  //   YES:  pm -70;         token 1000 x (4100/3500 - 1) = +171.428571
  //         gross +101.428571
  //   NO:   pm +100 - 70;   token 1000 x (3400/3500 - 1) = -28.571429
  //         gross +1.428571
  //   DIV:  pm -70;         worst token -28.571429 -> gross -98.571429
  //   fees (FEES model) = 7.55
  //   probabilities: yes 0.294, no 0.686, div 0.02
  //   EV = 0.294 x 101.428571 + 0.686 x 1.428571 - 0.02 x 98.571429 - 7.55
  //      = 29.82 + 0.98 - 1.971429 - 7.55 = 21.278571
  //   maxLoss = -98.571429 - 7.55 = -106.121429
  const pair = upside();
  const plan = suggestPlan(pair);
  const inputs = pairPayoffInputs(pair, 0.3, 0.7, 3500);

  it("suggests insuring the adverse side, long the token", () => {
    expect(plan.polymarketSide).toBe("NO");
    expect(plan.uniswapDirection).toBe("long");
    expect(plan.polymarketShares).toBe(100);
    expect(plan.uniswapNotionalUsd).toBe(1000);
  });

  it("computes gross scenario payoffs by hand", () => {
    const scenarios = payoffMatrix(plan, inputs, 0);
    const byName = Object.fromEntries(scenarios.map((s) => [s.scenario, s]));

    expect(byName.yes.grossUsd).toBeCloseTo(101.428571, 5);
    expect(byName.no.grossUsd).toBeCloseTo(1.428571, 5);
    expect(byName.divergence.grossUsd).toBeCloseTo(-98.571429, 5);

    expect(byName.yes.probability).toBeCloseTo(0.294, 10);
    expect(byName.no.probability).toBeCloseTo(0.686, 10);
    expect(byName.divergence.probability).toBeCloseTo(0.02, 10);

    const totalProbability = scenarios.reduce((p, s) => p + s.probability, 0);
    expect(totalProbability).toBeCloseTo(1, 10);
  });

  it("computes EV and max loss net of fees by hand", () => {
    const scenarios = payoffMatrix(plan, inputs, 7.55);
    expect(expectedValueUsd(scenarios)).toBeCloseTo(21.278571, 5);
    expect(maxLossUsd(scenarios)).toBeCloseTo(-106.121429, 5);
  });

  it("EV sign flips when fees swamp the edge", () => {
    const gross = expectedValueUsd(payoffMatrix(plan, inputs, 0));
    expect(gross).toBeCloseTo(28.828571, 5);
    expect(gross).toBeGreaterThan(0);

    // Fees reduce EV exactly one-for-one, so gross + $1 of fees flips sign.
    const swamped = expectedValueUsd(payoffMatrix(plan, inputs, gross + 1));
    expect(swamped).toBeCloseTo(-1, 5);
  });

  it("a higher divergence prior strictly lowers EV", () => {
    const cautious = pairPayoffInputs(upside({ divergenceProb: 0.1 }), 0.3, 0.7, 3500);
    const ev = expectedValueUsd(payoffMatrix(plan, inputs, 7.55));
    const cautiousEv = expectedValueUsd(payoffMatrix(plan, cautious, 7.55));
    expect(cautiousEv).toBeLessThan(ev);
  });

  it("downside markets insure with YES", () => {
    const downside = upside({ id: "pair-eth-3000", priceIfYes: 2950, priceIfNo: 3800 });
    expect(suggestPlan(downside).polymarketSide).toBe("YES");
  });
});

describe("opportunity ranking", () => {
  it("computeOpportunity matches the hand-computed worked example", () => {
    const opp = computeOpportunity(upside(), pmMarket(0.3, 0.7), uniMarket(3500), FEES);
    expect(opp.evUsd).toBeCloseTo(21.278571, 5);
    expect(opp.maxLossUsd).toBeCloseTo(-106.121429, 5);
    expect(opp.feesUsd).toBeCloseTo(7.55, 10);
    expect(opp.scenarios).toHaveLength(3);
  });

  it("ranks a known-negative-EV pair below a known-positive one", async () => {
    const store = new MemoryStore();
    // Positive: the worked example, EV +21.28.
    await store.upsertMarket(pmMarket(0.3, 0.7));
    await store.upsertMarket(uniMarket(3500));
    await store.upsertPair(upside());
    // Negative: insurance side NO costs 0.98.
    //   YES: -98 + 171.428571 = +73.428571
    //   NO:  +2 - 28.571429 = -26.571429
    //   DIV: -98 - 28.571429 = -126.571429
    //   EV_gross = 0.0196 x 73.428571 + 0.9604 x (-26.571429) + 0.02 x (-126.571429)
    //            = 1.439200 - 25.519200 - 2.531429 = -26.611429 (before fees)
    //   fees: pm 100 x 0.98 x 200 bps = 1.96; uniswap 6.00; gas 0.15 -> 8.11
    //   EV_net = -26.611429 - 8.11 = -34.721429
    await store.upsertMarket(pmMarket(0.02, 0.98, "254001"));
    await store.upsertPair(
      upside({ id: "pair-negative", marketAId: "polymarket:254001" }),
    );

    const ranked = await refreshOpportunities(store, FEES);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].pairId).toBe("pair-eth-4000");
    expect(ranked[0].evUsd).toBeGreaterThan(0);
    expect(ranked[1].pairId).toBe("pair-negative");
    expect(ranked[1].evUsd).toBeCloseTo(-34.721429, 5);
    expect(ranked[1].evUsd).toBeLessThan(0);
  });

  it("never ranks unconfirmed pairs", async () => {
    const store = new MemoryStore();
    await store.upsertMarket(pmMarket(0.3, 0.7));
    await store.upsertMarket(uniMarket(3500));
    await store.upsertPair(upside({ status: "candidate" }));

    const ranked = await refreshOpportunities(store, FEES);
    expect(ranked).toHaveLength(0);
  });

  it("skips pairs whose uniswap leg has no live spot yet", async () => {
    const store = new MemoryStore();
    await store.upsertMarket(pmMarket(0.3, 0.7));
    await store.upsertMarket(uniMarket(0));
    await store.upsertPair(upside());

    const ranked = await refreshOpportunities(store, FEES);
    expect(ranked).toHaveLength(0);
  });
});

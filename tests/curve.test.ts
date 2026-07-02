import { describe, expect, it } from "vitest";
import { buildPayoffCurve } from "@/lib/engine/curve";
import type { HedgePlan, Pair } from "@/lib/types";

const plan: HedgePlan = {
  pairId: "pair-eth-4000",
  polymarketSide: "NO",
  polymarketShares: 100,
  uniswapDirection: "long",
  uniswapNotionalUsd: 1000,
};

const pair: Pair = {
  id: "pair-eth-4000",
  marketAId: "polymarket:253591",
  marketBId: "uniswap:base-weth-usdc-500",
  status: "confirmed",
  divergenceProb: 0.02,
  priceIfYes: 4100,
  priceIfNo: 3400,
  createdAt: new Date().toISOString(),
};

describe("payoff curve", () => {
  // Same worked example as tests/engine.test.ts: NO x100 @0.70, long $1000,
  // spot 3500, fees 7.55. Marker values must equal the engine's scenario
  // nets: yes +93.878571, no -6.121429.
  it("marker payoffs match the hand-computed scenario nets", () => {
    const curve = buildPayoffCurve(plan, pair, { polymarketPrice: 0.7, spot: 3500 }, 7.55);
    const yes = curve.markers.find((m) => m.branch === "yes")!;
    const no = curve.markers.find((m) => m.branch === "no")!;
    expect(yes.x).toBe(4100);
    expect(yes.y).toBeCloseTo(93.878571, 5);
    expect(no.x).toBe(3400);
    expect(no.y).toBeCloseTo(-6.121429, 5);
  });

  it("branches are linear in token price and offset by the polymarket payout", () => {
    const curve = buildPayoffCurve(plan, pair, { polymarketPrice: 0.7, spot: 3500 }, 0);
    // At any x, NO branch = YES branch + 100 (the NO payout).
    for (let i = 0; i < curve.yes.length; i += 15) {
      expect(curve.no[i].y - curve.yes[i].y).toBeCloseTo(100, 8);
    }
    // Token leg slope: dy/dx = notional / spot.
    const dy = curve.yes[10].y - curve.yes[0].y;
    const dx = curve.yes[10].x - curve.yes[0].x;
    expect(dy / dx).toBeCloseTo(1000 / 3500, 8);
  });
});

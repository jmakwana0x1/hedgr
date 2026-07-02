import { describe, expect, it } from "vitest";
import { marketId, type Market } from "@/lib/types";
import { MemoryStore } from "@/lib/store/memory";
import {
  confirmPair,
  evaluatePair,
  isTradable,
  SIMILARITY_THRESHOLD,
} from "@/lib/matching/engine";
import { compareRules, extractAssets, extractFigures } from "@/lib/matching/rules";
import { CURATED_PAIRS, seedCuratedPairs, UNISWAP_LEGS } from "@/lib/matching/curated";

function market(partial: Partial<Market> & { venueId: string }): Market {
  return {
    id: marketId(partial.venue ?? "polymarket", partial.venueId),
    venue: "polymarket",
    question: "",
    rulesText: "",
    outcomes: [],
    status: "active",
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

const ethMarket = market({
  venueId: "253591",
  question: "Will ETH close above $4,000 on December 31?",
  rulesText:
    'Resolves to "Yes" if the Coinbase 1 minute candle for ETH-USD closes at or above $4,000.00 on December 31.',
});

const wethLeg = market({
  venue: "uniswap",
  venueId: "base-weth-usdc-500",
  question: "Spot price of WETH in USDC on Base, ETH above $4,000 hedge leg",
  rulesText:
    "Uniswap V3 WETH/USDC pool on Base tracking ETH-USD around the $4,000 level.",
});

const btcLeg = market({
  venue: "uniswap",
  venueId: "base-cbbtc-usdc-500",
  question: "Spot price of cbBTC in USDC on Base",
  rulesText:
    "Uniswap V3 cbBTC/USDC pool on Base, cbBTC tracks BTC-USD around $150,000.",
});

describe("rule comparison", () => {
  it("extracts normalized assets and figures", () => {
    expect(extractAssets("WETH tracks Ethereum")).toEqual(new Set(["eth"]));
    expect(extractAssets("cbBTC wraps Bitcoin")).toEqual(new Set(["btc"]));
    expect(extractFigures("closes at or above $4,000.00 on December 31")).toContain(4000);
  });

  it("accepts rule texts about the same asset and threshold", () => {
    const result = compareRules(ethMarket.rulesText, wethLeg.rulesText + " $4,000");
    expect(result.compatible).toBe(true);
  });

  it("rejects rule texts about different assets", () => {
    const result = compareRules(ethMarket.rulesText, btcLeg.rulesText);
    expect(result.compatible).toBe(false);
    expect(result.reasons.join(" ")).toContain("asset mismatch");
  });
});

describe("pair evaluation", () => {
  it("marks a plausible match as candidate, never confirmed", async () => {
    const evaluation = await evaluatePair(ethMarket, wethLeg);
    expect(evaluation.status).toBe("candidate");
    expect(evaluation.similarity).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
    // The pipeline type cannot express 'confirmed'; assert at runtime too.
    expect(evaluation.status).not.toBe("confirmed");
  });

  it("flags a deliberately mismatched pair instead of confirming it", async () => {
    const evaluation = await evaluatePair(ethMarket, btcLeg);
    expect(evaluation.status).toBe("flagged");
    expect(evaluation.reasons.length).toBeGreaterThan(0);
  });

  it("flags identical assets with conflicting thresholds", async () => {
    const otherStrike = market({
      venueId: "x",
      question: "Will ETH close above $9,000 on December 31?",
      rulesText: "Resolves YES if Coinbase ETH-USD closes at or above $9,000.00.",
    });
    const evaluation = await evaluatePair(ethMarket, otherStrike);
    expect(evaluation.status).toBe("flagged");
    expect(evaluation.reasons.join(" ")).toContain("key figure mismatch");
  });
});

describe("tradability invariant", () => {
  it("unreviewed pairs are never tradable", () => {
    const base = {
      id: "p1",
      marketAId: "polymarket:1",
      marketBId: "uniswap:1",
      divergenceProb: 0.02,
      createdAt: new Date().toISOString(),
    };
    expect(isTradable({ ...base, status: "candidate" })).toBe(false);
    expect(isTradable({ ...base, status: "flagged" })).toBe(false);
    expect(isTradable({ ...base, status: "confirmed" })).toBe(true);
  });

  it("confirmPair requires a reviewer identity", () => {
    const pair = {
      id: "p1",
      marketAId: "polymarket:1",
      marketBId: "uniswap:1",
      status: "candidate" as const,
      divergenceProb: 0.02,
      createdAt: new Date().toISOString(),
    };
    expect(() => confirmPair(pair, "  ")).toThrow();
    expect(confirmPair(pair, "reviewer@hedgr").status).toBe("confirmed");
  });
});

describe("curated seed", () => {
  it("seeds all curated pairs as confirmed with reviewed metadata", async () => {
    const store = new MemoryStore();
    const pairs = await seedCuratedPairs(store);

    expect(pairs).toHaveLength(CURATED_PAIRS.length);
    const stored = await store.listPairs({ status: "confirmed" });
    expect(stored).toHaveLength(CURATED_PAIRS.length);
    for (const pair of stored) {
      expect(pair.reviewedBy).toBeTruthy();
      expect(pair.priceIfYes).toBeGreaterThan(0);
      expect(pair.priceIfNo).toBeGreaterThan(0);
      expect(isTradable(pair)).toBe(true);
      expect(await store.getMarket(pair.marketAId)).not.toBeNull();
      expect(await store.getMarket(pair.marketBId)).not.toBeNull();
    }
  });

  it("every curated pair references a configured uniswap leg", () => {
    const legIds = new Set(UNISWAP_LEGS.map((l) => l.venueId));
    for (const def of CURATED_PAIRS) {
      expect(legIds.has(def.uniswapVenueId)).toBe(true);
    }
  });
});

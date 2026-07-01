import { describe, expect, it } from "vitest";
import gammaFixture from "./fixtures/gamma-market.json";
import {
  applyClobPriceEvent,
  normalizePolymarketMarket,
  type GammaMarket,
} from "@/lib/ingestion/polymarket";
import {
  normalizeUniswapQuote,
  quoteToSpotPrice,
  type UniswapLegConfig,
} from "@/lib/ingestion/uniswap";
import { persistMarket } from "@/lib/ingestion/types";
import { MemoryStore } from "@/lib/store/memory";

const NOW = new Date("2026-07-01T12:00:00Z");

describe("polymarket normalization", () => {
  it("normalizes a raw Gamma payload into the shared Market shape", () => {
    const market = normalizePolymarketMarket(gammaFixture as GammaMarket, NOW);

    expect(market.id).toBe("polymarket:253591");
    expect(market.venue).toBe("polymarket");
    expect(market.venueId).toBe("253591");
    expect(market.question).toBe("Will ETH close above $4,000 on December 31?");
    expect(market.rulesText).toContain("Coinbase 1 minute candle");
    expect(market.status).toBe("active");
    expect(market.endDate).toBe("2026-12-31T23:59:00Z");
    expect(market.liquidityUsd).toBeCloseTo(152340.55);
    expect(market.updatedAt).toBe(NOW.toISOString());

    expect(market.outcomes).toHaveLength(2);
    expect(market.outcomes[0]).toMatchObject({ name: "YES", price: 0.62 });
    expect(market.outcomes[1]).toMatchObject({ name: "NO", price: 0.38 });
    expect(market.outcomes[0].tokenId).toMatch(/^7132/);
  });

  it("maps closed payloads to closed status", () => {
    const market = normalizePolymarketMarket(
      { ...(gammaFixture as GammaMarket), closed: true },
      NOW,
    );
    expect(market.status).toBe("closed");
  });

  it("tolerates malformed outcome arrays", () => {
    const market = normalizePolymarketMarket(
      { id: "x", question: "q", outcomes: "not json" },
      NOW,
    );
    expect(market.outcomes).toEqual([]);
  });
});

describe("clob price events", () => {
  it("applies a price_change event to the matching outcome", () => {
    const market = normalizePolymarketMarket(gammaFixture as GammaMarket, NOW);
    const yesToken = market.outcomes[0].tokenId!;
    const updated = applyClobPriceEvent(
      market,
      { event_type: "price_change", changes: [{ asset_id: yesToken, price: "0.71" }] },
      new Date("2026-07-01T12:05:00Z"),
    );
    expect(updated).not.toBeNull();
    expect(updated!.outcomes[0].price).toBeCloseTo(0.71);
    expect(updated!.outcomes[1].price).toBeCloseTo(0.38);
    expect(updated!.updatedAt).toBe("2026-07-01T12:05:00.000Z");
  });

  it("returns null for events that touch no tracked outcome", () => {
    const market = normalizePolymarketMarket(gammaFixture as GammaMarket, NOW);
    const updated = applyClobPriceEvent(market, {
      event_type: "price_change",
      changes: [{ asset_id: "unknown-token", price: "0.5" }],
    });
    expect(updated).toBeNull();
  });
});

const wethLeg: UniswapLegConfig = {
  venueId: "base-weth-usdc-500",
  question: "Spot price of WETH in USDC on Base",
  rulesText: "Uniswap V3 WETH/USDC 0.05% pool on Base, QuoterV2 exact input of 1 WETH.",
  token: "0x4200000000000000000000000000000000000006",
  tokenDecimals: 18,
  feeTier: 500,
};

describe("uniswap normalization", () => {
  it("converts a raw quoter amountOut into a spot price", () => {
    // 1 WETH -> 3,412.501234 USDC (6 decimals)
    expect(quoteToSpotPrice(3412501234n, 6)).toBeCloseTo(3412.501234, 6);
  });

  it("normalizes a quote into the shared Market shape", () => {
    const market = normalizeUniswapQuote(wethLeg, 3412.5, NOW);
    expect(market.id).toBe("uniswap:base-weth-usdc-500");
    expect(market.venue).toBe("uniswap");
    expect(market.outcomes).toEqual([
      {
        name: "SPOT",
        price: 3412.5,
        tokenId: "0x4200000000000000000000000000000000000006",
      },
    ]);
    expect(market.status).toBe("active");
  });
});

describe("persistence", () => {
  it("upserts are idempotent on market id", async () => {
    const store = new MemoryStore();
    const market = normalizePolymarketMarket(gammaFixture as GammaMarket, NOW);

    await store.upsertMarket(market);
    await store.upsertMarket({ ...market, question: "updated question" });

    const all = await store.listMarkets();
    expect(all).toHaveLength(1);
    expect(all[0].question).toBe("updated question");
  });

  it("persistMarket writes one tick per outcome", async () => {
    const store = new MemoryStore();
    const market = normalizePolymarketMarket(gammaFixture as GammaMarket, NOW);

    await persistMarket(store, market, "pair-1");
    await persistMarket(store, market, "pair-1");

    const ticks = await store.listTicks(market.id);
    expect(ticks).toHaveLength(4);
    expect(ticks[0]).toMatchObject({
      pairId: "pair-1",
      marketId: "polymarket:253591",
      outcome: "YES",
      price: 0.62,
    });
  });
});

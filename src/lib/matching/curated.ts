import { marketId, type Market, type Pair } from "@/lib/types";
import type { MarketStore, PairStore } from "@/lib/store/types";
import type { UniswapLegConfig } from "@/lib/ingestion/uniswap";

/**
 * Hand-curated equivalent event pairs: the v1 ground truth for matching.
 * Each pair maps a Polymarket threshold market to the Uniswap token leg that
 * hedges it, with modeled conditional prices for the token under each
 * resolution and a reviewed divergence prior.
 *
 * polymarket.venueId values are Gamma market ids; refresh them against live
 * markets before running the ingest backfill (questions and rules below are
 * the review-time snapshots).
 */
export interface CuratedPairDef {
  id: string;
  polymarket: { venueId: string; question: string; rulesText: string };
  uniswapVenueId: string;
  priceIfYes: number;
  priceIfNo: number;
  divergenceProb: number;
  reviewedBy: string;
  notes: string;
}

export const UNISWAP_LEGS: UniswapLegConfig[] = [
  {
    venueId: "base-weth-usdc-500",
    question: "Spot price of WETH in USDC on Base",
    rulesText:
      "Uniswap V3 WETH/USDC 0.05% pool on Base, QuoterV2 exact input of 1 WETH. WETH tracks ETH.",
    token: "0x4200000000000000000000000000000000000006",
    tokenDecimals: 18,
    feeTier: 500,
  },
  {
    venueId: "base-cbbtc-usdc-500",
    question: "Spot price of cbBTC in USDC on Base",
    rulesText:
      "Uniswap V3 cbBTC/USDC 0.05% pool on Base, QuoterV2 exact input of 1 cbBTC. cbBTC tracks BTC.",
    token: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    tokenDecimals: 8,
    feeTier: 500,
  },
];

export const CURATED_PAIRS: CuratedPairDef[] = [
  {
    id: "pair-eth-4000-dec31",
    polymarket: {
      venueId: "253591",
      question: "Will ETH close above $4,000 on December 31?",
      rulesText:
        'Resolves to "Yes" if the Coinbase 1 minute candle for ETH-USD closes at or above $4,000.00 on December 31, 23:59 ET.',
    },
    uniswapVenueId: "base-weth-usdc-500",
    priceIfYes: 4100,
    priceIfNo: 3400,
    divergenceProb: 0.02,
    reviewedBy: "curation-v1",
    notes: "WETH on Base tracks Coinbase ETH-USD closely; divergence is oracle/depeg risk.",
  },
  {
    id: "pair-eth-5000-eoy",
    polymarket: {
      venueId: "253612",
      question: "Will ETH hit $5,000 by December 31?",
      rulesText:
        'Resolves to "Yes" if any Coinbase 1 minute candle for ETH-USD reaches $5,000.00 before December 31, 23:59 ET.',
    },
    uniswapVenueId: "base-weth-usdc-500",
    priceIfYes: 4900,
    priceIfNo: 3600,
    divergenceProb: 0.03,
    reviewedBy: "curation-v1",
    notes: "Touch market: token may retrace after the touch, so conditional prices are wider.",
  },
  {
    id: "pair-eth-3000-floor",
    polymarket: {
      venueId: "253640",
      question: "Will ETH dip below $3,000 before September 30?",
      rulesText:
        'Resolves to "Yes" if any Coinbase 1 minute candle for ETH-USD trades at or below $3,000.00 before September 30, 23:59 ET.',
    },
    uniswapVenueId: "base-weth-usdc-500",
    priceIfYes: 2950,
    priceIfNo: 3800,
    divergenceProb: 0.02,
    reviewedBy: "curation-v1",
    notes: "Downside market: YES means the token leg is worth less. Short leg hedges YES.",
  },
  {
    id: "pair-btc-150k-eoy",
    polymarket: {
      venueId: "254001",
      question: "Will BTC close above $150,000 on December 31?",
      rulesText:
        'Resolves to "Yes" if the Coinbase 1 minute candle for BTC-USD closes at or above $150,000.00 on December 31, 23:59 ET.',
    },
    uniswapVenueId: "base-cbbtc-usdc-500",
    priceIfYes: 152000,
    priceIfNo: 118000,
    divergenceProb: 0.03,
    reviewedBy: "curation-v1",
    notes: "cbBTC custodial wrapper adds depeg tail risk versus BTC-USD; wider divergence prior.",
  },
  {
    id: "pair-btc-200k-touch",
    polymarket: {
      venueId: "254012",
      question: "Will BTC hit $200,000 by December 31?",
      rulesText:
        'Resolves to "Yes" if any Coinbase 1 minute candle for BTC-USD reaches $200,000.00 before December 31, 23:59 ET.',
    },
    uniswapVenueId: "base-cbbtc-usdc-500",
    priceIfYes: 195000,
    priceIfNo: 125000,
    divergenceProb: 0.03,
    reviewedBy: "curation-v1",
    notes: "Touch market with retrace risk.",
  },
  {
    id: "pair-btc-100k-floor",
    polymarket: {
      venueId: "254030",
      question: "Will BTC dip below $100,000 before September 30?",
      rulesText:
        'Resolves to "Yes" if any Coinbase 1 minute candle for BTC-USD trades at or below $100,000.00 before September 30, 23:59 ET.',
    },
    uniswapVenueId: "base-cbbtc-usdc-500",
    priceIfYes: 98000,
    priceIfNo: 128000,
    divergenceProb: 0.02,
    reviewedBy: "curation-v1",
    notes: "Downside market; short leg hedges YES.",
  },
  {
    id: "pair-eth-4500-oct",
    polymarket: {
      venueId: "253655",
      question: "Will ETH close above $4,500 on October 31?",
      rulesText:
        'Resolves to "Yes" if the Coinbase 1 minute candle for ETH-USD closes at or above $4,500.00 on October 31, 23:59 ET.',
    },
    uniswapVenueId: "base-weth-usdc-500",
    priceIfYes: 4600,
    priceIfNo: 3700,
    divergenceProb: 0.02,
    reviewedBy: "curation-v1",
    notes: "Monthly close market.",
  },
  {
    id: "pair-eth-flip-08",
    polymarket: {
      venueId: "253701",
      question: "Will the ETH/BTC ratio exceed 0.05 by December 31?",
      rulesText:
        'Resolves to "Yes" if the Coinbase ETH-USD close divided by BTC-USD close is at or above 0.05 on any day before December 31.',
    },
    uniswapVenueId: "base-weth-usdc-500",
    priceIfYes: 4400,
    priceIfNo: 3300,
    divergenceProb: 0.08,
    reviewedBy: "curation-v1",
    notes:
      "Ratio market only partially hedged by a single WETH leg; high divergence prior on purpose.",
  },
  {
    id: "pair-btc-120k-sep",
    polymarket: {
      venueId: "254044",
      question: "Will BTC close above $120,000 on September 30?",
      rulesText:
        'Resolves to "Yes" if the Coinbase 1 minute candle for BTC-USD closes at or above $120,000.00 on September 30, 23:59 ET.',
    },
    uniswapVenueId: "base-cbbtc-usdc-500",
    priceIfYes: 123000,
    priceIfNo: 108000,
    divergenceProb: 0.02,
    reviewedBy: "curation-v1",
    notes: "Quarterly close market.",
  },
  {
    id: "pair-eth-ath-eoy",
    polymarket: {
      venueId: "253720",
      question: "Will ETH make a new all-time high above $4,868 by December 31?",
      rulesText:
        'Resolves to "Yes" if any Coinbase 1 minute candle for ETH-USD trades at or above $4,868.00 before December 31, 23:59 ET.',
    },
    uniswapVenueId: "base-weth-usdc-500",
    priceIfYes: 4800,
    priceIfNo: 3500,
    divergenceProb: 0.03,
    reviewedBy: "curation-v1",
    notes: "ATH touch market.",
  },
];

function placeholderPolymarket(def: CuratedPairDef): Market {
  return {
    id: marketId("polymarket", def.polymarket.venueId),
    venue: "polymarket",
    venueId: def.polymarket.venueId,
    question: def.polymarket.question,
    rulesText: def.polymarket.rulesText,
    outcomes: [
      { name: "YES", price: 0.5 },
      { name: "NO", price: 0.5 },
    ],
    status: "active",
    updatedAt: new Date().toISOString(),
  };
}

function placeholderUniswap(leg: UniswapLegConfig): Market {
  return {
    id: marketId("uniswap", leg.venueId),
    venue: "uniswap",
    venueId: leg.venueId,
    question: leg.question,
    rulesText: leg.rulesText,
    outcomes: [{ name: "SPOT", price: 0, tokenId: leg.token }],
    status: "active",
    updatedAt: new Date().toISOString(),
  };
}

export function curatedToPair(def: CuratedPairDef, now = new Date()): Pair {
  return {
    id: def.id,
    marketAId: marketId("polymarket", def.polymarket.venueId),
    marketBId: marketId("uniswap", def.uniswapVenueId),
    // Curated pairs are pre-reviewed ground truth, so confirmed is allowed here.
    status: "confirmed",
    divergenceProb: def.divergenceProb,
    priceIfYes: def.priceIfYes,
    priceIfNo: def.priceIfNo,
    reviewedBy: def.reviewedBy,
    notes: def.notes,
    createdAt: now.toISOString(),
  };
}

/**
 * Seed the curated set: upsert placeholder markets for any leg ingestion has
 * not filled yet (real prices overwrite them on the next tick) and upsert the
 * confirmed pairs.
 */
export async function seedCuratedPairs(
  store: MarketStore & PairStore,
  defs: CuratedPairDef[] = CURATED_PAIRS,
  legs: UniswapLegConfig[] = UNISWAP_LEGS,
): Promise<Pair[]> {
  const pairs: Pair[] = [];
  for (const leg of legs) {
    if (!(await store.getMarket(marketId("uniswap", leg.venueId)))) {
      await store.upsertMarket(placeholderUniswap(leg));
    }
  }
  for (const def of defs) {
    if (!(await store.getMarket(marketId("polymarket", def.polymarket.venueId)))) {
      await store.upsertMarket(placeholderPolymarket(def));
    }
    pairs.push(await store.upsertPair(curatedToPair(def)));
  }
  return pairs;
}

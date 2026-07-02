export type Venue = "polymarket" | "uniswap";

export type MarketStatus = "active" | "closed" | "resolved";

export interface MarketOutcome {
  /** 'YES' | 'NO' on prediction markets, 'SPOT' on token legs. */
  name: string;
  /** 0..1 probability on prediction outcomes, USDC spot on token legs. */
  price: number;
  /** CLOB token id (Polymarket) or ERC-20 address (Uniswap). */
  tokenId?: string;
}

export interface Market {
  /** `<venue>:<venueId>` */
  id: string;
  venue: Venue;
  venueId: string;
  question: string;
  rulesText: string;
  outcomes: MarketOutcome[];
  status: MarketStatus;
  endDate?: string;
  liquidityUsd?: number;
  updatedAt: string;
}

export function marketId(venue: Venue, venueId: string): string {
  return `${venue}:${venueId}`;
}

export type PairStatus = "confirmed" | "candidate" | "flagged";

export interface Pair {
  id: string;
  /** Polymarket leg. */
  marketAId: string;
  /** Uniswap leg. */
  marketBId: string;
  status: PairStatus;
  similarity?: number;
  /** Prior probability that the two venues settle inconsistently. */
  divergenceProb: number;
  /** Modeled token spot if the event resolves YES / NO. */
  priceIfYes?: number;
  priceIfNo?: number;
  reviewedBy?: string;
  notes?: string;
  createdAt: string;
}

export interface HedgePlan {
  pairId: string;
  polymarketSide: "YES" | "NO";
  polymarketShares: number;
  uniswapDirection: "long" | "short";
  uniswapNotionalUsd: number;
}

export interface ScenarioPayoff {
  scenario: "yes" | "no" | "divergence";
  probability: number;
  grossUsd: number;
  netUsd: number;
}

export interface Opportunity {
  id: string;
  pairId: string;
  evUsd: number;
  maxLossUsd: number;
  feesUsd: number;
  plan: HedgePlan;
  scenarios: ScenarioPayoff[];
  computedAt: string;
}

export type PositionMode = "paper" | "live";

export interface PositionEntry {
  polymarketPrice: number;
  uniswapPrice: number;
  txHashes?: string[];
}

export interface Position {
  id: string;
  idempotencyKey: string;
  pairId: string;
  mode: PositionMode;
  plan: HedgePlan;
  status: "open" | "settled" | "failed";
  entry?: PositionEntry;
  createdAt: string;
}

export interface PriceTick {
  pairId?: string;
  marketId: string;
  outcome: string;
  price: number;
  ts: string;
}

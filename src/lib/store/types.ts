import type {
  Market,
  Opportunity,
  Pair,
  PairStatus,
  Position,
  PriceTick,
  Venue,
} from "@/lib/types";

export interface MarketStore {
  upsertMarket(market: Market): Promise<Market>;
  getMarket(id: string): Promise<Market | null>;
  listMarkets(filter?: { venue?: Venue }): Promise<Market[]>;
}

export interface PairStore {
  upsertPair(pair: Pair): Promise<Pair>;
  getPair(id: string): Promise<Pair | null>;
  listPairs(filter?: { status?: PairStatus }): Promise<Pair[]>;
}

export interface OpportunityStore {
  replaceOpportunities(opportunities: Opportunity[]): Promise<void>;
  listOpportunities(limit?: number): Promise<Opportunity[]>;
}

export interface PositionInsertResult {
  position: Position;
  /** False when the idempotency key already existed and the stored position was returned. */
  created: boolean;
}

export interface PositionStore {
  /**
   * Insert a position unless one with the same idempotency key exists.
   * Must be safe to replay: a duplicate key returns the original position.
   */
  insertPositionIfAbsent(position: Position): Promise<PositionInsertResult>;
  getPosition(id: string): Promise<Position | null>;
  getPositionByIdempotencyKey(key: string): Promise<Position | null>;
  listPositions(): Promise<Position[]>;
}

export interface PriceHistoryStore {
  appendTick(tick: PriceTick): Promise<void>;
  listTicks(marketId: string, limit?: number): Promise<PriceTick[]>;
}

export interface Store
  extends MarketStore,
    PairStore,
    OpportunityStore,
    PositionStore,
    PriceHistoryStore {}

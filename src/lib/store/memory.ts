import type {
  Market,
  Opportunity,
  Pair,
  PairStatus,
  Position,
  PriceTick,
  Venue,
} from "@/lib/types";
import type { PositionInsertResult, Store } from "./types";

/**
 * In-memory store used by tests and by paper mode when no database is
 * configured. Implements the same contract as the Supabase store.
 */
export class MemoryStore implements Store {
  private markets = new Map<string, Market>();
  private pairs = new Map<string, Pair>();
  private opportunities: Opportunity[] = [];
  private positions = new Map<string, Position>();
  private positionsByKey = new Map<string, string>();
  private ticks: PriceTick[] = [];

  async upsertMarket(market: Market): Promise<Market> {
    this.markets.set(market.id, market);
    return market;
  }

  async getMarket(id: string): Promise<Market | null> {
    return this.markets.get(id) ?? null;
  }

  async listMarkets(filter?: { venue?: Venue }): Promise<Market[]> {
    const all = [...this.markets.values()];
    return filter?.venue ? all.filter((m) => m.venue === filter.venue) : all;
  }

  async upsertPair(pair: Pair): Promise<Pair> {
    this.pairs.set(pair.id, pair);
    return pair;
  }

  async getPair(id: string): Promise<Pair | null> {
    return this.pairs.get(id) ?? null;
  }

  async listPairs(filter?: { status?: PairStatus }): Promise<Pair[]> {
    const all = [...this.pairs.values()];
    return filter?.status ? all.filter((p) => p.status === filter.status) : all;
  }

  async replaceOpportunities(opportunities: Opportunity[]): Promise<void> {
    this.opportunities = [...opportunities];
  }

  async listOpportunities(limit = 20): Promise<Opportunity[]> {
    return [...this.opportunities]
      .sort((a, b) => b.evUsd - a.evUsd)
      .slice(0, limit);
  }

  async insertPositionIfAbsent(position: Position): Promise<PositionInsertResult> {
    const existingId = this.positionsByKey.get(position.idempotencyKey);
    if (existingId) {
      const existing = this.positions.get(existingId);
      if (existing) return { position: existing, created: false };
    }
    this.positions.set(position.id, position);
    this.positionsByKey.set(position.idempotencyKey, position.id);
    return { position, created: true };
  }

  async getPosition(id: string): Promise<Position | null> {
    return this.positions.get(id) ?? null;
  }

  async getPositionByIdempotencyKey(key: string): Promise<Position | null> {
    const id = this.positionsByKey.get(key);
    return id ? (this.positions.get(id) ?? null) : null;
  }

  async listPositions(): Promise<Position[]> {
    return [...this.positions.values()];
  }

  async appendTick(tick: PriceTick): Promise<void> {
    this.ticks.push(tick);
  }

  async listTicks(marketId: string, limit = 100): Promise<PriceTick[]> {
    return this.ticks.filter((t) => t.marketId === marketId).slice(-limit);
  }
}

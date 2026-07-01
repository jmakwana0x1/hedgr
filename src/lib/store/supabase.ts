import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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

const UNIQUE_VIOLATION = "23505";

function marketToRow(m: Market) {
  return {
    id: m.id,
    venue: m.venue,
    venue_id: m.venueId,
    question: m.question,
    rules_text: m.rulesText,
    outcomes: m.outcomes,
    status: m.status,
    end_date: m.endDate ?? null,
    liquidity_usd: m.liquidityUsd ?? null,
    updated_at: m.updatedAt,
  };
}

function rowToMarket(r: Record<string, unknown>): Market {
  return {
    id: r.id as string,
    venue: r.venue as Venue,
    venueId: r.venue_id as string,
    question: r.question as string,
    rulesText: (r.rules_text as string) ?? "",
    outcomes: (r.outcomes as Market["outcomes"]) ?? [],
    status: r.status as Market["status"],
    endDate: (r.end_date as string) ?? undefined,
    liquidityUsd: r.liquidity_usd == null ? undefined : Number(r.liquidity_usd),
    updatedAt: r.updated_at as string,
  };
}

function pairToRow(p: Pair) {
  return {
    id: p.id,
    market_a_id: p.marketAId,
    market_b_id: p.marketBId,
    status: p.status,
    similarity: p.similarity ?? null,
    divergence_prob: p.divergenceProb,
    price_if_yes: p.priceIfYes ?? null,
    price_if_no: p.priceIfNo ?? null,
    reviewed_by: p.reviewedBy ?? null,
    notes: p.notes ?? null,
    created_at: p.createdAt,
  };
}

function rowToPair(r: Record<string, unknown>): Pair {
  return {
    id: r.id as string,
    marketAId: r.market_a_id as string,
    marketBId: r.market_b_id as string,
    status: r.status as PairStatus,
    similarity: r.similarity == null ? undefined : Number(r.similarity),
    divergenceProb: Number(r.divergence_prob),
    priceIfYes: r.price_if_yes == null ? undefined : Number(r.price_if_yes),
    priceIfNo: r.price_if_no == null ? undefined : Number(r.price_if_no),
    reviewedBy: (r.reviewed_by as string) ?? undefined,
    notes: (r.notes as string) ?? undefined,
    createdAt: r.created_at as string,
  };
}

function positionToRow(p: Position) {
  return {
    id: p.id,
    idempotency_key: p.idempotencyKey,
    pair_id: p.pairId,
    mode: p.mode,
    plan: p.plan,
    status: p.status,
    entry: p.entry ?? null,
    created_at: p.createdAt,
  };
}

function rowToPosition(r: Record<string, unknown>): Position {
  return {
    id: r.id as string,
    idempotencyKey: r.idempotency_key as string,
    pairId: r.pair_id as string,
    mode: r.mode as Position["mode"],
    plan: r.plan as Position["plan"],
    status: r.status as Position["status"],
    entry: (r.entry as Position["entry"]) ?? undefined,
    createdAt: r.created_at as string,
  };
}

export class SupabaseStore implements Store {
  constructor(private client: SupabaseClient) {}

  static fromEnv(): SupabaseStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) must be set");
    }
    return new SupabaseStore(createClient(url, key, { auth: { persistSession: false } }));
  }

  async upsertMarket(market: Market): Promise<Market> {
    const { error } = await this.client.from("markets").upsert(marketToRow(market));
    if (error) throw new Error(`upsertMarket failed: ${error.message}`);
    return market;
  }

  async getMarket(id: string): Promise<Market | null> {
    const { data, error } = await this.client
      .from("markets").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`getMarket failed: ${error.message}`);
    return data ? rowToMarket(data) : null;
  }

  async listMarkets(filter?: { venue?: Venue }): Promise<Market[]> {
    let query = this.client.from("markets").select("*");
    if (filter?.venue) query = query.eq("venue", filter.venue);
    const { data, error } = await query;
    if (error) throw new Error(`listMarkets failed: ${error.message}`);
    return (data ?? []).map(rowToMarket);
  }

  async upsertPair(pair: Pair): Promise<Pair> {
    const { error } = await this.client.from("pairs").upsert(pairToRow(pair));
    if (error) throw new Error(`upsertPair failed: ${error.message}`);
    return pair;
  }

  async getPair(id: string): Promise<Pair | null> {
    const { data, error } = await this.client
      .from("pairs").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`getPair failed: ${error.message}`);
    return data ? rowToPair(data) : null;
  }

  async listPairs(filter?: { status?: PairStatus }): Promise<Pair[]> {
    let query = this.client.from("pairs").select("*");
    if (filter?.status) query = query.eq("status", filter.status);
    const { data, error } = await query;
    if (error) throw new Error(`listPairs failed: ${error.message}`);
    return (data ?? []).map(rowToPair);
  }

  async replaceOpportunities(opportunities: Opportunity[]): Promise<void> {
    const del = await this.client.from("opportunities").delete().neq("id", "");
    if (del.error) throw new Error(`replaceOpportunities delete failed: ${del.error.message}`);
    if (opportunities.length === 0) return;
    const rows = opportunities.map((o) => ({
      id: o.id,
      pair_id: o.pairId,
      ev_usd: o.evUsd,
      max_loss_usd: o.maxLossUsd,
      fees_usd: o.feesUsd,
      plan: { ...o.plan, scenarios: o.scenarios },
      computed_at: o.computedAt,
    }));
    const ins = await this.client.from("opportunities").insert(rows);
    if (ins.error) throw new Error(`replaceOpportunities insert failed: ${ins.error.message}`);
  }

  async listOpportunities(limit = 20): Promise<Opportunity[]> {
    const { data, error } = await this.client
      .from("opportunities").select("*")
      .order("ev_usd", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`listOpportunities failed: ${error.message}`);
    return (data ?? []).map((r) => {
      const plan = r.plan as Record<string, unknown>;
      const { scenarios, ...planRest } = plan;
      return {
        id: r.id as string,
        pairId: r.pair_id as string,
        evUsd: Number(r.ev_usd),
        maxLossUsd: Number(r.max_loss_usd),
        feesUsd: Number(r.fees_usd),
        plan: planRest as unknown as Opportunity["plan"],
        scenarios: (scenarios as Opportunity["scenarios"]) ?? [],
        computedAt: r.computed_at as string,
      };
    });
  }

  async insertPositionIfAbsent(position: Position): Promise<PositionInsertResult> {
    const { error } = await this.client.from("positions").insert(positionToRow(position));
    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        const existing = await this.getPositionByIdempotencyKey(position.idempotencyKey);
        if (existing) return { position: existing, created: false };
      }
      throw new Error(`insertPositionIfAbsent failed: ${error.message}`);
    }
    return { position, created: true };
  }

  async updatePosition(position: Position): Promise<Position> {
    const { error } = await this.client
      .from("positions")
      .update(positionToRow(position))
      .eq("id", position.id);
    if (error) throw new Error(`updatePosition failed: ${error.message}`);
    return position;
  }

  async getPosition(id: string): Promise<Position | null> {
    const { data, error } = await this.client
      .from("positions").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`getPosition failed: ${error.message}`);
    return data ? rowToPosition(data) : null;
  }

  async getPositionByIdempotencyKey(key: string): Promise<Position | null> {
    const { data, error } = await this.client
      .from("positions").select("*").eq("idempotency_key", key).maybeSingle();
    if (error) throw new Error(`getPositionByIdempotencyKey failed: ${error.message}`);
    return data ? rowToPosition(data) : null;
  }

  async listPositions(): Promise<Position[]> {
    const { data, error } = await this.client.from("positions").select("*");
    if (error) throw new Error(`listPositions failed: ${error.message}`);
    return (data ?? []).map(rowToPosition);
  }

  async appendTick(tick: PriceTick): Promise<void> {
    const { error } = await this.client.from("price_history").insert({
      pair_id: tick.pairId ?? null,
      market_id: tick.marketId,
      outcome: tick.outcome,
      price: tick.price,
      ts: tick.ts,
    });
    if (error) throw new Error(`appendTick failed: ${error.message}`);
  }

  async listTicks(marketId: string, limit = 100): Promise<PriceTick[]> {
    const { data, error } = await this.client
      .from("price_history").select("*")
      .eq("market_id", marketId)
      .order("ts", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`listTicks failed: ${error.message}`);
    return (data ?? []).reverse().map((r) => ({
      pairId: (r.pair_id as string) ?? undefined,
      marketId: r.market_id as string,
      outcome: r.outcome as string,
      price: Number(r.price),
      ts: r.ts as string,
    }));
  }
}

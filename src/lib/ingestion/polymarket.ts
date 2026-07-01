import { marketId, type Market, type MarketOutcome } from "@/lib/types";
import type { MarketStore, PriceHistoryStore } from "@/lib/store/types";
import { persistMarket, type VenueAdapter } from "./types";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

/** Raw market payload from the Polymarket Gamma REST API. */
export interface GammaMarket {
  id: string;
  question: string;
  description?: string;
  outcomes?: string; // stringified JSON array, e.g. '["Yes","No"]'
  outcomePrices?: string; // stringified JSON array, e.g. '["0.62","0.38"]'
  clobTokenIds?: string; // stringified JSON array of CLOB token ids
  endDate?: string;
  liquidityNum?: number;
  liquidity?: string;
  active?: boolean;
  closed?: boolean;
}

function parseJsonArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Normalize a raw Gamma API payload into the shared Market shape. */
export function normalizePolymarketMarket(raw: GammaMarket, now = new Date()): Market {
  const names = parseJsonArray(raw.outcomes);
  const prices = parseJsonArray(raw.outcomePrices).map(Number);
  const tokenIds = parseJsonArray(raw.clobTokenIds);

  const outcomes: MarketOutcome[] = names.map((name, i) => ({
    name: name.toUpperCase(),
    price: Number.isFinite(prices[i]) ? prices[i] : 0,
    tokenId: tokenIds[i],
  }));

  const liquidityUsd =
    raw.liquidityNum ?? (raw.liquidity != null ? Number(raw.liquidity) : undefined);

  return {
    id: marketId("polymarket", raw.id),
    venue: "polymarket",
    venueId: raw.id,
    question: raw.question,
    rulesText: raw.description ?? "",
    outcomes,
    status: raw.closed ? "closed" : raw.active === false ? "resolved" : "active",
    endDate: raw.endDate,
    liquidityUsd: Number.isFinite(liquidityUsd) ? liquidityUsd : undefined,
    updatedAt: now.toISOString(),
  };
}

/** Price event from the CLOB market WebSocket channel. */
export interface ClobPriceEvent {
  event_type: string; // 'price_change' | 'book' | ...
  asset_id?: string;
  price?: string;
  changes?: Array<{ asset_id: string; price: string }>;
}

/**
 * Apply a CLOB WebSocket price event to a normalized market. Returns the
 * updated market, or null when the event does not touch any of its outcomes.
 */
export function applyClobPriceEvent(
  market: Market,
  event: ClobPriceEvent,
  now = new Date(),
): Market | null {
  const updates = new Map<string, number>();
  if (event.event_type === "price_change") {
    for (const change of event.changes ?? []) {
      updates.set(change.asset_id, Number(change.price));
    }
    if (event.asset_id && event.price != null) {
      updates.set(event.asset_id, Number(event.price));
    }
  }
  if (updates.size === 0) return null;

  let touched = false;
  const outcomes = market.outcomes.map((o) => {
    const price = o.tokenId != null ? updates.get(o.tokenId) : undefined;
    if (price == null || !Number.isFinite(price)) return o;
    touched = true;
    return { ...o, price };
  });
  if (!touched) return null;
  return { ...market, outcomes, updatedAt: now.toISOString() };
}

export class PolymarketAdapter implements VenueAdapter {
  constructor(
    /** Gamma market ids to track. */
    private readonly ids: string[],
    private readonly baseUrl = GAMMA_API,
  ) {}

  async fetchMarkets(): Promise<Market[]> {
    const markets: Market[] = [];
    for (const id of this.ids) {
      const res = await fetch(`${this.baseUrl}/markets/${id}`);
      if (!res.ok) throw new Error(`gamma /markets/${id} returned ${res.status}`);
      markets.push(normalizePolymarketMarket((await res.json()) as GammaMarket));
    }
    return markets;
  }

  /**
   * Subscribe to live CLOB prices, falling back to REST polling if the
   * socket drops. Returns a stop function.
   */
  streamPrices(
    store: MarketStore & PriceHistoryStore,
    opts: { pollIntervalMs?: number; wsUrl?: string } = {},
  ): () => void {
    const pollIntervalMs = opts.pollIntervalMs ?? 15_000;
    let stopped = false;
    let ws: WebSocket | null = null;

    const poll = async () => {
      try {
        for (const market of await this.fetchMarkets()) {
          await persistMarket(store, market);
        }
      } catch (err) {
        console.error("polymarket poll failed", err);
      }
    };
    const timer = setInterval(poll, pollIntervalMs);
    void poll();

    const connect = async () => {
      const tokenIds = (await this.fetchMarkets())
        .flatMap((m) => m.outcomes.map((o) => o.tokenId))
        .filter((t): t is string => t != null);
      if (stopped || tokenIds.length === 0) return;

      ws = new WebSocket(opts.wsUrl ?? CLOB_WS);
      ws.addEventListener("open", () => {
        ws?.send(JSON.stringify({ type: "market", assets_ids: tokenIds }));
      });
      ws.addEventListener("message", async (msg) => {
        try {
          const event = JSON.parse(String(msg.data)) as ClobPriceEvent;
          for (const market of await store.listMarkets({ venue: "polymarket" })) {
            const updated = applyClobPriceEvent(market, event);
            if (updated) await persistMarket(store, updated);
          }
        } catch (err) {
          console.error("polymarket ws message failed", err);
        }
      });
      ws.addEventListener("close", () => {
        if (!stopped) setTimeout(() => void connect(), 5_000);
      });
    };
    void connect().catch((err) => console.error("polymarket ws connect failed", err));

    return () => {
      stopped = true;
      clearInterval(timer);
      ws?.close();
    };
  }
}

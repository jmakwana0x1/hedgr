import { randomUUID } from "node:crypto";
import type {
  HedgePlan,
  Opportunity,
  Position,
  PositionEntry,
  PositionMode,
} from "@/lib/types";
import type { Store } from "@/lib/store/types";
import { isTradable } from "@/lib/matching/engine";
import { computeOpportunity, DEFAULT_SIZING, outcomePrice } from "@/lib/engine/opportunities";
import { DEFAULT_FEES, type FeeModel } from "@/lib/engine/fees";

export interface HedgeRequest {
  /**
   * Caller-supplied idempotency key. Replaying a key returns the original
   * position and never creates a second one (CLAUDE.md invariant 2).
   */
  idempotencyKey: string;
  pairId: string;
  polymarketShares?: number;
  uniswapNotionalUsd?: number;
}

export interface EntryPrices {
  polymarketPrice: number;
  uniswapPrice: number;
}

/**
 * Venue leg execution. Paper mode records prices without side effects;
 * live mode (phase 5) sends the Polymarket and Uniswap transactions.
 */
export interface LegExecutor {
  mode: PositionMode;
  executeLegs(plan: HedgePlan, entry: EntryPrices): Promise<PositionEntry>;
}

export const paperExecutor: LegExecutor = {
  mode: "paper",
  async executeLegs(_plan, entry) {
    return { ...entry };
  },
};

export interface PlaceHedgeResult {
  position: Position;
  opportunity: Opportunity;
  /** True when the idempotency key had been used and no new execution ran. */
  replayed: boolean;
}

/**
 * Execute a hedge for a confirmed pair.
 *
 * Ordering matters for idempotency: the position row (keyed by the
 * idempotency key) is reserved before any leg executes, so a retry that
 * races or follows a timeout finds the reservation and does not re-execute.
 */
export async function placeHedge(
  store: Store,
  request: HedgeRequest,
  executor: LegExecutor = paperExecutor,
  feeModel: FeeModel = DEFAULT_FEES,
): Promise<PlaceHedgeResult> {
  if (!request.idempotencyKey?.trim()) {
    throw new Error("idempotencyKey is required on every execution request");
  }

  const pair = await store.getPair(request.pairId);
  if (!pair) throw new Error(`unknown pair ${request.pairId}`);
  if (!isTradable(pair)) {
    throw new Error(
      `pair ${pair.id} has status '${pair.status}'; only reviewed, confirmed pairs are tradable`,
    );
  }

  const polymarket = await store.getMarket(pair.marketAId);
  const uniswap = await store.getMarket(pair.marketBId);
  if (!polymarket || !uniswap) {
    throw new Error(`pair ${pair.id} legs are not ingested yet`);
  }

  const sizing = {
    polymarketShares: request.polymarketShares ?? DEFAULT_SIZING.polymarketShares,
    uniswapNotionalUsd: request.uniswapNotionalUsd ?? DEFAULT_SIZING.uniswapNotionalUsd,
  };
  const opportunity = computeOpportunity(pair, polymarket, uniswap, feeModel, sizing);
  const entry: EntryPrices = {
    polymarketPrice: outcomePrice(
      polymarket,
      opportunity.plan.polymarketSide,
    ),
    uniswapPrice: outcomePrice(uniswap, "SPOT"),
  };

  const reservation = await store.insertPositionIfAbsent({
    id: `pos:${randomUUID()}`,
    idempotencyKey: request.idempotencyKey,
    pairId: pair.id,
    mode: executor.mode,
    plan: opportunity.plan,
    status: "open",
    createdAt: new Date().toISOString(),
  });

  if (!reservation.created) {
    return { position: reservation.position, opportunity, replayed: true };
  }

  let position = reservation.position;
  try {
    const filledEntry = await executor.executeLegs(opportunity.plan, entry);
    position = await store.updatePosition({ ...position, entry: filledEntry });
  } catch (err) {
    position = await store.updatePosition({ ...position, status: "failed" });
    throw new Error(
      `leg execution failed for ${position.id} (position marked failed, replay the key to inspect): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { position, opportunity, replayed: false };
}

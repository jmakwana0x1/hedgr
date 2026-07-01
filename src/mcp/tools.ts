import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "@/lib/store/types";
import { DEFAULT_FEES, type FeeModel } from "@/lib/engine/fees";
import {
  computeOpportunity,
  DEFAULT_SIZING,
  refreshOpportunities,
} from "@/lib/engine/opportunities";
import { isTradable } from "@/lib/matching/engine";
import {
  paperExecutor,
  placeHedge,
  type LegExecutor,
} from "@/lib/execution";
import { openGate, paymentChallenge, type PaymentGate } from "@/lib/x402/types";

export interface HedgrServerOptions {
  /** Payment gate for the execution path. Defaults to open (no payment). */
  gate?: PaymentGate;
  /** Leg executor. Defaults to paper mode (no chain calls). */
  executor?: LegExecutor;
  feeModel?: FeeModel;
}

function json(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

function errorResult(err: unknown) {
  return json({ error: err instanceof Error ? err.message : String(err) }, true);
}

export function createHedgrServer(
  store: Store,
  options: HedgrServerOptions = {},
): McpServer {
  const gate = options.gate ?? openGate;
  const executor = options.executor ?? paperExecutor;
  const feeModel = options.feeModel ?? DEFAULT_FEES;

  const server = new McpServer({ name: "hedgr", version: "0.1.0" });

  server.registerTool(
    "list_opportunities",
    {
      title: "List ranked hedge opportunities",
      description:
        "Recompute and return fee-aware hedge opportunities across confirmed Polymarket/Uniswap pairs, ranked by expected value in USD. Includes the full scenario payoff breakdown and max loss for each.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ limit }) => {
      try {
        const ranked = await refreshOpportunities(store, feeModel);
        return json(ranked.slice(0, limit ?? 20));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_market",
    {
      title: "Get a normalized market",
      description:
        "Fetch one normalized market by id (format '<venue>:<venueId>', e.g. 'polymarket:253591' or 'uniswap:base-weth-usdc-500').",
      inputSchema: { marketId: z.string() },
    },
    async ({ marketId }) => {
      const market = await store.getMarket(marketId);
      if (!market) return json({ error: `unknown market ${marketId}` }, true);
      return json(market);
    },
  );

  server.registerTool(
    "get_position_summary",
    {
      title: "Get position summary",
      description:
        "List all positions (paper and live) with their hedge plans and entry prices, plus aggregate counts.",
      inputSchema: {},
    },
    async () => {
      const positions = await store.listPositions();
      const summary = {
        total: positions.length,
        open: positions.filter((p) => p.status === "open").length,
        paper: positions.filter((p) => p.mode === "paper").length,
        live: positions.filter((p) => p.mode === "live").length,
        positions,
      };
      return json(summary);
    },
  );

  server.registerTool(
    "simulate_hedge",
    {
      title: "Simulate a hedge",
      description:
        "Compute the full payoff matrix, fees, expected value, and max loss for a hedge on a pair at current prices. Read-only; does not place anything.",
      inputSchema: {
        pairId: z.string(),
        polymarketShares: z.number().positive().optional(),
        uniswapNotionalUsd: z.number().positive().optional(),
      },
    },
    async ({ pairId, polymarketShares, uniswapNotionalUsd }) => {
      try {
        const pair = await store.getPair(pairId);
        if (!pair) return json({ error: `unknown pair ${pairId}` }, true);
        const polymarket = await store.getMarket(pair.marketAId);
        const uniswap = await store.getMarket(pair.marketBId);
        if (!polymarket || !uniswap) {
          return json({ error: `pair ${pairId} legs are not ingested yet` }, true);
        }
        const opportunity = computeOpportunity(pair, polymarket, uniswap, feeModel, {
          polymarketShares: polymarketShares ?? DEFAULT_SIZING.polymarketShares,
          uniswapNotionalUsd: uniswapNotionalUsd ?? DEFAULT_SIZING.uniswapNotionalUsd,
        });
        return json({
          ...opportunity,
          pairStatus: pair.status,
          tradable: isTradable(pair),
          divergenceProb: pair.divergenceProb,
          notes: pair.notes,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "place_hedge",
    {
      title: "Place a hedge",
      description:
        "Execute both legs of a hedge on a confirmed pair. Requires a caller-generated idempotencyKey; replaying the same key returns the original position and never double-fills. When payment is enabled, an x402 payment proof must be supplied or a 402 challenge is returned.",
      inputSchema: {
        pairId: z.string(),
        idempotencyKey: z.string().min(8),
        polymarketShares: z.number().positive().optional(),
        uniswapNotionalUsd: z.number().positive().optional(),
        paymentProof: z.string().optional(),
      },
    },
    async ({ pairId, idempotencyKey, polymarketShares, uniswapNotionalUsd, paymentProof }) => {
      const verdict = await gate.verify(paymentProof, "place_hedge");
      if (!verdict.ok) {
        return json(paymentChallenge(gate, "place_hedge", verdict.error), true);
      }
      try {
        const result = await placeHedge(
          store,
          { idempotencyKey, pairId, polymarketShares, uniswapNotionalUsd },
          executor,
          feeModel,
        );
        return json({
          replayed: result.replayed,
          position: result.position,
          expectedValueUsd: result.opportunity.evUsd,
          maxLossUsd: result.opportunity.maxLossUsd,
          feesUsd: result.opportunity.feesUsd,
          scenarios: result.opportunity.scenarios,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

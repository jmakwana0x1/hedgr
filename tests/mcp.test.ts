import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Market, Pair } from "@/lib/types";
import { MemoryStore } from "@/lib/store/memory";
import { computeOpportunity } from "@/lib/engine/opportunities";
import { DEFAULT_FEES } from "@/lib/engine/fees";
import { createHedgrServer } from "@/mcp/tools";

function pmMarket(): Market {
  return {
    id: "polymarket:253591",
    venue: "polymarket",
    venueId: "253591",
    question: "Will ETH close above $4,000 on December 31?",
    rulesText: "Coinbase ETH-USD close at or above $4,000.00.",
    outcomes: [
      { name: "YES", price: 0.3 },
      { name: "NO", price: 0.7 },
    ],
    status: "active",
    updatedAt: new Date().toISOString(),
  };
}

function uniMarket(): Market {
  return {
    id: "uniswap:base-weth-usdc-500",
    venue: "uniswap",
    venueId: "base-weth-usdc-500",
    question: "Spot price of WETH in USDC on Base",
    rulesText: "Uniswap V3 WETH/USDC pool.",
    outcomes: [{ name: "SPOT", price: 3500 }],
    status: "active",
    updatedAt: new Date().toISOString(),
  };
}

function confirmedPair(): Pair {
  return {
    id: "pair-eth-4000",
    marketAId: "polymarket:253591",
    marketBId: "uniswap:base-weth-usdc-500",
    status: "confirmed",
    divergenceProb: 0.02,
    priceIfYes: 4100,
    priceIfNo: 3400,
    reviewedBy: "curation-v1",
    createdAt: new Date().toISOString(),
  };
}

async function connectedClient(store: MemoryStore) {
  const server = createHedgrServer(store);
  const client = new Client({ name: "test-agent", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function parseResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

describe("hedgr mcp server", () => {
  let store: MemoryStore;
  let client: Client;

  beforeEach(async () => {
    store = new MemoryStore();
    await store.upsertMarket(pmMarket());
    await store.upsertMarket(uniMarket());
    await store.upsertPair(confirmedPair());
    client = await connectedClient(store);
  });

  it("exposes the read and execution tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_market",
      "get_position_summary",
      "list_opportunities",
      "place_hedge",
      "simulate_hedge",
    ]);
  });

  it("lists ranked opportunities with EV and scenarios", async () => {
    const data = parseResult(
      await client.callTool({ name: "list_opportunities", arguments: {} }),
    );
    expect(data).toHaveLength(1);
    expect(data[0].pairId).toBe("pair-eth-4000");
    expect(data[0].evUsd).toBeGreaterThan(0);
    expect(data[0].scenarios).toHaveLength(3);
  });

  it("simulate_hedge output matches the engine exactly", async () => {
    const data = parseResult(
      await client.callTool({
        name: "simulate_hedge",
        arguments: { pairId: "pair-eth-4000", polymarketShares: 50, uniswapNotionalUsd: 500 },
      }),
    );
    const expected = computeOpportunity(
      confirmedPair(),
      pmMarket(),
      uniMarket(),
      DEFAULT_FEES,
      { polymarketShares: 50, uniswapNotionalUsd: 500 },
    );
    expect(data.evUsd).toBeCloseTo(expected.evUsd, 10);
    expect(data.maxLossUsd).toBeCloseTo(expected.maxLossUsd, 10);
    expect(data.feesUsd).toBeCloseTo(expected.feesUsd, 10);
    expect(data.plan).toEqual(expected.plan);
    expect(data.tradable).toBe(true);
    // Simulation writes nothing.
    expect(await store.listPositions()).toHaveLength(0);
  });

  it("place_hedge paper-executes and the position lands in the store", async () => {
    const data = parseResult(
      await client.callTool({
        name: "place_hedge",
        arguments: { pairId: "pair-eth-4000", idempotencyKey: "agent-key-0001" },
      }),
    );
    expect(data.replayed).toBe(false);
    expect(data.position.mode).toBe("paper");
    expect(data.position.status).toBe("open");
    expect(data.position.entry.polymarketPrice).toBeCloseTo(0.7, 10);
    expect(data.position.entry.uniswapPrice).toBeCloseTo(3500, 10);

    const positions = await store.listPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].idempotencyKey).toBe("agent-key-0001");
  });

  it("replaying an idempotency key never creates a second position", async () => {
    const first = parseResult(
      await client.callTool({
        name: "place_hedge",
        arguments: { pairId: "pair-eth-4000", idempotencyKey: "agent-key-0002" },
      }),
    );
    const second = parseResult(
      await client.callTool({
        name: "place_hedge",
        arguments: { pairId: "pair-eth-4000", idempotencyKey: "agent-key-0002" },
      }),
    );
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.position.id).toBe(first.position.id);
    expect(await store.listPositions()).toHaveLength(1);
  });

  it("refuses to trade unconfirmed pairs", async () => {
    await store.upsertPair({ ...confirmedPair(), id: "pair-cand", status: "candidate" });
    const result = await client.callTool({
      name: "place_hedge",
      arguments: { pairId: "pair-cand", idempotencyKey: "agent-key-0003" },
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain("only reviewed, confirmed pairs");
    expect(await store.listPositions()).toHaveLength(0);
  });

  it("summarizes positions", async () => {
    await client.callTool({
      name: "place_hedge",
      arguments: { pairId: "pair-eth-4000", idempotencyKey: "agent-key-0004" },
    });
    const summary = parseResult(
      await client.callTool({ name: "get_position_summary", arguments: {} }),
    );
    expect(summary.total).toBe(1);
    expect(summary.paper).toBe(1);
    expect(summary.live).toBe(0);
    expect(summary.positions[0].plan.pairId).toBe("pair-eth-4000");
  });
});

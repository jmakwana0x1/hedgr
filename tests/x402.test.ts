import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Market, Pair } from "@/lib/types";
import { MemoryStore } from "@/lib/store/memory";
import { createHedgrServer } from "@/mcp/tools";
import { X402Gate } from "@/lib/x402/gate";
import { buildEntrySwap } from "@/lib/execution/live";
import type { LegExecutor } from "@/lib/execution";

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

const VALID_PROOF = "proof-agent-paid-0x01";

function testGate() {
  return new X402Gate({
    payTo: "0x1111111111111111111111111111111111111111",
    priceAtomic: "100000", // 0.10 USDC
    verifier: async (proof) =>
      proof === VALID_PROOF ? { ok: true } : { ok: false, error: "invalid payment proof" },
  });
}

/** Executor that counts leg executions and can fail on demand. */
function countingExecutor(failures = 0): LegExecutor & { calls: number } {
  const executor = {
    mode: "paper" as const,
    calls: 0,
    async executeLegs(_plan: unknown, entry: { polymarketPrice: number; uniswapPrice: number }) {
      executor.calls += 1;
      if (executor.calls <= failures) throw new Error("venue timeout");
      return { ...entry };
    },
  };
  return executor;
}

async function connect(store: MemoryStore, executor: LegExecutor) {
  const server = createHedgrServer(store, { gate: testGate(), executor });
  const client = new Client({ name: "test-agent", version: "0.0.1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

describe("x402 payment gate", () => {
  let store: MemoryStore;
  let executor: ReturnType<typeof countingExecutor>;
  let client: Client;

  beforeEach(async () => {
    store = new MemoryStore();
    await store.upsertMarket(pmMarket());
    await store.upsertMarket(uniMarket());
    await store.upsertPair(confirmedPair());
    executor = countingExecutor();
    client = await connect(store, executor);
  });

  it("answers an unpaid request with a 402 challenge and executes nothing", async () => {
    const result = await client.callTool({
      name: "place_hedge",
      arguments: { pairId: "pair-eth-4000", idempotencyKey: "agent-key-0001" },
    });
    expect(result.isError).toBe(true);
    const challenge = parse(result);
    expect(challenge.status).toBe(402);
    expect(challenge.error).toBe("payment_required");
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "base",
      payTo: "0x1111111111111111111111111111111111111111",
      maxAmountRequired: "100000",
      resource: "place_hedge",
    });
    expect(executor.calls).toBe(0);
    expect(await store.listPositions()).toHaveLength(0);
  });

  it("rejects an invalid proof with a fresh challenge", async () => {
    const result = await client.callTool({
      name: "place_hedge",
      arguments: {
        pairId: "pair-eth-4000",
        idempotencyKey: "agent-key-0002",
        paymentProof: "forged",
      },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).status).toBe(402);
    expect(executor.calls).toBe(0);
  });

  it("settles and executes with a valid proof", async () => {
    const result = await client.callTool({
      name: "place_hedge",
      arguments: {
        pairId: "pair-eth-4000",
        idempotencyKey: "agent-key-0003",
        paymentProof: VALID_PROOF,
      },
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.position.status).toBe("open");
    expect(data.settlement).toBe("settled");
    expect(executor.calls).toBe(1);
  });

  it("read tools stay free of charge", async () => {
    const result = await client.callTool({ name: "list_opportunities", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(parse(result)).toHaveLength(1);
  });
});

describe("retry safety", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    await store.upsertMarket(pmMarket());
    await store.upsertMarket(uniMarket());
    await store.upsertPair(confirmedPair());
  });

  it("a retry after a client timeout does not double-fill", async () => {
    const executor = countingExecutor();
    const client = await connect(store, executor);
    const args = {
      pairId: "pair-eth-4000",
      idempotencyKey: "agent-key-1000",
      paymentProof: VALID_PROOF,
    };

    // First call succeeds server-side, but the client times out and retries.
    const first = parse(await client.callTool({ name: "place_hedge", arguments: args }));
    const second = parse(await client.callTool({ name: "place_hedge", arguments: args }));

    expect(executor.calls).toBe(1);
    expect(second.replayed).toBe(true);
    expect(second.position.id).toBe(first.position.id);
    expect(await store.listPositions()).toHaveLength(1);
  });

  it("a failed leg marks the position failed and is not re-executed on replay", async () => {
    const executor = countingExecutor(1);
    const client = await connect(store, executor);
    const args = {
      pairId: "pair-eth-4000",
      idempotencyKey: "agent-key-1001",
      paymentProof: VALID_PROOF,
    };

    const first = await client.callTool({ name: "place_hedge", arguments: args });
    expect(first.isError).toBe(true);
    expect(parse(first).error).toContain("leg execution failed");

    const retry = parse(await client.callTool({ name: "place_hedge", arguments: args }));
    expect(retry.replayed).toBe(true);
    expect(retry.position.status).toBe("failed");
    expect(executor.calls).toBe(1);

    const positions = await store.listPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].status).toBe("failed");
  });
});

describe("live swap construction", () => {
  it("builds the entry swap with hand-computed sizing and slippage", () => {
    // $1,200 notional into cbBTC (8 decimals) at $120,000 spot:
    //   amountIn = 1200 x 1e6 = 1,200,000,000 USDC units
    //   expectedOut = 1200 / 120000 = 0.01 cbBTC = 1,000,000 sats
    //   100 bps slippage -> amountOutMinimum = 990,000
    const swap = buildEntrySwap(
      { uniswapNotionalUsd: 1200 },
      "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      8,
      500,
      120_000,
      100,
    );
    expect(swap.amountIn).toBe(1_200_000_000n);
    expect(swap.amountOutMinimum).toBe(990_000n);
    expect(swap.fee).toBe(500);
    expect(swap.tokenIn).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(swap.tokenOut).toBe("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf");
  });

  it("rejects a nonpositive entry spot", () => {
    expect(() =>
      buildEntrySwap({ uniswapNotionalUsd: 100 }, "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", 8, 500, 0, 50),
    ).toThrow();
  });
});

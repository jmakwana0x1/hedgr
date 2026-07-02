import { createPublicClient, http, type PublicClient } from "viem";
import { base } from "viem/chains";
import { marketId, type Market } from "@/lib/types";
import type { VenueAdapter } from "./types";

/** Uniswap V3 QuoterV2 on Base. */
export const QUOTER_V2_BASE = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as const;
/** Native USDC on Base. */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

export const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/** One tracked Uniswap token leg, quoted against USDC. */
export interface UniswapLegConfig {
  /** Stable venue id, e.g. 'base-weth-usdc-500'. */
  venueId: string;
  question: string;
  rulesText: string;
  token: `0x${string}`;
  tokenDecimals: number;
  quoteToken?: `0x${string}`;
  quoteDecimals?: number;
  /** Pool fee tier in hundredths of a bip (500, 3000, 10000). */
  feeTier: number;
}

/**
 * Convert a raw quoter amountOut (quote token units for one whole token in)
 * into a spot price. Pure so it can be tested against fixture bigints.
 */
export function quoteToSpotPrice(amountOut: bigint, quoteDecimals: number): number {
  return Number(amountOut) / 10 ** quoteDecimals;
}

/** Normalize a quoted spot price into the shared Market shape. */
export function normalizeUniswapQuote(
  cfg: UniswapLegConfig,
  spotUsd: number,
  now = new Date(),
): Market {
  return {
    id: marketId("uniswap", cfg.venueId),
    venue: "uniswap",
    venueId: cfg.venueId,
    question: cfg.question,
    rulesText: cfg.rulesText,
    outcomes: [{ name: "SPOT", price: spotUsd, tokenId: cfg.token }],
    status: "active",
    updatedAt: now.toISOString(),
  };
}

export class UniswapAdapter implements VenueAdapter {
  private client: PublicClient;

  constructor(
    private readonly legs: UniswapLegConfig[],
    client?: PublicClient,
    private readonly quoter: `0x${string}` = QUOTER_V2_BASE,
  ) {
    this.client =
      client ??
      (createPublicClient({
        chain: base,
        transport: http(process.env.BASE_RPC_URL),
      }) as PublicClient);
  }

  /** Read spot for one leg: quote 1 whole token into USDC via QuoterV2. */
  async readSpot(cfg: UniswapLegConfig): Promise<number> {
    const { result } = await this.client.simulateContract({
      address: this.quoter,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: cfg.token,
          tokenOut: cfg.quoteToken ?? USDC_BASE,
          amountIn: BigInt(10) ** BigInt(cfg.tokenDecimals),
          fee: cfg.feeTier,
          sqrtPriceLimitX96: BigInt(0),
        },
      ],
    });
    return quoteToSpotPrice(result[0], cfg.quoteDecimals ?? 6);
  }

  async fetchMarkets(): Promise<Market[]> {
    const markets: Market[] = [];
    for (const leg of this.legs) {
      markets.push(normalizeUniswapQuote(leg, await this.readSpot(leg)));
    }
    return markets;
  }
}

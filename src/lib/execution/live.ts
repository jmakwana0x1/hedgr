import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import type { HedgePlan, PositionEntry } from "@/lib/types";
import type { Store } from "@/lib/store/types";
import { USDC_BASE } from "@/lib/ingestion/uniswap";
import { UNISWAP_LEGS } from "@/lib/matching/curated";
import type { EntryPrices, LegExecutor } from "./index";

/** Uniswap SwapRouter02 on Base. */
export const SWAP_ROUTER_02_BASE = "0x2626664c2603336E57B271c5C0b26F421741e481" as const;

export const SWAP_ROUTER_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface SwapParams {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  fee: number;
  amountIn: bigint;
  amountOutMinimum: bigint;
}

/**
 * Build the USDC -> token entry swap for the long leg. Pure so the sizing
 * and slippage math is unit tested against hand-computed values.
 *
 * amountIn is the USD notional in USDC atomic units. amountOutMinimum is the
 * expected token amount at the entry spot, reduced by slippageBps.
 */
export function buildEntrySwap(
  plan: Pick<HedgePlan, "uniswapNotionalUsd">,
  token: `0x${string}`,
  tokenDecimals: number,
  feeTier: number,
  entrySpotUsd: number,
  slippageBps: number,
  usdc: `0x${string}` = USDC_BASE,
): SwapParams {
  if (entrySpotUsd <= 0) throw new Error("entry spot must be positive");
  const amountIn = BigInt(Math.round(plan.uniswapNotionalUsd * 1_000_000));
  const expectedOut =
    (plan.uniswapNotionalUsd / entrySpotUsd) * 10 ** tokenDecimals;
  const amountOutMinimum = BigInt(
    Math.floor(expectedOut * (1 - slippageBps / 10_000)),
  );
  return { tokenIn: usdc, tokenOut: token, fee: feeTier, amountIn, amountOutMinimum };
}

export interface LiveExecutorConfig {
  rpcUrl?: string;
  privateKey: `0x${string}`;
  router?: `0x${string}`;
  slippageBps?: number;
  /**
   * Polymarket leg submission. Placing a real CLOB order requires API
   * credentials and EIP-712 order signing via the official CLOB client;
   * without an implementation the executor fails closed rather than leaving
   * the position half-hedged.
   */
  polymarketLeg?: (plan: HedgePlan, entry: EntryPrices) => Promise<{ orderId: string }>;
}

export function createLiveExecutor(
  store: Store,
  config: LiveExecutorConfig,
): LegExecutor {
  const account = privateKeyToAccount(config.privateKey);
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ chain: base, transport }) as PublicClient;
  const walletClient: WalletClient = createWalletClient({ account, chain: base, transport });
  const router = config.router ?? SWAP_ROUTER_02_BASE;
  const slippageBps = config.slippageBps ?? 50;

  return {
    mode: "live",
    async executeLegs(plan, entry): Promise<PositionEntry> {
      if (plan.uniswapDirection !== "long") {
        throw new Error("live executor only supports the long token leg");
      }
      const pair = await store.getPair(plan.pairId);
      if (!pair) throw new Error(`unknown pair ${plan.pairId}`);
      const uniMarket = await store.getMarket(pair.marketBId);
      const leg = UNISWAP_LEGS.find((l) => `uniswap:${l.venueId}` === pair.marketBId);
      if (!uniMarket || !leg) {
        throw new Error(`pair ${plan.pairId} has no configured uniswap leg`);
      }

      // Polymarket leg first: it is the harder leg to fill, and failing
      // before the swap leaves nothing on chain to unwind.
      if (!config.polymarketLeg) {
        throw new Error(
          "live Polymarket leg is not configured; supply polymarketLeg (CLOB client) or run paper mode",
        );
      }
      const order = await config.polymarketLeg(plan, entry);

      const swap = buildEntrySwap(
        plan,
        leg.token,
        leg.tokenDecimals,
        leg.feeTier,
        entry.uniswapPrice,
        slippageBps,
      );

      const approveHash = await walletClient.writeContract({
        chain: base,
        account,
        address: swap.tokenIn,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [router, swap.amountIn],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      const swapHash = await walletClient.writeContract({
        chain: base,
        account,
        address: router,
        abi: SWAP_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            ...swap,
            recipient: account.address,
            sqrtPriceLimitX96: BigInt(0),
          },
        ],
      });
      await publicClient.waitForTransactionReceipt({ hash: swapHash });

      return {
        ...entry,
        txHashes: [order.orderId, approveHash, swapHash],
      };
    },
  };
}

export function liveExecutorFromEnv(store: Store): LegExecutor {
  const privateKey = process.env.HEDGR_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) throw new Error("HEDGR_PRIVATE_KEY must be set when HEDGR_LIVE=1");
  return createLiveExecutor(store, {
    privateKey,
    rpcUrl: process.env.BASE_RPC_URL,
    slippageBps: process.env.HEDGR_SLIPPAGE_BPS
      ? Number(process.env.HEDGR_SLIPPAGE_BPS)
      : undefined,
  });
}

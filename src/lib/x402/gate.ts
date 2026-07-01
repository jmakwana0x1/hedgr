import type { PaymentGate, PaymentRequirement, VerifyResult } from "./types";

/** Native USDC on Base. */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export interface X402GateConfig {
  payTo: string;
  network?: string;
  asset?: string;
  /** Price per execution in atomic units of the asset (USDC has 6 decimals). */
  priceAtomic: string;
  /**
   * x402 facilitator base URL used to verify and settle payments. Optional
   * when a custom verifier is injected (tests, local development).
   */
  facilitatorUrl?: string;
  verifier?: (proof: string, requirement: PaymentRequirement) => Promise<VerifyResult>;
}

export class X402Gate implements PaymentGate {
  constructor(private readonly config: X402GateConfig) {
    if (!config.facilitatorUrl && !config.verifier) {
      throw new Error("X402Gate needs a facilitatorUrl or a custom verifier");
    }
  }

  accepts(resource: string): PaymentRequirement[] {
    return [
      {
        scheme: "exact",
        network: this.config.network ?? "base",
        asset: this.config.asset ?? USDC_BASE,
        payTo: this.config.payTo,
        maxAmountRequired: this.config.priceAtomic,
        resource,
        description: `Payment for one Hedgr ${resource} execution`,
      },
    ];
  }

  async verify(proof: string | undefined, resource: string): Promise<VerifyResult> {
    if (!proof?.trim()) {
      return { ok: false, error: "missing x402 payment proof" };
    }
    const requirement = this.accepts(resource)[0];
    if (this.config.verifier) {
      return this.config.verifier(proof, requirement);
    }
    return this.facilitator("verify", proof, requirement);
  }

  /** Capture the payment after the gated work succeeds. */
  async settle(proof: string, resource: string): Promise<VerifyResult> {
    const requirement = this.accepts(resource)[0];
    if (this.config.verifier) {
      // Custom verifiers are treated as verify-and-settle in one step.
      return { ok: true };
    }
    return this.facilitator("settle", proof, requirement);
  }

  private async facilitator(
    action: "verify" | "settle",
    proof: string,
    requirement: PaymentRequirement,
  ): Promise<VerifyResult> {
    const res = await fetch(`${this.config.facilitatorUrl}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload: proof,
        paymentRequirements: requirement,
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `facilitator ${action} returned ${res.status}` };
    }
    const body = (await res.json()) as {
      isValid?: boolean;
      success?: boolean;
      invalidReason?: string;
      errorReason?: string;
      payer?: string;
    };
    const ok = action === "verify" ? body.isValid === true : body.success === true;
    if (!ok) {
      return {
        ok: false,
        error: body.invalidReason ?? body.errorReason ?? `facilitator rejected ${action}`,
      };
    }
    return { ok: true, payer: body.payer };
  }
}

export function x402GateFromEnv(): X402Gate {
  const payTo = process.env.X402_PAY_TO;
  if (!payTo) throw new Error("X402_PAY_TO must be set when HEDGR_X402=1");
  const priceUsdc = Number(process.env.X402_PRICE_USDC ?? "0.10");
  return new X402Gate({
    payTo,
    network: process.env.X402_NETWORK ?? "base",
    priceAtomic: String(Math.round(priceUsdc * 1_000_000)),
    facilitatorUrl: process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
  });
}

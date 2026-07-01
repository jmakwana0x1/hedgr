/**
 * Payment gating for the MCP execution path, modeled on the x402 protocol:
 * a request without a valid payment proof is answered with a 402-style
 * challenge listing acceptable payment requirements; the client pays,
 * attaches the proof, and retries.
 */
export interface PaymentRequirement {
  scheme: "exact";
  network: string;
  /** ERC-20 asset address the payment must be made in. */
  asset: string;
  payTo: string;
  /** Price in atomic units of the asset. */
  maxAmountRequired: string;
  resource: string;
  description: string;
}

export type VerifyResult =
  | { ok: true; payer?: string }
  | { ok: false; error: string };

export interface PaymentGate {
  /** Requirements advertised in the 402 challenge for a resource. */
  accepts(resource: string): PaymentRequirement[];
  /** Verify a payment proof for a resource. */
  verify(proof: string | undefined, resource: string): Promise<VerifyResult>;
}

/** No-op gate: execution is free. Used in paper mode and tests. */
export const openGate: PaymentGate = {
  accepts: () => [],
  verify: async () => ({ ok: true }),
};

export interface PaymentChallenge {
  error: "payment_required";
  status: 402;
  message: string;
  accepts: PaymentRequirement[];
}

export function paymentChallenge(
  gate: PaymentGate,
  resource: string,
  message: string,
): PaymentChallenge {
  return {
    error: "payment_required",
    status: 402,
    message,
    accepts: gate.accepts(resource),
  };
}

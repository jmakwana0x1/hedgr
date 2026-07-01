import type { Market, Pair, PairStatus } from "@/lib/types";
import { LocalEmbedder, similarityScore, type Embedder } from "./similarity";
import { compareRules } from "./rules";

/**
 * Statuses the automated pipeline is allowed to assign. 'confirmed' is
 * deliberately absent: only human review (confirmPair, or the curated seed
 * list which is pre-reviewed) may mark a pair confirmed. See CLAUDE.md
 * invariant 1.
 */
export type PipelineStatus = Extract<PairStatus, "candidate" | "flagged">;

export interface PairEvaluation {
  status: PipelineStatus;
  similarity: number;
  reasons: string[];
}

export const SIMILARITY_THRESHOLD = 0.35;

/**
 * Evaluate whether two markets look like the same bet. Returns 'candidate'
 * (plausible match, needs human review) or 'flagged' (evidence of mismatch).
 * Never returns 'confirmed'.
 */
export async function evaluatePair(
  marketA: Market,
  marketB: Market,
  embedder: Embedder = new LocalEmbedder(),
): Promise<PairEvaluation> {
  const textA = `${marketA.question}\n${marketA.rulesText}`;
  const textB = `${marketB.question}\n${marketB.rulesText}`;

  const similarity = await similarityScore(embedder, textA, textB);
  const rules = compareRules(textA, textB);

  const reasons = [...rules.reasons];
  if (similarity < SIMILARITY_THRESHOLD) {
    reasons.push(
      `similarity ${similarity.toFixed(3)} below threshold ${SIMILARITY_THRESHOLD}`,
    );
  }

  return {
    status: reasons.length > 0 ? "flagged" : "candidate",
    similarity,
    reasons,
  };
}

/** Only confirmed pairs are ever tradable. */
export function isTradable(pair: Pair): boolean {
  return pair.status === "confirmed";
}

/**
 * Human review path: promote a pair to confirmed. This is the only code path
 * that assigns 'confirmed' outside the curated seed list.
 */
export function confirmPair(pair: Pair, reviewedBy: string): Pair {
  if (!reviewedBy.trim()) {
    throw new Error("confirmPair requires a reviewer identity");
  }
  return { ...pair, status: "confirmed", reviewedBy };
}

/**
 * Rule-text comparison used to confirm or reject candidate pairs. Two rule
 * texts are compatible when they reference the same underlying asset and do
 * not disagree on key figures (thresholds, strike levels).
 */

const KNOWN_ASSETS = [
  "eth", "ethereum", "weth",
  "btc", "bitcoin", "cbbtc", "wbtc",
  "sol", "solana",
  "usdc", "usdt",
];

const ASSET_ALIASES: Record<string, string> = {
  ethereum: "eth",
  weth: "eth",
  bitcoin: "btc",
  cbbtc: "btc",
  wbtc: "btc",
  solana: "sol",
};

export function extractAssets(text: string): Set<string> {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const asset of KNOWN_ASSETS) {
    if (new RegExp(`\\b${asset}\\b`).test(lower)) {
      found.add(ASSET_ALIASES[asset] ?? asset);
    }
  }
  return found;
}

/** Extract significant numeric figures: $4,000 -> 4000, "0.05%" -> 0.05. */
export function extractFigures(text: string): Set<number> {
  const figures = new Set<number>();
  for (const match of text.matchAll(/\$?([\d,]+(?:\.\d+)?)%?/g)) {
    const value = Number(match[1].replace(/,/g, ""));
    // Ignore small incidental numbers (list indexes, "1 minute candle").
    if (Number.isFinite(value) && value >= 100) figures.add(value);
  }
  return figures;
}

export interface RuleComparison {
  compatible: boolean;
  reasons: string[];
}

export function compareRules(textA: string, textB: string): RuleComparison {
  const reasons: string[] = [];

  const assetsA = extractAssets(textA);
  const assetsB = extractAssets(textB);
  if (assetsA.size > 0 && assetsB.size > 0) {
    const shared = [...assetsA].filter((a) => assetsB.has(a));
    if (shared.length === 0) {
      reasons.push(
        `asset mismatch: [${[...assetsA].join(", ")}] vs [${[...assetsB].join(", ")}]`,
      );
    }
  }

  const figuresA = extractFigures(textA);
  const figuresB = extractFigures(textB);
  if (figuresA.size > 0 && figuresB.size > 0) {
    const shared = [...figuresA].filter((f) => figuresB.has(f));
    if (shared.length === 0) {
      reasons.push(
        `key figure mismatch: [${[...figuresA].join(", ")}] vs [${[...figuresB].join(", ")}]`,
      );
    }
  }

  return { compatible: reasons.length === 0, reasons };
}

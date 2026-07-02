/**
 * Embedding-assisted candidate discovery. The Embedder interface allows a
 * hosted embedding model in production; the default LocalEmbedder is a
 * deterministic term-frequency embedding so discovery works offline and
 * tests never hit the network.
 */
export interface Embedder {
  embed(text: string): Promise<Map<string, number>>;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "on", "in", "at", "to", "will", "be", "is", "this",
  "that", "if", "or", "and", "for", "by", "market", "resolve", "resolves",
  "otherwise", "no", "yes",
]);

/** Wrapped assets embed as their underlying so cross-venue text can match. */
const TOKEN_ALIASES: Record<string, string> = {
  weth: "eth",
  ethereum: "eth",
  cbbtc: "btc",
  wbtc: "btc",
  bitcoin: "btc",
  solana: "sol",
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\$([\d,]+(?:\.\d+)?)/g, (_, n: string) => ` ${n.replace(/,/g, "")} `)
    .replace(/[^a-z0-9.]+/g, " ")
    .split(/\s+/)
    .map((t) => {
      // Normalize numeric tokens so '4000.00' and '4000' embed identically.
      const n = Number(t);
      if (t !== "" && Number.isFinite(n)) return String(n);
      return TOKEN_ALIASES[t] ?? t;
    })
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export class LocalEmbedder implements Embedder {
  async embed(text: string): Promise<Map<string, number>> {
    const vector = new Map<string, number>();
    for (const token of tokenize(text)) {
      vector.set(token, (vector.get(token) ?? 0) + 1);
    }
    return vector;
  }
}

export function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [token, weight] of a) {
    normA += weight * weight;
    const other = b.get(token);
    if (other != null) dot += weight * other;
  }
  for (const weight of b.values()) normB += weight * weight;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function similarityScore(
  embedder: Embedder,
  textA: string,
  textB: string,
): Promise<number> {
  const [a, b] = await Promise.all([embedder.embed(textA), embedder.embed(textB)]);
  return cosineSimilarity(a, b);
}

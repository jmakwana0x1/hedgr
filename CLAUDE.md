# Hedgr

MCP server where AI agents discover and execute cross-venue hedges across Polymarket and
Uniswap, settled through x402 micropayments. Read-heavy, freshness-sensitive, on-chain-native.

Framing is resolution-correlated hedging with EV scoring, not risk-free arbitrage. The
defensible IP is the resolution-divergence discount.

## Stack

- Next.js App Router + TypeScript + Tailwind, deployed on Vercel.
- Supabase (Postgres) for persistence. Migrations live in `supabase/migrations/`.
- TypeScript MCP server built on `@modelcontextprotocol/sdk` (`src/mcp/`).
- Viem for chain reads/writes (Uniswap quoter, execution legs).

## Layout

- `src/lib/types.ts`: shared domain types. `Market` is the single normalized market shape;
  every adapter must emit it. Do not fork per-venue market types.
- `src/lib/store/`: repository interfaces plus in-memory and Supabase implementations.
  Domain code depends only on the interfaces in `store/types.ts`.
- `src/lib/ingestion/`: venue adapters (Polymarket CLOB, Uniswap quoter). Pure
  normalization functions are exported separately from I/O so they can be unit tested
  against fixture payloads.
- `src/lib/matching/`: pair discovery and confirmation. Curated pairs are v1 ground truth.
- `src/lib/engine/`: fee math, payoff matrices, resolution-divergence discount, EV ranking.
- `src/lib/execution/`: paper and live execution paths, idempotency enforcement.
- `src/lib/x402/`: payment gate for the execution path.
- `src/mcp/`: MCP server and tool definitions.
- `src/app/`: Next.js dashboard.
- `tests/`: vitest suites and fixture payloads.

## Invariants (never break these)

1. **No auto-trade on unreviewed pairs.** Only pairs with status `confirmed` are tradable.
   The matching pipeline may only produce `candidate` or `flagged`; the `confirmed` status
   is set exclusively by human review (curated seed list counts as reviewed). Execution
   must reject any pair that is not `confirmed`.
2. **Idempotency key on all execution.** Every execution request (paper or live) carries a
   caller-supplied idempotency key. Replaying a key must return the original position and
   must never create a second position or send a second transaction.

## Schema

Tables: `markets`, `pairs`, `opportunities`, `positions`, `price_history`.
`price_history` is indexed on `(pair_id, ts)`. `positions.idempotency_key` is unique.
See `supabase/migrations/0001_init.sql` for the authoritative definitions. Schema changes
go through a new migration file, never by editing an applied one.

## Naming

- Venue identifiers are the lowercase strings `polymarket` and `uniswap`.
- Internal market ids are `<venue>:<venueId>`.
- Money amounts are USD numbers suffixed `Usd`; prices are 0..1 probabilities on
  prediction outcomes and USDC spot on token legs. Fees in basis points are suffixed `Bps`.

## Git workflow

- One branch per phase: `phase-1-scaffold`, `phase-2-ingestion`, and so on.
- Commit at the end of each task inside a phase, not once at the end. Small commits.
- Commit message format: `phase-N: <subsystem> <what changed>`. No AI-signature lines,
  no em-dashes.
- Open a GitHub issue at the start of each phase listing that phase's tasks. Close it when
  the phase merges.
- Never force-push. Never hard-reset. Never push directly to `main` (the bootstrap commit
  is the only exception); open a PR from the phase branch.

## Testing

- `npm test` runs vitest. Tests must not hit the network or a live database; adapters are
  tested against fixtures in `tests/fixtures/`, stores against the in-memory implementation.
- Fee math and EV tests are the highest-rigor suites. A wrong fee constant silently
  poisons every ranking. Any change to `src/lib/engine/` requires hand-computed expected
  values in the tests, not values copied from the implementation's own output.

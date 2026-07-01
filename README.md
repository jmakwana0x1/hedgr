# Hedgr

An MCP server where AI agents discover and execute cross-venue hedges across
Polymarket and Uniswap, settled through x402 micropayments.

Hedgr is honest about what it is: **resolution-correlated hedging with expected-value
scoring, not risk-free arbitrage.** A Polymarket outcome and a Uniswap token position
are never the same instrument. The two venues can settle inconsistently, and that
possibility is priced in as a first-class scenario: the resolution-divergence
discount. Every opportunity Hedgr ranks carries an EV net of real fees, a max loss,
and the full scenario payoff matrix that produced them. EV can be negative, and the
engine will say so.

## What an agent can do

Connect any MCP client to the server and drive the whole loop:

```
npm run mcp
```

| Tool | What it does |
|---|---|
| `list_opportunities` | Recompute and rank fee-aware hedges across confirmed pairs by EV |
| `get_market` | Fetch one normalized market (either venue) |
| `simulate_hedge` | Full payoff matrix, fees, EV, and max loss at current prices; read-only |
| `place_hedge` | Execute both legs; idempotency key required, x402 gated when enabled |
| `get_position_summary` | All positions with plans, entries, and aggregates |

Example Claude Code registration:

```json
{
  "mcpServers": {
    "hedgr": { "command": "npm", "args": ["run", "mcp"], "cwd": "/path/to/hedgr" }
  }
}
```

Paper mode is the default: no database, no chain calls, no payments. Positions land
in an in-memory store seeded with the curated pairs.

## How it works

1. **Data spine.** Venue adapters normalize both feeds into one `Market` shape.
   Polymarket comes in over the Gamma REST API with CLOB WebSocket price events and
   a polling fallback; Uniswap legs are QuoterV2 reads on Base via viem. Every tick
   lands in `price_history`.
2. **Matching.** Which two markets are the same bet? A hand-curated set of pairs is
   the v1 ground truth. Embedding similarity plus rule-text comparison (asset and
   key-figure extraction) assist discovery, but the pipeline can only produce
   `candidate` or `flagged`. Only human review confirms a pair, and **only confirmed
   pairs are ever tradable.**
3. **Opportunity engine.** For each confirmed pair: a payoff matrix across YES, NO,
   and divergence scenarios, real fee math (Polymarket fee, Uniswap pool fee both
   ways, gas per transaction), and EV weighted by market-implied probability with
   the divergence prior taken from review. Ranked on every tick.
4. **Execution.** `place_hedge` reserves the position under the caller's idempotency
   key before any leg executes, so a retry after a timeout can never double-fill.
   Paper mode records entry prices; live mode sends the Uniswap swap on Base and
   fails closed if the Polymarket CLOB leg is not configured.
5. **x402.** When enabled, `place_hedge` answers unpaid calls with a 402 challenge
   (scheme, asset, amount, receiver). The agent pays, retries with the proof, the
   gate verifies against a facilitator, and settlement is captured only after the
   hedge actually executes. Replays are never charged twice.

## Stack

Next.js App Router dashboard (positions, combined payoff curve, live EV), Supabase
for persistence, TypeScript MCP server on `@modelcontextprotocol/sdk`, viem for all
chain access. Tests are vitest against fixtures and the in-memory store; the fee and
EV suites assert hand-computed values.

## Running it

```bash
npm install
npm test              # 48 tests, no network
npm run dev           # dashboard on :3000, demo data when no SUPABASE_URL
npm run mcp           # MCP server on stdio, paper mode
```

Environment (all optional; absence means paper/demo mode):

| Variable | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Postgres persistence (`supabase/migrations/`) |
| `POLYMARKET_IDS` | Gamma market ids for `npm run ingest` |
| `BASE_RPC_URL` | Base RPC for quoter reads and live swaps |
| `HEDGR_X402=1` + `X402_PAY_TO`, `X402_PRICE_USDC`, `X402_FACILITATOR_URL` | payment-gate `place_hedge` |
| `HEDGR_LIVE=1` + `HEDGR_PRIVATE_KEY` | live execution, trivial size only |

## Invariants

1. No auto-trade on unreviewed pairs. The matcher cannot confirm; execution rejects
   anything not confirmed.
2. Idempotency key on all execution. Replay returns the original position, always.

## What this is not

Not financial advice, not a money printer, and not arbitrage. Hedges here have
negative-EV configurations, a real worst case, and a modeled probability that the
venues disagree about reality. The point is that an agent can see all of that
before it pays to act.

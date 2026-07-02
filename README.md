# Hedgr

An MCP server where AI agents discover and execute cross-venue hedges across
Polymarket and Uniswap, settled through x402 micropayments.

Hedgr is honest about what it is: **resolution-correlated hedging with expected-value
scoring, not risk-free arbitrage.** A Polymarket outcome token and a Uniswap spot
position are never the same instrument. The two venues can settle inconsistently,
and that possibility is priced in as a first-class scenario rather than assumed away.
Every opportunity Hedgr ranks carries an EV net of real fees, a max loss, and the
full scenario payoff matrix that produced them. EV can be negative, and the engine
will say so.

This document explains the system in depth: what each layer does, and why it is
built the way it is.

---

## Contents

1. [The thesis](#1-the-thesis)
2. [System overview](#2-system-overview)
3. [The domain model](#3-the-domain-model)
4. [Data spine: ingestion](#4-data-spine-ingestion)
5. [Storage: the repository layer](#5-storage-the-repository-layer)
6. [Matching: which two markets are the same bet](#6-matching-which-two-markets-are-the-same-bet)
7. [The opportunity engine](#7-the-opportunity-engine)
8. [Execution and idempotency](#8-execution-and-idempotency)
9. [x402: paying per action](#9-x402-paying-per-action)
10. [The MCP server](#10-the-mcp-server)
11. [The dashboard](#11-the-dashboard)
12. [Testing philosophy](#12-testing-philosophy)
13. [The two invariants](#13-the-two-invariants)
14. [Running it](#14-running-it)
15. [Known gaps and roadmap](#15-known-gaps-and-roadmap)

---

## 1. The thesis

Prediction markets and spot markets price the same underlying reality through
different instruments. "Will ETH close above $4,000 on December 31?" on Polymarket
and a WETH position on Uniswap are both, in different currencies of risk, opinions
about the same future. When you hold one, the other can insure it: buy the
Polymarket side that pays out exactly when your token position suffers, and the
combined book has a much flatter payoff than either leg alone.

The catch, and the reason this is not arbitrage, is **resolution divergence**. The
prediction market resolves on an oracle reading of a specific data source at a
specific instant; the token settles wherever the pool happens to trade. A wrapped
asset can depeg from its underlying. An oracle can read a different feed than the
pool tracks. A "touch" market can resolve YES while the token has already retraced.
In all of those worlds the insurance fails precisely when it was needed. Most
cross-venue tooling ignores this tail; Hedgr makes it a scenario in the payoff
matrix with a reviewed prior probability per pair, and discounts EV accordingly.
That discount is the defensible core of the project.

**Why these two venues.** Polymarket is the deepest on-chain prediction market and
its prices are directly readable as probabilities. Uniswap is the canonical
USDC-native settlement rail: quoting, swapping, and paying all happen in one
ecosystem with one wallet. An earlier design included Kalshi and was dropped:
KYC and fiat rails break the agentic story completely. An AI agent cannot pass KYC,
hold a brokerage account, or wire dollars; it can hold a key and sign transactions.
Keeping every leg on-chain is what makes "an agent pays a micropayment and executes
a hedge end to end" real rather than a demo with a human in the loop.

**Why MCP.** The consumer of this system is not a human clicking a UI; it is an
agent reasoning over structured tool results. MCP gives a typed, discoverable tool
surface that any compliant client (Claude, or anything else speaking the protocol)
can drive without bespoke integration. The dashboard exists for humans to audit
what the agents did, not to trade.

---

## 2. System overview

```
                 Polymarket                      Base (Uniswap)
            Gamma REST + CLOB WS                QuoterV2 via viem
                     |                                 |
                     v                                 v
            +------------------ ingestion -------------------+
            |   pure normalizers -> shared Market shape      |
            +-----------------------+------------------------+
                                    v
            +------------------- store ----------------------+
            | repository interfaces; in-memory + Supabase    |
            | markets, pairs, opportunities, positions,      |
            | price_history                                  |
            +---+----------------+----------------+----------+
                |                |                |
                v                v                v
            matching          engine          execution
         curated pairs,   fees, payoff     idempotent paper
         similarity,      matrix,          and live paths
         rule compare     divergence
                          discount, EV
                                    |
                                    v
            +------------------ MCP server ------------------+
            | list_opportunities  get_market  simulate_hedge |
            | place_hedge (x402-gated)  get_position_summary |
            +------------------------------------------------+
                                    |
                              AI agent (MCP client)

            Next.js dashboard reads the same store for humans
```

The dependency direction is strict: domain code (`matching`, `engine`, `execution`)
depends only on the repository **interfaces**, never on Supabase or on an adapter.
Adapters depend on the domain types, never on each other. The MCP server and the
dashboard are thin composition layers at the edge. This is what makes the whole
system testable without a network and swappable at every seam.

### Layout

```
src/
  lib/
    types.ts        shared domain types; Market is the single normalized shape
    store/          repository interfaces + in-memory and Supabase implementations
    ingestion/      Polymarket and Uniswap adapters; pure normalizers split from I/O
    matching/       curated pairs, similarity, rule comparison, pair status machine
    engine/         fee math, payoff matrix, divergence discount, EV ranking, curve
    execution/      paper and live execution, idempotency enforcement
    x402/           payment gate for the execution path
    demo.ts         demo-mode seed for the dashboard
  mcp/              MCP server and tool definitions
  app/              Next.js dashboard
  components/       payoff chart, stat tiles
  scripts/          ingest backfill
supabase/migrations/  authoritative schema
tests/                vitest suites + fixture payloads
```

---

## 3. The domain model

Everything hangs off one deliberate decision: **there is exactly one `Market`
shape, and every venue adapter must emit it.**

```ts
interface Market {
  id: string;            // "<venue>:<venueId>"
  venue: "polymarket" | "uniswap";
  venueId: string;
  question: string;
  rulesText: string;
  outcomes: MarketOutcome[];   // [{ name, price, tokenId? }]
  status: "active" | "closed" | "resolved";
  endDate?: string;
  liquidityUsd?: number;
  updatedAt: string;
}
```

The tempting alternative is a `PolymarketMarket` and a `UniswapPool` with a common
interface. That forks the type system at the root: matching, the engine, storage,
and the MCP tools would all need to branch on venue forever. Instead, the venues
are unified at the earliest possible moment and the asymmetry is pushed into the
`outcomes` array:

- A Polymarket market has `YES` and `NO` outcomes whose prices are 0..1 implied
  probabilities, with CLOB token ids attached.
- A Uniswap leg has a single `SPOT` outcome whose price is the USDC spot of the
  token, with the ERC-20 address attached.

Calling a Uniswap pool a "market" with a one-outcome book is a modeling stretch,
and it is worth it: everything downstream of ingestion is venue-agnostic. The
engine asks for `outcomePrice(market, "YES")` or `outcomePrice(market, "SPOT")`
and never knows which API the number came from.

Two smaller conventions do a lot of quiet work:

- **Ids are `"<venue>:<venueId>"`** (`polymarket:253591`,
  `uniswap:base-weth-usdc-500`). Globally unique, human-readable in logs, and the
  venue is recoverable from the id without a join.
- **Units are encoded in names.** Money is a number suffixed `Usd`, fees in basis
  points are suffixed `Bps`, prediction prices are bare 0..1 numbers. A fee-math
  bug where dollars meet basis points is the classic silent killer in this kind of
  system; making units grep-able is cheap insurance.

The other core types follow from the flow: `Pair` (two market ids plus review
state and the divergence model), `HedgePlan` (side, shares, direction, notional),
`Opportunity` (EV, max loss, fees, and the scenario array that produced them),
`Position` (a placed plan with its idempotency key and entry). Opportunities carry
their full `scenarios` breakdown deliberately: an agent deciding whether to pay to
execute should see *why* the EV is what it is, not just the headline number.

---

## 4. Data spine: ingestion

The rule for adapters: **pure normalization functions are exported separately from
I/O.** `normalizePolymarketMarket(rawGammaPayload)` and
`normalizeUniswapQuote(config, spotUsd)` are pure and are unit tested against
fixture payloads checked into `tests/fixtures/`. The fetching, polling, and
socket code around them is thin and boring. This split is why the test suite can
prove normalization is right without ever touching a network, and why a venue API
change becomes a fixture update rather than an archaeology project.

### Polymarket

Three paths, because prediction market data has three different freshness needs:

1. **Gamma REST** for market discovery and full state (question, rules,
   outcomes, liquidity, close status). Gamma returns outcome arrays as
   *stringified JSON inside JSON* (`"outcomes": "[\"Yes\",\"No\"]"`); the
   normalizer parses these defensively and degrades to an empty outcome list on
   malformed input rather than throwing, because one broken market must not kill
   an ingestion sweep.
2. **CLOB WebSocket** for price ticks. `applyClobPriceEvent(market, event)` is a
   pure function from a normalized market plus a socket event to an updated market
   (or `null` if the event touches nothing tracked). The socket handler is a dumb
   pipe around it.
3. **REST polling fallback** on an interval, always running. Sockets drop, and a
   hedging system quietly serving stale prices is worse than one that is briefly
   rate-limited. The poll also self-heals any missed socket events.

### Uniswap

Spot comes from **QuoterV2 on Base** (`quoteExactInputSingle`, simulated via viem,
never sent). Quoting an exact input of one whole token into USDC returns an
execution-realistic price that already includes the pool's fee and current-tick
liquidity, which is more honest for an execution system than reading
`slot0.sqrtPriceX96` and pretending mid-price is attainable. Tracked legs are
static config (`UniswapLegConfig`: token, decimals, fee tier, rules text), because
the interesting token set is the handful referenced by curated pairs, not the long
tail of pools.

The decimal conversion (`quoteToSpotPrice`) is a pure function tested against
fixture bigints, since mixing 6-decimal USDC with 18-decimal WETH and 8-decimal
cbBTC is exactly where an off-by-1e2 hides.

Both adapters persist through one shared path, `persistMarket`, which upserts the
market and appends one `price_history` tick per outcome. One write path means one
place where tick semantics live.

---

## 5. Storage: the repository layer

Domain code depends only on the interfaces in `src/lib/store/types.ts`
(`MarketStore`, `PairStore`, `OpportunityStore`, `PositionStore`,
`PriceHistoryStore`). Two implementations exist:

- **`MemoryStore`**: used by every test, by paper mode, and by the demo dashboard.
- **`SupabaseStore`**: straight table mapping onto the schema in
  `supabase/migrations/0001_init.sql`.

The point of the port-and-adapter split is not architectural piety; it is that the
entire domain, including end-to-end MCP flows, runs against `MemoryStore` in
milliseconds with zero infrastructure, while production swaps in Postgres without
touching a line of domain code. `getStore()` picks by the presence of
`SUPABASE_URL`.

The one interface method with real design weight is:

```ts
insertPositionIfAbsent(position): Promise<{ position, created: boolean }>
```

This is idempotency pushed down to the storage contract. It is deliberately *not*
"check by key, then insert": that is a read-then-write race. The memory
implementation is atomic by virtue of the single-threaded event loop; the Supabase
implementation inserts and treats Postgres unique-violation `23505` on
`positions.idempotency_key` as "already exists, fetch and return the original".
The database's unique constraint, not application logic, is the final arbiter, so
two racing replays cannot both create a position no matter how many server
instances are running.

Schema notes: `price_history` is indexed on `(pair_id, ts)` because the read
pattern is "recent ticks for this pair" (charts, freshness checks), not global
scans. Plans and scenario arrays are stored as `jsonb` rather than exploded into
columns, since they are read and written as units and their shape is owned by the
TypeScript types. Schema changes go through new migration files only; an applied
migration is history, not an editable document.

---

## 6. Matching: which two markets are the same bet

Matching is where a plausible-looking system can quietly become dangerous. Two
markets that read alike but differ in one threshold, one data source, or one
deadline produce a "hedge" that is actually an unhedged double bet. Hedgr's
response is a status machine with a hard ceiling on what automation may do:

```
pipeline may emit:   candidate | flagged
human review emits:  confirmed
tradable:            confirmed only
```

This is enforced three times over, on the belt-and-suspenders theory that
invariants this important should not depend on one code path behaving:

1. **In the type system.** `evaluatePair` returns
   `PipelineStatus = Extract<PairStatus, "candidate" | "flagged">`. Code that
   tried to make the pipeline emit `confirmed` would not compile.
2. **In review.** `confirmPair` is the only function that assigns `confirmed`,
   and it throws without a reviewer identity.
3. **At execution.** `placeHedge` rejects any pair that is not `confirmed`,
   regardless of how it got its status.

**Curated pairs are the v1 ground truth.** Ten hand-reviewed pairs
(`src/lib/matching/curated.ts`) map Polymarket threshold markets to the WETH and
cbBTC legs on Base. Each carries three reviewed numbers that no algorithm sets:
`priceIfYes` and `priceIfNo` (the modeled token spot under each resolution, which
parameterize the payoff matrix) and `divergenceProb` (the prior that the venues
settle inconsistently). The priors are deliberately judgment calls: a clean
"Coinbase close vs WETH" pair gets 0.02, a cbBTC pair gets 0.03 for custodial
depeg tail, and an ETH/BTC ratio market only partially hedged by a single WETH
leg gets 0.08. Encoding "this hedge is structurally leakier" as a reviewed number
is exactly the discount doing its job. The curated seed counts as reviewed, which
is why `seedCuratedPairs` may write `confirmed`.

**Discovery assists; it never decides.** Candidate discovery uses embedding
cosine similarity over question plus rules text. The `Embedder` is an interface;
the default `LocalEmbedder` is a deterministic term-frequency embedding with a
tokenizer that normalizes the things that matter in this domain: `$4,000.00`,
`4000.00`, and `4000` all become the token `4000`, and wrapped assets alias to
their underlying (`weth -> eth`, `cbbtc -> btc`). A hosted embedding model can be
dropped in behind the interface, but the default keeps discovery working offline
and tests hermetic. Rule-text comparison then extracts **assets** (with the same
aliasing) and **key figures** (numbers >= 100, filtering out incidental "1 minute
candle" noise) and rejects pairs that disagree: an ETH market against a cbBTC leg
is an asset mismatch; a $4,000 strike against a $9,000 strike is a key-figure
mismatch. Both produce `flagged` with human-readable reasons attached, because a
flag a reviewer cannot understand is a flag that gets rubber-stamped.

The similarity threshold (0.35) gates `candidate` vs `flagged`, and that is all
it gates. Getting above it earns a pair a place in the review queue, never a
trade.

---

## 7. The opportunity engine

This is the highest-rigor code in the repository, on the principle stated in
CLAUDE.md: a wrong fee constant silently poisons every ranking. Everything here
is small, pure, and tested against values computed by hand in the test comments,
never against the implementation's own output.

### The hedge construction

`suggestPlan` builds one canonical hedge shape: **hold the token leg long, and buy
the Polymarket side that pays when the event is adverse for the token.** For an
upside market (token modeled higher on YES), the insurance side is NO; for a
downside market ("will ETH dip below $3,000"), it is YES. This models the real
user: an agent (or its principal) carrying token inventory who wants resolution
insurance, not a market-neutral fund running both directions. Shorting the token
leg is representable in the types (`uniswapDirection`) but not constructed in v1.

### The fee model

```ts
{ polymarketFeeBps, uniswapPoolFeeBps, gasPerTxUsd }
```

- Polymarket: bps on entry notional (shares x entry price). Currently 0 on most
  markets, but parameterized because a hardcoded zero is a trap for the day that
  changes; the test model uses 200 bps precisely so the math is exercised with a
  nonzero value.
- Uniswap: the pool fee applied **twice**, entry and exit, because a hedge that
  is put on must eventually come off, and pricing only the entry half flatters
  every opportunity.
- Gas: a flat per-transaction estimate times `TXS_PER_HEDGE = 3` (Polymarket
  entry, swap in, swap out), an explicit named constant rather than a magic
  number buried in a formula.

### The payoff matrix and the divergence discount

Three scenarios, with probabilities that provably sum to 1:

| scenario | probability | payoff model |
|---|---|---|
| YES | `p_yes x (1 - d)` | PM leg settles at $1/$0; token leg marks to `priceIfYes` |
| NO | `(1 - p_yes) x (1 - d)` | same, with `priceIfNo` |
| divergence | `d` | PM leg **loses outright**; token leg takes its **worse** conditional |

`p_yes` is the market-implied probability (the YES price), and `d` is the
reviewed pair prior. The divergence payoff is deliberately conservative, close to
worst-case: the insurance pays nothing *and* the token went the wrong way. A
softer model (partial fills, correlated-but-not-identical settlement) would be
more realistic and much easier to fool yourself with; the conservative version
guarantees the discount only ever pushes EV down and max loss out. Divergence is
also always the max-loss scenario by construction, which makes the "worst case"
number the agent sees mean something concrete: *this is what happens if the
venues disagree about reality.*

EV is the probability-weighted sum of net payoffs; fees are subtracted inside
every scenario (they are paid regardless of outcome); `maxLossUsd` is the minimum
scenario net. `refreshOpportunities` recomputes and re-ranks over confirmed pairs
on tick, skipping pairs whose legs have no live price yet rather than ranking
them with garbage, and never touching unconfirmed pairs at all.

---

## 8. Execution and idempotency

Agents retry. Networks time out after the work succeeded. Any execution path that
does not treat "the same request arriving twice" as a first-class case will
eventually double-spend someone's money. Hedgr's rule: **every execution request
carries a caller-supplied idempotency key, and replaying a key returns the
original position without re-executing anything.**

The ordering inside `placeHedge` is the whole design:

```
validate key -> load pair -> reject if not confirmed -> price the plan
   -> RESERVE position row under the key   (insertPositionIfAbsent)
   -> if reservation says "already exists": return original, replayed=true, STOP
   -> execute venue legs
   -> success: attach entry (prices, tx hashes)
   -> failure: mark position failed, keep the reservation
```

The reservation happens **before any leg executes**. A retry that races the
original, or arrives after a client timeout, finds the reservation and stops;
the unique constraint on `positions.idempotency_key` makes this hold across
concurrent server instances, not just within one process.

Failure semantics are deliberate: a failed leg execution marks the position
`failed` but *keeps* the key reserved. Replaying the key returns the failed
position for inspection instead of silently re-attempting, because after a
timeout the server cannot know whether the venue half-filled. Automatically
retrying a possibly-half-filled two-leg trade is how you end up with two fills;
surfacing the failed position and letting the caller mint a *new* key after
investigating is the safe contract. The tests pin all of this down with a
counting executor: across timeout-retry and failure-replay flows, `executeLegs`
runs exactly once per key, ever.

Execution is pluggable through one small interface:

```ts
interface LegExecutor {
  mode: "paper" | "live";
  executeLegs(plan, entry): Promise<PositionEntry>;
}
```

**Paper mode** records entry prices and touches nothing external; it exercises
every line of the flow above except the venue calls themselves, which is what
makes the idempotency tests honest. **Live mode** (`createLiveExecutor`) runs the
Polymarket leg first, then approves and sends the Uniswap swap
(SwapRouter02 `exactInputSingle` on Base). The ordering is intentional: the CLOB
order is the harder leg to fill, and failing before the swap leaves nothing
on-chain to unwind. Swap construction (`buildEntrySwap`, sizing plus slippage
floor) is a pure function with hand-computed tests; the transaction sending
around it is thin I/O. The Polymarket leg itself is an injected function, and if
none is configured the executor **fails closed** with an explicit error rather
than executing only the swap, because a half-hedged position is worse than no
position and must never happen silently.

---

## 9. x402: paying per action

x402 revives HTTP 402 Payment Required as a machine-payable flow: respond to an
unpaid request with a challenge describing acceptable payment, let the client pay
on-chain and retry with proof, verify, do the work, settle. It fits this system
unusually well because the buyer is an agent with a wallet, the price is per
action rather than per seat, and the money (USDC on Base) lives on the same rail
as the trades themselves.

Hedgr adapts the flow to MCP, where there is no HTTP status to return: the gate
is a `PaymentGate` interface in front of `place_hedge`, and an unpaid or
invalidly-paid call returns a structured 402-shaped challenge as the tool result
(`{ error: "payment_required", status: 402, accepts: [...] }` with scheme,
network, asset, amount, and receiver). The agent reads the challenge, pays,
and retries the same tool call with `paymentProof` attached.

Two decisions carry the correctness weight:

- **Verify before, settle after.** The proof is verified before any execution,
  but the payment is only captured after the hedge actually executes. A hedge
  that fails costs the agent nothing.
- **Replays are never charged.** Settlement is skipped when the execution was a
  replay of an existing idempotency key, so the payment gate composes with the
  idempotency contract instead of fighting it: retrying a timed-out request
  cannot double-charge any more than it can double-fill.

Verification and settlement delegate to an x402 facilitator over HTTP in
production; a `verifier` function can be injected instead, which is how tests
exercise the full challenge, rejection, settlement, and replay matrix hermetically.
Read tools are deliberately free: agents should explore, simulate, and reason
without friction, and pay only at the moment of execution. The gate defaults to
open unless `HEDGR_X402=1`, keeping paper mode zero-config.

---

## 10. The MCP server

Five tools, mirroring the loop an agent actually runs: *discover, inspect,
simulate, execute, review.*

| tool | role |
|---|---|
| `list_opportunities` | recompute and rank fee-aware hedges across confirmed pairs |
| `get_market` | one normalized market by id, either venue |
| `simulate_hedge` | full payoff matrix, fees, EV, max loss at current prices; read-only |
| `place_hedge` | idempotent, x402-gated execution of both legs |
| `get_position_summary` | all positions with plans, entries, aggregates |

Design choices:

- **`simulate_hedge` and `place_hedge` share one code path** for pricing and plan
  construction (`computeOpportunity`). What the agent simulates is exactly what
  execution would do, enforced by a test asserting simulation output equals
  engine output to ten decimal places. Simulation works on unconfirmed pairs too,
  returning a `tradable: false` flag; agents may *reason* about anything, they
  may *trade* only what review confirmed.
- **Results are pretty-printed JSON in text content.** The consumer is a language
  model; a stable, self-describing JSON body with full scenario breakdowns is the
  most robust interface across MCP clients.
- **Errors are structured tool results** (`isError: true` with a JSON `error`
  message), not protocol exceptions, so an agent can read "pair X has status
  'candidate'; only reviewed, confirmed pairs are tradable" and adapt its plan.
- **The server is a factory**: `createHedgrServer(store, { gate, executor,
  feeModel })`. The stdio entrypoint (`npm run mcp`) is a few lines that pick
  implementations from the environment; tests build the same server over
  `InMemoryTransport` and drive it with a real MCP `Client`, so the full
  protocol round trip (schemas, serialization, error shapes) is covered
  end to end, in-process.

```json
{
  "mcpServers": {
    "hedgr": { "command": "npm", "args": ["run", "mcp"], "cwd": "/path/to/hedgr" }
  }
}
```

---

## 11. The dashboard

The dashboard (`src/app/page.tsx`) is the human audit surface: KPI tiles (open
positions, portfolio EV, worst-case loss, modeled fees), the combined payoff
curve of the top-ranked opportunity, ranked opportunities, and all positions with
live EV recomputed at current prices.

The payoff chart plots combined net payoff against token price at resolution,
**split into two lines by resolution branch** (YES and NO). Within a branch the
Polymarket leg is a constant and the token leg is linear, so the two parallel
lines separated by exactly the payout ($100 per 100 shares) make the hedge's
mechanics visible at a glance: where each branch crosses zero, where the modeled
resolution points (the dots) land, and what fees shift. Curve math lives in
`src/lib/engine/curve.ts` as a pure, tested function; the React component only
draws.

Chart craft follows a deliberate spec: the two series colors were validated for
color-vision-deficiency separation and contrast on the dark surface (not
eyeballed), lines carry identity while all text stays in neutral ink, a legend
plus direct end-labels mean color is never the only channel, the scenario table
under the chart is the accessible data view, and a crosshair tooltip reads both
branches at any price. Everything renders server-side from the store; with no
database configured, a demo seed (curated pairs, plausible prices, two paper
positions) makes the dashboard meaningful out of the box and is overwritten by
real ingestion.

---

## 12. Testing philosophy

48 tests, zero network, zero live database. The rules:

- **Fixtures for adapters.** Raw venue payloads are checked into
  `tests/fixtures/` and normalizers are tested against them, including malformed
  input. A venue API change is a fixture diff, visible in review.
- **The in-memory store for everything stateful.** It implements the same
  contract as Postgres (including idempotent insert semantics), so domain tests
  are fast and hermetic.
- **Hand-computed expected values in engine tests.** Every EV, fee, and payoff
  assertion in `tests/engine.test.ts` and `tests/curve.test.ts` is derived by
  hand in an adjacent comment. Copying the implementation's output into the test
  would make the suite a change detector that blesses whatever the code does;
  hand computation makes it an independent check of the math. The worked example
  (NO x100 @ 0.70, $1,000 long, spot 3500) is cross-checked in three suites:
  the payoff matrix, the ranked opportunity, and the chart curve all must agree.
- **Property-flavored checks where they say more than points.** Scenario
  probabilities sum to 1; a higher divergence prior strictly lowers EV; fees
  reduce EV exactly one-for-one; the NO branch sits exactly one payout above the
  YES branch at every sampled price.
- **Invariants get adversarial tests.** A deliberately mismatched pair must come
  out `flagged`; a candidate pair with attractive numbers must be refused by
  execution and absent from rankings; a replayed key must never run legs twice,
  across success, timeout-retry, and failure-replay paths.
- **The MCP layer is tested through the real protocol**, client to server over
  `InMemoryTransport`, not by calling handlers directly.

---

## 13. The two invariants

Stated once in CLAUDE.md and enforced everywhere:

1. **No auto-trade on unreviewed pairs.** The matching pipeline can only produce
   `candidate` or `flagged`; `confirmed` comes exclusively from human review
   (the curated seed counts as reviewed); execution rejects anything else.
   Enforced in the pipeline's return type, in `confirmPair`, in
   `refreshOpportunities`, and in `placeHedge`.
2. **Idempotency key on all execution.** Paper or live, every request carries a
   caller-supplied key; replay returns the original position and never creates a
   second position or sends a second transaction. Enforced by reservation-before-
   execution and a database unique constraint, and pinned by tests counting
   executor invocations.

Everything else in the system is a design choice; these two are load-bearing
safety properties.

---

## 14. Running it

```bash
npm install
npm test          # 48 tests, no network, no database
npm run dev       # dashboard on :3000, demo data when no SUPABASE_URL
npm run mcp       # MCP server on stdio, paper mode
npm run ingest    # one-shot backfill (needs POLYMARKET_IDS, optionally BASE_RPC_URL)
```

All environment variables are optional; absence of a group means the
corresponding capability stays in its safe default (in-memory, paper, free).

| variable | purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Postgres persistence; apply `supabase/migrations/0001_init.sql` |
| `POLYMARKET_IDS` | comma-separated Gamma market ids for the ingest backfill |
| `BASE_RPC_URL` | Base RPC for quoter reads and live swaps |
| `HEDGR_X402=1` + `X402_PAY_TO`, `X402_PRICE_USDC`, `X402_FACILITATOR_URL` | gate `place_hedge` behind x402 |
| `HEDGR_LIVE=1` + `HEDGR_PRIVATE_KEY`, `HEDGR_SLIPPAGE_BPS` | live execution, trivial size only |

---

## 15. Known gaps and roadmap

Stated plainly, because the framing of this project is honesty about edges:

- **The live Polymarket leg is not implemented.** Real CLOB orders need API
  credentials and EIP-712 order signing via the official client. The executor
  fails closed without it, by design; wiring the official CLOB client into the
  injectable `polymarketLeg` hook is the next live-mode step.
- **Curated Gamma ids are review-time snapshots.** Refresh them against live
  markets before running the backfill; questions and rules in the curated file
  are the reviewed reference text.
- **Divergence priors are judgment, not estimation.** They are reviewed constants
  per pair. A principled upgrade is calibrating them from historical
  oracle-vs-pool basis data, which `price_history` is already accumulating.
- **Matching is curated-first.** Embedding-assisted discovery exists but the
  confirmed set is ten hand-reviewed pairs. That is a feature at this scale
  (ground truth over recall), and general discovery with human review tooling is
  the obvious growth path.
- **Exit is modeled, not managed.** Fees price a round trip, but there is no
  position-close flow yet; positions settle conceptually at resolution.
- **x402 settlement depends on a facilitator** and has been exercised against the
  protocol shape with injected verifiers, not against a production facilitator
  with real USDC.

---

## What this is not

Not financial advice, not a money printer, and not arbitrage. Hedges here have
negative-EV configurations, a real worst case, and a modeled probability that the
venues disagree about reality. The point of the system is that an agent can see
all of that, priced and itemized, before it pays to act.

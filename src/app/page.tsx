import type { Market, Opportunity, Pair, Position } from "@/lib/types";
import { getStore } from "@/lib/store";
import { ensureDemoData } from "@/lib/demo";
import { computeOpportunity, refreshOpportunities } from "@/lib/engine/opportunities";
import { buildPayoffCurve } from "@/lib/engine/curve";
import { outcomePrice } from "@/lib/engine/opportunities";
import PayoffChart from "@/components/PayoffChart";
import StatTile from "@/components/StatTile";

export const dynamic = "force-dynamic";

const usd = (v: number, digits = 2) =>
  `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;

async function loadData() {
  const store = getStore();
  if (!process.env.SUPABASE_URL) await ensureDemoData(store);

  const opportunities = await refreshOpportunities(store);
  const positions = await store.listPositions();
  const pairs = new Map<string, Pair>();
  const markets = new Map<string, Market>();
  for (const pair of await store.listPairs()) pairs.set(pair.id, pair);
  for (const market of await store.listMarkets()) markets.set(market.id, market);

  const positionViews = positions.map((position) => {
    const pair = pairs.get(position.pairId);
    const pm = pair && markets.get(pair.marketAId);
    const uni = pair && markets.get(pair.marketBId);
    let current: Opportunity | null = null;
    if (pair && pm && uni) {
      try {
        current = computeOpportunity(pair, pm, uni, undefined, {
          polymarketShares: position.plan.polymarketShares,
          uniswapNotionalUsd: position.plan.uniswapNotionalUsd,
        });
      } catch {
        current = null;
      }
    }
    return { position, pair, question: pm?.question ?? position.pairId, current };
  });

  const top = opportunities[0];
  let curve = null;
  let topQuestion = "";
  if (top) {
    const pair = pairs.get(top.pairId)!;
    const pm = markets.get(pair.marketAId)!;
    const uni = markets.get(pair.marketBId)!;
    topQuestion = pm.question;
    curve = {
      spot: outcomePrice(uni, "SPOT"),
      data: buildPayoffCurve(
        top.plan,
        pair,
        {
          polymarketPrice: outcomePrice(pm, top.plan.polymarketSide),
          spot: outcomePrice(uni, "SPOT"),
        },
        top.feesUsd,
      ),
      opportunity: top,
    };
  }

  return { opportunities, positionViews, pairs, curve, topQuestion };
}

export default async function Home() {
  const { opportunities, positionViews, curve, topQuestion } = await loadData();

  const open = positionViews.filter((v) => v.position.status === "open");
  const portfolioEv = open.reduce((s, v) => s + (v.current?.evUsd ?? 0), 0);
  const worstCase = open.reduce((s, v) => s + (v.current?.maxLossUsd ?? 0), 0);
  const feesModeled = open.reduce((s, v) => s + (v.current?.feesUsd ?? 0), 0);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-10">
        <h1 className="text-2xl font-semibold tracking-tight">Hedgr</h1>
        <p className="mt-1 text-sm text-[#898781]">
          Cross-venue hedges across Polymarket and Uniswap, scored by expected value
          with a resolution-divergence discount. Driven by agents over MCP.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile
          label="Open positions"
          value={String(open.length)}
          sub={`${open.filter((v) => v.position.mode === "paper").length} paper, ${open.filter((v) => v.position.mode === "live").length} live`}
        />
        <StatTile
          label="Portfolio expected value"
          value={usd(portfolioEv)}
          sub="at current prices, net of fees"
          tone={portfolioEv >= 0 ? "good" : "bad"}
        />
        <StatTile
          label="Worst-case loss"
          value={usd(worstCase)}
          sub="sum of per-position max loss"
          tone="bad"
        />
        <StatTile label="Fees modeled" value={usd(feesModeled)} sub="venue fees plus gas" />
      </section>

      {curve && (
        <section className="mt-10 rounded-lg border border-white/10 bg-[#1a1a19] p-6">
          <h2 className="text-sm font-medium text-[#c3c2b7]">
            Top opportunity payoff
          </h2>
          <p className="mb-4 mt-1 text-xs text-[#898781]">
            {topQuestion} · EV {usd(curve.opportunity.evUsd)} · max loss{" "}
            {usd(curve.opportunity.maxLossUsd)} · combined net payoff by token price
            at resolution
          </p>
          <PayoffChart
            xLabel="token price at resolution (USDC)"
            currentX={curve.spot}
            series={[
              {
                name: "Resolves YES",
                points: curve.data.yes.map((p) => ({ x: p.x, y: p.y })),
              },
              {
                name: "Resolves NO",
                points: curve.data.no.map((p) => ({ x: p.x, y: p.y })),
              },
            ]}
            markers={curve.data.markers.map((m) => ({
              seriesIndex: m.branch === "yes" ? 0 : 1,
              x: m.x,
              y: m.y,
              label: `modeled ${m.branch}`,
            }))}
          />
          <table className="mt-4 w-full text-left text-xs">
            <thead>
              <tr className="text-[#898781]">
                <th className="py-1 font-normal">Scenario</th>
                <th className="py-1 font-normal">Probability</th>
                <th className="py-1 text-right font-normal">Net payoff</th>
              </tr>
            </thead>
            <tbody className="text-[#c3c2b7]">
              {curve.opportunity.scenarios.map((s) => (
                <tr key={s.scenario} className="border-t border-white/5">
                  <td className="py-1.5 capitalize">{s.scenario}</td>
                  <td className="py-1.5 tabular-nums">{(s.probability * 100).toFixed(1)}%</td>
                  <td className="py-1.5 text-right tabular-nums">{usd(s.netUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-medium text-[#c3c2b7]">
          Ranked opportunities
        </h2>
        <div className="overflow-x-auto rounded-lg border border-white/10 bg-[#1a1a19]">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[#898781]">
                <th className="px-4 py-2.5 font-normal">Pair</th>
                <th className="px-4 py-2.5 font-normal">Insurance side</th>
                <th className="px-4 py-2.5 text-right font-normal">EV</th>
                <th className="px-4 py-2.5 text-right font-normal">Max loss</th>
                <th className="px-4 py-2.5 text-right font-normal">Fees</th>
              </tr>
            </thead>
            <tbody className="text-[#c3c2b7]">
              {opportunities.slice(0, 10).map((o) => (
                <tr key={o.id} className="border-t border-white/5">
                  <td className="px-4 py-2">{o.pairId}</td>
                  <td className="px-4 py-2">{o.plan.polymarketSide}</td>
                  <td
                    className="px-4 py-2 text-right tabular-nums"
                    style={{ color: o.evUsd >= 0 ? "#0ca30c" : "#d03b3b" }}
                  >
                    {usd(o.evUsd)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{usd(o.maxLossUsd)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{usd(o.feesUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-medium text-[#c3c2b7]">Positions</h2>
        <div className="overflow-x-auto rounded-lg border border-white/10 bg-[#1a1a19]">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[#898781]">
                <th className="px-4 py-2.5 font-normal">Market</th>
                <th className="px-4 py-2.5 font-normal">Mode</th>
                <th className="px-4 py-2.5 font-normal">Status</th>
                <th className="px-4 py-2.5 font-normal">Plan</th>
                <th className="px-4 py-2.5 text-right font-normal">Entry</th>
                <th className="px-4 py-2.5 text-right font-normal">EV now</th>
              </tr>
            </thead>
            <tbody className="text-[#c3c2b7]">
              {positionViews.map(({ position, question, current }) => (
                <tr key={position.id} className="border-t border-white/5">
                  <td className="max-w-64 truncate px-4 py-2">{question}</td>
                  <td className="px-4 py-2">{position.mode}</td>
                  <td className="px-4 py-2">{position.status}</td>
                  <td className="px-4 py-2">
                    {position.plan.polymarketSide} x{position.plan.polymarketShares}, long{" "}
                    {usd(position.plan.uniswapNotionalUsd, 0)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {position.entry
                      ? `${position.entry.polymarketPrice.toFixed(2)} / ${usd(position.entry.uniswapPrice, 0)}`
                      : "-"}
                  </td>
                  <td
                    className="px-4 py-2 text-right tabular-nums"
                    style={{
                      color:
                        current == null
                          ? undefined
                          : current.evUsd >= 0
                            ? "#0ca30c"
                            : "#d03b3b",
                    }}
                  >
                    {current ? usd(current.evUsd) : "-"}
                  </td>
                </tr>
              ))}
              {positionViews.length === 0 && (
                <tr>
                  <td className="px-4 py-3 text-[#898781]" colSpan={6}>
                    No positions yet. Drive one through the MCP server.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="mt-12 text-xs text-[#898781]">
        Hedges are resolution-correlated with EV scoring, not risk-free arbitrage.
        Divergence risk is priced in, not eliminated.
      </footer>
    </main>
  );
}

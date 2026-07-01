"use client";

import { useMemo, useRef, useState } from "react";

/** Dark-mode chart tokens (reference palette, dark column). */
const SURFACE = "#1a1a19";
const SECONDARY = "#c3c2b7";
const MUTED = "#898781";
const GRID = "#2c2c2a";
const BASELINE = "#383835";
/** Categorical slots 1 and 2 (dark), validated: CVD dE 69.8, contrast >= 3:1. */
const SERIES = ["#3987e5", "#199e70"];

export interface ChartSeries {
  name: string;
  points: { x: number; y: number }[];
}

export interface ChartMarker {
  seriesIndex: number;
  x: number;
  y: number;
  label: string;
}

interface Props {
  series: ChartSeries[];
  markers: ChartMarker[];
  xLabel: string;
  currentX?: number;
}

const W = 760;
const H = 340;
const PAD = { top: 18, right: 132, bottom: 40, left: 64 };

const usd = (v: number) =>
  `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function ticks(min: number, max: number, count: number): number[] {
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let t = start; t <= max; t += step) out.push(t);
  return out;
}

export default function PayoffChart({ series, markers, xLabel, currentX }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { xMin, xMax, yMin, yMax } = useMemo(() => {
    const xs = series.flatMap((s) => s.points.map((p) => p.x));
    const ys = series.flatMap((s) => s.points.map((p) => p.y));
    const yPad = (Math.max(...ys) - Math.min(...ys)) * 0.1;
    return {
      xMin: Math.min(...xs),
      xMax: Math.max(...xs),
      yMin: Math.min(...ys, 0) - yPad,
      yMax: Math.max(...ys, 0) + yPad,
    };
  }, [series]);

  const sx = (x: number) =>
    PAD.left + ((x - xMin) / (xMax - xMin)) * (W - PAD.left - PAD.right);
  const sy = (y: number) =>
    PAD.top + (1 - (y - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const n = series[0].points.length;
    const frac = (px - PAD.left) / (W - PAD.left - PAD.right);
    const idx = Math.round(frac * (n - 1));
    setHoverIdx(idx >= 0 && idx < n ? idx : null);
  };

  const hover = hoverIdx != null ? series[0].points[hoverIdx].x : null;

  return (
    <div className="relative">
      <div className="mb-3 flex gap-5 text-xs" style={{ color: SECONDARY }}>
        {series.map((s, i) => (
          <span key={s.name} className="inline-flex items-center gap-2">
            <span
              className="inline-block h-[3px] w-4 rounded-full"
              style={{ background: SERIES[i] }}
            />
            {s.name}
          </span>
        ))}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Combined hedge payoff versus ${xLabel}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {ticks(yMin, yMax, 5).map((t) => (
          <g key={`y${t}`}>
            <line x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)} stroke={GRID} strokeWidth={1} />
            <text
              x={PAD.left - 8}
              y={sy(t) + 3.5}
              textAnchor="end"
              fontSize={11}
              fill={MUTED}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {usd(t)}
            </text>
          </g>
        ))}
        {ticks(xMin, xMax, 6).map((t) => (
          <text
            key={`x${t}`}
            x={sx(t)}
            y={H - PAD.bottom + 18}
            textAnchor="middle"
            fontSize={11}
            fill={MUTED}
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {usd(t)}
          </text>
        ))}
        <text x={(PAD.left + W - PAD.right) / 2} y={H - 4} textAnchor="middle" fontSize={11} fill={MUTED}>
          {xLabel}
        </text>

        {/* Zero payoff baseline */}
        <line x1={PAD.left} x2={W - PAD.right} y1={sy(0)} y2={sy(0)} stroke={BASELINE} strokeWidth={1.5} />

        {/* Entry spot reference */}
        {currentX != null && (
          <g>
            <line x1={sx(currentX)} x2={sx(currentX)} y1={PAD.top} y2={H - PAD.bottom} stroke={BASELINE} strokeWidth={1} />
            <text x={sx(currentX)} y={PAD.top - 5} textAnchor="middle" fontSize={10} fill={MUTED}>
              entry spot
            </text>
          </g>
        )}

        {series.map((s, i) => (
          <path
            key={s.name}
            d={s.points.map((p, j) => `${j === 0 ? "M" : "L"}${sx(p.x)},${sy(p.y)}`).join(" ")}
            fill="none"
            stroke={SERIES[i]}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* Direct end labels, text tokens with the line carrying identity */}
        {series.map((s, i) => {
          const last = s.points[s.points.length - 1];
          return (
            <text
              key={`lbl-${s.name}`}
              x={sx(last.x) + 8}
              y={sy(last.y) + 4}
              fontSize={11}
              fill={SECONDARY}
            >
              {s.name}
            </text>
          );
        })}

        {/* Modeled resolution markers: >=8px with a 2px surface ring */}
        {markers.map((m) => (
          <circle
            key={m.label}
            cx={sx(m.x)}
            cy={sy(m.y)}
            r={4.5}
            fill={SERIES[m.seriesIndex]}
            stroke={SURFACE}
            strokeWidth={2}
          />
        ))}

        {hover != null && hoverIdx != null && (
          <g pointerEvents="none">
            <line x1={sx(hover)} x2={sx(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke={MUTED} strokeWidth={1} />
            {series.map((s, i) => (
              <circle
                key={`h${i}`}
                cx={sx(s.points[hoverIdx].x)}
                cy={sy(s.points[hoverIdx].y)}
                r={4}
                fill={SERIES[i]}
                stroke={SURFACE}
                strokeWidth={2}
              />
            ))}
          </g>
        )}
      </svg>

      {hover != null && hoverIdx != null && (
        <div
          className="pointer-events-none absolute rounded-md border px-3 py-2 text-xs shadow-lg"
          style={{
            left: `${(sx(hover) / W) * 100}%`,
            top: 24,
            transform: sx(hover) > W * 0.62 ? "translateX(-108%)" : "translateX(12px)",
            background: "#222220",
            borderColor: "rgba(255,255,255,0.10)",
            color: SECONDARY,
          }}
        >
          <div style={{ color: MUTED }}>token at {usd(hover)}</div>
          {series.map((s, i) => (
            <div key={s.name} className="mt-1 flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: SERIES[i] }} />
              <span>{s.name}</span>
              <span className="ml-auto pl-3" style={{ fontVariantNumeric: "tabular-nums" }}>
                {usd(s.points[hoverIdx].y)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const GOOD = "#0ca30c";
const CRITICAL = "#d03b3b";

interface Props {
  label: string;
  value: string;
  sub?: string;
  /** Colors the value by direction when the tile carries a signed quantity. */
  tone?: "good" | "bad" | "neutral";
}

export default function StatTile({ label, value, sub, tone = "neutral" }: Props) {
  const color =
    tone === "good" ? GOOD : tone === "bad" ? CRITICAL : "var(--foreground)";
  return (
    <div className="rounded-lg border border-white/10 bg-[#1a1a19] px-5 py-4">
      <div className="text-xs text-[#898781]">{label}</div>
      <div className="mt-1 text-2xl font-semibold" style={{ color }}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-[#898781]">{sub}</div>}
    </div>
  );
}

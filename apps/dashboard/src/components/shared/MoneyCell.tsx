import { formatUsdFromMills } from "@/lib/format";

export function MoneyCell({ mills }: { mills: number | bigint | null | undefined }) {
  if (mills == null) return <span className="text-zinc-500">--</span>;
  const n = typeof mills === "bigint" ? Number(mills) : mills;
  const formatted = formatUsdFromMills(n);
  return (
    <span className={n < 0 ? "text-red-400" : "text-zinc-100"} title={`${n} mills`}>
      {formatted}
    </span>
  );
}

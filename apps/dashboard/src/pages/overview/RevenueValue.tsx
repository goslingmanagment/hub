import { signedMoney } from "./presentation.js";

export function RevenueDelta({
  deltaNetMills,
  deltaPct,
}: {
  deltaNetMills?: number | null | undefined;
  deltaPct?: number | null | undefined;
}) {
  return (
    <span
      className={`v1-delta ${deltaNetMills == null || deltaNetMills === 0 ? "v1-delta-flat" : deltaNetMills < 0 ? "v1-delta-down" : "v1-delta-up"}`}
    >
      {deltaNetMills == null ? "—" : signedMoney(deltaNetMills)}
      <span className="v1-delta-pct">
        {deltaNetMills == null
          ? "нет сравнения"
          : deltaPct == null
            ? "нет базы"
            : `${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(1)}%`}
      </span>
    </span>
  );
}

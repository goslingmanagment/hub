import { useState } from "react";
import { readOfapiVendorUsage } from "@/api/ofapiVendor";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { DisclosureCard } from "@/components/ui/DisclosureCard";
import { formatDateTime } from "@/lib/format";
import { OFAPI_OFF_REASON, OFAPI_UNKNOWN_REASON, type OfapiStatus } from "@/lib/statusWords";
import { credits, fmtCredits } from "./OfapiCostsParts.js";

type Report = Awaited<ReturnType<typeof readOfapiVendorUsage>>;

const VISIBILITY: Readonly<Record<string, string>> = {
  unknown: "неизвестна",
  declared_restricted: "ограниченные аккаунты",
  declared_team: "вся команда (подтверждено владельцем)",
};

/**
 * «Сверка с поставщиком»: the first half of the old evidence card, the free report
 * of closed days. The same request and the same window check; off while the API is
 * off or its state is unknown. The key's rights went to Система → OnlyFans API.
 */
export function OfapiVendorReconcile({ ofapi }: { ofapi: OfapiStatus }) {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(yesterday);
  const [to, setTo] = useState(yesterday);
  const [report, setReport] = useState<Report | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const windowDays = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  const invalidWindow = !from || !to || !Number.isFinite(windowDays) || windowDays < 0 || windowDays >= 366 || to > yesterday;
  const blocked = ofapi === "off" ? OFAPI_OFF_REASON : ofapi === "unknown" ? OFAPI_UNKNOWN_REASON : null;

  const run = async () => {
    setPending(true);
    setError(null);
    try {
      setReport(await readOfapiVendorUsage({ from, to, groupBy: "day", accountId: null, includeToday: false }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось прочитать отчёт");
    } finally {
      setPending(false);
    }
  };

  return (
    <DisclosureCard title="Сверка с поставщиком">
      <div className="card-body space-y-4">
        <p className="text-text-secondary">
          Запрос отчёта бесплатный. Суммы поставщика и Hub показаны отдельно; неизвестная область ключа не означает всю команду.
        </p>
        <fieldset disabled={blocked !== null || pending} className="tx-filters">
          <label className="tx-field">
            <span className="field-label">С</span>
            <input aria-label="Сверка с даты" className="input w-auto" type="date" value={from} max={yesterday} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="tx-field">
            <span className="field-label">По</span>
            <input aria-label="Сверка по дату" className="input w-auto" type="date" value={to} max={yesterday} onChange={(event) => setTo(event.target.value)} />
          </label>
          <button type="button" className="btn" disabled={invalidWindow} onClick={() => void run()}>
            {pending ? "Сверяем…" : "Сверить закрытые дни, бесплатно"}
          </button>
          {blocked && <span className="ofc-note pb-2">{blocked}</span>}
        </fieldset>
        {blocked === null && invalidWindow && <p className="ai-warn text-sm">Выберите от 1 до 366 закрытых дней; начало не может быть позже конца.</p>}
        {error && <p className="ai-warn text-sm" role="alert">{error}</p>}
        {report && (
          <div className="space-y-4">
            <StatGrid>
              <Stat label="OnlyFans API" value={credits(report.vendor.totals.credits)} />
              <Stat label="Hub" value={credits(report.local.recordedCredits)} meta={`из них оценочные: ${fmtCredits(report.local.estimatedCredits)}`} />
              <Stat label="Разница" value={credits(report.difference)} meta={`остаток сверки баланса: ${fmtCredits(report.local.externalResidualCredits)}`} />
            </StatGrid>
            <p className="text-sm text-text-secondary">
              Период отчёта: {report.vendor.from} — {report.vendor.to}, сутки по UTC. Область: {VISIBILITY[report.visibility] ?? report.visibility}.
              Совпадение исторической области ключа не доказано; разница сама по себе не подтверждает потерю расходов.
              Отчёт получен {formatDateTime(report.observedAt)}.
            </p>
            <div className="ai-cut">
              <table className="data-table data-table-dense" aria-label="Расходы по данным поставщика">
                <thead><tr><th scope="col">Дата</th><th scope="col">Тип</th><th scope="col" className="num">Кредиты</th><th scope="col" className="num">Запросы</th></tr></thead>
                <tbody>
                  {report.vendor.results.map((row, index) => (
                    <tr key={`${row.day}-${row.creditType}-${index}`}>
                      <td>{row.day ?? "Без даты"}</td>
                      <td className="muted">{row.creditType ?? "Не указан"}</td>
                      <td className="num">{fmtCredits(row.credits)}</td>
                      <td className="num">{fmtCredits(row.requests)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </DisclosureCard>
  );
}

import { Link, useLocation, useSearchParams } from "react-router";
import { CHATTER_SHIFT_END_IDLE_MINUTES, CHATTER_SHIFT_MIN_MESSAGES, CHATTER_SHIFT_MIN_WORKED_MINUTES } from "@agency_hub_core/contracts";
import { useAdminAiSpend } from "@/api/adminAiSpend";
import { useAdminChatterUsage } from "@/api/adminUsage";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { AnchorNav } from "@/components/ui/PeriodStepper";
import { Segmented } from "@/components/ui/Segmented";
import { formatDayRange, formatDuration, usageRange, type UsagePeriod } from "@/lib/format";
import { AiDetails, AiUnitPrices } from "./AiDetails.js";
import { AiMoneyBlock } from "./AiMoneyBlock.js";
import { AiPeopleBlock } from "./AiPeopleBlock.js";
import { AiPeriodBlock } from "./AiPeriodBlock.js";
import { anchorOf, todayMoscow, usagePeriodOf } from "./aiShared.js";

const MODES: ReadonlyArray<{ value: UsagePeriod; label: string }> = [
  { value: "day", label: "День" },
  { value: "week", label: "Неделя" },
  { value: "month", label: "Месяц" },
];

/**
 * Деньги → Расходы → ИИ: how much money for AI is left, how much went, on what
 * and by whom. The period is the screen's own (`?period=`, `?at=`), Moscow days.
 * Writes live only in «Деньги на ИИ», each with its row's account as the target.
 */
export function AiCostsPage() {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const today = todayMoscow();
  const mode = usagePeriodOf(search.get("period"));
  const anchor = anchorOf(search.get("at"), today);
  const range = usageRange(anchor, mode);
  const spend = useAdminAiSpend(range);
  const usage = useAdminChatterUsage(range);
  const data = spend.data;

  function go(next: { period?: UsagePeriod; at?: string }) {
    const query = new URLSearchParams(search);
    const period = next.period ?? mode;
    const at = next.at ?? anchor;
    if (period === "week") query.delete("period");
    else query.set("period", period);
    if (at === today) query.delete("at");
    else query.set("at", at);
    setSearch(query, { state: location.state });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={(
          <>
            <AnchorNav anchor={anchor} mode={mode} today={today} onChange={(at) => go({ at })} />
            <Segmented label="Период" value={mode} onChange={(period) => go({ period })} options={MODES} />
          </>
        )}
        window={`${formatDayRange(range.from, range.to)}, дни по Москве`}
        fresh={data ? { at: data.generatedAt, refreshing: spend.isFetching, onRefresh: () => void Promise.all([spend.refetch(), usage.refetch()]) } : undefined}
      />
      <AiMoneyBlock />
      {data && <QueryNotice error={spend.isError} stale retry={spend.refetch} at={spend.dataUpdatedAt} />}
      {!data && spend.isError ? (
        <NoAnswerPanel retry={spend.refetch} />
      ) : !data ? (
        <div role="status" className="space-y-6">
          <span className="sr-only">Загружаем траты…</span>
          <StatCardSkeleton count={4} />
          <div className="card"><TableSkeleton rows={4} columns={7} /></div>
        </div>
      ) : (
        <div className={spend.isPlaceholderData ? "is-refreshing space-y-6" : "space-y-6"}>
          <AiPeriodBlock data={data} mode={mode} onShowMonth={() => go({ period: "month" })} />
          {/* A change of the period folds the people's rows, as before. */}
          <AiPeopleBlock key={`${range.from}-${range.to}`} data={data} range={range} />
          <AiUnitPrices features={data.features} />
        </div>
      )}
      <div className="help-row">
      {data && <AiDetails data={data} usage={usage.data} />}
      <Disclosure>
        <p>
          Цена каждого вызова — расчёт Hub по токенам и прайсу Anthropic, включая ошибки и отмены: Anthropic берёт деньги и
          за них. Сверка с настоящим счётом — на вкладке <Link className="link" to="/money/costs/anthropic">«Сверка с Anthropic»</Link>.
        </p>
        <p>
          «По кнопке чаттера» — запрос из расширения. «Сам Hub» — факты из переписки и описания картинок. «Отправленное
          сообщение» — все траты функции, делённые на сообщения, ушедшие фанам из её ответов. Перегенерации — доля
          ответов, которые сгенерировали заново; больше 30 % отмечается как «много». Часы работы — смены: от{" "}
          {formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений, заканчиваются после{" "}
          {formatDuration(CHATTER_SHIFT_END_IDLE_MINUTES)} без действий; заходы не считаются. Дни по Москве.
        </p>
        <p>
          Голосовые: пока они включены, Hub каждые полчаса смотрит аккаунт ElevenLabs и пишет в Telegram, если ключ не
          принят, подписка не активна или символы на исходе.
        </p>
      </Disclosure>
      </div>
    </div>
  );
}

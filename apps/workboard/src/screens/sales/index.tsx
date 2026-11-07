import { useLocation, useParams } from "react-router";
import { Tabs } from "@agency_hub_core/ui";
import { carryParams } from "@/shared/links";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { ScreenStub } from "@/shared/ScreenStub";

const TABS = [
  { tab: "price", label: "Цена" },
  { tab: "speed", label: "Скорость ответа" },
  { tab: "win-back", label: "Возврат фанов" },
  { tab: "greetings", label: "Приветствия и охват" },
] as const;

/** Что продаёт (spec §4.5): prices, reply speed, win-back, greetings — by page or by chatter. */
export function SalesScreen() {
  const { tab } = useParams();
  const location = useLocation();
  const search = carryParams(location.search).toString();
  const current = TABS.find((item) => item.tab === tab) ?? TABS[0];
  return (
    <>
      <ScreenHeader
        title="Что продаёт"
        period
        pageFilter
        tabs={<Tabs label="Разделы" items={TABS.map((item) => ({ to: { pathname: `/sales/${item.tab}`, search: search ? `?${search}` : "" }, label: item.label }))} />}
      />
      <div className="wb-content">
        <ScreenStub title={current.label}>
          Какие цены, скорость ответа, подходы возврата и приветствия работают — по страницам или по чаттерам.
        </ScreenStub>
      </div>
    </>
  );
}

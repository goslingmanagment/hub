import { useLocation, useParams } from "react-router";
import { Tabs } from "@agency_hub_core/ui";
import { personPath, useBackTarget, type PersonTab } from "@/shared/links";
import { PersonAccessPanel } from "@/shared/PersonAccessPanel";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { ScreenStub } from "@/shared/ScreenStub";
import { useMe } from "@/shared/useMe";

/** Люди (spec §4.3): every chatter side by side for the period. */
export function PeopleScreen() {
  return (
    <>
      <ScreenHeader title="Люди" period pageFilter />
      <div className="wb-content">
        <ScreenStub title="Люди">
          Все чаттеры за период рядом: статус, продажи и изменение, в час, скорость ответа, ответы без ответа, доля ИИ. Строка открывает человека.
        </ScreenStub>
      </div>
    </>
  );
}

const TABS: readonly { tab: PersonTab; label: string }[] = [
  { tab: "work", label: "Работа" },
  { tab: "shifts", label: "Смены" },
  { tab: "sales", label: "Продажи" },
  { tab: "access", label: "Доступ" },
];

/** Человек `/people/:userId` (spec §4.4): Работа · Смены · Продажи · Доступ. */
export function PersonScreen() {
  const { userId, tab } = useParams();
  const { isOwner } = useMe();
  const location = useLocation();
  const id = Number(userId);
  const current = (TABS.find((item) => item.tab === tab)?.tab ?? "work");
  const back = useBackTarget({ to: "/people", label: "Люди" });
  return (
    <>
      <ScreenHeader
        title={`Человек ${userId ?? ""}`}
        back={back}
        period={current !== "access"}
        pageFilter={current !== "access"}
        tabs={(
          <Tabs
            label="Разделы карточки"
            items={TABS.filter((item) => item.tab !== "access" || isOwner).map((item) => ({
              to: personPath(id, location.search, item.tab),
              label: item.label,
              end: true,
            }))}
          />
        )}
      />
      <div className="wb-content">
        {current === "access" ? (
          <PersonAccessPanel userId={id} variant="page" />
        ) : (
          <ScreenStub title={TABS.find((item) => item.tab === current)?.label ?? "Работа"}>
            Вердикт за период, лента смен по часам и таблица смен, каждая строка открывает разбор.
          </ScreenStub>
        )}
      </div>
    </>
  );
}

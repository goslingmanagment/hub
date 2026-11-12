import { EmptyState, LinkButton } from "@agency_hub_core/ui";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { homePath, useMe } from "@/shared/useMe";

export function NotFoundScreen() {
  const { role } = useMe();
  const chatter = role === "chatter";
  return (
    <>
      <ScreenHeader title="Такого экрана нет" />
      <div className="wb-content">
        <EmptyState title="Адрес не ведёт ни к одному экрану" action={<LinkButton to={homePath(role)}>{chatter ? "К моим отчётам" : "К сменам"}</LinkButton>}>
          {chatter ? "Возможно, ссылка устарела. Ваши отчёты в меню." : "Возможно, ссылка устарела. Смены, люди и решения — в меню слева."}
        </EmptyState>
      </div>
    </>
  );
}

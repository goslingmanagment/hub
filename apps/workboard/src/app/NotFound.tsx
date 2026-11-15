import { EmptyState, LinkButton } from "@agency_hub_core/ui";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { homePath } from "@/shared/useMe";

export function NotFoundScreen() {
  return (
    <>
      <ScreenHeader title="Такого экрана нет" />
      <div className="wb-content">
        <EmptyState title="Адрес не ведёт ни к одному экрану" action={<LinkButton to={homePath()}>Сегодня</LinkButton>}>
          Возможно, ссылка устарела. Все экраны в меню.
        </EmptyState>
      </div>
    </>
  );
}

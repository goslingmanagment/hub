import { EmptyState, LinkButton } from "@agency_hub_core/ui";
import { ScreenHeader } from "@/shared/ScreenHeader";

export function NotFoundScreen() {
  return (
    <>
      <ScreenHeader title="Такого экрана нет" />
      <div className="wb-content">
        <EmptyState title="Адрес не ведёт ни к одному экрану" action={<LinkButton to="/shifts">К сменам</LinkButton>}>
          Возможно, ссылка устарела. Смены, люди и решения — в меню слева.
        </EmptyState>
      </div>
    </>
  );
}

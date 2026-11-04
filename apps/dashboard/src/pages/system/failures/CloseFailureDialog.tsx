import type { NotificationsIncidentItem } from "@agency_hub_core/contracts";
import { toast } from "sonner";
import { useResolveIncident } from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { formatDateTime } from "@/lib/format";
import { failureKindLabel } from "@/lib/failures";

/**
 * «Закрыть сбой» asks first (added, design/screens/system.md §4, block 4): closing
 * sends a message to the Telegram chat of alerts. The request is the one it was:
 * `notificationsResolveIncident` with the row's own id, one attempt.
 */
export function CloseFailureDialog({ item, onDone }: {
  item: NotificationsIncidentItem;
  /** `true`: the failure was closed. */
  onDone: (closed: boolean) => void;
}) {
  const resolveIncident = useResolveIncident();
  const title = failureKindLabel(item.kind);
  const where = item.pageLabel === null ? "" : `, ${item.pageLabel}`;
  return (
    <ConfirmModal
      title={item.pageLabel === null ? `Закрыть сбой «${title}»?` : `Закрыть сбой «${title}» на ${item.pageLabel}?`}
      message="Сбой уйдёт из открытых."
      facts={[
        { label: "Что именно", value: `${title}${where}, открыт ${formatDateTime(item.openedAt, { yearUnlessCurrent: true })}` },
        { label: "Куда", value: "в чат оповещений Telegram уйдёт сообщение о закрытии" },
        { label: "Отменить", value: "нельзя. Если причина осталась, Hub откроет сбой снова" },
      ]}
      confirmLabel="Закрыть сбой"
      pendingLabel="Закрываем…"
      tone="primary"
      isPending={resolveIncident.isPending}
      onConfirm={() => {
        resolveIncident.mutate(item.id, {
          onSuccess: () => {
            toast.success(`Сбой закрыт: ${title}${where}.`);
            onDone(true);
          },
          onError: () => {
            toast.error("Не удалось закрыть сбой: Hub не ответил. Список обновится сам.");
            onDone(false);
          },
        });
      }}
      onClose={() => onDone(false)}
    />
  );
}

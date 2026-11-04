import { toast } from "sonner";
import type { AdminAiPersona } from "@agency_hub_core/contracts";
import { useAdminArchiveAiPersona } from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { isConflict, isUnknownOutcome, UNKNOWN_OUTCOME } from "../settingsFeedback.js";

/**
 * «В архив», the same on the list and on the persona: the version the row was
 * read with goes as `expectedVersion`, the target is the row's or the path's key.
 */
export function ArchivePersonaConfirm({ persona, onClose, onArchived }: {
  persona: AdminAiPersona;
  onClose: () => void;
  onArchived?: () => void;
}) {
  const archive = useAdminArchiveAiPersona(persona.key);

  async function handleConfirm() {
    try {
      await archive.mutateAsync(persona.version);
      toast.success("Персона в архиве");
      onClose();
      onArchived?.();
    } catch {
      // The refusal stays in the window.
    }
  }

  const error = archive.error
    ? isConflict(archive.error)
      ? "Персону успели изменить в другом окне. Список обновлён, откройте её снова."
      : isUnknownOutcome(archive.error)
        ? `${UNKNOWN_OUTCOME} Обновите список и проверьте.`
        : "Не удалось убрать персону в архив."
    : undefined;

  return (
    <ConfirmModal
      title={`Убрать «${persona.displayName}» в архив?`}
      message="Персона останется в списке как архивная, но чаттеры больше не смогут её выбрать."
      facts={[{ label: "Отменить", value: "Нельзя: вернуть персону из архива в консоли пока нельзя" }]}
      confirmLabel="В архив"
      pendingLabel="Убираем…"
      initialFocus="cancel"
      error={error}
      isPending={archive.isPending}
      onConfirm={() => void handleConfirm()}
      onClose={onClose}
    />
  );
}

import { toast } from "sonner";
import type { AssignedPage, ModelListItem } from "@agency_hub_core/contracts";
import { useAdminDeleteModel, useAdminDeletePage, useDeletePageBrowserDraft } from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { UNKNOWN_OUTCOME, isUnknownOutcome } from "../settingsFeedback.js";
import { PLATFORM_NAMES } from "./pagesView.js";

/** A write's refusal in the window's words; no answer means the outcome is unknown. */
function writeError(error: unknown, known: string): string | undefined {
  if (!error) return undefined;
  return isUnknownOutcome(error) ? `${UNKNOWN_OUTCOME} Обновите экран и проверьте.` : known;
}

/** «Удалить модель»: only a model without pages; the target is the row's model. */
export function DeleteModelConfirm({ model, onClose }: { model: ModelListItem; onClose: () => void }) {
  const deleteModel = useAdminDeleteModel(model.slug);

  async function handleConfirm() {
    try {
      await deleteModel.mutateAsync();
      toast.success("Модель удалена");
      onClose();
    } catch {
      // The error stays in the window: one place, one button left.
    }
  }

  return (
    <ConfirmModal
      title={`Удалить модель «${model.name}»?`}
      message="Модель исчезнет из списка."
      facts={[{ label: "Отменить", value: "Нельзя" }]}
      confirmLabel="Удалить модель"
      pendingLabel="Удаляем…"
      initialFocus="cancel"
      error={writeError(deleteModel.error, "Не удалось удалить модель. Модель осталась в списке.")}
      isPending={deleteModel.isPending}
      onConfirm={() => void handleConfirm()}
      onClose={onClose}
    />
  );
}

/** «Отключить страницу»: the server marks it deleted, its history stays. */
export function DeletePageConfirm({ page, workers, onClose }: { page: AssignedPage; workers: readonly string[] | null; onClose: () => void }) {
  const deletePage = useAdminDeletePage(page.label);

  async function handleConfirm() {
    try {
      await deletePage.mutateAsync();
      toast.success(`${page.label} отключена, история сохранена`);
      onClose();
    } catch {
      // The error stays in the window.
    }
  }

  return (
    <ConfirmModal
      title={`Отключить страницу ${page.label}?`}
      message="Страница пропадёт из активных, сбор данных остановится. Собранная история сохранится."
      facts={[
        { label: "Откуда", value: `${page.label}, ${PLATFORM_NAMES[page.platform] ?? page.platform}, модель ${page.modelName}` },
        { label: "Кто работает", value: workers === null ? "Не удалось проверить" : workers.length === 0 ? "Никто" : workers.join(", ") },
        { label: "Отменить", value: "Нельзя: включить страницу обратно из консоли пока нельзя" },
      ]}
      confirmLabel={`Отключить ${page.label}`}
      pendingLabel="Отключаем…"
      initialFocus="cancel"
      error={writeError(deletePage.error, "Не удалось отключить страницу. Она осталась активной.")}
      isPending={deletePage.isPending}
      onConfirm={() => void handleConfirm()}
      onClose={onClose}
    />
  );
}

/** «Удалить черновик» (added: it used to go without a question and without an error). */
export function DeleteDraftConfirm({ name, onClose }: { name: string; onClose: () => void }) {
  const remove = useDeletePageBrowserDraft();

  function handleConfirm() {
    remove.mutate(name, {
      onSuccess: () => {
        toast.success(`Черновик ${name} удалён`);
        onClose();
      },

    });
  }

  return (
    <ConfirmModal
      title={`Удалить черновик ${name}?`}
      message="Проверенный прокси и окружение из черновика будут стёрты."
      facts={[{ label: "Отменить", value: "Нельзя: подключение придётся начать заново" }]}
      confirmLabel="Удалить черновик"
      pendingLabel="Удаляем…"
      initialFocus="cancel"
      error={writeError(remove.error, `Не удалось удалить черновик ${name}.`)}
      isPending={remove.isPending}
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}

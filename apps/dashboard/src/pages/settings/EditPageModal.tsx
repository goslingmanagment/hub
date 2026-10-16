import { useState } from "react";
import type { AssignedPage, ModelListItem, UpdatePageBody } from "@agency_hub_core/contracts";
import { useAdminUpdatePage } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { toast } from "sonner";

export function EditPageModal({
  page,
  models,
  onClose,
}: {
  page: AssignedPage;
  models: ModelListItem[];
  onClose: () => void;
}) {
  const updatePage = useAdminUpdatePage(page.label);
  const [label, setLabel] = useState(page.label);
  const [modelSlug, setModelSlug] = useState(page.modelSlug);

  async function handleSubmit() {
    const body: UpdatePageBody = {};
    if (label.trim() !== page.label) body.label = label.trim();
    if (modelSlug !== page.modelSlug) body.modelSlug = modelSlug;

    if (!body.label && !body.modelSlug) {
      onClose();
      return;
    }

    try {
      await updatePage.mutateAsync(body);
      toast.success("Страница сохранена");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сохранить страницу");
    }
  }

  return (
    <ModalShell title={`Изменить страницу ${page.label}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-sm text-text-secondary">
          <PlatformBadge platform={page.platform} />
          Платформу страницы изменить нельзя.
        </p>
        <Field label="Название страницы">
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="input"
          />
        </Field>
        <Field label="Модель">
          <select
            value={modelSlug}
            onChange={(event) => setModelSlug(event.target.value)}
            className="select"
          >
            {models.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className="btn">
          Отмена
        </button>
        <button
          type="button"
          disabled={updatePage.isPending || !label.trim()}
          onClick={handleSubmit}
          className="btn btn-primary"
        >
          {updatePage.isPending ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
    </ModalShell>
  );
}

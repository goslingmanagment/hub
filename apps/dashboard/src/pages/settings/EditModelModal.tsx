import { useState } from "react";
import type { ModelListItem, UpdateModelBody } from "@agency_hub_core/contracts";
import { useAdminUpdateModel } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { toast } from "sonner";

export function EditModelModal({
  model,
  onClose,
}: {
  model: ModelListItem;
  onClose: () => void;
}) {
  const updateModel = useAdminUpdateModel(model.slug);
  const [slug, setSlug] = useState(model.slug);
  const [name, setName] = useState(model.name);

  async function handleSubmit() {
    const body: UpdateModelBody = {};
    if (slug.trim() !== model.slug) body.slug = slug.trim();
    if (name.trim() !== model.name) body.name = name.trim();

    if (!body.slug && !body.name) {
      onClose();
      return;
    }

    try {
      await updateModel.mutateAsync(body);
      toast.success("Модель сохранена");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сохранить модель");
    }
  }

  return (
    <ModalShell title={`Изменить модель «${model.name}»`} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Имя модели">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            className="input"
          />
        </Field>
        <Field label="Короткое имя" hint="Внутреннее имя модели в Hub. Обычно его не меняют.">
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="input"
          />
        </Field>
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className="btn">
          Отмена
        </button>
        <button
          type="button"
          disabled={updateModel.isPending || !slug.trim() || !name.trim()}
          onClick={handleSubmit}
          className="btn btn-primary"
        >
          {updateModel.isPending ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
    </ModalShell>
  );
}

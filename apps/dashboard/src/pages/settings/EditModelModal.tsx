import { useState } from "react";
import type { ModelListItem, UpdateModelBody } from "@agency_hub_core/contracts";
import { useAdminUpdateModel } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { Disclosure } from "@/components/ui/Disclosure";
import { toast } from "sonner";
import { isConflict, toastWriteError } from "./settingsFeedback.js";

/**
 * «Переименовать модель»: the name in front, the short name folded under
 * «Подробнее», away from the harmless field. The body holds only what changed;
 * nothing changed, nothing is sent. The target is the row's model.
 */
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
  const [conflict, setConflict] = useState(false);

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
      if (isConflict(error)) setConflict(true);
      else toastWriteError(error, "Не удалось сохранить модель");
    }
  }

  return (
    <ModalShell title={`Переименовать модель «${model.name}»`} onClose={() => { if (!updateModel.isPending) onClose(); }}>
      <div className="space-y-4">
        <Field label="Имя модели">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            className="input"
          />
        </Field>
        <Disclosure label="Подробнее" open={conflict || slug !== model.slug ? true : undefined}>
          <Field
            label="Короткое имя"
            hint="Внутреннее имя модели в Hub. Обычно его не меняют."
            error={conflict ? "Модель с таким коротким именем уже есть." : undefined}
          >
            <input
              value={slug}
              aria-invalid={conflict}
              onChange={(event) => { setSlug(event.target.value); setConflict(false); }}
              autoComplete="off"
              spellCheck={false}
              className="input"
            />
          </Field>
        </Disclosure>
      </div>

      <div className="dialog-actions">
        <button type="button" onClick={onClose} disabled={updateModel.isPending} className="btn">
          Отмена
        </button>
        <button
          type="button"
          disabled={updateModel.isPending || !slug.trim() || !name.trim()}
          onClick={() => void handleSubmit()}
          className="btn btn-primary"
        >
          {updateModel.isPending ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
    </ModalShell>
  );
}

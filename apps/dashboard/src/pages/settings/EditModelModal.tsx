import { useRef, useState } from "react";
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
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const pending = submitting || updateModel.isPending;

  function requestClose() {
    if (!inFlight.current) onClose();
  }

  async function handleSubmit() {
    if (inFlight.current || !slug.trim() || !name.trim()) return;
    const body: UpdateModelBody = {};
    if (slug.trim() !== model.slug) body.slug = slug.trim();
    if (name.trim() !== model.name) body.name = name.trim();

    if (!body.slug && !body.name) {
      onClose();
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    setSubmitError("");
    try {
      await updateModel.mutateAsync(body);
      toast.success("Модель обновлена");
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Не удалось обновить модель");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title={`Изменить модель: ${model.name}`} onClose={requestClose} closeLabel="Закрыть">
      <form aria-busy={pending} onSubmit={(event) => { event.preventDefault(); return handleSubmit(); }}>
      <fieldset disabled={pending} className="space-y-4">
        <Field label="Код модели">
          <input
            value={slug}
            required
            maxLength={100}
            onChange={(event) => setSlug(event.target.value)}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="Имя модели">
          <input
            value={name}
            required
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
      </fieldset>
      {submitError && <p role="alert" className="mt-4 break-words rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{submitError}</p>}

      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={requestClose}
          disabled={pending}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="submit"
          disabled={pending || !slug.trim() || !name.trim()}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
      </form>
    </ModalShell>
  );
}

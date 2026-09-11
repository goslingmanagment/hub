import { useRef, useState } from "react";
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
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const pending = submitting || updatePage.isPending;
  const selectedModelAvailable = models.some((model) => model.slug === modelSlug);
  const validModel = modelSlug === page.modelSlug || selectedModelAvailable;

  function requestClose() {
    if (!inFlight.current) onClose();
  }

  async function handleSubmit() {
    if (inFlight.current || !label.trim() || !modelSlug || !validModel) return;
    const body: UpdatePageBody = {};
    if (label.trim() !== page.label) body.label = label.trim();
    if (modelSlug !== page.modelSlug) body.modelSlug = modelSlug;

    if (!body.label && !body.modelSlug) {
      onClose();
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    setSubmitError("");
    try {
      await updatePage.mutateAsync(body);
      toast.success("Страница обновлена");
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Не удалось обновить страницу");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title={`Изменить страницу: ${page.label}`} onClose={requestClose} closeLabel="Закрыть">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <PlatformBadge platform={page.platform} />
        <span className="text-sm text-text-muted">Платформу страницы изменить нельзя</span>
      </div>

      <form aria-busy={pending} onSubmit={(event) => { event.preventDefault(); return handleSubmit(); }}>
      <fieldset disabled={pending} className="space-y-4">
        <Field label="Название страницы">
          <input
            value={label}
            required
            onChange={(event) => setLabel(event.target.value)}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="Модель">
          <select
            value={modelSlug}
            required
            onChange={(event) => setModelSlug(event.target.value)}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          >
            {!selectedModelAvailable && <option value={modelSlug}>{modelSlug === page.modelSlug ? page.modelName : modelSlug} · нет в текущем каталоге</option>}
            {models.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.name} ({m.slug})
              </option>
            ))}
          </select>
        </Field>
        {!selectedModelAvailable && <p className="text-xs text-text-muted">{modelSlug === page.modelSlug ? "Исходная привязка сохранена. Для выбора другой модели нужен актуальный каталог." : "Выбранная модель исчезла из каталога. Выберите доступную модель перед сохранением."}</p>}
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
          disabled={pending || !label.trim() || !modelSlug || !validModel}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
      </form>
    </ModalShell>
  );
}

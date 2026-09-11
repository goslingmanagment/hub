import { useRef, useState } from "react";
import type { CreateModelBody } from "@agency_hub_core/contracts";
import { useAdminCreateModel } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { toast } from "sonner";

export function CreateModelModal({ onClose }: { onClose: () => void }) {
  const createModel = useAdminCreateModel();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const pending = submitting || createModel.isPending;

  function requestClose() {
    if (!inFlight.current) onClose();
  }

  async function handleSubmit() {
    if (inFlight.current || !slug.trim() || !name.trim()) return;
    inFlight.current = true;
    setSubmitting(true);
    setSubmitError("");
    const body: CreateModelBody = {
      slug: slug.trim(),
      name: name.trim(),
    };

    try {
      await createModel.mutateAsync(body);
      toast.success("Модель создана");
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Не удалось создать модель");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title="Добавить модель" onClose={requestClose} closeLabel="Закрыть">
      <form aria-busy={pending} onSubmit={(event) => { event.preventDefault(); return handleSubmit(); }}>
      <fieldset disabled={pending} className="space-y-4">
        <Field label="Код модели">
          <input
            value={slug}
            required
            maxLength={100}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="Например, alice"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="Имя модели">
          <input
            value={name}
            required
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            placeholder="Например, Alice"
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
          {pending ? "Создаём…" : "Создать модель"}
        </button>
      </div>
      </form>
    </ModalShell>
  );
}

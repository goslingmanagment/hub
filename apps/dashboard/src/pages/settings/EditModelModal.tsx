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
      toast.success("Model updated");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update model");
    }
  }

  return (
    <ModalShell title={`Edit model: ${model.slug}`} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Slug">
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="Name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={updateModel.isPending || !slug.trim() || !name.trim()}
          onClick={handleSubmit}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </ModalShell>
  );
}

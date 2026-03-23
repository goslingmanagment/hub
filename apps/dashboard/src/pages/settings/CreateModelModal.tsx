import { useState } from "react";
import type { CreateModelBody } from "@agency_hub_core/contracts";
import { useAdminCreateModel } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { toast } from "sonner";

export function CreateModelModal({ onClose }: { onClose: () => void }) {
  const createModel = useAdminCreateModel();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");

  async function handleSubmit() {
    const body: CreateModelBody = {
      slug: slug.trim(),
      name: name.trim(),
    };

    try {
      await createModel.mutateAsync(body);
      toast.success("Model created");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create model");
    }
  }

  return (
    <ModalShell title="Create Model" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Slug">
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="e.g. alice"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="Name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Alice Johnson"
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
          disabled={createModel.isPending || !slug.trim() || !name.trim()}
          onClick={handleSubmit}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          Create
        </button>
      </div>
    </ModalShell>
  );
}

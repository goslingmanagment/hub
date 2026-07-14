import { useState } from "react";
import type {
  AdminAiPersona,
  AdminAiPersonaCreateBody,
  AdminAiPersonaUpdateBody,
} from "@agency_hub_core/contracts";
import { toast } from "sonner";

import {
  useAdminAiPersonas,
  useAdminArchiveAiPersona,
  useAdminCreateAiPersona,
  useAdminUpdateAiPersona,
} from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { Field } from "@/components/shared/Field";
import { ModalShell } from "@/components/shared/ModalShell";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";

function conflictMessage(error: unknown) {
  return error instanceof KernelApiError && error.status === 409
    ? "This persona changed on the server. The list was refreshed; reopen it and try again."
    : null;
}

export function AiPersonasTab() {
  const { data, isLoading, isError, error } = useAdminAiPersonas();
  const [showCreate, setShowCreate] = useState(false);
  const [editPersona, setEditPersona] = useState<AdminAiPersona | null>(null);
  const [archivePersona, setArchivePersona] = useState<AdminAiPersona | null>(null);

  if (isLoading && !data) {
    return <div className="py-12 text-center text-sm text-text-muted">Loading AI personas...</div>;
  }
  if (isError && !data) {
    return (
      <StatusPanel
        title="AI personas failed to load"
        description={error instanceof Error ? error.message : "The persona catalog could not be fetched."}
        tone="error"
      />
    );
  }

  const personas = data?.personas ?? [];

  return (
    <>
      <div>
        <div className="mb-3 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-text-primary">AI Personas</h2>
            <p className="mt-1 text-xs text-text-muted">
              Global prompt content. Desktop and browser clients only select from this catalog.
            </p>
            <p className="mt-1 text-xs text-warning">
              Transitional: released legacy clients can still overwrite or resurrect personas until read-only fleet coverage is confirmed.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90"
          >
            Create Persona
          </button>
        </div>

        {isError && data && <StaleDataNotice error={error} className="mb-3" />}

        {personas.length === 0 ? (
          <p className="text-sm text-text-muted">No personas configured.</p>
        ) : (
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  {[
                    "Key",
                    "Name",
                    "Version",
                    "Status",
                    "Actions",
                  ].map((column) => (
                    <th
                      key={column}
                      className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {personas.map((persona) => (
                  <tr key={persona.key} className="border-t border-border">
                    <td className="px-4 py-3 font-mono text-xs text-text-primary">{persona.key}</td>
                    <td className="px-4 py-3 text-sm text-text-secondary">{persona.displayName}</td>
                    <td className="px-4 py-3 text-sm text-text-secondary">{persona.version}</td>
                    <td className="px-4 py-3 text-sm">
                      <span className={persona.status === "active" ? "text-success" : "text-text-muted"}>
                        {persona.status === "active" ? "Active" : "Archived"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {persona.status === "active" ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setEditPersona(persona)}
                            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => setArchivePersona(persona)}
                            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
                          >
                            Archive
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-text-muted">Read only</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>

      {showCreate && <CreatePersonaModal onClose={() => setShowCreate(false)} />}
      {editPersona && (
        <EditPersonaModal persona={editPersona} onClose={() => setEditPersona(null)} />
      )}
      {archivePersona && (
        <ArchivePersonaConfirm
          persona={archivePersona}
          onClose={() => setArchivePersona(null)}
        />
      )}
    </>
  );
}

function PersonaFields({
  displayName,
  systemBlock,
  onDisplayNameChange,
  onSystemBlockChange,
}: {
  displayName: string;
  systemBlock: string;
  onDisplayNameChange: (value: string) => void;
  onSystemBlockChange: (value: string) => void;
}) {
  return (
    <>
      <Field label="Display name">
        <input
          value={displayName}
          maxLength={120}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </Field>
      <Field label="System prompt">
        <textarea
          value={systemBlock}
          maxLength={50_000}
          rows={16}
          onChange={(event) => onSystemBlockChange(event.target.value)}
          className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs outline-none focus:border-accent"
        />
      </Field>
    </>
  );
}

function CreatePersonaModal({ onClose }: { onClose: () => void }) {
  const create = useAdminCreateAiPersona();
  const [key, setKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [systemBlock, setSystemBlock] = useState("");

  async function handleSubmit() {
    const body: AdminAiPersonaCreateBody = {
      key: key.trim(),
      displayName: displayName.trim(),
      systemBlock,
    };
    try {
      await create.mutateAsync(body);
      toast.success("Persona created");
      onClose();
    } catch (error) {
      toast.error(conflictMessage(error) ?? (error instanceof Error ? error.message : "Failed to create persona"));
    }
  }

  return (
    <ModalShell title="Create AI Persona" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Key">
          <input
            value={key}
            maxLength={120}
            onChange={(event) => setKey(event.target.value)}
            placeholder="e.g. custom:milly"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
          />
        </Field>
        <PersonaFields
          displayName={displayName}
          systemBlock={systemBlock}
          onDisplayNameChange={setDisplayName}
          onSystemBlockChange={setSystemBlock}
        />
      </div>
      <PersonaModalActions
        pending={create.isPending}
        disabled={!key.trim() || !displayName.trim() || !systemBlock.trim()}
        submitLabel="Create"
        onClose={onClose}
        onSubmit={handleSubmit}
      />
    </ModalShell>
  );
}

function EditPersonaModal({ persona, onClose }: { persona: AdminAiPersona; onClose: () => void }) {
  const update = useAdminUpdateAiPersona(persona.key);
  const [displayName, setDisplayName] = useState(persona.displayName);
  const [systemBlock, setSystemBlock] = useState(persona.systemBlock);

  async function handleSubmit() {
    const body: AdminAiPersonaUpdateBody = {
      displayName: displayName.trim(),
      systemBlock,
      expectedVersion: persona.version,
    };
    try {
      await update.mutateAsync(body);
      toast.success("Persona updated");
      onClose();
    } catch (error) {
      const conflict = conflictMessage(error);
      toast.error(conflict ?? (error instanceof Error ? error.message : "Failed to update persona"));
      if (conflict) onClose();
    }
  }

  return (
    <ModalShell title={`Edit AI Persona: ${persona.key}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-text-muted">Editing version {persona.version}</p>
        <PersonaFields
          displayName={displayName}
          systemBlock={systemBlock}
          onDisplayNameChange={setDisplayName}
          onSystemBlockChange={setSystemBlock}
        />
      </div>
      <PersonaModalActions
        pending={update.isPending}
        disabled={!displayName.trim() || !systemBlock.trim()}
        submitLabel="Save"
        onClose={onClose}
        onSubmit={handleSubmit}
      />
    </ModalShell>
  );
}

function PersonaModalActions({
  pending,
  disabled,
  submitLabel,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  disabled: boolean;
  submitLabel: string;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
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
        disabled={pending || disabled}
        onClick={onSubmit}
        className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
      >
        {submitLabel}
      </button>
    </div>
  );
}

function ArchivePersonaConfirm({
  persona,
  onClose,
}: {
  persona: AdminAiPersona;
  onClose: () => void;
}) {
  const archive = useAdminArchiveAiPersona(persona.key);

  async function handleConfirm() {
    try {
      await archive.mutateAsync(persona.version);
      toast.success("Persona archived");
      onClose();
    } catch (error) {
      toast.error(conflictMessage(error) ?? (error instanceof Error ? error.message : "Failed to archive persona"));
      onClose();
    }
  }

  return (
    <ConfirmModal
      title={`Archive persona: ${persona.key}`}
      message="The persona will remain visible as an archived catalog entry, but clients cannot select it."
      confirmLabel="Archive"
      isPending={archive.isPending}
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}

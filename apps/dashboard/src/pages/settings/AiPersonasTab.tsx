import { useState } from "react";
import type {
  AdminAiPersona,
  AdminAiPersonaCreateBody,
  AdminAiPersonaUpdateBody,
} from "@agency_hub_core/contracts";
import { Plus } from "lucide-react";
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

import { PersonaOpenersSection } from "./PersonaOpenersSection.js";

function conflictMessage(error: unknown) {
  return error instanceof KernelApiError && error.status === 409
    ? "Персону успели изменить в другом окне. Список обновлён — откройте её снова."
    : null;
}

const SYSTEM_BLOCK_MAX = 50_000;

export function AiPersonasTab() {
  const { data, isLoading, isError, error } = useAdminAiPersonas();
  const [showCreate, setShowCreate] = useState(false);
  const [editPersona, setEditPersona] = useState<AdminAiPersona | null>(null);
  const [archivePersona, setArchivePersona] = useState<AdminAiPersona | null>(null);

  if (isLoading && !data) {
    return <div role="status" className="py-12 text-center text-sm text-text-secondary">Загружаем персоны…</div>;
  }
  if (isError && !data) {
    return (
      <StatusPanel
        title="Не удалось загрузить AI-персоны"
        description={error instanceof Error ? error.message : "Список персон недоступен."}
        tone="error"
      />
    );
  }

  const personas = data?.personas ?? [];
  const createButton = (
    <button type="button" onClick={() => setShowCreate(true)} className="btn btn-primary">
      <Plus size={16} aria-hidden /> Новая персона
    </button>
  );

  return (
    <>
      <div className="space-y-5">
        {isError && data && <StaleDataNotice error={error} />}

        {personas.length === 0 ? (
          <StatusPanel
            title="Персон пока нет"
            description="Добавьте первую: её смогут выбрать чаттеры в своих приложениях."
            action={createButton}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-end gap-2">{createButton}</div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Название</th>
                    <th className="num">Версия</th>
                    <th>Статус</th>
                    <th aria-label="Действия" />
                  </tr>
                </thead>
                <tbody>
                  {personas.map((persona) => (
                    <tr key={persona.key}>
                      <td>
                        <div className="font-medium">{persona.displayName}</div>
                        <div className="text-xs text-text-secondary">{persona.key}</div>
                      </td>
                      <td className="num muted">{persona.version}</td>
                      <td>
                        {persona.status === "active"
                          ? <span className="badge badge-success">Активна</span>
                          : <span className="badge">В архиве</span>}
                      </td>
                      <td>
                        {persona.status === "active" && (
                          <div className="flex items-center justify-end gap-1">
                            <button type="button" onClick={() => setEditPersona(persona)} className="btn btn-sm">
                              Изменить
                            </button>
                            <button type="button" onClick={() => setArchivePersona(persona)} className="btn btn-ghost btn-sm">
                              В архив
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PersonaOpenersSection personas={personas} />
          </>
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
      <Field label="Название" hint="Его видят чаттеры, когда выбирают персону.">
        <input
          value={displayName}
          maxLength={120}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          placeholder="например, Лора — нежная и игривая"
          className="input"
        />
      </Field>
      <div>
        <label htmlFor="persona-system-block" className="field-label">Инструкция для AI</label>
        <textarea
          id="persona-system-block"
          value={systemBlock}
          maxLength={SYSTEM_BLOCK_MAX}
          rows={18}
          onChange={(event) => onSystemBlockChange(event.target.value)}
          placeholder="Кто она, как пишет, о чём говорит и чего избегает…"
          className="textarea min-h-[320px] resize-y leading-relaxed"
        />
        <div className="field-hint flex flex-wrap justify-between gap-2">
          <span>Характер, манера речи и ограничения персоны.</span>
          <span className="tabular-nums">
            {systemBlock.length.toLocaleString("ru-RU")} из {SYSTEM_BLOCK_MAX.toLocaleString("ru-RU")} знаков
          </span>
        </div>
      </div>
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
      toast.success("Персона добавлена");
      onClose();
    } catch (error) {
      toast.error(conflictMessage(error) ?? (error instanceof Error ? error.message : "Не удалось добавить персону"));
    }
  }

  return (
    <ModalShell title="Новая персона" onClose={onClose}>
      <div className="space-y-4">
        <PersonaFields
          displayName={displayName}
          systemBlock={systemBlock}
          onDisplayNameChange={setDisplayName}
          onSystemBlockChange={setSystemBlock}
        />
        <Field label="Внутреннее имя" hint="Латинские буквы, цифры, двоеточие, дефис или подчёркивание. По нему приложения узнают персону; изменить его потом нельзя.">
          <input
            value={key}
            maxLength={120}
            onChange={(event) => setKey(event.target.value)}
            placeholder="например, custom:milly"
            autoComplete="off"
            spellCheck={false}
            className="input"
          />
        </Field>
      </div>
      <PersonaModalActions
        pending={create.isPending}
        disabled={!key.trim() || !displayName.trim() || !systemBlock.trim()}
        submitLabel="Добавить персону"
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
      toast.success("Персона сохранена");
      onClose();
    } catch (error) {
      const conflict = conflictMessage(error);
      toast.error(conflict ?? (error instanceof Error ? error.message : "Не удалось сохранить персону"));
      if (conflict) onClose();
    }
  }

  return (
    <ModalShell title={`Персона «${persona.displayName}»`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-text-secondary">
          Версия {persona.version} · {persona.key}
        </p>
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
        submitLabel="Сохранить"
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
      <button type="button" onClick={onClose} className="btn">
        Отмена
      </button>
      <button type="button" disabled={pending || disabled} onClick={onSubmit} className="btn btn-primary">
        {pending ? "Сохраняем…" : submitLabel}
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
      toast.success("Персона в архиве");
      onClose();
    } catch (error) {
      toast.error(conflictMessage(error) ?? (error instanceof Error ? error.message : "Не удалось убрать персону в архив"));
      onClose();
    }
  }

  return (
    <ConfirmModal
      title={`Убрать «${persona.displayName}» в архив?`}
      message="Персона останется в списке как архивная, но чаттеры больше не смогут её выбрать."
      confirmLabel="В архив"
      isPending={archive.isPending}
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}

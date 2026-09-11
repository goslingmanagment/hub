import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
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
import { SearchInput } from "@/components/shared/SearchInput";
import { formatDateTime } from "@/lib/format";

const ADMIN_PERSONA_MUTATIONS_ENABLED = false;

function conflictMessage(error: unknown) {
  return error instanceof KernelApiError && error.status === 409
    ? "Персона изменилась на сервере. Черновик сохранён: скопируйте свои правки, закройте форму и откройте актуальную версию из обновлённого каталога."
    : null;
}

export function AiPersonasTab() {
  const { data, isError, error, refetch } = useAdminAiPersonas({ suppressGlobalError: true });
  const [showCreate, setShowCreate] = useState(false);
  const [editPersona, setEditPersona] = useState<AdminAiPersona | null>(null);
  const [archivePersona, setArchivePersona] = useState<AdminAiPersona | null>(null);

  const [viewPersona, setViewPersona] = useState<AdminAiPersona | null>(null);
  const [search, setSearch] = useSearchParams();
  const query = search.get("personaQuery") ?? "";
  const rawStatus = search.get("personaStatus");
  const status = rawStatus === "active" || rawStatus === "archived" ? rawStatus : "all";
  const personas = data?.personas ?? [];
  const visiblePersonas = personas.filter((persona) => (status === "all" || persona.status === status) && `${persona.key} ${persona.displayName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  function updateSearch(changes: Record<string, string | null>) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value); else next.delete(key);
      }
      return next;
    });
  }

  return (
    <>
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-text-primary">AI-персоны</h2>
            <p className="mt-1 text-xs text-text-muted">
              Образы и стили общения AI. Клиенты выбирают персону из этого общего каталога.
            </p>
            <p className="mt-1 text-xs text-warning-dark">
              Пока доступен только просмотр. Изменение каталога станет доступно после завершения перехода клиентов.
            </p>
          </div>
          {ADMIN_PERSONA_MUTATIONS_ENABLED && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90"
            >
              Добавить персону
            </button>
          )}
        </div>

        {isError && data && <div className="mb-3"><StaleDataNotice title="Показан последний загруженный каталог персон" error={error} /><button type="button" className="mt-2 text-sm font-semibold text-accent" onClick={() => void refetch()}>Повторить загрузку</button></div>}

        <div className="mb-3 flex flex-wrap items-end gap-3">
          <SearchInput value={query} onChange={(value) => updateSearch({ personaQuery: value })} placeholder="Найти персону по имени или ключу…" />
          <label className="text-xs text-text-secondary"><span className="mb-1 block">Состояние</span><select value={status} onChange={(event) => updateSearch({ personaStatus: event.target.value === "all" ? null : event.target.value })} className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary"><option value="all">Все персоны</option><option value="active">Активные</option><option value="archived">Архивные</option></select></label>
          {(query || status !== "all") && <button type="button" className="py-2 text-sm font-medium text-accent" onClick={() => updateSearch({ personaQuery: null, personaStatus: null })}>Сбросить фильтры</button>}
          {data && <span className="py-2 text-xs text-text-muted">{visiblePersonas.length} из {personas.length}</span>}
        </div>
        {!data ? (
          <StatusPanel title={isError ? "Не удалось загрузить AI-персоны" : "AI-персоны"} description={isError ? error instanceof Error ? error.message : "Каталог персон недоступен." : "Загружаем каталог персон…"} tone={isError ? "error" : "default"} action={isError ? <button type="button" className="font-semibold text-accent" onClick={() => void refetch()}>Повторить загрузку</button> : undefined} />
        ) : visiblePersonas.length === 0 ? (
          <StatusPanel title={personas.length === 0 ? "Персон пока нет" : "Персоны не найдены"} description={personas.length === 0 ? "Каталог ещё не содержит сохранённых персон." : "Попробуйте другой запрос или сбросьте фильтры."} />
        ) : (
          <section className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[600px] border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  {[
                    "Ключ",
                    "Имя",
                    "Версия",
                    "Состояние",
                    "Действия",
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
                {visiblePersonas.map((persona) => (
                  <tr key={persona.key} className="border-t border-border">
                    <td className="px-4 py-3 font-mono text-xs text-text-primary">{persona.key}</td>
                    <td className="px-4 py-3 text-sm text-text-secondary">{persona.displayName}</td>
                    <td className="px-4 py-3 text-sm text-text-secondary">{persona.version}</td>
                    <td className="px-4 py-3 text-sm">
                      <span className={persona.status === "active" ? "text-green" : "text-text-muted"}>
                        {persona.status === "active" ? "Активна" : "В архиве"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <button type="button" className="mb-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-hover" aria-label={`Посмотреть персону ${persona.displayName}`} onClick={() => setViewPersona(persona)}>Посмотреть</button>
                      {ADMIN_PERSONA_MUTATIONS_ENABLED && persona.status === "active" ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setEditPersona(persona)}
                            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
                          >
                            Изменить
                          </button>
                          <button
                            type="button"
                            onClick={() => setArchivePersona(persona)}
                            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
                          >
                            Архивировать
                          </button>
                        </div>
                      ) : (
                        <span className="block text-xs text-text-muted">Только просмотр</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>

      {viewPersona && <ViewPersonaModal persona={viewPersona} onClose={() => setViewPersona(null)} />}
      {ADMIN_PERSONA_MUTATIONS_ENABLED && showCreate && <CreatePersonaModal onClose={() => setShowCreate(false)} />}
      {ADMIN_PERSONA_MUTATIONS_ENABLED && editPersona && (
        <EditPersonaModal persona={editPersona} onClose={() => setEditPersona(null)} />
      )}
      {ADMIN_PERSONA_MUTATIONS_ENABLED && archivePersona && (
        <ArchivePersonaConfirm
          persona={archivePersona}
          onClose={() => setArchivePersona(null)}
        />
      )}
    </>
  );
}

export function ViewPersonaModal({ persona, onClose }: { persona: AdminAiPersona; onClose: () => void }) {
  return <ModalShell title={persona.displayName} onClose={onClose} closeLabel="Закрыть">
    <p className="mb-3 break-words text-sm text-text-secondary">{persona.key} · Версия {persona.version} · {persona.status === "active" ? "Активна" : "В архиве"}</p>
    <p className="mb-4 text-xs text-text-muted">{Number.isFinite(Date.parse(persona.updatedAt)) ? `Обновлена ${formatDateTime(persona.updatedAt)}` : "Дата обновления неизвестна"}. Просмотр сохранённой версии; текст доступен для выделения и копирования.</p>
    <Field label="Инструкции персоны">
      <textarea readOnly value={persona.systemBlock} rows={18} className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs leading-relaxed text-text-primary focus:border-accent focus:outline-none" />
    </Field>
    <p className="mt-2 text-xs text-text-muted">{persona.systemBlock.length.toLocaleString()} знаков</p>
  </ModalShell>;
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
      <Field label="Имя персоны">
        <input
          value={displayName}
          required
          maxLength={120}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </Field>
      <Field label="Инструкции персоны">
        <textarea
          value={systemBlock}
          required
          maxLength={50_000}
          rows={16}
          onChange={(event) => onSystemBlockChange(event.target.value)}
          className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs outline-none focus:border-accent"
        />
      </Field>
    </>
  );
}

export function CreatePersonaModal({ onClose }: { onClose: () => void }) {
  const create = useAdminCreateAiPersona();
  const [key, setKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [systemBlock, setSystemBlock] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const pending = submitting || create.isPending;
  const validKey = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(key.trim());

  function requestClose() {
    if (!inFlight.current) onClose();
  }

  async function handleSubmit() {
    if (inFlight.current || !validKey || !displayName.trim() || !systemBlock.trim()) return;
    inFlight.current = true;
    setSubmitting(true);
    setSubmitError("");
    const body: AdminAiPersonaCreateBody = {
      key: key.trim(),
      displayName: displayName.trim(),
      systemBlock,
    };
    try {
      await create.mutateAsync(body);
      toast.success("Персона создана");
      onClose();
    } catch (error) {
      setSubmitError(error instanceof KernelApiError && error.status === 409 ? "Этот ключ уже занят. Черновик сохранён; выберите другой ключ." : error instanceof Error ? error.message : "Не удалось создать персону");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title="Добавить AI-персону" onClose={requestClose} closeLabel="Закрыть">
      <form aria-busy={pending} onSubmit={(event) => { event.preventDefault(); return handleSubmit(); }}>
      <fieldset disabled={pending} className="space-y-4">
        <Field label="Ключ">
          <input
            value={key}
            required
            maxLength={120}
            onChange={(event) => setKey(event.target.value)}
            placeholder="Например, custom:milly"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
          />
        </Field>
        <p className="text-xs text-text-muted">Начните ключ с латинской буквы или цифры. Также доступны двоеточие, дефис и подчёркивание.</p>
        <PersonaFields
          displayName={displayName}
          systemBlock={systemBlock}
          onDisplayNameChange={setDisplayName}
          onSystemBlockChange={setSystemBlock}
        />
      </fieldset>
      {submitError && <p role="alert" className="mt-4 break-words rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{submitError}</p>}
      <PersonaModalActions
        pending={pending}
        disabled={!validKey || !displayName.trim() || !systemBlock.trim()}
        submitLabel="Создать"
        onClose={requestClose}
      />
      </form>
    </ModalShell>
  );
}

export function EditPersonaModal({ persona, onClose }: { persona: AdminAiPersona; onClose: () => void }) {
  const update = useAdminUpdateAiPersona(persona.key);
  const [displayName, setDisplayName] = useState(persona.displayName);
  const [systemBlock, setSystemBlock] = useState(persona.systemBlock);
  const [submitError, setSubmitError] = useState("");
  const [hasConflict, setHasConflict] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const pending = submitting || update.isPending;

  function requestClose() {
    if (!inFlight.current) onClose();
  }

  async function handleSubmit() {
    if (inFlight.current || hasConflict || !displayName.trim() || !systemBlock.trim()) return;
    inFlight.current = true;
    setSubmitting(true);
    setSubmitError("");
    const body: AdminAiPersonaUpdateBody = {
      displayName: displayName.trim(),
      systemBlock,
      expectedVersion: persona.version,
    };
    try {
      await update.mutateAsync(body);
      toast.success("Персона обновлена");
      onClose();
    } catch (error) {
      const conflict = conflictMessage(error);
      setSubmitError(conflict ?? (error instanceof Error ? error.message : "Не удалось обновить персону"));
      if (conflict) setHasConflict(true);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title={`Изменить AI-персону: ${persona.key}`} onClose={requestClose} closeLabel="Закрыть">
      <form aria-busy={pending} onSubmit={(event) => { event.preventDefault(); return handleSubmit(); }}>
      <fieldset disabled={pending} className="space-y-4">
        <p className="text-xs text-text-muted">Редактируется версия {persona.version}</p>
        <PersonaFields
          displayName={displayName}
          systemBlock={systemBlock}
          onDisplayNameChange={setDisplayName}
          onSystemBlockChange={setSystemBlock}
        />
      </fieldset>
      {submitError && <p role="alert" className="mt-4 break-words rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{submitError}</p>}
      <PersonaModalActions
        pending={pending}
        disabled={hasConflict || !displayName.trim() || !systemBlock.trim()}
        submitLabel="Сохранить"
        onClose={requestClose}
      />
      </form>
    </ModalShell>
  );
}

function PersonaModalActions({
  pending,
  disabled,
  submitLabel,
  onClose,
}: {
  pending: boolean;
  disabled: boolean;
  submitLabel: string;
  onClose: () => void;
}) {
  return (
    <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        onClick={onClose}
        disabled={pending}
        className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
      >
        Отмена
      </button>
      <button
        type="submit"
        disabled={pending || disabled}
        className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
      >
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
  const inFlight = useRef(false);

  function requestClose() {
    if (!inFlight.current) onClose();
  }

  async function handleConfirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await archive.mutateAsync(persona.version);
      toast.success("Персона архивирована");
      onClose();
    } catch (error) {
      toast.error(conflictMessage(error) ?? (error instanceof Error ? error.message : "Не удалось архивировать персону"));
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <ConfirmModal
      title={`Архивировать персону: ${persona.key}`}
      message="Персона останется в каталоге как архивная запись. Клиенты больше не смогут её выбрать."
      confirmLabel="Архивировать"
      isPending={archive.isPending}
      onConfirm={handleConfirm}
      onClose={requestClose}
    />
  );
}

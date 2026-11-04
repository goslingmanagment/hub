import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { AdminAiPersona } from "@agency_hub_core/contracts";
import { toast } from "sonner";
import { useAdminAiPersonas, useAdminUpdateAiPersona } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { RowMenu } from "@/components/ui/RowMenu";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { Skeleton, Spinner } from "@/components/ui/Skeleton";
import { formatMomentAgo } from "@/lib/format";
import { errorStatus, isConflict, isUnknownOutcome } from "../settingsFeedback.js";
import { StaleNotice } from "../StaleNotice.js";
import { ArchivePersonaConfirm } from "./ArchivePersonaConfirm.js";
import { PersonaDiff } from "./PersonaDiff.js";
import { PersonaFields, useLeaveGuard } from "./PersonaFields.js";
import { PersonaOpeners } from "./PersonaOpeners.js";
import { personaRoute } from "./PersonasPage.js";

const WHY = "Образ для ответов ИИ: его выбирают чаттеры.";

interface Base {
  displayName: string;
  systemBlock: string;
  version: number;
}

const baseOf = (persona: AdminAiPersona): Base => ({ displayName: persona.displayName, systemBlock: persona.systemBlock, version: persona.version });

/**
 * One persona on a page of its own: its instruction, edited with the changes shown
 * before saving, and its first messages (`?tab=openers`). The draft owns the
 * version it began with; a refresh of the list never moves it under an edit
 * (design/screens/settings.md §3). Every write goes to the path's key.
 */
export function PersonaPage() {
  const { key = "" } = useParams<{ key: string }>();
  const [search] = useSearchParams();
  const tab = search.get("tab") === "openers" ? "openers" : "instruction";
  const query = useAdminAiPersonas();
  const persona = query.data?.personas.find((candidate) => candidate.key === key);

  if (query.isLoading && !query.data) {
    return (
      <>
        <PageHeader title="Персона" description={WHY} />
        <div className="persona-form" aria-hidden="true"><Skeleton width={240} /><Skeleton width={480} className="!h-[480px]" /></div>
      </>
    );
  }
  if (!query.data) {
    return (
      <>
        <PageHeader title="Персона" description={WHY} />
        <StatusPanel
          tone="error"
          title="Hub не ответил"
          description="Персона не пришла. Править её можно, когда Hub ответит."
          action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}
        />
      </>
    );
  }
  if (!persona) {
    return (
      <>
        <PageHeader title="Такой персоны нет" description={WHY} />
        <StatusPanel
          title="Такой персоны нет"
          description="Возможно, у неё другое внутреннее имя."
          action={<Link to="/settings/ai/personas" className="btn btn-sm">К списку персон</Link>}
        />
      </>
    );
  }
  return <PersonaEditor key={persona.key} persona={persona} tab={tab} stale={query.isError} staleAt={query.dataUpdatedAt} refetch={query.refetch} />;
}

function PersonaEditor({ persona, tab, stale, staleAt, refetch }: {
  persona: AdminAiPersona;
  tab: "instruction" | "openers";
  stale: boolean;
  staleAt: number;
  refetch: () => Promise<{ data?: { personas: AdminAiPersona[] } | undefined }>;
}) {
  const navigate = useNavigate();
  const update = useAdminUpdateAiPersona(persona.key);
  const [base, setBase] = useState<Base>(() => baseOf(persona));
  const [displayName, setDisplayName] = useState(persona.displayName);
  const [systemBlock, setSystemBlock] = useState(persona.systemBlock);
  const [view, setView] = useState<"edit" | "diff">("edit");
  const [touched, setTouched] = useState(false);
  const [saveError, setSaveError] = useState<"conflict" | "refused" | "unknown" | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [copied, setCopied] = useState(false);
  const archived = persona.status !== "active";

  // The name goes trimmed, as in the request; the text exactly, as it is stored.
  const dirty = displayName.trim() !== base.displayName || systemBlock !== base.systemBlock;
  const valid = displayName.trim() !== "" && /\S/.test(systemBlock);
  const newer = persona.version !== base.version;

  // No edit: a newer version is taken in quietly.
  useEffect(() => {
    if (dirty || persona.version === base.version) return;
    setBase(baseOf(persona));
    setDisplayName(persona.displayName);
    setSystemBlock(persona.systemBlock);
  }, [dirty, persona, base.version]);

  const leaveGuard = useLeaveGuard(dirty && !archived, base.displayName);

  async function compareWithNewer() {
    const result = await refetch();
    const fresh = result.data?.personas.find((candidate) => candidate.key === persona.key) ?? persona;
    setBase(baseOf(fresh));
    setSaveError(null);
    setView("diff");
  }

  async function save() {
    setSaveError(null);
    try {
      const saved = await update.mutateAsync({
        displayName: displayName.trim(),
        systemBlock,
        expectedVersion: base.version,
      });
      setBase(baseOf(saved));
      setDisplayName(saved.displayName);
      setSystemBlock(saved.systemBlock);
      setView("edit");
      toast.success(`Персона «${saved.displayName}» сохранена`);
    } catch (error) {
      setSaveError(isConflict(error) ? "conflict" : isUnknownOutcome(error) ? "unknown" : errorStatus(error) === 400 ? "refused" : "refused");
    }
  }

  function copyBefore() {
    void navigator.clipboard?.writeText(base.systemBlock).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    }, () => undefined);
  }

  const conflictNotice = (newer && dirty) || saveError === "conflict";
  const notices = (
    <>
      {stale && <StaleNotice at={staleAt} retry={refetch} />}
      {archived && (
        <Notice tone="off">Персона в архиве: чаттеры её не выбирают. Вернуть из архива в консоли пока нельзя.</Notice>
      )}
      {conflictNotice && (
        <Notice
          tone="warning"
          role="alert"
          action={<button type="button" className="btn btn-sm" onClick={() => void compareWithNewer()}>Сравнить с новой версией</button>}
        >
          Пока вы правили, персону изменили в другом окне. Ваш текст не потерян.
        </Notice>
      )}
      {saveError === "refused" && <Notice tone="danger" role="alert">Не сохранено: Hub не принял текст. Ваш текст остался на экране.</Notice>}
      {saveError === "unknown" && (
        <Notice tone="danger" role="alert">
          Hub не ответил: неизвестно, сохранилось ли. Ваш текст остался на экране. Откройте персону заново и сравните дату изменения.
        </Notice>
      )}
    </>
  );

  const updatedWindow = `Изменена ${formatMomentAgo(persona.updatedAt)}`;

  if (view === "diff") {
    return (
      <>
        <PageHeader
          title={`Изменения: ${base.displayName}`}
          description={WHY}
          window={updatedWindow}
          actions={(
            <>
              <button type="button" className="btn" disabled={update.isPending} onClick={() => setView("edit")}>Вернуться к правке</button>
              <button type="button" className="btn btn-primary" disabled={update.isPending || !valid || !dirty || conflictNotice} onClick={() => void save()}>
                {update.isPending && <Spinner />}
                {update.isPending ? "Сохраняем…" : "Сохранить персону"}
              </button>
            </>
          )}
        />
        <div className="stack">
          <div className="settings-notices">
            <Notice
              action={<button type="button" className="btn btn-sm" onClick={copyBefore}>{copied ? "Скопировано" : "Скопировать прежний текст"}</button>}
              detail="Прежний текст в Hub не хранится."
            >
              Сохранение сразу меняет ответы ИИ у всех чаттеров, которые выбирают эту персону.
            </Notice>
            {notices}
          </div>
          {displayName.trim() !== base.displayName && (
            <dl className="kv">
              <dt>Название</dt>
              <dd>{base.displayName} → {displayName.trim()}</dd>
            </dl>
          )}
          {systemBlock === base.systemBlock
            ? <p className="text-text-secondary">Инструкция не менялась.</p>
            : <PersonaDiff before={base.systemBlock} after={systemBlock} />}
        </div>
        {leaveGuard}
      </>
    );
  }

  const tabs = [
    { to: personaRoute(persona.key), label: "Инструкция" },
    { to: personaRoute(persona.key, "openers"), label: "Первые сообщения" },
  ];

  return (
    <>
      <PageHeader
        title={base.displayName}
        description={WHY}
        window={updatedWindow}
        actions={!archived && tab === "instruction" ? (
          <>
            {!dirty && <span className="settings-header-reason">Изменений нет</span>}
            <button
              type="button"
              className="btn btn-primary"
              disabled={!dirty}
              onClick={() => {
                setTouched(true);
                if (valid) setView("diff");
              }}
            >
              Показать изменения
            </button>
            <RowMenu
              label={`Действия с персоной ${base.displayName}`}
              items={[{
                label: "В архив",
                danger: true,
                disabled: dirty,
                hint: dirty ? "Сначала сохраните или отмените правку" : undefined,
                onSelect: () => setArchiving(true),
              }]}
            />
          </>
        ) : undefined}
      />
      <SectionTabs label="Персона" items={tabs} current={tab === "openers" ? tabs[1]!.to : tabs[0]!.to} />
      <div className="stack">
        <div className="settings-notices">{notices}</div>
        {tab === "instruction" ? (
          <>
            <PersonaFields
              displayName={displayName}
              systemBlock={systemBlock}
              readOnly={archived}
              touched={touched}
              onDisplayNameChange={(value) => { setDisplayName(value); setTouched(true); }}
              onSystemBlockChange={(value) => { setSystemBlock(value); setTouched(true); }}
            />
            <Disclosure label="Подробнее">
              <p>Внутреннее имя: <span className="font-medium text-text-primary">{persona.key}</span>. По нему приложения узнают персону, изменить его нельзя.</p>
              <p>Версия: {persona.version}.</p>
              <p>Где персона используется, Hub пока не показывает.</p>
            </Disclosure>
          </>
        ) : (
          <PersonaOpeners persona={persona} />
        )}
      </div>
      {archiving && (
        <ArchivePersonaConfirm
          persona={persona}
          onClose={() => setArchiving(false)}
          onArchived={() => navigate("/settings/ai/personas")}
        />
      )}
      {leaveGuard}
    </>
  );
}

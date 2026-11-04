import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Plus } from "lucide-react";
import type { AdminAiPersona } from "@agency_hub_core/contracts";
import { useAdminAiPersonaOpeners, useAdminAiPersonas } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import { RowMenu } from "@/components/ui/RowMenu";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatMomentAgo } from "@/lib/format";
import { pathSegment } from "@/lib/path";
import { StaleNotice } from "../StaleNotice.js";
import { ArchivePersonaConfirm } from "./ArchivePersonaConfirm.js";

export function personaRoute(key: string, tab?: "openers"): string {
  return `/settings/ai/personas/${pathSegment(key)}${tab ? `?tab=${tab}` : ""}`;
}

/** «7 из 8 включены»: the persona's own openers read, the same cache as its page. */
function OpenersCell({ persona }: { persona: AdminAiPersona }) {
  const { data, isLoading, isError } = useAdminAiPersonaOpeners(persona.key);
  if (isLoading && !data) return <Skeleton width={110} />;
  if (isError && !data) return <span className="muted">—</span>;
  const openers = data?.openers ?? [];
  const to = personaRoute(persona.key, "openers");
  if (openers.length === 0) return <Link to={to} className="settings-link text-text-secondary">Текстов нет: Hi пишет сам</Link>;
  const enabled = openers.filter((opener) => opener.enabled).length;
  return <Link to={to} className="settings-link">{enabled} из {openers.length} {enabled === 1 ? "включён" : "включены"}</Link>;
}

/**
 * «Персоны»: the images the AI answers in. The owner writes them, chatters pick
 * them. Active first, the archive after its own line (design/screens/settings.md §2).
 */
export function PersonasPage() {
  const query = useAdminAiPersonas();
  const navigate = useNavigate();
  const [archiving, setArchiving] = useState<AdminAiPersona | null>(null);
  const personas = query.data?.personas ?? [];
  const active = personas.filter((persona) => persona.status === "active");
  const archived = personas.filter((persona) => persona.status !== "active");

  const header = (
    <PageHeader
      actions={<Link to="/settings/ai/new-persona" className="btn btn-primary"><Plus size={16} aria-hidden="true" /> Новая персона</Link>}
      fresh={query.dataUpdatedAt ? { at: query.dataUpdatedAt, onRefresh: () => void query.refetch(), refreshing: query.isFetching } : undefined}
    />
  );

  if (query.isLoading && !query.data) {
    return <>{header}<div className="card"><TableSkeleton rows={4} columns={3} /></div></>;
  }
  if (!query.data) {
    return (
      <>
        {header}
        <StatusPanel
          tone="error"
          title="Hub не ответил"
          description="Список персон не пришёл. Это не значит, что их нет."
          action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}
        />
      </>
    );
  }
  if (personas.length === 0) {
    return (
      <>
        {header}
        <StatusPanel
          title="Персон пока нет"
          description="Добавьте первую: её смогут выбрать чаттеры в своих приложениях."
          action={<Link to="/settings/ai/new-persona" className="btn btn-primary btn-sm">Новая персона</Link>}
        />
      </>
    );
  }

  const row = (persona: AdminAiPersona) => {
    const isActive = persona.status === "active";
    return (
      <tr key={persona.key}>
        <td>
          <Link to={personaRoute(persona.key)} className="settings-link font-medium">{persona.displayName}</Link>
        </td>
        <td>{isActive ? <OpenersCell persona={persona} /> : <span className="muted">—</span>}</td>
        <td className="muted">{formatMomentAgo(persona.updatedAt)}</td>
        <td>
          <div className="settings-actions">
            <RowMenu
              label={`Действия с персоной ${persona.displayName}`}
              items={isActive
                ? [
                  { label: "Изменить", onSelect: () => navigate(personaRoute(persona.key)) },
                  { label: "Первые сообщения", onSelect: () => navigate(personaRoute(persona.key, "openers")) },
                  { label: "В архив", danger: true, onSelect: () => setArchiving(persona) },
                ]
                : [{ label: "Посмотреть", onSelect: () => navigate(personaRoute(persona.key)) }]}
            />
          </div>
        </td>
      </tr>
    );
  };

  return (
    <>
      {header}
      <div className="stack">
      {query.isError && <StaleNotice at={query.dataUpdatedAt} retry={() => query.refetch()} />}
      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Первые сообщения</th>
                <th>Изменена</th>
                <th><span className="sr-only">Действия</span></th>
              </tr>
            </thead>
            <tbody>
              {active.map(row)}
              {archived.length > 0 && (
                <tr className="row-group">
                  <td colSpan={4}>В архиве</td>
                </tr>
              )}
              {archived.map(row)}
            </tbody>
          </table>
        </div>
      </div>
      </div>
      {archiving && <ArchivePersonaConfirm persona={archiving} onClose={() => setArchiving(null)} />}
    </>
  );
}

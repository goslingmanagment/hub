import { Fragment, useState } from "react";
import { useSearchParams } from "react-router";
import { useAdminIncidents, useAdminLogs } from "@/api/queries";
import { staleDataText } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";

import { syncStreamLabel } from "@/pages/settings/sync/syncVocabulary";
import { freshOf, MomentCell, OfapiOffBanner, useOfapi } from "../shared.js";
import { EventDetailPanel, getEventDisplaySeverity, SeverityBadge, severityLabel } from "./EventDetailPanel.js";

type Mode = "all" | "info" | "warn" | "error" | "problems";

function resolveEventCode(details: Record<string, unknown> | null, fallback: string | null) {
  return typeof details?.code === "string" ? details.code : fallback;
}

interface Row {
  key: string;
  emittedAt: string | null;
  pageLabel: string | null;
  stream: string | null;
  severity: string;
  displaySeverity: string;
  type: string | null;
  code: string | null;
  message: string | null;
  syncRunId: number | string | null;
  details: Record<string, unknown> | null;
}

function EventsTable({ rows, problems, off }: { rows: readonly Row[]; problems: boolean; off: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="table-wrap">
      <table className="data-table data-table-dense sys-log">
        <thead>
          <tr>
            <th>Время</th>
            <th>Страница</th>
            <th>Поток</th>
            <th>Важность</th>
            <th>{problems ? "Код" : "Тип"}</th>
            <th>Сообщение</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={6} className="text-center text-text-secondary">Записей нет.</td></tr>
          )}
          {rows.map((row) => {
            const isOpen = expanded === row.key;
            const toggle = () => setExpanded(isOpen ? null : row.key);
            return (
              <Fragment key={row.key}>
                <tr
                  className="sys-click-row"
                  onClick={toggle}
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggle();
                    }
                  }}
                >
                  <td className="muted"><MomentCell at={row.emittedAt} /></td>
                  <td className="whitespace-nowrap">{row.pageLabel ?? "—"}</td>
                  <td className="muted">{row.stream ? syncStreamLabel(row.stream) : "—"}</td>
                  <td className="status-col"><SeverityBadge severity={row.displaySeverity} off={off} /></td>
                  <td><span className="sys-code">{(problems ? row.code : row.type) ?? "—"}</span></td>
                  <td className="muted"><span className="sys-truncate">{row.message ?? "—"}</span></td>
                </tr>
                {isOpen && (
                  <tr className="sys-detail-row">
                    <td colSpan={6} className="sys-event-cell">
                      <EventDetailPanel
                        message={row.message}
                        syncRunId={row.syncRunId}
                        eventCode={row.code}
                        severity={row.severity}
                        details={row.details}
                        off={off}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LogMode({ severity, off }: { severity: string | null; off: boolean }) {
  const query = useAdminLogs({ ...(severity ? { severity } : {}), limit: 100 });
  const rows: Row[] = (query.data ?? []).map((log, index) => {
    const code = resolveEventCode(log.details, log.eventType);
    return {
      key: log.id != null ? String(log.id) : String(index),
      emittedAt: log.emittedAt,
      pageLabel: log.pageLabel,
      stream: log.stream,
      severity: log.severity,
      displaySeverity: getEventDisplaySeverity({ eventCode: code, severity: log.severity, details: log.details }),
      type: log.eventType,
      code,
      message: log.message,
      syncRunId: log.syncRunId,
      details: log.details,
    };
  });
  return (
    <>
      <PageHeader fresh={freshOf(query)} />
      {query.isError && query.data && (
        <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}>
          {staleDataText(query.dataUpdatedAt)}
        </Notice>
      )}
      <section className="card" aria-label="События">
        {query.isLoading && !query.data ? <TableSkeleton rows={8} columns={6} /> : !query.data ? <NoAnswerPanel retry={query.refetch} /> : <EventsTable rows={rows} problems={false} off={off} />}
      </section>
    </>
  );
}

function ProblemsMode({ code, onCode, off }: { code: string | null; onCode: (code: string | null) => void; off: boolean }) {
  const query = useAdminIncidents({ ...(code ? { code } : {}), limit: 100 });
  const data = query.data;
  const summary = (data?.summary ?? []).reduce<Array<{ code: string | null; severity: string; count: number }>>((acc, item) => {
    const displaySeverity = getEventDisplaySeverity({ eventCode: item.code, severity: item.severity ?? "info", details: null });
    const existing = acc.find((entry) => entry.code === item.code && entry.severity === displaySeverity);
    if (existing) existing.count += item.count;
    else acc.push({ code: item.code, severity: displaySeverity, count: item.count });
    return acc;
  }, []);
  const rows: Row[] = (data?.items ?? []).map((item, index) => {
    const eventCode = resolveEventCode(item.details, item.eventType);
    return {
      key: item.id != null ? String(item.id) : String(index),
      emittedAt: item.emittedAt,
      pageLabel: item.pageLabel,
      stream: item.stream,
      severity: item.severity,
      displaySeverity: getEventDisplaySeverity({ eventCode, severity: item.severity, details: item.details }),
      type: item.eventType,
      code: eventCode,
      message: item.message,
      syncRunId: item.syncRunId,
      details: item.details,
    };
  });
  return (
    <>
      <PageHeader fresh={freshOf(query)} />
      {query.isError && data && (
        <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}>
          {staleDataText(query.dataUpdatedAt)}
        </Notice>
      )}
      {query.isLoading && !data ? (
        <div className="card"><TableSkeleton rows={8} columns={6} /></div>
      ) : !data ? (
        <div className="card"><NoAnswerPanel retry={query.refetch} /></div>
      ) : (
        <>
          <section className="card" aria-labelledby="codes-heading">
            <div className="card-header">
              <h2 id="codes-heading" className="card-title">Коды за 7 дней</h2>
              {code && (
                <span className="sys-row-between">
                  <span className="text-text-secondary">Показан код: <span className="sys-code">{code}</span></span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCode(null)}>Показать все</button>
                </span>
              )}
            </div>
            {summary.length === 0 ? (
              <StatusPanel title="За 7 дней кодов нет." description="Журнал застыл 1 ноября: ниже последние записи." />
            ) : (
              <div className="table-wrap">
                <table className="data-table data-table-dense">
                  <thead>
                    <tr>
                      <th>Код</th>
                      <th>Важность</th>
                      <th className="num">Сколько</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.map((entry) => {
                      const active = entry.code !== null && entry.code === code;
                      return (
                        <tr
                          key={`${entry.code ?? "none"}:${entry.severity}`}
                          className={`${entry.code === null ? "" : "sys-click-row"}${active ? " is-selected" : ""}`}
                          onClick={() => {
                            if (entry.code !== null) onCode(active ? null : entry.code);
                          }}
                        >
                          <td>{entry.code === null ? <span className="text-text-secondary">Без кода</span> : <span className="sys-code">{entry.code}</span>}</td>
                          <td className="status-col">{off ? <span className="badge badge-off">{severityLabel(entry.severity)}</span> : <SeverityBadge severity={entry.severity} />}</td>
                          <td className="num">{entry.count}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="card" aria-label="Записи">
            <EventsTable rows={rows} problems off={off} />
          </section>
        </>
      )}
    </>
  );
}

/** «Журнал сбора OnlyFans»: the old collection's events, the last 100; `?problems=1` is only the problems (§14). */
export function LogPage() {
  const [search, setSearch] = useSearchParams();
  const ofapi = useOfapi();
  const off = ofapi.status === "off";
  const problems = search.get("problems") === "1";
  const severityParam = search.get("severity");
  const severity = severityParam === "info" || severityParam === "warn" || severityParam === "error" ? severityParam : null;
  const mode: Mode = problems ? "problems" : severity ?? "all";
  const code = search.get("code");

  function choose(next: Mode) {
    const query = new URLSearchParams(search);
    query.delete("problems");
    query.delete("severity");
    query.delete("code");
    if (next === "problems") query.set("problems", "1");
    else if (next !== "all") query.set("severity", next);
    setSearch(query);
  }

  return (
    <div className="space-y-6 sys-screen">
      {off && <OfapiOffBanner link={false}>Журнал застыл 1 ноября вместе с OnlyFans API.</OfapiOffBanner>}
      <div className="sys-seg-scroll"><Segmented
        label="Какие записи"
        value={mode}
        onChange={choose}
        options={[
          { value: "all", label: "Все" },
          { value: "info", label: "Инфо" },
          { value: "warn", label: "Предупреждения" },
          { value: "error", label: "Ошибки" },
          { value: "problems", label: "Только проблемы" },
        ]}
      /></div>
      {problems ? (
        <ProblemsMode
          code={code}
          off={off}
          onCode={(next) => {
            const query = new URLSearchParams(search);
            if (next === null) query.delete("code");
            else query.set("code", next);
            setSearch(query);
          }}
        />
      ) : (
        <LogMode severity={severity} off={off} />
      )}
    </div>
  );
}

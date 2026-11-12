import { Fragment, useState } from "react";
import type {
  SystemPlace,
  SystemStateCopy,
  SystemStateReporter,
  SystemStateResponse,
  SystemStateRoutine,
} from "@agency_hub_core/contracts";
import { ExternalLink } from "lucide-react";
import { Link } from "react-router";
import { useSystemState } from "@/api/systemState";
import { staleDataText } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatAgo, formatSeconds } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { freshOf, MomentCell, RowChevron } from "../shared.js";
import {
  bytesWords,
  COPY_WORD,
  moscowAt,
  periodWords,
  PLACE_TITLE,
  PLACES,
  ROUTINE_WORD,
  routineLine,
  spanWords,
} from "./stateWords.js";

/** The server monitor: CPU, memory, disks and containers of agency-de, the owner's sign-in. */
const SERVER_MONITOR_URL = "https://monitor.gosling-agency.ru";

const RESULT_WORD: Readonly<Record<NonNullable<SystemStateRoutine["lastResult"]>, string>> = {
  ok: "готово",
  failed: "сбой",
  skipped: "нечего делать",
  empty_input: "пустой вход",
};

const ROLE_WORD: Readonly<Record<string, string>> = { api: "API", worker: "фоновые задачи", scheduler: "расписание", sync: "сбор Fansly" };

// ── «Сервер» ────────────────────────────────────────────────────────────────

function ServerBlock({ server, ledger }: { server: SystemStateResponse["server"]; ledger: SystemStateRoutine | undefined }) {
  const down = server.processes.filter((process) => process.state !== "active");
  const queueOld = server.queue.oldestWaitingAgeMs !== null && server.queue.oldestWaitingAgeMs > 5 * 60_000;
  const lines: Array<{ label: string; value: string; tone: "ok" | "warn" | "error"; to?: string }> = [
    {
      label: "Процессы Hub",
      tone: down.length === 0 ? "ok" : "error",
      value: down.length === 0
        ? `Работают все ${server.processes.length}: ${server.processes.map((process) => ROLE_WORD[process.role] ?? process.role).join(", ")}`
        : `Не работают: ${down.map((process) => `${ROLE_WORD[process.role] ?? process.role}${process.state === "stale" && process.lastSeenAt ? ` (молчит с ${moscowAt(process.lastSeenAt)})` : ""}`).join(", ")}`,
    },
    {
      label: "Очередь задач",
      tone: server.queue.failedLastHour > 0 || queueOld ? "warn" : "ok",
      value: `Ждут ${server.queue.waiting}${server.queue.oldestWaitingAgeMs !== null && server.queue.waiting > 0 ? `, самая старая ${formatSeconds(server.queue.oldestWaitingAgeMs / 1000)}` : ""}; со сбоем за час: ${server.queue.failedLastHour}`,
      to: "/system/dev/queue",
    },
    {
      label: "Открытые сбои",
      tone: server.openIncidents > 0 ? "warn" : "ok",
      value: server.openIncidents === 0 ? "Нет" : `${server.openIncidents} ${ruPlural(server.openIncidents, "сбой", "сбоя", "сбоев")}`,
      to: "/system/failures",
    },
  ];
  if (ledger) {
    lines.push({
      label: "Ledger",
      tone: ledger.level === "healthy" ? "ok" : "error",
      value: ledger.level === "healthy" ? `Отвечает${ledger.detail ? `. ${ledger.detail}` : ""}` : routineLine(ledger),
    });
  }
  return (
    <section className="card" aria-labelledby="state-server-title">
      <div className="card-header">
        <h2 id="state-server-title" className="card-title">Сервер</h2>
        <a href={SERVER_MONITOR_URL} target="_blank" rel="noreferrer" className="link state-external">
          Монитор сервера <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>
      <dl className="state-lines">
        {lines.map((line) => (
          <div key={line.label} className="state-line">
            <dt>{line.label}</dt>
            <dd>
              <span className={`status-dot ${line.tone === "ok" ? "status-dot-ok" : line.tone === "warn" ? "status-dot-warn" : "status-dot-error"}`} aria-hidden="true" />
              {line.to ? <Link to={line.to} className="sys-row-link state-line-link">{line.value}</Link> : <span>{line.value}</span>}
            </dd>
          </div>
        ))}
        {server.revision && (
          <div className="state-line">
            <dt>Версия Hub</dt>
            <dd><span className="sys-code">{server.revision.slice(0, 12)}</span></dd>
          </div>
        )}
      </dl>
    </section>
  );
}

// ── «Рутины» ────────────────────────────────────────────────────────────────

function RoutineDetail({ routine }: { routine: SystemStateRoutine }) {
  const facts: Array<[string, string]> = [
    ["Где", PLACE_TITLE[routine.place]],
    ["Как часто", periodWords(routine.periodSeconds)],
    ["Последний запуск", routine.lastRunAt ? `${moscowAt(routine.lastRunAt)}, ${formatAgo(routine.lastRunAt)}` : "не было"],
    ["Последний успех", routine.lastSuccessAt ? `${moscowAt(routine.lastSuccessAt)}, ${formatAgo(routine.lastSuccessAt)}` : "не было"],
    ["Итог последнего запуска", routine.lastResult ? RESULT_WORD[routine.lastResult] : "не виден"],
  ];
  if (routine.failedStreak > 0) facts.push(["Сбоев подряд", String(routine.failedStreak)]);
  if (routine.emptySince) facts.push(["Пусто на входе с", moscowAt(routine.emptySince)]);
  if (routine.emptyThresholdSeconds !== null) facts.push(["Пустой вход дольше этого — проблема", spanWords(routine.emptyThresholdSeconds * 1000)]);
  if (routine.state !== "unchecked" && routine.level !== "problem") facts.push(["Будет считаться молчащей после", moscowAt(routine.silentAfter)]);
  if (routine.detail) facts.push(["Подробности", routine.detail]);
  facts.push(["Прислал", `${routine.reportedBy ?? "Hub сам"}, ${formatAgo(routine.reportedAt)}`]);
  facts.push(["Ключ", routine.key]);
  return (
    <dl className="state-detail">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={label === "Ключ" ? "sys-code" : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RoutineRows({ routines, open, toggle }: { routines: readonly SystemStateRoutine[]; open: string | null; toggle: (key: string) => void }) {
  return (
    <div className="table-wrap">
      <table className="data-table state-table">
        <thead>
          <tr>
            <th>Рутина</th>
            <th className="state-col-mark">Состояние</th>
          </tr>
        </thead>
        <tbody>
          {routines.map((routine) => {
            const opened = open === routine.key;
            const word = ROUTINE_WORD[routine.state];
            return (
              <Fragment key={routine.key}>
                <tr className="sys-click-row" data-routine={routine.key} data-state={routine.state} onClick={() => toggle(routine.key)}>
                  <td>
                    <span className="state-title">
                      <RowChevron open={opened} label={`Подробнее: ${routine.title}`} onToggle={() => toggle(routine.key)} />
                      <span className="sys-row-link">{routine.title}</span>
                    </span>
                    <span className="cell-second state-second">{routineLine(routine)}</span>
                  </td>
                  <td className="state-col-mark"><StatusBadge tone={word.tone} bare={routine.level === "healthy"}>{word.word}</StatusBadge></td>
                </tr>
                {opened && (
                  <tr className="state-detail-row">
                    <td colSpan={2}><RoutineDetail routine={routine} /></td>
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

/** A place's reporter in one line: who tells Hub about it, and when it last did. */
function ReporterLine({ place, reporter }: { place: SystemPlace; reporter: SystemStateReporter | undefined }) {
  if (place === "server") {
    return <p className="state-reporter">Hub проверяет сам{reporter ? `, последний раз ${formatAgo(reporter.lastReportAt)}` : ""}.</p>;
  }
  if (!reporter) return <p className="state-reporter">{PLACE_TITLE[place]} пока не присылает состояние.</p>;
  if (reporter.fresh) {
    return <p className="state-reporter">Сборщик прислал состояние {formatAgo(reporter.lastReportAt)}.</p>;
  }
  const since = `${moscowAt(reporter.lastReportAt)}, уже ${spanWords(Date.now() - Date.parse(reporter.lastReportAt))}`;
  return (
    <Notice
      tone={reporter.silentProblem ? "danger" : "off"}
      className="state-reporter-notice"
      detail={reporter.silentProblem
        ? "Строки ниже не проверены: Hub не знает, работают ли они. Это не сбой рутин, а молчание сборщика."
        : `Вне часов наблюдения${reporter.hours ? ` (с ${reporter.hours.from}:00 до ${reporter.hours.to}:00 мск)` : ""} это нормально. Строки ниже не проверены.`}
    >
      {PLACE_TITLE[place]} не присылает состояние с {since}
    </Notice>
  );
}

function PlaceGroup({ place, routines, reporter }: { place: SystemPlace; routines: readonly SystemStateRoutine[]; reporter: SystemStateReporter | undefined }) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (key: string) => setOpen((current) => (current === key ? null : key));
  const shown = routines.filter((routine) => routine.level === "problem" || routine.level === "attention");
  const folded = routines.filter((routine) => routine.level === "healthy" || routine.level === "unchecked");
  const unchecked = folded.length > 0 && folded.every((routine) => routine.level === "unchecked");
  return (
    <div className="state-place" data-place={place}>
      <div className="state-place-head">
        <h3 className="state-place-title">{PLACE_TITLE[place]}</h3>
        {routines.length > 0 && <span className="state-place-count">{routines.length} {ruPlural(routines.length, "рутина", "рутины", "рутин")}</span>}
      </div>
      <ReporterLine place={place} reporter={reporter} />
      {shown.length > 0 && <RoutineRows routines={shown} open={open} toggle={toggle} />}
      {folded.length > 0 && (
        <details className="state-fold" data-fold={unchecked ? "unchecked" : "healthy"}>
          <summary className="state-fold-summary">
            {unchecked ? "Не проверено" : "В порядке"}: {folded.length}
          </summary>
          <RoutineRows routines={folded} open={open} toggle={toggle} />
        </details>
      )}
    </div>
  );
}

// ── «Копии» ─────────────────────────────────────────────────────────────────

function CopyRows({ copies, limitHours }: { copies: readonly SystemStateCopy[]; limitHours: number }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="table-wrap">
      <table className="data-table state-table">
        <thead>
          <tr>
            <th>Копия</th>
            <th className="state-col-when">Снята (мск)</th>
            <th className="state-col-mark">Состояние</th>
          </tr>
        </thead>
        <tbody>
          {copies.map((copy) => {
            const opened = open === copy.key;
            const word = COPY_WORD[copy.state];
            const toggle = () => setOpen((current) => (current === copy.key ? null : copy.key));
            return (
              <Fragment key={copy.key}>
                <tr className="sys-click-row" data-copy={copy.key} data-state={copy.state} onClick={toggle}>
                  <td>
                    <span className="state-title">
                      <RowChevron open={opened} label={`Подробнее: ${copy.title}`} onToggle={toggle} />
                      <span className="sys-row-link">{copy.title}</span>
                    </span>
                    <span className="cell-second state-second">
                      {copy.source}, {copy.destination}
                      {copy.bytes !== null && ` · ${bytesWords(copy.bytes)}`}
                      {copy.kept !== null && copy.kept > 0 && `, хранится ${copy.kept} ${ruPlural(copy.kept, "копия", "копии", "копий")}`}
                      {copy.state === "stale" && (copy.takenAt ? `. Старше ${limitHours} ч` : ". Копий нет")}
                    </span>
                  </td>
                  <td className="state-col-when"><MomentCell at={copy.takenAt} empty="нет" /></td>
                  <td className="state-col-mark"><StatusBadge tone={word.tone} bare={copy.level === "healthy"}>{word.word}</StatusBadge></td>
                </tr>
                {opened && (
                  <tr className="state-detail-row">
                    <td colSpan={3}>
                      <dl className="state-detail">
                        <div><dt>Откуда</dt><dd>{copy.source}</dd></div>
                        <div><dt>Куда</dt><dd>{copy.destination}</dd></div>
                        <div><dt>Новейшая снята</dt><dd>{copy.takenAt ? `${moscowAt(copy.takenAt)}, ${formatAgo(copy.takenAt)}` : "нет ни одной"}</dd></div>
                        <div><dt>Размер</dt><dd>{bytesWords(copy.bytes)}</dd></div>
                        <div><dt>Хранится</dt><dd>{copy.kept === null ? "не известно" : `${copy.kept} ${ruPlural(copy.kept, "копия", "копии", "копий")}`}</dd></div>
                        {copy.detail && <div><dt>Подробности</dt><dd>{copy.detail}</dd></div>}
                        <div><dt>Прислал</dt><dd>{copy.reportedBy ?? "Hub сам"}, {formatAgo(copy.reportedAt)}</dd></div>
                        <div><dt>Ключ</dt><dd className="sys-code">{copy.key}</dd></div>
                      </dl>
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

// ── The screen ──────────────────────────────────────────────────────────────

/** Система → «Состояние»: every routine and every copy, problems first, from the owner's place. */
export function SystemStatePage() {
  const query = useSystemState();
  const data = query.data;
  const stale = query.isError && data !== undefined;

  const problems = data ? data.routines.filter((routine) => routine.level === "problem").length
    + data.copies.filter((copy) => copy.level === "problem").length
    + data.reporters.filter((reporter) => reporter.silentProblem).length : 0;
  const reporterOf = (place: SystemPlace) => data?.reporters.find((reporter) => reporter.place === place && (place !== "server" || reporter.reporter === "hub"));

  return (
    <div className="space-y-6 sys-screen state-screen">
      <PageHeader fresh={freshOf(query)} />
      {stale && (
        <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}>
          {staleDataText(query.dataUpdatedAt)}
        </Notice>
      )}

      {query.isLoading && !data ? (
        <div className="card"><TableSkeleton rows={6} columns={3} /></div>
      ) : !data ? (
        <div className="card"><NoAnswerPanel retry={query.refetch} /></div>
      ) : (
        <>
          {problems > 0 ? (
            <Notice tone="danger" role="status">
              Требуют внимания: {problems}. Они наверху своих блоков.
            </Notice>
          ) : (
            <Notice tone="success" role="status">Проблем нет: всё, что проверено, работает вовремя.</Notice>
          )}

          <ServerBlock server={data.server} ledger={data.routines.find((routine) => routine.key === "server.ledger.service")} />

          <section className="card" aria-labelledby="state-routines-title">
            <div className="card-header">
              <h2 id="state-routines-title" className="card-title">Рутины</h2>
              <span className="card-description">Что работает само: на сервере, на маке и на ПК</span>
            </div>
            {PLACES.map((place) => (
              <PlaceGroup
                key={place}
                place={place}
                routines={data.routines.filter((routine) => routine.place === place)}
                reporter={reporterOf(place)}
              />
            ))}
          </section>

          <section className="card" aria-labelledby="state-copies-title">
            <div className="card-header">
              <h2 id="state-copies-title" className="card-title">Копии</h2>
              <span className="card-description">Старше {data.limits.copyStaleHours} ч: проблема</span>
            </div>
            {data.copies.length === 0
              ? <StatusPanel title="Копии пока никто не прислал" description="Сборщик мака присылает их вместе с рутинами." />
              : <CopyRows copies={data.copies} limitHours={data.limits.copyStaleHours} />}
          </section>
        </>
      )}

      <Disclosure label="Как это считается">
        <p>
          Рутина молчит, если не запускалась дольше двух своих периодов и ещё 10 минут. Сбои подряд: два последних запуска
          кончились сбоем. Пустой вход: рутина работает, но ей нечего разбирать дольше порога, который задан для неё на маке.
          «Нечего делать» и «итог не виден» не считаются ни успехом, ни сбоем. Копия старше 36 часов устарела.
        </p>
        <p>
          Если мак не присылает состояние дольше {data?.limits.reporterSilentMinutes ?? 30} минут, его строки «не проверено»: не
          зелёные и не красные. В часы наблюдения за маком это само дело. Каждая проблема открывает дело у вас и закрывается
          сама, когда проходит. Время московское.
        </p>
      </Disclosure>
    </div>
  );
}

import { useCallback, useMemo, useState } from "react";
import type { NotificationsIncidentItem } from "@agency_hub_core/contracts";
import { Power } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useNotificationIncidents } from "@/api/queries";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { Pagination } from "@/components/shared/Pagination";
import { staleDataText } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { RowMenu } from "@/components/ui/RowMenu";
import { Segmented } from "@/components/ui/Segmented";
import { formatDateTime } from "@/lib/format";
import { deliveryWord, FAILURE_KIND_GROUPS, failureKindLabel, failureWords, isOfapiOffFailure } from "@/lib/failures";
import { buildPageRoute } from "@/lib/navigation";
import { ruPlural } from "@/lib/plural";
import { isPlainRowClick } from "@/lib/rowClick";
import { FAILURE_CLOSED } from "@/lib/statusWords";
import { syncStreamLabel } from "@/pages/settings/sync/syncVocabulary";
import { freshOf, OfapiUnknownNotice, useOfapi, WhenCell } from "../shared.js";
import { CloseFailureDialog } from "./CloseFailureDialog.js";
import { FailureDrawer } from "./FailureDrawer.js";

const LIMIT = 50;
/** The open ones: the same read as the count of «Ждут вас». */
const OPEN_LIMIT = 200;

type StatusFilter = "open" | "resolved" | "all";

function statusOf(search: URLSearchParams): StatusFilter {
  const value = search.get("status");
  return value === "resolved" || value === "all" ? value : "open";
}

function FailureDot({ item, off }: { item: NotificationsIncidentItem; off: boolean }) {
  if (item.status !== "open") return null;
  const tone = off ? "status-dot-off" : item.kind === "ofapi_platform_notice" ? "status-dot-warn" : "status-dot-error";
  return <span className={`status-dot ${tone}`} aria-hidden="true" />;
}

function DeliveryCell({ item }: { item: NotificationsIncidentItem }) {
  const word = deliveryWord(item);
  if (word.look === "warning") return <span className="badge badge-bare badge-warning">{word.text}</span>;
  return <span className={word.look === "quiet" ? "text-text-secondary" : undefined}>{word.text}</span>;
}

function FailureRows({ items, off, onOpen, onClose, closing }: {
  items: readonly NotificationsIncidentItem[];
  /** The grey group: the switched-off OnlyFans API, nothing to repair. */
  off: boolean;
  onOpen: (item: NotificationsIncidentItem) => void;
  onClose: (item: NotificationsIncidentItem) => void;
  closing: boolean;
}) {
  const navigate = useNavigate();
  return (
    <div className="table-wrap">
      <table className="data-table sys-failures">
        <thead>
          <tr>
            <th>Сбой</th>
            <th>Страница</th>
            <th className="sys-col-opened">Открыт</th>
            <th className="sys-col-telegram">Telegram</th>
            <th><span className="sr-only">Действия</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const words = failureWords(item);
            const open = item.status === "open";
            const second = off ? "Сбор через OnlyFans API не идёт." : `${words.what} ${words.todo}`;
            // A closed failure has nothing to repair: no button of where.
            const fix = off || !open ? null : words.fix;
            return (
              <tr
                key={item.id}
                className="sys-click-row"
                data-failure={item.id}
                onClick={(event) => {
                  if (isPlainRowClick(event)) onOpen(item);
                }}
              >
                <td className="sys-failure-cell">
                  <span className="sys-failure-title">
                    <FailureDot item={item} off={off} />
                    <button type="button" className="sys-row-link" onClick={() => onOpen(item)}>{words.title}</button>
                    {!open && <span className="badge badge-off">{FAILURE_CLOSED.word}</span>}
                  </span>
                  <span className="cell-second sys-clamp">{second}</span>
                  {item.stream && <span className="cell-second">поток: {syncStreamLabel(item.stream)}</span>}
                </td>
                <td className="whitespace-nowrap">
                  {item.pageLabel
                    ? <Link to={buildPageRoute(item.pageLabel)} className="sys-row-link font-medium">{item.pageLabel}</Link>
                    : <span className="text-text-secondary">Вся система</span>}
                </td>
                <td className="sys-col-opened">
                  <WhenCell at={item.openedAt} />
                  {!open && item.resolvedAt && (
                    <span className="cell-second whitespace-nowrap">закрыт {formatDateTime(item.resolvedAt, { yearUnlessCurrent: true })}</span>
                  )}
                </td>
                <td className="sys-col-telegram whitespace-nowrap"><DeliveryCell item={item} /></td>
                <td className="sys-actions">
                  <div className="sys-actions-inner">
                    {fix
                      ? <Link to={fix.to} className="btn btn-sm sys-fix-btn">{fix.label}</Link>
                      : open && !off && (
                        <button type="button" className="btn btn-sm" disabled={closing} onClick={() => onClose(item)}>Закрыть сбой</button>
                      )}
                    <RowMenu
                      label={`Ещё: ${words.title}`}
                      items={[
                        { label: "Подробнее", onSelect: () => onOpen(item) },
                        ...(fix ? [{ label: fix.label, onSelect: () => navigate(fix.to) }] : []),
                        ...(open ? [{ label: "Закрыть сбой", onSelect: () => onClose(item), disabled: closing }] : []),
                      ]}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** «Сбои»: what broke, what to do and where it is repaired (design/screens/system.md §4). */
export function FailuresPage() {
  const [search, setSearch] = useSearchParams();
  const filter = usePageFilter();
  const ofapi = useOfapi();
  const status = statusOf(search);
  const kind = search.get("kind") ?? undefined;
  const offset = Math.max(0, Number(search.get("offset") ?? 0) || 0);
  const failureId = search.get("failure");
  const pageLabel = filter.page ?? undefined;

  const narrow = { ...(kind ? { kind } : {}), ...(pageLabel ? { pageLabel } : {}) };
  const params = status === "open"
    ? { status: "open", ...narrow, limit: OPEN_LIMIT }
    : { ...(status === "resolved" ? { status: "resolved" } : {}), ...narrow, limit: LIMIT, offset };
  const list = useNotificationIncidents(params);
  // Every open failure: the same read as «Ждут вас», for the line about what the filter hides.
  const everyOpen = useNotificationIncidents({ status: "open", limit: OPEN_LIMIT });
  const [closing, setClosing] = useState<NotificationsIncidentItem | null>(null);

  const change = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setSearch(next);
  }, [search, setSearch]);
  // A filter's change goes back to the first page and closes the panel.
  const refilter = (patch: Record<string, string | null>) => change({ ...patch, offset: null, failure: null });

  const ofapiOff = ofapi.status === "off";
  const items = list.data?.items ?? [];
  const greyed = ofapiOff && status !== "resolved" ? items.filter((item) => item.status === "open" && isOfapiOffFailure(item)) : [];
  const main = items.filter((item) => !greyed.includes(item));
  const selected = failureId === null ? null : items.find((item) => String(item.id) === failureId) ?? null;

  const elsewhere = useMemo(() => {
    if (!pageLabel || !everyOpen.data) return null;
    const others = everyOpen.data.items.filter((item) => item.pageLabel !== pageLabel && !(ofapiOff && isOfapiOffFailure(item)));
    return { count: others.length, global: others.filter((item) => item.pageLabel === null).length };
  }, [everyOpen.data, ofapiOff, pageLabel]);

  const stale = list.isError && list.data !== undefined;
  const open = (item: NotificationsIncidentItem) => change({ failure: String(item.id) });

  return (
    <div className="space-y-6 sys-screen">
      <PageHeader fresh={freshOf(list, [everyOpen])} />
      <OfapiUnknownNotice ofapi={ofapi} />

      <div className="space-y-3">
        <div className="table-toolbar sys-toolbar">
          <Segmented
            label="Какие сбои"
            value={status}
            onChange={(value) => refilter({ status: value === "open" ? null : value })}
            options={[
              { value: "open", label: "Открытые", count: status === "open" && list.data ? main.length : undefined },
              { value: "resolved", label: "Закрытые" },
              { value: "all", label: "Все" },
            ]}
          />
          <select
            aria-label="Вид сбоя"
            className="select sys-select"
            value={kind ?? ""}
            onChange={(event) => refilter({ kind: event.target.value || null })}
          >
            <option value="">Все виды</option>
            {FAILURE_KIND_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.kinds.map((value) => <option key={value} value={value}>{failureKindLabel(value)}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        {pageLabel && (
          <p className="table-toolbar-note">
            Показаны сбои {pageLabel}.
            {elsewhere && elsewhere.count > 0 && (
              <> В других местах открыто ещё {elsewhere.count}{elsewhere.global > 0 ? `, из них ${elsewhere.global} всей системы` : ""}.</>
            )}{" "}
            <button type="button" className="link" onClick={() => filter.select(null)}>Показать все страницы</button>
          </p>
        )}
      </div>

      {stale && (
        <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void list.refetch()}>Повторить</button>}>
          {staleDataText(list.dataUpdatedAt)}
        </Notice>
      )}

      {list.isLoading && !list.data ? (
        <div className="card"><TableSkeleton rows={5} columns={5} /></div>
      ) : !list.data ? (
        <div className="card"><NoAnswerPanel retry={list.refetch} /></div>
      ) : main.length === 0 && greyed.length === 0 ? (
        <div className="card">
          {offset > 0 ? (
            <StatusPanel
              title="На этой странице списка сбоев нет"
              action={<button type="button" className="btn btn-sm" onClick={() => change({ offset: null })}>К первой странице</button>}
            />
          ) : status === "open" && !kind && pageLabel ? (
            <StatusPanel
              title={`На ${pageLabel} открытых сбоев нет`}
              action={<button type="button" className="btn btn-sm" onClick={() => filter.select(null)}>Показать все страницы</button>}
            />
          ) : status === "open" && !kind ? (
            <StatusPanel title="Открытых сбоев нет" description="Если что-то сломается, сбой появится здесь и в «Ждут вас»." />
          ) : (
            <StatusPanel
              title="Под эти фильтры сбоев нет"
              description="Пустой список с фильтром ничего не говорит о системе в целом."
              action={<button type="button" className="btn btn-sm" onClick={() => refilter({ status: null, kind: null })}>Сбросить фильтры</button>}
            />
          )}
        </div>
      ) : (
        <>
          {main.length > 0 ? (
            <section className="card" aria-label="Сбои">
              <FailureRows items={main} off={false} onOpen={open} onClose={setClosing} closing={list.isError} />
              {status === "open" && list.data.total > OPEN_LIMIT && (
                <p className="card-footer">Показаны первые {OPEN_LIMIT} из {list.data.total}.</p>
              )}
              {status !== "open" && list.data.total > LIMIT && (
                <Pagination
                  offset={offset}
                  limit={LIMIT}
                  total={list.data.total}
                  onPageChange={(next) => change({ offset: next === 0 ? null : String(next), failure: null })}
                />
              )}
            </section>
          ) : (
            <div className="card">
              <StatusPanel title="Открытых сбоев нет" description="Ниже только сбои выключенного OnlyFans API: чинить их нечего." />
            </div>
          )}
          {greyed.length > 0 && (
            <details className="card sys-off-group" data-failures-off>
              <summary className="sys-off-summary">
                <Power size={16} aria-hidden="true" className="sys-off-icon" />
                <span className="min-w-0 flex-1">
                  <span className="sys-off-title">
                    OnlyFans API выключен · {greyed.length} {ruPlural(greyed.length, "сбой", "сбоя", "сбоев")}
                  </span>
                  <span className="cell-second">Пока API выключен, чинить нечего. Эти сбои не считаются в «Ждут вас».</span>
                </span>
                <Link to="/system/onlyfans-api" className="link sys-off-link">Что это значит</Link>
              </summary>
              <FailureRows items={greyed} off onOpen={open} onClose={setClosing} closing={list.isError} />
            </details>
          )}
        </>
      )}

      <Disclosure label="Как это считается">
        <p>
          Сбой открывается сам, когда Hub замечает проблему, и обычно сам закрывается, когда она прошла. Закрыть вручную нужно те,
          что сами не закрываются. Без страницы — сбои всей системы: при выбранной странице они скрыты. «Ждут вас» считает
          открытые сбои, кроме серой группы и «Входа заблокирован», который уже посчитан строкой «Нужен вход в Fansly».
        </p>
      </Disclosure>

      {failureId !== null && list.data && (
        <FailureDrawer
          id={failureId}
          item={selected}
          off={selected !== null && greyed.includes(selected)}
          closing={list.isError}
          onCloseFailure={setClosing}
          onShowAll={() => change({ status: "all", kind: null, offset: null })}
          onDismiss={() => change({ failure: null })}
        />
      )}

      {closing && (
        <CloseFailureDialog
          item={closing}
          onDone={(closed) => {
            const id = String(closing.id);
            setClosing(null);
            if (closed && failureId === id) change({ failure: null });
          }}
        />
      )}
    </div>
  );
}

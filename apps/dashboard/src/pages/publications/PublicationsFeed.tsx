import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router";
import type { PublicationWire } from "@agency_hub_core/contracts";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { RowMenu, type RowMenuItem } from "@/components/ui/RowMenu";
import { Skeleton } from "@/components/ui/Skeleton";
import { isPlainRowClick } from "@/lib/rowClick";
import { buildPostUrl } from "@/lib/platformUrls";
import { OFAPI_OFF_REASON } from "@/lib/statusWords";
import {
  deletePostBlock,
  feedCountLabel,
  isCancellable,
  manualSubLine,
  platformName,
  postSubLine,
  priceLabel,
  rowNote,
  statusWord,
  textStart,
  timeOf,
  withdrawBlock,
  type FeedDay,
  type PagePublishing,
} from "./publicationsView.js";

/** A checkbox that can say "some of these". */
export function Checkbox({ checked, indeterminate = false, disabled = false, label, onChange }: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="pub-check"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      title={label}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

/**
 * What a row can do. Every handler takes the row's own publication: the page
 * filter never reaches here (design/ia.md §0).
 */
export interface RowActions {
  busy: boolean;
  /** Pages Hub stopped by itself: nothing is withdrawn or deleted for them. */
  stoppedPages: ReadonlySet<string>;
  /** OnlyFans pages while its API is off: approvals and withdrawals are off. */
  ofapiOffPages: ReadonlySet<string>;
  usernameOf: (pageLabel: string) => string | null;
  /** The address of a row's panel. */
  openHref: (publication: PublicationWire) => string;
  onOpen: (publication: PublicationWire) => void;
  onApprove: (publication: PublicationWire) => void;
  onCancel: (publication: PublicationWire) => void;
  onResolve: (publication: PublicationWire) => void;
  onWithdraw: (publication: PublicationWire) => void;
  onDeletePost: (publication: PublicationWire) => void;
  onReplace: (publication: PublicationWire) => void;
}

/** Why «Утвердить» is off for this row, or null. */
export function approveBlock(publication: PublicationWire, actions: Pick<RowActions, "ofapiOffPages">): string | null {
  if (publication.blocked) return "Есть замечания, которые не дают утвердить";
  if (actions.ofapiOffPages.has(publication.pageLabel)) return OFAPI_OFF_REASON;
  return null;
}

/** Why «Убрать из расписания» is off, undefined when the post has none. */
export function withdrawReason(publication: PublicationWire, actions: Pick<RowActions, "stoppedPages" | "ofapiOffPages">): string | null | undefined {
  const block = withdrawBlock(publication, actions.stoppedPages.has(publication.pageLabel), new Date());
  if (block === undefined) return undefined;
  return block ?? (actions.ofapiOffPages.has(publication.pageLabel) ? OFAPI_OFF_REASON : null);
}

/** The post on the platform, when it has a number and is not a story. */
export function platformPostLink(publication: PublicationWire, username: string | null): { label: string; url: string } | null {
  if (publication.kind === "story" || publication.platformPostRef === null) return null;
  const url = buildPostUrl(publication.platform, username, publication.platformPostRef);
  return url === null ? null : { label: `Открыть на ${platformName(publication.platform)}`, url };
}

function menuItems(publication: PublicationWire, actions: RowActions): RowMenuItem[] {
  const items: RowMenuItem[] = [{ label: "Открыть", onSelect: () => actions.onOpen(publication) }];
  const link = platformPostLink(publication, actions.usernameOf(publication.pageLabel));
  const deletion = deletePostBlock(publication, actions.stoppedPages.has(publication.pageLabel));
  const withdrawal = withdrawReason(publication, actions);
  if (publication.status === "published" && link) {
    items.push({ label: link.label, onSelect: () => window.open(link.url, "_blank", "noopener,noreferrer") });
  }
  if (deletion !== undefined) {
    items.push({ label: "Удалить со стены", danger: true, disabled: actions.busy || deletion !== null, hint: deletion ?? undefined, onSelect: () => actions.onDeletePost(publication) });
  }
  if (withdrawal !== undefined) {
    items.push({ label: "Убрать из расписания", danger: true, disabled: actions.busy || withdrawal !== null, hint: withdrawal ?? undefined, onSelect: () => actions.onWithdraw(publication) });
  }
  if (publication.status === "withdrawn") {
    items.push({ label: "Заменить", disabled: actions.busy, onSelect: () => actions.onReplace(publication) });
  }
  if (isCancellable(publication)) {
    items.push({ label: "Отменить публикацию", danger: true, disabled: actions.busy, onSelect: () => actions.onCancel(publication) });
  }
  return items;
}

function RowButtons({ publication, actions }: { publication: PublicationWire; actions: RowActions }) {
  let main: ReactNode = null;
  if (publication.status === "draft") {
    const block = approveBlock(publication, actions);
    main = (
      <button type="button" className="btn btn-sm" disabled={actions.busy || block !== null} title={block ?? undefined} onClick={() => actions.onApprove(publication)}>
        Утвердить
      </button>
    );
  } else if (publication.status === "unknown") {
    main = <button type="button" className="btn btn-sm" disabled={actions.busy} onClick={() => actions.onResolve(publication)}>Проверить</button>;
  }
  return (
    <div className="pub-row-actions">
      {main}
      <RowMenu label={`Действия: ${publication.pageLabel}, ${timeOf(publication.publishAt)}`} items={menuItems(publication, actions)} />
    </div>
  );
}

export interface FeedProps {
  days: readonly FeedDay[];
  todayKey: string;
  /** The page column: hidden when the chip names one page. */
  showPage: boolean;
  selection: ReadonlySet<number>;
  /** A row that may be ticked: approvable, and not OnlyFans while its API is off. */
  canSelect: (publication: PublicationWire) => boolean;
  /** The rows are the previous filter's: no ticking. */
  selectDisabled: boolean;
  onSelect: (ids: number[], checked: boolean) => void;
  pageStates: ReadonlyMap<string, PagePublishing>;
  actions: RowActions;
  dimmed: boolean;
  /** Above the header while something is ticked. */
  selectBar: ReactNode;
  footer: string;
}

const COLUMNS_WITH_PAGE = 7;

/**
 * One sheet, one table, the days as group rows: every day's columns line up.
 * A row opens its panel; a ticked one is approved with the others in one window.
 */
export function PublicationsFeed({ days, todayKey, showPage, selection, canSelect, selectDisabled, onSelect, pageStates, actions, dimmed, selectBar, footer }: FeedProps) {
  const columns = showPage ? COLUMNS_WITH_PAGE : COLUMNS_WITH_PAGE - 1;
  const selectable = days.flatMap((day) => day.rows.flatMap((row) => (row.kind === "post" && canSelect(row.publication) ? [row.publication.id] : [])));
  const chosen = selectable.filter((id) => selection.has(id)).length;

  return (
    <section className="card pub-feed" aria-label="Публикации по дням" aria-busy={dimmed}>
      {selectBar}
      <div className="table-wrap">
        <table className={`data-table data-table-sticky data-table-page pub-table ${dimmed ? "is-refreshing" : ""}`.trim()}>
          <colgroup>
            <col className="pub-col-check" />
            <col className="pub-col-time" />
            {showPage && <col className="pub-col-page" />}
            <col />
            <col className="pub-col-price" />
            <col className="pub-col-status" />
            <col className="pub-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">
                {selectable.length > 0 && (
                  <Checkbox
                    checked={chosen > 0 && chosen === selectable.length}
                    indeterminate={chosen > 0 && chosen < selectable.length}
                    disabled={selectDisabled}
                    label="Выбрать все черновики, которые можно утвердить"
                    onChange={(checked) => onSelect(selectable, checked)}
                  />
                )}
              </th>
              <th scope="col">Время</th>
              {showPage && <th scope="col">Страница</th>}
              <th scope="col">Пост</th>
              <th scope="col" className="num">Цена</th>
              <th scope="col">Статус</th>
              <th scope="col"><span className="sr-only">Действия</span></th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => {
              const dayIds = day.rows.flatMap((row) => (row.kind === "post" && canSelect(row.publication) ? [row.publication.id] : []));
              const dayChosen = dayIds.filter((id) => selection.has(id)).length;
              return (
                <DayRows
                  key={day.key}
                  day={day}
                  columns={columns}
                  dayIds={dayIds}
                  dayChosen={dayChosen}
                  todayKey={todayKey}
                  showPage={showPage}
                  selection={selection}
                  canSelect={canSelect}
                  selectDisabled={selectDisabled}
                  onSelect={onSelect}
                  pageStates={pageStates}
                  actions={actions}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="card-footer">{footer}</div>
    </section>
  );
}

function DayRows({ day, columns, dayIds, dayChosen, todayKey, showPage, selection, canSelect, selectDisabled, onSelect, pageStates, actions }: {
  day: FeedDay;
  columns: number;
  dayIds: number[];
  dayChosen: number;
} & Pick<FeedProps, "todayKey" | "showPage" | "selection" | "canSelect" | "selectDisabled" | "onSelect" | "pageStates" | "actions">) {
  return (
    <>
      <tr className="row-day">
        <td>
          {dayIds.length > 0 && (
            <Checkbox
              checked={dayChosen === dayIds.length}
              indeterminate={dayChosen > 0 && dayChosen < dayIds.length}
              disabled={selectDisabled}
              label={`Выбрать черновики дня: ${day.label}`}
              onChange={(checked) => onSelect(dayIds, checked)}
            />
          )}
        </td>
        <td colSpan={columns - 1}>
          <div className="pub-day">
            <span>{day.label} <span className="pub-day-count">· {feedCountLabel(day.total, day.manual)}</span></span>
            {dayIds.length > 0 && <span className="pub-day-count">Черновики дня: {dayIds.length}</span>}
          </div>
        </td>
      </tr>
      {day.rows.map((row) => {
        if (row.kind === "more") {
          return (
            <tr key={`more:${row.pageLabel}`} className="pub-row-manual">
              <td />
              <td colSpan={columns - 1} className="muted">{row.pageLabel}: и ещё {row.count}, поставлено вручную</td>
            </tr>
          );
        }
        if (row.kind === "manual") {
          const { entry, pageLabel, platform } = row.manual;
          return (
            <tr key={`manual:${pageLabel}:${entry.queueId}`} className="pub-row-manual">
              <td />
              <td className="pub-time">{entry.publishAt === null ? "—" : timeOf(entry.publishAt)}</td>
              {showPage && (
                <td>
                  <div className="pub-page">{pageLabel}</div>
                  <div className="post-sub">{platformName(platform)}</div>
                </td>
              )}
              <td className="pub-post">
                <div className="post-text pub-ellipsis">{textStart(entry.text, 140)}</div>
                <div className="post-sub">{manualSubLine(entry)}</div>
              </td>
              <td className="num">—</td>
              <td className="status-col"><StatusBadge tone="moving" bare>На площадке</StatusBadge></td>
              <td />
            </tr>
          );
        }
        const publication = row.publication;
        const ticked = selection.has(publication.id);
        const note = rowNote(publication, pageStates.get(publication.pageLabel), todayKey);
        const empty = publication.text.trim() === "";
        return (
          <tr
            key={publication.id}
            className={`pub-row ${ticked ? "is-selected" : ""}`.trim()}
            onClick={(event) => { if (isPlainRowClick(event)) actions.onOpen(publication); }}
          >
            <td>
              {canSelect(publication) && (
                <Checkbox
                  checked={ticked}
                  disabled={selectDisabled}
                  label={`Выбрать: ${publication.pageLabel}, ${timeOf(publication.publishAt)}`}
                  onChange={(checked) => onSelect([publication.id], checked)}
                />
              )}
            </td>
            <td className="pub-time">{timeOf(publication.publishAt)}</td>
            {showPage && (
              <td>
                <div className="pub-page">{publication.pageLabel}</div>
                <div className="post-sub">{platformName(publication.platform)}</div>
              </td>
            )}
            <td className="pub-post">
              <Link to={actions.openHref(publication)} replace className={`post-text pub-ellipsis pub-post-link ${empty ? "is-empty" : ""}`.trim()}>
                {textStart(publication.text, 140)}
              </Link>
              <div className="post-sub pub-ellipsis">{postSubLine(publication)}</div>
              {note && <div className={`post-note post-note-${note.tone} pub-ellipsis`} title={note.text}>{note.text}</div>}
            </td>
            <td className={`num ${publication.priceMills === null ? "muted" : ""}`.trim()}>{priceLabel(publication.priceMills)}</td>
            <td className="status-col"><StatusBadge status={statusWord(publication)} /></td>
            <td className="num"><RowButtons publication={publication} actions={actions} /></td>
          </tr>
        );
      })}
    </>
  );
}

/** The feed on its way: the same seven columns, six rows. */
export function FeedSkeleton() {
  return (
    <section className="card pub-feed" aria-hidden="true">
      <div className="table-wrap">
        <table className="data-table pub-table">
          <colgroup>
            <col className="pub-col-check" />
            <col className="pub-col-time" />
            <col className="pub-col-page" />
            <col />
            <col className="pub-col-price" />
            <col className="pub-col-status" />
            <col className="pub-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th />
              <th>Время</th>
              <th>Страница</th>
              <th>Пост</th>
              <th className="num">Цена</th>
              <th>Статус</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }, (_, index) => (
              <tr key={index} className="pub-row-skeleton">
                <td />
                <td><Skeleton width={40} /></td>
                <td><Skeleton width={56} /></td>
                <td>
                  <Skeleton width={`${50 + ((index * 13) % 35)}%`} />
                  <div className="mt-2"><Skeleton width={160} /></div>
                </td>
                <td className="num"><Skeleton width={48} className="ml-auto" /></td>
                <td><Skeleton width={96} /></td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}


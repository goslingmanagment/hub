import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { SpenderDetailResponse } from "@agency_hub_core/contracts";
import {
  usePageFanProfile,
  usePageFanProfileVersion,
  usePageFanProfileVersions,
  usePageFanTransactions,
} from "@/api/queries";
import { kernel } from "@/api/sdk";
import { FanIntelligenceMarkdown } from "@/components/page/FanIntelligenceMarkdown";
import { ChatPreviewPanel } from "@/components/shared/ChatPreviewPanel";
import { Pagination } from "@/components/shared/Pagination";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { TransactionState } from "@/components/shared/TransactionsPreviewPanel";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDate, formatDateTime, formatMills, formatSignedMills, transactionTypeLabel } from "@/lib/format";
import { buildFanProfileNavigation } from "@/lib/navigation";
import { TEAM_STATUS, type StatusWord } from "@/lib/statusWords";
import { pageSubscriptionState, subscriptionWords } from "../fanWords.js";

const TX_LIMIT = 50;

/** «На других страницах»: the platform's pages the viewer sees, the most money first. */
export function FanOtherPages({ detail, platform, platformUserId, platformName, period, backTo }: {
  detail: { data: SpenderDetailResponse | undefined; isError: boolean; refetch: () => unknown };
  platform: string;
  platformUserId: string;
  platformName: string;
  period: string;
  backTo: string;
}) {
  const others = (detail.data?.pages ?? []).filter((page) => !page.inScope).sort((a, b) => b.creatorNetAmountMills - a.creatorNetAmountMills);
  return (
    <section className="card" aria-labelledby="fan-other-title">
      <div className="card-header">
        <div>
          <h2 id="fan-other-title" className="card-title">На других страницах</h2>
          <p className="card-description">Только {platformName}. Другие площадки — в «Памяти».</p>
        </div>
      </div>
      <div className="card-body">
        {!detail.data ? (
          detail.isError ? <NoAnswerPanel retry={detail.refetch} /> : <Skeleton width="80%" />
        ) : others.length === 0 ? (
          <p className="fan-muted-line">На других страницах {platformName} этого фана нет.</p>
        ) : (
          <ul className="fan-other-list">
            {others.map((page) => {
              const nav = buildFanProfileNavigation(page.pageLabel, platform, platformUserId, backTo);
              const sub = subscriptionWords(pageSubscriptionState(page));
              return (
                <li key={page.pageLabel}>
                  <div className="fan-other-head">
                    <Link className="fan-link" to={`${nav.to}?${new URLSearchParams({ period })}`} state={nav.state}>{page.pageLabel}</Link>
                    <span className="fan-other-model">{page.modelName}</span>
                    <span className="fan-other-sum">{formatMills(page.creatorNetAmountMills)}</span>
                  </div>
                  <p className="fan-cell-sub">
                    {[sub.first === "—" ? null : sub.first, page.isFollower && page.followerSince ? `Фолловит с ${formatDate(page.followerSince)}` : null].filter(Boolean).join(" · ") || "Не подписан"}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/** «Переписка»: the last 25 messages, read only. */
export function FanChat({ pageLabel, platform, conversationId, rowState, owner }: {
  pageLabel: string;
  platform: string;
  conversationId: string | null;
  rowState: { isError: boolean; settled: boolean; refetch: () => unknown };
  owner: boolean;
}) {
  return (
    <section className="card" aria-labelledby="fan-chat-title">
      <div className="card-header">
        <div>
          <h2 id="fan-chat-title" className="card-title">Переписка</h2>
          <p className="card-description">Последние 25 сообщений. Написать отсюда нельзя.</p>
        </div>
      </div>
      <div className="card-body">
        {!rowState.settled ? (
          <Skeleton width="60%" />
        ) : conversationId ? (
          <ChatPreviewPanel pageLabel={pageLabel} platformConversationId={conversationId} platform={platform} owner={owner} />
        ) : rowState.isError ? (
          <NoAnswerPanel retry={rowState.refetch} />
        ) : (
          <p className="fan-muted-line">Переписки с этим фаном в Hub нет.</p>
        )}
      </div>
    </section>
  );
}

const CUSTOM_STATE: Readonly<Record<string, StatusWord | null>> = {
  ordered: TEAM_STATUS.customUnpaid,
  paid: TEAM_STATUS.customPaid,
  delivered: TEAM_STATUS.customDelivered,
};

const LINK_REASON: Readonly<Record<string, string>> = {
  same_alias: "то же имя у команды",
  same_username: "тот же ник",
  replaced_account: "новый аккаунт вместо старого",
};

const FACT_KINDS: ReadonlyArray<{ kind: string; title: string }> = [
  { kind: "about", title: "О себе" },
  { kind: "promise", title: "Обещали" },
  { kind: "agreement", title: "Договорились" },
];

/** «Память»: what Hub knows about the person from the chats, on every page. Read only (§8.6). */
export function FanMemory({ pageLabel, platformUserId, platformName }: { pageLabel: string; platformUserId: string; platformName: (platform: string) => string }) {
  const card = useQuery({
    queryKey: ["pageFanCard", pageLabel, platformUserId],
    queryFn: () => kernel.pageFanCard({ params: { pageLabel, platformUserId } as Parameters<typeof kernel.pageFanCard>[0]["params"] }),
    meta: { suppressGlobalError: true },
    retry: false,
  });
  const data = card.data;
  const others = data?.accounts.slice(1) ?? [];
  const empty = data && data.facts.length === 0 && data.customs.length === 0 && others.length === 0 && data.suggestions.length === 0;
  return (
    <section className="card" aria-labelledby="fan-memory-title">
      <div className="card-header">
        <div>
          <h2 id="fan-memory-title" className="card-title">Память</h2>
          <p className="card-description">Что Hub знает о человеке из переписки, на всех страницах. Менять факты и кастомы можно только в расширении.</p>
        </div>
      </div>
      <div className="card-body fan-memory">
        {!data ? (
          card.isError ? <NoAnswerPanel retry={card.refetch} /> : <><Skeleton width="70%" /><Skeleton width="55%" /></>
        ) : empty ? (
          <p className="fan-muted-line">Hub пока ничего не знает об этом человеке из переписки.</p>
        ) : (
          <div className="fan-memory-grid">
            {FACT_KINDS.map(({ kind, title }) => {
              const facts = data.facts.filter((fact) => fact.kind === kind);
              if (facts.length === 0) return null;
              return (
                <div key={kind} className="fan-memory-part">
                  <h3 className="fan-subtitle">{title}</h3>
                  <ul className="fan-memory-list">
                    {facts.map((fact) => (
                      <li key={fact.id}>
                        <p>{fact.text}</p>
                        <p className="fan-cell-sub">
                          {[fact.pageLabel, fact.messageAt ? formatDateTime(fact.messageAt, { yearUnlessCurrent: true }) : null, fact.source === "ai" ? "ИИ" : fact.author].filter(Boolean).join(" · ")}
                        </p>
                        {fact.quote && <p className="fan-quote">{fact.quote.from === "fan" ? "Фан" : "Модель"}: «{fact.quote.text}»</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {data.customs.length > 0 && (
              <div className="fan-memory-part">
                <h3 className="fan-subtitle">Кастомы</h3>
                <ul className="fan-memory-list">
                  {data.customs.map((custom) => {
                    const word = CUSTOM_STATE[custom.state];
                    return (
                      <li key={custom.id} className="fan-memory-row">
                        <div>
                          <p>{custom.description}</p>
                          <p className="fan-cell-sub">{[custom.pageLabel, custom.priceMills === null ? null : formatMills(custom.priceMills)].filter(Boolean).join(" · ")}</p>
                        </div>
                        {word ? <StatusBadge status={word} /> : custom.state === "cancelled" ? <StatusBadge tone="off">Отменён</StatusBadge> : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {others.length > 0 && (
              <div className="fan-memory-part">
                <h3 className="fan-subtitle">Другие аккаунты</h3>
                <ul className="fan-memory-list">
                  {others.map((account) => (
                    <li key={`${account.platform}:${account.fanRef}`} className="fan-memory-row">
                      <div>
                        <p>{account.displayName ?? (account.username ? `@${account.username}` : account.fanRef)}</p>
                        <p className="fan-cell-sub">{[platformName(account.platform), account.linkedBy ? `Подтвердил ${account.linkedBy}` : null].filter(Boolean).join(" · ")}</p>
                      </div>
                      {account.gone && <span className="badge">Ушёл</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.suggestions.length > 0 && (
              <div className="fan-memory-part">
                <h3 className="fan-subtitle">Похоже, это тот же человек</h3>
                <ul className="fan-memory-list">
                  {data.suggestions.map((suggestion) => (
                    <li key={`${suggestion.platform}:${suggestion.fanRef}`}>
                      <p>{suggestion.displayName ?? (suggestion.username ? `@${suggestion.username}` : suggestion.fanRef)}</p>
                      <p className="fan-cell-sub">
                        {[platformName(suggestion.platform), LINK_REASON[suggestion.reason] ?? null, `общее: ${suggestion.shared}`].filter(Boolean).join(" · ")}
                      </p>
                    </li>
                  ))}
                </ul>
                <p className="fan-muted-line">Решает чаттер в расширении.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** «Досье (ИИ)»: folded, the summary a chatter saved from the extension; its versions (§8.7). */
export function FanDossier({ pageLabel, platformUserId }: { pageLabel: string; platformUserId: string }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const latest = usePageFanProfile(pageLabel, platformUserId);
  const versions = usePageFanProfileVersions(pageLabel, platformUserId, { enabled: historyOpen });
  const chosen = usePageFanProfileVersion(pageLabel, platformUserId, selected, { enabled: selected !== null });
  const latestProfile = latest.data?.profile ?? null;
  const viewingOld = selected !== null;
  const shown = viewingOld ? chosen.data ?? null : latestProfile;
  const shownQuery = viewingOld ? chosen : latest;

  return (
    <details className="card fan-dossier" onToggle={(event) => { if (!event.currentTarget.open) setSelected(null); }}>
      <summary className="fan-dossier-summary">
        <span className="card-title">Досье (ИИ)</span>
        <span className="fan-card-meta">
          {latestProfile ? `Версия ${latestProfile.version} · ${formatDateTime(latestProfile.createdAt, { yearUnlessCurrent: true })}` : latest.isLoading ? "" : "нет"}
        </span>
      </summary>
      <div className="card-body">
        <p className="fan-muted-line">Полное саммари ИИ, которое чаттер сохранил из расширения.</p>
        {viewingOld && (
          <div className="fan-dossier-old">
            <span className="badge">Версия {selected}{shown && latestProfile?.version === selected ? " · текущая" : ""}</span>
            <button type="button" className="link" onClick={() => setSelected(null)}>К последней версии</button>
          </div>
        )}
        {shownQuery.isLoading ? (
          <><Skeleton width="90%" /><Skeleton width="70%" /></>
        ) : shownQuery.isError && !shown ? (
          viewingOld ? <p className="fan-muted-line">Не удалось загрузить выбранную версию.</p> : <NoAnswerPanel retry={shownQuery.refetch} />
        ) : shown ? (
          <FanIntelligenceMarkdown body={shown.body} />
        ) : (
          <p className="fan-muted-line">Досье пока нет. Оно появится, когда чаттер сохранит полное саммари в расширении.</p>
        )}
        <div className="fan-dossier-history">
          <button type="button" className="link" aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>
            {historyOpen ? "Скрыть историю версий" : "История версий"}
          </button>
          {historyOpen && (
            versions.isLoading ? <p className="fan-muted-line">Загружаем версии…</p>
              : versions.isError ? <NoAnswerPanel retry={versions.refetch} />
              : (versions.data?.items.length ?? 0) === 0 ? <p className="fan-muted-line">Сохранённых версий пока нет.</p>
              : (
                <ul className="fan-version-list">
                  {versions.data!.items.map((item) => (
                    <li key={item.version}>
                      <button type="button" className="fan-version" aria-pressed={selected === item.version} onClick={() => setSelected(item.version)}>
                        <span>Версия {item.version}{item.isCurrent && <span className="fan-version-current"> · текущая</span>}</span>
                        <span className="fan-cell-sub">{formatDateTime(item.createdAt, { yearUnlessCurrent: true })}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
          )}
        </div>
      </div>
    </details>
  );
}

/** «История операций»: every operation of the fan on this page, all time (§8.8). */
export function FanOperations({ pageLabel, platformUserId, offset, onOffset }: {
  pageLabel: string;
  platformUserId: string;
  offset: number;
  onOffset: (offset: number) => void;
}) {
  const query = usePageFanTransactions(pageLabel, platformUserId, { limit: TX_LIMIT, offset });
  const data = query.data;
  return (
    <section className="card" aria-labelledby="fan-history-title">
      <div className="card-header">
        <div>
          <h2 id="fan-history-title" className="card-title">
            История операций {data && <span className="card-title-count">{data.total}</span>}
          </h2>
          <p className="card-description">Все операции фана на {pageLabel}, за всё время.</p>
        </div>
      </div>
      {!data ? (
        query.isError ? <NoAnswerPanel retry={query.refetch} /> : <TableSkeleton rows={5} columns={5} />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table fan-table">
              <thead>
                <tr>
                  <th scope="col">Когда</th>
                  <th scope="col">Вид дохода</th>
                  <th scope="col">Статус</th>
                  <th scope="col" className="num">До комиссии</th>
                  <th scope="col" className="num">После комиссии</th>
                </tr>
              </thead>
              <tbody>
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="fan-empty-row">
                      <div className="empty">
                        <p className="empty-title">{offset > 0 ? "На этой странице списка записей нет." : "Операций пока нет."}</p>
                        {offset > 0 && <div className="empty-actions"><button type="button" className="btn btn-sm" onClick={() => onOffset(0)}>К началу списка</button></div>}
                      </div>
                    </td>
                  </tr>
                )}
                {data.items.map((tx) => (
                  <tr key={tx.transactionId}>
                    <td>{formatDateTime(tx.occurredAt, { yearUnlessCurrent: true })}</td>
                    <td>{transactionTypeLabel(tx.canonicalType)}</td>
                    <td className="status-col"><TransactionState state={tx.transactionState} /></td>
                    <td className="num muted">{formatMills(tx.amountMills)}</td>
                    <td className="num">{tx.netAmountMills < 0 ? formatSignedMills(tx.netAmountMills) : formatMills(tx.netAmountMills)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.total > 0 && <Pagination offset={offset} limit={TX_LIMIT} total={data.total} onPageChange={onOffset} />}
        </>
      )}
    </section>
  );
}

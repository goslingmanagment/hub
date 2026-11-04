import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useAuthMe, usePageFanDetail } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { PLATFORM_WORD } from "@/components/shared/PlatformBadge";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatCardSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { RowMenu } from "@/components/ui/RowMenu";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDate, formatDateTime } from "@/lib/format";
import { buildPageRoute, isSafeInAppPath, resolveFanProfileBackTarget } from "@/lib/navigation";
import { listOffset } from "@/lib/overviewNavigation";
import { PLATFORM_DISPLAY_NAME, resolveExternalLink, type ExternalLinkPlatform } from "@/lib/platformUrls";
import { GoneMark } from "./FanCell.js";
import { fanName, tierOf } from "./fanWords.js";
import { FanChat, FanDossier, FanMemory, FanOperations, FanOtherPages } from "./fan-card/FanBlocks.js";
import { FanMoneyBreakdown, FanMoneyTiles, useFanMoney } from "./fan-card/FanMoney.js";
import { FanNotes } from "./fan-card/FanNotes.js";
import { useFanRow, useFollowerChat } from "./fan-card/useFanRow.js";
import { useListParams } from "./listParts.js";

function hasRememberedReturn(state: unknown): boolean {
  return typeof state === "object" && state !== null && "backTo" in state && typeof state.backTo === "string" && isSafeInAppPath(state.backTo);
}

async function copy(url: string, kind: "chat" | "profile") {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    toast.error("Буфер обмена недоступен");
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast.success(kind === "chat" ? "Ссылка на чат скопирована" : "Ссылка на профиль скопирована");
  } catch {
    toast.error("Не удалось скопировать");
  }
}

/**
 * The fan's card on one page: who he is to this page and on the others. The page
 * and the fan come from the path; the filter does not touch them (§8).
 */
export function FanCardPage() {
  const params = useParams<{ pageLabel: string; platform: string; platformUserId: string }>();
  // As the old card: the router's own values, the same the note was always written with.
  const pageLabel = params.pageLabel ?? "";
  const platform = params.platform ?? "";
  const platformUserId = params.platformUserId ?? "";
  const location = useLocation();
  const navigate = useNavigate();
  const auth = useAuthMe();
  const owner = auth.data?.user.role === "owner";
  const principalId = auth.data?.user.id ?? null;
  const { findPageByLabel } = useDashboardShell();
  const catalogPage = findPageByLabel(pageLabel);
  const { key: period } = useScreenPeriod();
  const { search, update } = useListParams();
  const txOffset = listOffset(search.get("txOffset"));
  const backTo = resolveFanProfileBackTarget(location.state, pageLabel);
  const routeKey = `${pageLabel}\0${platform}\0${platformUserId}`;

  const detail = usePageFanDetail(pageLabel, platformUserId);
  const money = useFanMoney(platform, platformUserId, pageLabel, period);
  const row = useFanRow({ pageLabel, platform, platformUserId });
  const needsFollower = platform === "fansly" && row.isSuccess && row.data === null;
  const follower = useFollowerChat(pageLabel, platformUserId, needsFollower);
  const conversationId = row.data?.conversation.platformConversationId
    ?? follower.data?.dm.platformConversationId
    ?? (platform === "onlyfans" && row.isSuccess ? platformUserId : null);
  const rowSettled = row.isSuccess && (!needsFollower || follower.isSuccess || follower.isError);

  const site = PLATFORM_DISPLAY_NAME[platform as ExternalLinkPlatform] ?? PLATFORM_WORD[platform as "fansly"] ?? platform;
  const here = `${location.pathname}${location.search}`;
  const back = hasRememberedReturn(location.state) ? <Link to={backTo} className="link fan-back">← Назад</Link> : null;

  if (!detail.data) {
    const missing = (detail.error instanceof KernelApiError && detail.error.status === 404);
    if (detail.isError) {
      return (
        <div className="fan-screen">
          {back}
          {missing ? (
            <StatusPanel
              title={`Такого фана нет на ${pageLabel}`}
              description="Он мог удалить аккаунт или никогда не быть на этой странице."
              action={<button type="button" className="btn btn-sm" onClick={() => navigate(backTo)}>Назад к списку</button>}
            />
          ) : (
            <NoAnswerPanel retry={detail.refetch} />
          )}
        </div>
      );
    }
    return (
      <div className="fan-screen" aria-busy="true">
        <PageHeader description={<Skeleton width={320} />} />
        <StatCardSkeleton count={4} />
      </div>
    );
  }

  const { fan, page } = detail.data;
  if (fan.platform !== platform) {
    return (
      <div className="fan-screen">
        <StatusPanel title={`Такого фана нет на ${pageLabel}`} description="Он мог удалить аккаунт или никогда не быть на этой странице." action={<button type="button" className="btn btn-sm" onClick={() => navigate(backTo)}>Назад к списку</button>} />
      </div>
    );
  }
  const name = fanName(fan);
  const link = resolveExternalLink(platform as ExternalLinkPlatform, { username: fan.username, platformConversationId: conversationId });
  const profileLink = resolveExternalLink(platform as ExternalLinkPlatform, { username: fan.username });
  const tier = money.lifetimeQuery.data ? tierOf(money.lifetimeQuery.data.metrics.lifetime.scopeCreatorNetAmountMills) : null;
  const facts = [
    page.isSubscriber ? (page.subscriptionExpiresAt ? `Подписан до ${formatDate(page.subscriptionExpiresAt)}` : "Подписан") : null,
    page.isSubscriber && page.autoRenew === false ? `без автопродления${page.autoRenewOffDetectedAt ? ` с ${formatDate(page.autoRenewOffDetectedAt)}` : ""}` : null,
    page.isSubscriber && page.subscriberSince ? `Подписан с ${formatDate(page.subscriberSince)}` : null,
    page.isFollower && page.followerSince ? `Фолловит с ${formatDate(page.followerSince)}` : null,
  ].filter((value): value is string => value !== null);
  const miss = row.data?.accountLookupMissAt ?? null;

  return (
    <div className="fan-screen">
      <PageHeader
        title={name.label}
        description={
          <span className="fan-head-line">
            <Link className="fan-link" to={buildPageRoute(pageLabel)}>{pageLabel}</Link>
            <span>{page.modelName}</span>
            <span>{PLATFORM_WORD[fan.platform]}</span>
            {name.handle && <span>@{name.handle}</span>}
            {fan.createdAtExternal && <span>на площадке с {formatDate(fan.createdAtExternal, { includeYear: true })}</span>}
          </span>
        }
        actions={
          <>
            {link && (
              <a className="btn" href={link.url} target="_blank" rel="noreferrer">
                <ExternalLink size={16} aria-hidden="true" />
                {link.kind === "chat" ? `Открыть чат на ${site}` : `Открыть профиль на ${site}`}
              </a>
            )}
            <RowMenu
              label="Ещё"
              items={[
                ...(link?.kind === "chat" ? [{ label: `Скопировать ссылку на чат ${site}`, onSelect: () => void copy(link.url, "chat") }] : []),
                ...(profileLink ? [{ label: `Скопировать ссылку на профиль ${site}`, onSelect: () => void copy(profileLink.url, "profile") }] : []),
              ]}
            />
          </>
        }
      />
      {back}
      <QueryNotice error={detail.isError} stale retry={detail.refetch} at={detail.dataUpdatedAt} />
      {(facts.length > 0 || tier || miss) && (
        <p className="fan-facts">
          {facts.map((fact, index) => <span key={index}>{fact}</span>)}
          {tier && <span className="badge">{tier}</span>}
          {miss && <span className="fan-facts-gone"><GoneMark missAt={miss} /> страница не видит аккаунт, проверено {formatDateTime(miss, { yearUnlessCurrent: true })}</span>}
        </p>
      )}

      <FanMoneyTiles money={money} pageLabel={pageLabel} platformName={site} period={period} row={row.data} lastTransactionAt={page.lastTransactionAt} />

      <div className="fan-card-grid">
        <div className="fan-card-main">
          <FanMoneyBreakdown money={money} period={period} pageLabel={pageLabel} platform={platform} platformUserId={platformUserId} />
          <FanChat
            pageLabel={pageLabel}
            platform={catalogPage?.platform ?? platform}
            conversationId={conversationId}
            rowState={{ isError: row.isError, settled: rowSettled || row.isError, refetch: row.refetch }}
            owner={owner}
          />
        </div>
        <div className="fan-card-side">
          <FanNotes key={routeKey} pageLabel={pageLabel} platformUserId={platformUserId} routeKey={routeKey} principalId={principalId} notes={page.notes} owner={owner} />
          <FanOtherPages detail={money.lifetimeQuery} platform={platform} platformUserId={platformUserId} platformName={site} period={period} backTo={here} />
        </div>
      </div>

      <FanMemory pageLabel={pageLabel} platformUserId={platformUserId} platformName={(value) => PLATFORM_WORD[value as "fansly"] ?? value} />
      <FanDossier key={routeKey} pageLabel={pageLabel} platformUserId={platformUserId} />
      <FanOperations pageLabel={pageLabel} platformUserId={platformUserId} offset={txOffset} onOffset={(next) => update({ txOffset: next === 0 ? null : String(next) }, { keepPosition: true })} />

      <div className="help-row">
        <Disclosure>
          <p>За всё время и за период — после комиссии, по операциям этой страницы. Всего на {site} — по всем страницам {site}, которые вам видны.</p>
          <p>Уровень считается по тратам на этой странице за всё время: Кит от $500, VIP от $100, Постоянный от $50.</p>
        </Disclosure>
        <Disclosure label="Подробнее">
          <p>ID фана на площадке: <span className="tabular-nums text-text-primary">{platformUserId}</span></p>
        </Disclosure>
      </div>
    </div>
  );
}

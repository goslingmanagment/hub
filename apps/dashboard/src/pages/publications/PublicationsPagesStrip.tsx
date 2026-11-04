import { useNavigate } from "react-router";
import type { PublicationQueueSnapshotWire } from "@agency_hub_core/contracts";
import { RowMenu, type RowMenuItem } from "@/components/ui/RowMenu";
import { buildPageRoute, buildPageSectionRoute } from "@/lib/navigation";
import { buildProfileUrl } from "@/lib/platformUrls";
import { OFAPI_OFF_REASON } from "@/lib/statusWords";
import { platformName, type PagePublishing } from "./publicationsView.js";

export interface StripPage {
  pageLabel: string;
  platform: "fansly" | "onlyfans";
  username: string | null;
  state: PagePublishing;
  /** The platform's schedule as Hub last read it; undefined: no read, or the read failed. */
  queue: PublicationQueueSnapshotWire | undefined;
}

/** A dot of the page's state: a hollow ring when it is off on purpose. */
export function StateDot({ tone }: { tone: PagePublishing["tone"] }) {
  return <span className={`pub-dot pub-dot-${tone}`} aria-hidden="true" />;
}

/**
 * One element per Fansly and OnlyFans page, in the catalog's order: its state in
 * a dot and a word, a click narrows the feed, «⋯» holds what is done with the
 * page. Every item of the menu acts on that page, never on the filter's.
 */
export function PublicationsPagesStrip({ pages, picked, loading, failed, onRetry, busy, refreshing, onPick, onEdit, onOpenSettings, onRefresh, onWithdrawAll }: {
  pages: readonly StripPage[];
  /** The page of the filter: drawn as a chosen chip. */
  picked: string | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  busy: boolean;
  refreshing: boolean;
  onPick: (pageLabel: string | null) => void;
  onEdit: (pageLabel: string) => void;
  onOpenSettings: () => void;
  onRefresh: (page: StripPage) => void;
  onWithdrawAll: (page: StripPage) => void;
}) {
  const navigate = useNavigate();
  const settingsButton = <button type="button" className="btn btn-sm pub-strip-settings" onClick={onOpenSettings}>Настройки публикации</button>;

  if (loading) {
    return (
      <div className="pub-strip" aria-hidden="true">
        {Array.from({ length: 8 }, (_, index) => <span key={index} className="pub-strip-item pub-strip-skeleton" />)}
      </div>
    );
  }
  if (failed) {
    return (
      <div className="pub-strip">
        <p className="pub-strip-note" role="alert">
          Настройки страниц не загрузились.{" "}
          <button type="button" className="link" onClick={onRetry}>Повторить</button>
        </p>
        {settingsButton}
      </div>
    );
  }
  if (pages.length === 0) {
    return (
      <div className="pub-strip">
        <p className="pub-strip-note">Нет активных страниц.</p>
        {settingsButton}
      </div>
    );
  }

  return (
    <div className="pub-strip" role="group" aria-label="Страницы">
      {pages.map((page) => {
        const isPicked = picked === page.pageLabel;
        const { state, queue } = page;
        const profile = buildProfileUrl(page.platform, page.username);
        const ofapiBlock = state.ofapiOff ? OFAPI_OFF_REASON : null;
        const items: RowMenuItem[] = [
          { label: `Настройки публикации ${page.pageLabel}`, onSelect: () => onEdit(page.pageLabel) },
        ];
        if (state.action === "login") {
          items.push({ label: "Войти в Fansly", onSelect: () => navigate(buildPageSectionRoute(page.pageLabel, "browser-login")) });
        }
        if (queue !== undefined) {
          const requested = queue.refreshRequestedAt !== null;
          items.push({
            label: requested ? "Чтение запрошено…" : "Прочитать расписание заново",
            disabled: busy || refreshing || requested || ofapiBlock !== null,
            hint: ofapiBlock ?? undefined,
            onSelect: () => onRefresh(page),
          });
        }
        items.push({ label: "Открыть карточку страницы", onSelect: () => navigate(buildPageRoute(page.pageLabel)) });
        if (profile !== null) {
          items.push({ label: `Открыть страницу на ${platformName(page.platform)}`, onSelect: () => window.open(profile, "_blank", "noopener,noreferrer") });
        }
        if (queue !== undefined) {
          const block = ofapiBlock ?? (state.stopped ? "Публикация на странице остановлена: убрать нельзя, расписание на площадке осталось" : null);
          items.push({
            label: "Убрать из расписания всё, что поставил Hub",
            danger: true,
            disabled: busy || refreshing || block !== null,
            hint: block ?? undefined,
            onSelect: () => onWithdrawAll(page),
          });
        }
        return (
          <div key={page.pageLabel} className={`pub-strip-item ${isPicked ? "is-picked" : ""}`.trim()}>
            <button
              type="button"
              className="pub-strip-pick"
              aria-pressed={isPicked}
              title={isPicked ? "Показать все страницы" : `Показать только ${page.pageLabel}`}
              onClick={() => onPick(isPicked ? null : page.pageLabel)}
            >
              <StateDot tone={state.tone} />
              <span className="pub-strip-label">{page.pageLabel}</span>
              {state.word !== null && <span className={`pub-strip-word pub-strip-word-${state.tone}`} title={state.reason}>{state.word}</span>}
            </button>
            <RowMenu label={`Действия страницы ${page.pageLabel}`} items={items} />
          </div>
        );
      })}
      {settingsButton}
    </div>
  );
}

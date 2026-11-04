/**
 * What the system screens share: the owner's view of the OnlyFans API switch, its
 * two notices, the screen's freshness and the plain pieces of a table row.
 */
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { useAuthMe } from "@/api/queries";
import { useOfapiStatusQuery } from "@/api/waiting";
import type { PageFreshness } from "@/components/ui/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { formatDateTime, formatAgo, formatMomentAgo } from "@/lib/format";
import { OFAPI_OFF_REASON, ofapiWriteBlock, type OfapiStatus } from "@/lib/statusWords";

/** The session's role; «» while it is unknown. */
export function useRole(): string {
  return useAuthMe().data?.user.role ?? "";
}

export interface OfapiView {
  status: OfapiStatus;
  isLoading: boolean;
  refetch: () => void;
  /** Why a write of the vendor is off; null only when the key is known to be set. */
  block: string | null;
}

/** Whether the OnlyFans API is on, for the screen's buttons and notices (system.md §0.2). */
export function useOfapi(): OfapiView {
  const query = useOfapiStatusQuery(useRole());
  return { ...query, block: ofapiWriteBlock(query.status) };
}

/** `unknown` with no answer: say nothing is claimed, offer a retry. While the read runs: nothing. */
export function OfapiUnknownNotice({ ofapi }: { ofapi: OfapiView }) {
  if (ofapi.status !== "unknown" || ofapi.isLoading) return null;
  return (
    <Notice
      tone="warning"
      role="alert"
      action={<button type="button" className="btn btn-sm" onClick={ofapi.refetch}>Повторить</button>}
    >
      Не удалось проверить, включён ли OnlyFans API. Кнопки записи отключены, пока Hub не ответит.
    </Notice>
  );
}

/** «OnlyFans API выключен с 1 ноября.» and the screen's sentence, with «Что это значит». */
export function OfapiOffBanner({ children, link = true }: { children?: ReactNode; link?: boolean }) {
  return (
    <Notice
      tone="off"
      action={link ? <Link to="/system/onlyfans-api" className="btn btn-sm">Что это значит</Link> : undefined}
    >
      <b className="font-medium">{OFAPI_OFF_REASON}.</b>{children ? <> {children}</> : null}
    </Notice>
  );
}

/** The freshness of a screen's main read: «Обновлено в 23:41, 5 мин назад», the refresh button. */
export function freshOf(query: { dataUpdatedAt: number; isFetching: boolean; refetch: () => unknown }, more: Array<{ refetch: () => unknown }> = []): PageFreshness | undefined {
  if (query.dataUpdatedAt === 0) return undefined;
  return {
    at: query.dataUpdatedAt,
    refreshing: query.isFetching,
    onRefresh: () => {
      void query.refetch();
      for (const other of more) void other.refetch();
    },
  };
}

/** «3 нояб., 14:05» over «8 ч назад»: an instant in a cell. */
export function WhenCell({ at, empty = "—" }: { at: string | null | undefined; empty?: string }) {
  if (!at) return <span className="text-text-secondary">{empty}</span>;
  return (
    <>
      <span className="block whitespace-nowrap">{formatDateTime(at, { yearUnlessCurrent: true })}</span>
      <span className="cell-second whitespace-nowrap">{formatAgo(at)}</span>
    </>
  );
}

/** «23:41, 5 мин назад» in one line, or the empty word. */
export function momentOr(at: string | null | undefined, empty = "—"): string {
  return at ? formatMomentAgo(at) : empty;
}

/** The chevron that opens a row. */
export function RowChevron({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="row-chevron"
      aria-expanded={open}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  );
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = { fansly: "Fansly", onlyfans: "OnlyFans", telegram: "Telegram" };

/** A platform as plain text. */
export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

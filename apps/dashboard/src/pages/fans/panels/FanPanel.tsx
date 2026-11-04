import { Link } from "react-router";
import { ChatPreviewPanel } from "@/components/shared/ChatPreviewPanel";
import { SpenderTrendPanel } from "@/components/shared/SpenderTrendPanel";
import { TransactionsPreviewPanel } from "@/components/shared/TransactionsPreviewPanel";
import { Drawer } from "@/components/ui/Drawer";
import { formatMills } from "@/lib/format";
import { SOURCE_LABELS } from "@/lib/revenueDisplay";
import { periodColumn } from "../fanWords.js";

export type PanelKind = "chat" | "operations" | "trend";

export function panelKind(value: string | null): PanelKind | null {
  return value === "chat" || value === "operations" || value === "trend" ? value : null;
}

const PANEL_WHAT: Readonly<Record<PanelKind, string>> = {
  chat: "Переписка, последние 25 сообщений",
  operations: "Операции",
  trend: "Траты по дням",
};

export interface PanelFan {
  platformUserId: string;
  name: string;
  platform: string;
  /** The row's own page; null on «Все страницы». */
  pageLabel: string | null;
  conversationId: string | null;
  cardHref: string;
  cardState: unknown;
  windowMills: number | null;
  windowCount: number | null;
  lifetimeMills: number | null;
  breakdown: ReadonlyArray<{ canonicalType: string; creatorNetAmountMills: number }> | null;
}

/**
 * A panel on the right of «Платящие»: the fan's chat, operations or money by day,
 * without losing the list. Its address is `?fan=&show=`. Nothing is written here.
 */
export function FanPanel({ kind, fan, period, owner, onClose }: {
  kind: PanelKind;
  fan: PanelFan;
  period: string;
  owner: boolean;
  onClose: () => void;
}) {
  const where = fan.pageLabel ? ` · ${fan.pageLabel}` : "";
  return (
    <Drawer title={fan.name} onClose={onClose}>
      <p className="drawer-what">{PANEL_WHAT[kind]}{where}</p>
      {kind === "chat" && (fan.pageLabel && fan.conversationId
        ? <ChatPreviewPanel pageLabel={fan.pageLabel} platformConversationId={fan.conversationId} platform={fan.platform} owner={owner} />
        : <div className="empty"><p className="empty-title">Переписки с этим фаном в Hub нет</p></div>)}
      {kind === "operations" && (
        <>
          <Breakdown period={period} rows={fan.breakdown} />
          <TransactionsPreviewPanel pageLabel={fan.pageLabel} platform={fan.platform} platformUserId={fan.platformUserId} />
        </>
      )}
      {kind === "trend" && (
        <SpenderTrendPanel
          pageLabel={fan.pageLabel}
          platform={fan.platform}
          platformUserId={fan.platformUserId}
          period={period}
          headline={period === "all"
            ? { label: "За всё время", mills: fan.lifetimeMills, count: null }
            : { label: periodColumn(period), mills: fan.windowMills, count: fan.windowCount }}
        />
      )}
      <div className="drawer-foot">
        <Link to={fan.cardHref} state={fan.cardState} className="link">Открыть карточку</Link>
      </div>
    </Drawer>
  );
}

/** «За 7 дней: Подписки $47.96 · Чаевые $371.38 · …», the server's sums. */
function Breakdown({ period, rows }: { period: string; rows: PanelFan["breakdown"] }) {
  const shown = (rows ?? []).filter((row) => row.creatorNetAmountMills !== 0);
  if (rows === null || shown.length === 0) return null;
  return (
    <p className="drawer-breakdown">
      <span className="text-text-secondary">{periodColumn(period)}:</span>{" "}
      {shown.map((row, index) => (
        <span key={row.canonicalType}>
          {index > 0 && " · "}
          {SOURCE_LABELS[row.canonicalType] ?? row.canonicalType} <span className="tabular-nums">{formatMills(row.creatorNetAmountMills)}</span>
        </span>
      ))}
    </p>
  );
}

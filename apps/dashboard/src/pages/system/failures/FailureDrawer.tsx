import type { NotificationsIncidentItem } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { Drawer } from "@/components/ui/Drawer";
import { Disclosure } from "@/components/ui/Disclosure";
import { KeyValue } from "@/components/ui/KeyValue";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { formatDateTime, formatAgo } from "@/lib/format";
import { deliveryReason, deliveryWord, failureKindLabel, failureWords } from "@/lib/failures";
import { buildPageRoute } from "@/lib/navigation";
import { FAILURE_CLOSED } from "@/lib/statusWords";
import { syncStreamLabel } from "@/pages/settings/sync/syncVocabulary";

function when(at: string | null): string | null {
  return at === null ? null : `${formatDateTime(at, { yearUnlessCurrent: true })}, ${formatAgo(at)}`;
}

/** One failure on the right, `?failure=<id>`: what happened in full, where it is repaired, the server's words under «Подробнее». */
export function FailureDrawer({ id, item, off, closing, onCloseFailure, onShowAll, onDismiss }: {
  id: string;
  item: NotificationsIncidentItem | null;
  off: boolean;
  /** The list did not refresh: closing waits, as before. */
  closing: boolean;
  onCloseFailure: (item: NotificationsIncidentItem) => void;
  onShowAll: () => void;
  onDismiss: () => void;
}) {
  if (item === null) {
    return (
      <Drawer title="Сбой" onClose={onDismiss}>
        <StatusPanel
          title={`Сбоя №${id} нет в этом списке.`}
          action={<button type="button" className="btn btn-sm" onClick={onShowAll}>Показать все</button>}
        />
      </Drawer>
    );
  }
  const words = failureWords(item);
  const open = item.status === "open";
  const delivery = deliveryWord(item);
  return (
    <Drawer title={failureKindLabel(item.kind)} onClose={onDismiss}>
      <div className="space-y-6">
        <p className="sys-drawer-lead">
          {open
            ? <span className={`status-dot ${off ? "status-dot-off" : item.kind === "ofapi_platform_notice" ? "status-dot-warn" : "status-dot-error"}`} aria-hidden="true" />
            : <span className="badge badge-off">{FAILURE_CLOSED.word}</span>}
          <span>{item.pageLabel ?? "Вся система"}</span>
          <span className="text-text-secondary">· открыт {formatDateTime(item.openedAt, { yearUnlessCurrent: true })}</span>
          {item.resolvedAt && <span className="text-text-secondary">· закрыт {formatDateTime(item.resolvedAt, { yearUnlessCurrent: true })}</span>}
        </p>

        <div className="space-y-3">
          <div>
            <p className="sys-label">Что случилось</p>
            <p>{off ? "Сбор через OnlyFans API не идёт: API выключен с 1 ноября." : words.what}</p>
          </div>
          <div>
            <p className="sys-label">Что делать</p>
            <p>{off ? "Ничего: пока API выключен, чинить нечего." : words.todo}</p>
          </div>
          {words.fix && !off && <Link to={words.fix.to} className="btn btn-sm">{words.fix.label}</Link>}
        </div>

        <KeyValue
          rows={[
            { label: "Страница", value: item.pageLabel ? <Link className="link" to={buildPageRoute(item.pageLabel)}>{item.pageLabel}</Link> : "Вся система" },
            { label: "Поток", value: item.stream ? syncStreamLabel(item.stream) : null },
            { label: "Открыт", value: when(item.openedAt) },
            { label: "Последний раз", value: when(item.lastSeenAt) },
            { label: "Закрыт", value: when(item.resolvedAt) },
            {
              label: "Telegram",
              value: (
                <span className="block">
                  {delivery.text}
                  <span className="cell-second">{deliveryReason(item)} <Link className="link" to="/settings/notifications">Настройки оповещений</Link></span>
                </span>
              ),
            },
          ]}
        />

        <Disclosure label="Подробнее">
          <KeyValue
            rows={[
              { label: "Сервер написал", value: item.errorSummary ? <span lang="en">{item.errorSummary}</span> : null },
              { label: "Код ошибки", value: item.errorCode ? <code className="sys-code">{item.errorCode}</code> : null },
              { label: "Ключ сбоя", value: <code className="sys-code">{item.incidentKey}</code> },
              { label: "Оповещений", value: String(item.notificationCount) },
              { label: "Ошибка отправки", value: item.outboxLastError },
              { label: "Почему не отправлялось", value: item.outboxSuppressionReason ? <code className="sys-code">{item.outboxSuppressionReason}</code> : null },
            ]}
          />
        </Disclosure>

        {open && (
          <button type="button" className="btn" disabled={closing} onClick={() => onCloseFailure(item)}>Закрыть сбой</button>
        )}
      </div>
    </Drawer>
  );
}

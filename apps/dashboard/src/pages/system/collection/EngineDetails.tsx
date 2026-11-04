import type { ReactNode } from "react";
import type { SyncBlocksPage } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { toast } from "sonner";
import { Disclosure } from "@/components/ui/Disclosure";
import { KeyValue, type KeyValueRow } from "@/components/ui/KeyValue";
import { buildPageSectionRoute } from "@/lib/navigation";
import { ruPlural } from "@/lib/plural";
import {
  browserAlarmText,
  browserBufferText,
  browserBufferTroubleLines,
  browserDeliveryText,
  browserExitIpText,
  browserHaltText,
  browserHeadline,
  browserLinkText,
  browserLoginText,
  browserOwnerStopText,
  browserSelfTestText,
  browserStateText,
  browserVersionsText,
  type EngineBrowser,
} from "@/pages/settings/engine/engineBrowserDisplay";
import {
  ENGINE_CLASS_LABELS,
  ENGINE_WORK_CLASSES,
  engineAgeText,
  engineClockText,
  engineCount,
  engineHoldText,
  engineOwnerText,
  engineSendsByResource,
  engineSendsLastHour,
  engineSocketText,
  engineWaitingText,
  type EnginePageStatus,
  type EngineStatusState,
} from "@/pages/settings/engine/engineDisplay";
import { engineDevCommands } from "@/pages/settings/engine/enginePageSummary";

function pauseText(status: EnginePageStatus): string {
  const parts = [`${engineCount(status.pause.settingMs)} мс`];
  if (status.pause.minGapLastHourMs !== null) parts.push(`наименьший промежуток за час ${engineCount(status.pause.minGapLastHourMs)} мс`);
  if (status.pause.violationsLastDay > 0) parts.push(`нарушений за сутки: ${status.pause.violationsLastDay}`);
  if (status.pause.siteCloseLastDay > 0) {
    parts.push(`запросов самого сайта ближе паузы за сутки: ${engineCount(status.pause.siteCloseLastDay)} (не нарушение)`);
  }
  return parts.join(" · ");
}

function StateRows({ status, now }: { status: EnginePageStatus; now: number }) {
  const lastSend = engineAgeText(status.pause.lastSendAt, now);
  const breakers = [
    status.breakers.open > 0 ? `повтор после ошибок: ${engineCount(status.breakers.open)}` : null,
    status.breakers.blockedByVendor > 0 ? `Fansly отказывает: ${engineCount(status.breakers.blockedByVendor)}` : null,
  ].filter((part): part is string => part !== null);
  const rows: KeyValueRow[] = [
    { label: "Сервер сбора", value: engineOwnerText(status, now) },
    { label: "Страница ждёт", value: engineHoldText(status, now) ?? "нет" },
  ];
  if (status.holds.resources.length > 0) {
    rows.push({ label: "Ждут после ошибок", value: status.holds.resources.map((hold) => `${hold.file} до ${engineClockText(hold.until, now)}`).join(", ") });
  }
  rows.push(
    { label: "Новые сообщения приходят сразу", value: engineSocketText(status, now) },
    {
      label: "Пауза между запросами",
      value: <>{pauseText(status)} · <Link className="link" to="/system/collection#config-fanslyDefaultDelayMs">Изменить</Link></>,
    },
    { label: "Последний запрос", value: lastSend === null ? "не было" : `${lastSend} назад` },
  );
  if (breakers.length > 0) rows.push({ label: "Защита от ошибок", value: breakers.join(" · ") });
  if (status.quarantined > 0) {
    rows.push({ label: "Отложено на разбор", value: `${engineCount(status.quarantined)} ${ruPlural(status.quarantined, "строка", "строки", "строк")}` });
  }
  return <KeyValue rows={rows} />;
}

function QueueTable({ status }: { status: EnginePageStatus }) {
  const runnable = ENGINE_WORK_CLASSES.reduce((sum, workClass) => sum + status.queue[workClass].runnable, 0);
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Очередь</th>
            <th className="num">Готово к запуску</th>
            <th>Ждёт</th>
            <th className="num">Запросов за час</th>
          </tr>
        </thead>
        <tbody>
          {ENGINE_WORK_CLASSES.map((workClass) => (
            <tr key={workClass}>
              <td>{ENGINE_CLASS_LABELS[workClass]}</td>
              <td className="num">{engineCount(status.queue[workClass].runnable)}</td>
              <td className="muted">{engineWaitingText(status.queue[workClass]) || "—"}</td>
              <td className="num">{engineCount(status.sendsLastHour[workClass])}</td>
            </tr>
          ))}
          <tr className="row-total">
            <td>Всего</td>
            <td className="num">{engineCount(runnable)}</td>
            <td />
            <td className="num">{engineCount(engineSendsLastHour(status))}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const HEADLINE_TONES: Record<ReturnType<typeof browserHeadline>["tone"], string> = {
  ok: "badge badge-bare badge-success",
  quiet: "badge badge-bare badge-info",
  warn: "badge badge-warning",
  danger: "badge badge-danger",
};

function BrowserRows({ browser, pageLabel, now }: { browser: EngineBrowser; pageLabel: string; now: number }) {
  const headline = browserHeadline(browser);
  const ownerStop = browserOwnerStopText(browser, now);
  const halt = browserHaltText(browser, now);
  const startAgain = "запуск — командой сервера ниже";
  const trouble = browserBufferTroubleLines(browser, now);
  const rows: KeyValueRow[] = [
    { label: "Браузер", value: <span className={HEADLINE_TONES[headline.tone]}>{headline.text.charAt(0).toUpperCase() + headline.text.slice(1)}</span> },
    { label: "Связь", value: browserLinkText(browser, now) },
    { label: "Состояние", value: browserStateText(browser, now) },
  ];
  if (ownerStop !== null) rows.push({ label: "Остановка", value: `${ownerStop} · ${startAgain}` });
  if (halt !== null) {
    rows.push({ label: "Решение", value: browser.halt?.reason === "login_required" ? `${halt} · решается входом в Fansly` : `${halt} · ${startAgain}` });
  }
  rows.push(
    {
      label: "Вход",
      value: <>{browserLoginText(browser)} · <Link className="link" to={buildPageSectionRoute(pageLabel, "browser-login")}>Войти в Fansly</Link></>,
    },
    { label: "Выходной IP", value: browserExitIpText(browser) },
    { label: "Буфер", value: <>{browserBufferText(browser)}{trouble.map((line) => <span key={line} className="block">{line}</span>)}</> },
    { label: "Доставка событий", value: browserDeliveryText(browser, now) },
    { label: "Версии", value: browserVersionsText(browser) },
    { label: "Самопроверка", value: browserSelfTestText(browser, now) },
  );
  const alarm = browserAlarmText(browser, now);
  if (alarm !== null) rows.push({ label: "Последняя тревога", value: alarm });
  return <KeyValue rows={rows} />;
}

async function copy(command: string) {
  try {
    await navigator.clipboard.writeText(command);
    toast.success("Команда скопирована");
  } catch {
    toast.error("Буфер обмена недоступен: выделите команду и скопируйте её вручную.");
  }
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="sys-part">
      <h3 className="sys-subtitle">{title}</h3>
      {children}
    </div>
  );
}

/** «Подробнее» of a Fansly page: the state of its collection, its browser and the server's commands (§3.1, block 6). */
export function EngineDetails({ page, state, now = Date.now() }: { page: SyncBlocksPage; state: EngineStatusState; now?: number }) {
  const status = state.kind === "ready" ? state.status : null;
  const commands = engineDevCommands(page, state);
  const resources = status ? engineSendsByResource(status) : [];
  return (
    <Disclosure label="Подробнее">
      <div className="sys-stack sys-details">
        <Part title="Состояние сбора">
          {status === null ? (
            <p>
              {state.kind === "loading" ? "Состояние сбора загружается." : state.kind === "error" ? "Состояние сбора не загрузилось." : "Сбор Fansly эту страницу не ведёт: её ничто не читает."}
            </p>
          ) : (
            <>
              <StateRows status={status} now={now} />
              <QueueTable status={status} />
              {resources.length > 0 && (
                <div>
                  <p className="sys-label">Запросов за час по ресурсам</p>
                  <div className="sys-chips">
                    {resources.map(({ resource, sends }) => (
                      <span key={resource} className="badge"><span className="sys-code">{resource}</span> · {engineCount(sends)}</span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </Part>
        {status?.browser !== undefined && status !== null && (
          <Part title="Браузер">
            <BrowserRows browser={status.browser} pageLabel={page.pageLabel} now={now} />
          </Part>
        )}
        {commands.length > 0 && (
          <Part title="Команды сервера">
            <p>Команды консоли сервера для того, что показано на этом экране.</p>
            <ul className="sys-commands">
              {commands.map((item) => (
                <li key={item.command}>
                  <span className="text-text-secondary">{item.label}</span>
                  <code className="sys-command">{item.command}</code>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(item.command)}>Скопировать</button>
                </li>
              ))}
            </ul>
          </Part>
        )}
      </div>
    </Disclosure>
  );
}

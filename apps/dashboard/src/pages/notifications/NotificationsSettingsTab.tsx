import { useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { toast } from "sonner";
import {
  useDiscoverTelegramChats,
  useNotificationsSettings,
  useSendTestMessage,
  useUpdateNotificationsSettings,
} from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { ModalShell } from "@/components/shared/ModalShell";
import { formatRelativeTime } from "@/lib/format";

type DiscoveredChat = { id: string; type: string; title: string };

function apiErrorMessage(error: unknown): string | undefined {
  return error instanceof Error && error.message ? error.message : undefined;
}

const CONNECTION_LABELS = {
  connected: { label: "Подключён", badge: "badge badge-success", dot: "status-dot status-dot-ok" },
  last_message_failed: { label: "Последнее сообщение не доставлено", badge: "badge badge-danger", dot: "status-dot status-dot-error" },
  untested: { label: "Ещё не проверен", badge: "badge", dot: "status-dot" },
} as const;

export function NotificationsSettingsTab() {
  const { data, isLoading, isError, error, refetch, isFetching } = useNotificationsSettings();
  const updateSettings = useUpdateNotificationsSettings();
  const sendTest = useSendTestMessage();
  const discoverChats = useDiscoverTelegramChats();
  const botTokenRef = useRef<HTMLInputElement>(null);
  const chatIdRef = useRef<HTMLInputElement>(null);
  const [detectedChats, setDetectedChats] = useState<DiscoveredChat[] | null>(null);
  const [botUsername, setBotUsername] = useState<string | null>(null);

  if (isLoading && !data) {
    return <StatusPanel title="Загружаем настройки уведомлений…" />;
  }

  if (!data) {
    return (
      <StatusPanel
        title="Настройки уведомлений не загрузились"
        description="Сервер не ответил. Попробуйте ещё раз."
        tone="error"
        action={<button type="button" disabled={isFetching} onClick={() => void refetch()} className="btn btn-sm">Повторить</button>}
      />
    );
  }

  const settings = data;

  function handleToggle(
    field:
      | "enabled"
      | "dailyReportEnabled"
      | "syncFailureAlertsEnabled"
      | "aiCriticalAlertsEnabled",
    value: boolean,
  ) {
    if (updateSettings.isPending || isError) return;
    updateSettings.mutate({ [field]: value }, { onError: (mutationError) => toast.error(apiErrorMessage(mutationError) ?? "Настройка не сохранилась") });
  }

  function handleReportHourChange(hour: number) {
    if (updateSettings.isPending || isError) return;
    updateSettings.mutate({ reportHourUtc: hour }, { onError: (mutationError) => toast.error(apiErrorMessage(mutationError) ?? "Час отчёта не сохранился") });
  }

  // After saving credentials, send a real test so the connection status reflects
  // an actual delivery rather than "credentials exist". A single toast reports
  // the connection outcome (and makes clear the creds were saved either way).
  function verifyAfterSave() {
    sendTest.mutate(undefined, {
      onSuccess: (result) => {
        if (result.status === "sent") {
          toast.success("Подключено — проверочное сообщение отправлено");
        } else {
          toast.error(result.error ?? "Сохранено, но проверочное сообщение не дошло");
        }
      },
      onError: () => toast.error("Сохранено, но проверочное сообщение не дошло"),
    });
  }

  async function handleSaveCredentials(): Promise<boolean> {
    if (updateSettings.isPending || sendTest.isPending || isError) return false;
    const botToken = botTokenRef.current?.value?.trim() || undefined;
    const chatId = chatIdRef.current?.value?.trim() || undefined;

    // A field is satisfied if it's already stored (DB or env) or entered now, so
    // a partial env config (e.g. token in env) lets the operator supply just the
    // missing piece instead of being forced to re-paste both.
    const haveToken = settings.botTokenSet || !!botToken;
    const haveChat = !!settings.chatId || !!chatId;
    if (!haveToken || !haveChat) {
      toast.error("Нужны и токен бота, и ID чата");
      return false;
    }

    if (!botToken && !chatId) {
      toast.error("Нечего сохранять");
      return false;
    }

    try {
      await updateSettings.mutateAsync({ botToken, chatId });
      setDetectedChats(null);
      if (botTokenRef.current) botTokenRef.current.value = "";
      verifyAfterSave();
      return true;
    } catch (mutationError) {
      toast.error(apiErrorMessage(mutationError) ?? "Не удалось сохранить данные Telegram");
      return false;
    }
  }

  async function handleClearCredentials(): Promise<boolean> {
    if (updateSettings.isPending || sendTest.isPending || isError) return false;
    if (!window.confirm("Удалить сохранённые токен бота и ID чата? Если они заданы в настройках сервера, снова начнут действовать те. Чтобы остановить автоматические уведомления, выключите «Уведомления включены».")) {
      return false;
    }
    try {
      await updateSettings.mutateAsync({ botToken: null, chatId: null });
      toast.success("Сохранённые данные удалены");
      setDetectedChats(null);
      setBotUsername(null);
      if (botTokenRef.current) botTokenRef.current.value = "";
      if (chatIdRef.current) chatIdRef.current.value = "";
      return true;
    } catch {
      toast.error("Не удалось удалить данные");
      return false;
    }
  }

  // Ask the backend to call getMe + getUpdates so the operator picks their chat
  // from a menu instead of hand-copying it out of a raw getUpdates URL.
  function handleDetectChats() {
    const botToken = botTokenRef.current?.value?.trim() || undefined;
    discoverChats.mutate({ botToken }, {
      onSuccess: (result) => {
        setBotUsername(result.botUsername);
        if (result.chats.length === 0) {
          setDetectedChats(null);
          toast.message("Чатов пока нет — откройте бота в Telegram, напишите ему что-нибудь и нажмите «Найти чат» ещё раз.");
          return;
        }
        if (result.chats.length === 1) {
          const only = result.chats[0]!;
          if (chatIdRef.current) chatIdRef.current.value = only.id;
          setDetectedChats(null);
          toast.success(`Найден чат: ${only.title}`);
          return;
        }
        setDetectedChats(result.chats);
        toast.success(`Найдено чатов: ${result.chats.length} — выберите нужный`);
      },
      onError: (error) => toast.error(apiErrorMessage(error) ?? "Не удалось связаться с Telegram"),
    });
  }

  function handlePickChat(id: string) {
    if (chatIdRef.current) chatIdRef.current.value = id;
    setDetectedChats(null);
  }

  function handleSendTest() {
    sendTest.mutate(undefined, {
      onSuccess: (result) => {
        if (result.status === "sent") {
          toast.success("Проверочное сообщение отправлено");
        } else {
          toast.error(result.error ?? "Проверочное сообщение не отправилось");
        }
      },
      onError: () => toast.error("Проверочное сообщение не отправилось"),
    });
  }

  const savePending = updateSettings.isPending || sendTest.isPending;
  const writesUnavailable = savePending || isError;
  const connection = CONNECTION_LABELS[settings.connectionStatus as keyof typeof CONNECTION_LABELS] ?? CONNECTION_LABELS.untested;

  return (
    <div className="space-y-5">
      {isError && (
        <div className="flex flex-wrap items-center gap-2">
          <StaleDataNotice title="Не удалось обновить настройки — введённое сохранено" error={error} className="flex-1" />
          <button type="button" disabled={isFetching} onClick={() => void refetch()} className="btn btn-sm">Повторить</button>
        </div>
      )}

      {!settings.configured ? (
        <section className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Подключите Telegram</h3>
              <p className="card-description">Hub будет присылать в чат оповещения о сбоях и ежедневный отчёт.</p>
            </div>
          </div>
          <ol className="card-body max-w-xl space-y-5">
            <Step number={1} title="Создайте бота у @BotFather в Telegram и вставьте его токен">
              <input
                ref={botTokenRef}
                aria-label="Токен бота"
                type="password"
                placeholder="7123456789:AAH…"
                className="input"
              />
              {botUsername && (
                <p className="field-hint text-green">Бот найден: @{botUsername}</p>
              )}
              {settings.botTokenSet && (
                <p className="field-hint">
                  Токен уже задан{settings.botTokenSource === "env" ? " в настройках сервера" : ""} — оставьте поле пустым, чтобы его не менять.
                </p>
              )}
            </Step>
            <Step number={2} title="Напишите боту любое сообщение и нажмите «Найти чат»">
              <ChatIdField
                chatIdRef={chatIdRef}
                defaultValue={settings.chatId ?? ""}
                onDetect={handleDetectChats}
                isDetecting={discoverChats.isPending}
                detectedChats={detectedChats}
                onPick={handlePickChat}
              />
            </Step>
            <Step number={3} title="Сохраните — Hub отправит проверочное сообщение">
              <button
                type="button"
                onClick={handleSaveCredentials}
                disabled={writesUnavailable}
                className="btn btn-primary"
              >
                {updateSettings.isPending ? "Сохраняем…" : sendTest.isPending ? "Проверяем…" : "Сохранить и проверить"}
              </button>
            </Step>
          </ol>
        </section>
      ) : (
        <section className="card">
          <div className="card-header">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="card-title">Telegram</h3>
                <span className={connection.badge}>
                  <span className={connection.dot} aria-hidden="true" />
                  {connection.label}
                </span>
              </div>
              <p className="card-description">
                {settings.chatId ? <>Чат {settings.chatId}{settings.chatIdSource === "env" && " (задан в настройках сервера)"}</> : "Чат не задан"}
                {settings.lastMessageAt && <> · последнее сообщение {formatRelativeTime(settings.lastMessageAt)}</>}
              </p>
              {settings.connectionStatus === "untested" && (
                <p className="card-description">Отправьте проверочное сообщение, чтобы убедиться, что оно доходит.</p>
              )}
              {settings.lastMessageError && (
                <p className="mt-1 text-[13px] text-danger">{settings.lastMessageError}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <CredentialsEdit
                chatId={settings.chatId}
                onClear={handleClearCredentials}
                onSave={handleSaveCredentials}
                botTokenRef={botTokenRef}
                chatIdRef={chatIdRef}
                isPending={savePending}
                writesUnavailable={isError}
                onDetect={handleDetectChats}
                isDetecting={discoverChats.isPending}
                detectedChats={detectedChats}
                onPick={handlePickChat}
                botUsername={botUsername}
              />
              <button
                type="button"
                onClick={handleSendTest}
                disabled={writesUnavailable}
                className="btn btn-sm"
              >
                {sendTest.isPending ? "Отправляем…" : "Отправить проверку"}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Что присылать</h3>
            <p className="card-description">Время отчёта — UTC.</p>
          </div>
        </div>
        <ul className="divide-y divide-border-light">
          <ToggleRow
            disabled={writesUnavailable}
            label="Уведомления включены"
            description="Если выключить, автоматические оповещения и отчёт по расписанию не отправляются. Ручные действия работают."
            checked={settings.enabled}
            onChange={(value) => handleToggle("enabled", value)}
          />
          <ToggleRow
            disabled={writesUnavailable}
            label="Ежедневный отчёт о доходе"
            description="Сводка дохода за прошедший день, каждый день в выбранный час."
            checked={settings.dailyReportEnabled}
            onChange={(value) => handleToggle("dailyReportEnabled", value)}
            extra={(
              <select
                aria-label="Час ежедневного отчёта (UTC)"
                disabled={writesUnavailable}
                value={settings.reportHourUtc}
                onChange={(event) => handleReportHourChange(Number(event.target.value))}
                className="select w-auto min-h-[34px] py-1.5"
              >
                {Array.from({ length: 24 }, (_, index) => (
                  <option key={index} value={index}>{String(index).padStart(2, "0")}:00 UTC</option>
                ))}
              </select>
            )}
          />
          <ToggleRow
            disabled={writesUnavailable}
            label="Сбои сбора данных"
            description="Сообщать, когда инцидент сбора открывается и закрывается."
            checked={settings.syncFailureAlertsEnabled}
            onChange={(value) => handleToggle("syncFailureAlertsEnabled", value)}
          />
          <ToggleRow
            disabled={writesUnavailable}
            label="Критичные сбои AI"
            description="Проблемы AI-провайдера — отдельно от сбоев сбора."
            checked={settings.aiCriticalAlertsEnabled}
            onChange={(value) => handleToggle("aiCriticalAlertsEnabled", value)}
          />
        </ul>
      </section>
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent"
      >
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium text-text-primary">{title}</p>
        {children}
      </div>
    </li>
  );
}

function ChatIdField({
  chatIdRef,
  defaultValue,
  onDetect,
  isDetecting,
  detectedChats,
  onPick,
}: {
  chatIdRef: RefObject<HTMLInputElement | null>;
  defaultValue: string;
  onDetect: () => void;
  isDetecting: boolean;
  detectedChats: DiscoveredChat[] | null;
  onPick: (id: string) => void;
}) {
  return (
    <div>
      <div className="flex gap-2">
        <input
          ref={chatIdRef}
          aria-label="ID чата"
          type="text"
          defaultValue={defaultValue}
          placeholder="ID чата: 123456789 или -100…"
          className="input"
        />
        <button
          type="button"
          onClick={onDetect}
          disabled={isDetecting}
          className="btn"
        >
          {isDetecting ? "Ищем…" : "Найти чат"}
        </button>
      </div>
      {detectedChats && detectedChats.length > 0 && (
        <div className="mt-2 space-y-1 rounded-lg border border-border bg-card p-1.5">
          {detectedChats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              onClick={() => onPick(chat.id)}
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover"
            >
              <span className="font-medium text-text-primary">{chat.title}</span>
              <span className="text-text-secondary">{chat.type} · {chat.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CredentialsEdit({
  chatId,
  onClear,
  onSave,
  botTokenRef,
  chatIdRef,
  isPending,
  writesUnavailable,
  onDetect,
  isDetecting,
  detectedChats,
  onPick,
  botUsername,
}: {
  chatId: string | null;
  onClear: () => Promise<boolean>;
  onSave: () => Promise<boolean>;
  botTokenRef: RefObject<HTMLInputElement | null>;
  chatIdRef: RefObject<HTMLInputElement | null>;
  isPending: boolean;
  writesUnavailable: boolean;
  onDetect: () => void;
  isDetecting: boolean;
  detectedChats: DiscoveredChat[] | null;
  onPick: (id: string) => void;
  botUsername: string | null;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn btn-sm">
        Изменить данные
      </button>
    );
  }

  return (
    <ModalShell title="Данные Telegram" onClose={() => { if (!isPending) setOpen(false); }}>
        <div className="space-y-4">
          <label className="block">
            <span className="field-label">Токен бота</span>
            <input
              ref={botTokenRef}
              aria-label="Токен бота"
              type="password"
              placeholder="Новый токен (пусто — оставить текущий)"
              className="input"
            />
            {botUsername && (
              <p className="field-hint text-green">Бот найден: @{botUsername}</p>
            )}
          </label>
          <div>
            <span className="field-label">ID чата</span>
            <ChatIdField
              chatIdRef={chatIdRef}
              defaultValue={chatId ?? ""}
              onDetect={onDetect}
              isDetecting={isDetecting}
              detectedChats={detectedChats}
              onPick={onPick}
            />
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void onClear().then((cleared) => { if (cleared) setOpen(false); })}
            disabled={isPending || writesUnavailable}
            className="btn btn-ghost mr-auto text-danger"
          >
            Удалить сохранённые данные
          </button>
          <button type="button" onClick={() => setOpen(false)} disabled={isPending} className="btn">
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void onSave().then((saved) => { if (saved) setOpen(false); })}
            disabled={isPending || writesUnavailable}
            className="btn btn-primary"
          >
            Сохранить и проверить
          </button>
        </div>
    </ModalShell>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  extra,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
  extra?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-4">
      <div className="min-w-0 flex-1 basis-60">
        <div className="text-sm font-medium text-text-primary">{label}</div>
        <div className="mt-0.5 text-[13px] text-text-secondary">{description}</div>
      </div>
      <div className="flex items-center gap-3">
        {extra}
        <button
          type="button"
          role="switch"
          aria-label={label}
          disabled={disabled}
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            checked ? "bg-accent" : "bg-border-strong"
          }`}
        >
          <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`} />
        </button>
      </div>
    </li>
  );
}

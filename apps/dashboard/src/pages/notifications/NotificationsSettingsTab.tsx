import { useRef, useState } from "react";
import type { RefObject } from "react";
import { toast } from "sonner";
import {
  useDiscoverTelegramChats,
  useNotificationsSettings,
  useSendTestMessage,
  useUpdateNotificationsSettings,
} from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { ModalShell } from "@/components/shared/ModalShell";
import { formatRelativeTime } from "@/lib/format";

type DiscoveredChat = { id: string; type: string; title: string };

function apiErrorMessage(error: unknown): string | undefined {
  return error instanceof Error && error.message ? error.message : undefined;
}

export function NotificationsSettingsTab() {
  const { data, isLoading, isError, refetch } = useNotificationsSettings();
  const updateSettings = useUpdateNotificationsSettings();
  const sendTest = useSendTestMessage();
  const discoverChats = useDiscoverTelegramChats();
  const botTokenRef = useRef<HTMLInputElement>(null);
  const chatIdRef = useRef<HTMLInputElement>(null);
  const [detectedChats, setDetectedChats] = useState<DiscoveredChat[] | null>(null);
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [resultNotice, setResultNotice] = useState("");

  if (isLoading) {
    return (
      <StatusPanel
        title="Загружаем настройки уведомлений…"
      />
    );
  }

  if (!data) {
    return (
      <StatusPanel
        title="Не удалось загрузить настройки уведомлений"
        action={<button type="button" className="text-accent underline" onClick={() => void refetch()}>Повторить</button>}
        tone="error"
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
    updateSettings.mutate({ [field]: value }, { onError: (error) => toast.error(apiErrorMessage(error) ?? "Не удалось сохранить настройку") });
  }

  function handleReportHourChange(hour: number) {
    updateSettings.mutate({ reportHourUtc: hour }, { onError: (error) => toast.error(apiErrorMessage(error) ?? "Не удалось сохранить время отчёта") });
  }

  async function handleSaveCredentials(): Promise<boolean> {
    const botToken = botTokenRef.current?.value?.trim() || undefined;
    const chatId = chatIdRef.current?.value?.trim() || undefined;

    // A field is satisfied if it's already stored (DB or env) or entered now, so
    // a partial env config (e.g. token in env) lets the operator supply just the
    // missing piece instead of being forced to re-paste both.
    const haveToken = settings.botTokenSet || !!botToken;
    const haveChat = !!settings.chatId || !!chatId;
    if (!haveToken || !haveChat) {
      toast.error("Нужны токен бота и Chat ID получателя");
      return false;
    }

    if (!botToken && !chatId) {
      toast.error("Введите реквизиты для сохранения");
      return false;
    }

    try {
      await updateSettings.mutateAsync({ botToken, chatId });
      setDetectedChats(null);
      if (botTokenRef.current) botTokenRef.current.value = "";
      setResultNotice(`Реквизиты сохранены. Получатель: ${chatId ?? settings.chatId}. Доставку можно проверить отдельной кнопкой «Отправить тест».`);
      toast.success("Реквизиты сохранены");
      return true;
    } catch (error) {
      toast.error(apiErrorMessage(error) ?? "Не удалось сохранить реквизиты");
      return false;
    }
  }

  async function handleClearCredentials(): Promise<boolean> {
    if (!window.confirm("Удалить сохранённые токен бота и Chat ID? Параметры из окружения, если они есть, продолжат действовать.")) return false;
    try {
      await updateSettings.mutateAsync({ botToken: null, chatId: null });
      toast.success("Сохранённые реквизиты удалены");
      setResultNotice("Сохранённые реквизиты удалены. Проверьте текущее подключение ниже.");
      setDetectedChats(null); setBotUsername(null);
      if (botTokenRef.current) botTokenRef.current.value = "";
      if (chatIdRef.current) chatIdRef.current.value = "";
      return true;
    } catch {
      toast.error("Не удалось удалить реквизиты");
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
          toast.message("Чаты не найдены. Откройте бота в Telegram, отправьте ему сообщение и повторите поиск.");
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
        toast.success(`Найдено чатов: ${result.chats.length}. Выберите получателя.`);
      },
      onError: (error) => toast.error(apiErrorMessage(error) ?? "Не удалось связаться с Telegram"),
    });
  }

  function handlePickChat(id: string) {
    if (chatIdRef.current) chatIdRef.current.value = id;
    setDetectedChats(null);
  }

  function handleSendTest() {
    setResultNotice("");
    sendTest.mutate(undefined, {
      onSuccess: (result) => {
        if (result.status === "sent") {
          setResultNotice(`Тестовое сообщение отправлено в чат ${settings.chatId}.`);
          toast.success("Тестовое сообщение отправлено");
        } else {
          setResultNotice(`Реквизиты сохранены, но тест не доставлен: ${result.error ?? "Telegram не подтвердил отправку"}`);
          toast.error(result.error ?? "Не удалось отправить тест");
        }
      },
      onError: () => { setResultNotice("Реквизиты сохранены. Подтверждение доставки теста не получено."); toast.error("Не удалось получить результат отправки теста"); },
    });
  }

  const savePending = updateSettings.isPending || sendTest.isPending;

  return (
    <div className="space-y-4">
      <QueryNotice error={isError} stale retry={refetch} />
      {resultNotice && <p role="status" className="rounded-lg border border-border bg-hover p-3 text-sm text-text-secondary">{resultNotice}</p>}
      {!settings.configured ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="mb-1 text-sm font-semibold text-text-primary">Подключение Telegram</h3>
          <p className="mb-4 text-[12px] text-text-muted">
            Создайте бота через @BotFather и введите его токен. Отправьте боту сообщение в Telegram,
            затем нажмите <span className="font-medium text-text-secondary">Найти чат</span> и выберите получателя.
          </p>
          <div className="max-w-md space-y-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-text-secondary">Токен бота</label>
              <input
                ref={botTokenRef}
                aria-label="Токен Telegram-бота"
                type="password"
                placeholder="7123456789:AAH..."
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              {botUsername && (
                <p className="mt-1 text-[12px] text-green">Бот подтверждён: @{botUsername}</p>
              )}
              {settings.botTokenSet && (
                <p className="mt-1 text-[12px] text-text-muted">
                  Токен бота уже настроен{settings.botTokenSource === "env" ? " через окружение" : ""} — оставьте поле пустым, чтобы сохранить его.
                </p>
              )}
            </div>
            <ChatIdField
              chatIdRef={chatIdRef}
              defaultValue={settings.chatId ?? ""}
              onDetect={handleDetectChats}
              isDetecting={discoverChats.isPending}
              detectedChats={detectedChats}
              onPick={handlePickChat}
            />
            <button
              onClick={handleSaveCredentials}
              disabled={savePending}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
            >
              {updateSettings.isPending ? "Сохраняем…" : "Сохранить реквизиты"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className={`h-2.5 w-2.5 rounded-full ${
              settings.connectionStatus === "connected" ? "bg-green"
                : settings.connectionStatus === "last_message_failed" ? "bg-danger"
                : "bg-text-muted"
            }`} />
            <div>
              <span className="text-sm font-medium text-text-primary">
                {settings.connectionStatus === "connected" ? "Доставка подтверждена"
                  : settings.connectionStatus === "last_message_failed" ? "Ошибка последней отправки"
                  : "Доставка ещё не проверена"}
              </span>
              {settings.chatId && (
                <span className="ml-2 text-[12px] text-text-muted">
                  Получатель: чат {settings.chatId}
                  {settings.chatIdSource === "env" && " (из окружения)"}
                </span>
              )}
              {settings.lastMessageAt && (
                <span className="ml-2 text-[12px] text-text-muted">
                  &middot; {formatRelativeTime(settings.lastMessageAt)}
                </span>
              )}
              {settings.connectionStatus === "untested" && (
                <p className="mt-0.5 text-[12px] text-text-muted">Нажмите «Отправить тест», чтобы проверить доставку этому получателю.</p>
              )}
              {settings.lastMessageError && (
                <p className="mt-0.5 text-[12px] text-danger">{settings.lastMessageError}</p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CredentialsEdit
              chatId={settings.chatId}
              onClear={handleClearCredentials}
              onSave={handleSaveCredentials}
              botTokenRef={botTokenRef}
              chatIdRef={chatIdRef}
              isPending={savePending}
              onDetect={handleDetectChats}
              isDetecting={discoverChats.isPending}
              detectedChats={detectedChats}
              onPick={handlePickChat}
              botUsername={botUsername}
            />
            <button
              onClick={handleSendTest}
              disabled={savePending || isError}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
            >
              {sendTest.isPending ? "Отправляем…" : "Отправить тест"}
            </button>
          </div>
        </div>
      )}

      <ToggleRow
        label="Автоматические уведомления"
        description="Инциденты и ежедневные отчёты отправляются автоматически. Ручные отправки доступны отдельно."
        disabled={savePending || isError}
        checked={settings.enabled}
        onChange={(value) => handleToggle("enabled", value)}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
        <div>
          <div className="text-sm font-medium text-text-primary">Время отчёта (UTC)</div>
          <div className="text-[12px] text-text-muted">Час отправки ежедневного отчёта</div>
        </div>
        <select
          aria-label="Час ежедневного отчёта UTC"
          disabled={savePending || isError}
          value={settings.reportHourUtc}
          onChange={(event) => handleReportHourChange(Number(event.target.value))}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-text-primary"
        >
          {Array.from({ length: 24 }, (_, index) => (
            <option key={index} value={index}>{String(index).padStart(2, "0")}:00 UTC</option>
          ))}
        </select>
      </div>

      <ToggleRow
        label="Ежедневный отчёт"
        description="Отправлять ежедневную сводку выручки в Telegram"
        disabled={savePending || isError}
        checked={settings.dailyReportEnabled}
        onChange={(value) => handleToggle("dailyReportEnabled", value)}
      />

      <ToggleRow
        label="Ошибки синхронизации"
        description="Сообщать об открытии и закрытии инцидентов синхронизации"
        disabled={savePending || isError}
        checked={settings.syncFailureAlertsEnabled}
        onChange={(value) => handleToggle("syncFailureAlertsEnabled", value)}
      />

      <ToggleRow
        label="Критические ошибки AI"
        description="Отдельно сообщать о критических ошибках AI-провайдера"
        disabled={savePending || isError}
        checked={settings.aiCriticalAlertsEnabled}
        onChange={(value) => handleToggle("aiCriticalAlertsEnabled", value)}
      />
    </div>
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
      <label className="mb-1 block text-[12px] font-medium text-text-secondary">Chat ID</label>
      <div className="flex gap-2">
        <input
          ref={chatIdRef}
          aria-label="Chat ID получателя"
          type="text"
          defaultValue={defaultValue}
          placeholder="123456789 или -100..."
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={onDetect}
          disabled={isDetecting}
          className="shrink-0 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-text-secondary hover:bg-hover disabled:opacity-40"
        >
          {isDetecting ? "Ищем…" : "Найти чат"}
        </button>
      </div>
      {detectedChats && detectedChats.length > 0 && (
        <div className="mt-2 space-y-1 rounded-lg border border-border bg-card p-2">
          {detectedChats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              onClick={() => onPick(chat.id)}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-hover"
            >
              <span className="font-medium text-text-primary">{chat.title}</span>
              <span className="text-text-muted">{chat.type} · {chat.id}</span>
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
  onDetect: () => void;
  isDetecting: boolean;
  detectedChats: DiscoveredChat[] | null;
  onPick: (id: string) => void;
  botUsername: string | null;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-hover"
      >
        Изменить реквизиты
      </button>
    );
  }

  return (
    <ModalShell title="Реквизиты Telegram" closeLabel="Закрыть" onClose={() => { if (!isPending) setOpen(false); }}>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-text-secondary">Токен бота</label>
            <input
              ref={botTokenRef}
              aria-label="Новый токен Telegram-бота"
              type="password"
              placeholder="Новый токен — пустое поле сохранит текущий"
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            {botUsername && (
              <p className="mt-1 text-[12px] text-green">Бот подтверждён: @{botUsername}</p>
            )}
          </div>
          <ChatIdField
            chatIdRef={chatIdRef}
            defaultValue={chatId ?? ""}
            onDetect={onDetect}
            isDetecting={isDetecting}
            detectedChats={detectedChats}
            onPick={onPick}
          />
        </div>
        <p className="mt-3 text-xs text-text-muted">Сохранение обновит реквизиты. Для проверки доставки отправьте тест отдельной кнопкой после сохранения.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            onClick={() => { void onClear().then((cleared) => { if (cleared) setOpen(false); }); }}
            disabled={isPending}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-hover disabled:opacity-40"
          >
            Удалить сохранённые реквизиты
          </button>
          <button
            onClick={() => setOpen(false)}
            disabled={isPending}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-hover"
          >
            Отмена
          </button>
          <button
            onClick={() => { void onSave().then((saved) => { if (saved) setOpen(false); }); }}
            disabled={isPending}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
          >
            Сохранить
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
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
      <div>
        <div className="text-sm font-medium text-text-primary">{label}</div>
        <div className="text-[12px] text-text-muted">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
          checked ? "bg-accent" : "bg-border"
        }`}
      >
        <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`} />
      </button>
    </div>
  );
}

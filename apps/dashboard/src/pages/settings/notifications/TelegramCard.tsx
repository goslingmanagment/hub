import { useRef, useState, type ReactNode, type RefObject } from "react";
import type { NotificationsSettingsResponse } from "@agency_hub_core/contracts";
import { toast } from "sonner";
import { useDiscoverTelegramChats, useSendTestMessage, useUpdateNotificationsSettings } from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { ModalShell } from "@/components/shared/ModalShell";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Switch } from "@/components/ui/Switch";
import { formatMomentAgo } from "@/lib/format";
import { TELEGRAM_STATUS } from "@/lib/statusWords";
import { toastError } from "../settingsFeedback.js";
import { chatTypeRu, telegramErrorRu } from "./notificationsView.js";

type DiscoveredChat = { id: string; type: string; title: string };
type Settings = NotificationsSettingsResponse;

const CONNECTION = {
  connected: TELEGRAM_STATUS.connected,
  last_message_failed: TELEGRAM_STATUS.notDelivered,
  untested: TELEGRAM_STATUS.unchecked,
} as const;

function ChatIdField({ chatIdRef, defaultValue, onDetect, isDetecting, detectedChats, onPick }: {
  chatIdRef: RefObject<HTMLInputElement | null>;
  defaultValue: string;
  onDetect: () => void;
  isDetecting: boolean;
  detectedChats: DiscoveredChat[] | null;
  onPick: (id: string) => void;
}) {
  return (
    <div>
      <div className="settings-chat-field">
        <input
          ref={chatIdRef}
          aria-label="ID чата"
          type="text"
          defaultValue={defaultValue}
          placeholder="ID чата: 123456789 или -100…"
          className="input"
        />
        <button type="button" onClick={onDetect} disabled={isDetecting} className="btn">
          {isDetecting ? "Ищем…" : "Найти чат"}
        </button>
      </div>
      {detectedChats && detectedChats.length > 0 && (
        <div className="settings-chat-list" role="list" aria-label="Найденные чаты">
          {detectedChats.map((chat) => (
            <button key={chat.id} type="button" role="listitem" onClick={() => onPick(chat.id)} className="settings-chat-option">
              <span className="font-medium">{chat.title}</span>
              <span className="settings-second">{chatTypeRu(chat.type)}, {chat.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li className="settings-step">
      <span aria-hidden="true" className="settings-step-number">{number}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}

/**
 * The bot's chat: connect it, change it, check it, and the main switch of every
 * automatic message. The token stays out of React's state: its field is read by a
 * ref, as before. Every write is the form's, never a page's.
 */
export function TelegramCard({ settings, isError, update, sendTest }: {
  settings: Settings;
  /** The settings did not refresh: nothing is written. */
  isError: boolean;
  update: ReturnType<typeof useUpdateNotificationsSettings>;
  sendTest: ReturnType<typeof useSendTestMessage>;
}) {
  const discoverChats = useDiscoverTelegramChats();
  const botTokenRef = useRef<HTMLInputElement>(null);
  const chatIdRef = useRef<HTMLInputElement>(null);
  const [detectedChats, setDetectedChats] = useState<DiscoveredChat[] | null>(null);
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"test" | "clear" | "off" | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const busy = update.isPending || sendTest.isPending;
  const blocked = busy || isError;

  // After saving the credentials a real test is sent, so the state reflects an
  // actual delivery and not «credentials exist».
  function verifyAfterSave() {
    sendTest.mutate(undefined, {
      onSuccess: (result) => {
        if (result.status === "sent") toast.success("Подключено: проверочное сообщение отправлено");
        else toastError("Сохранено, но проверочное сообщение не дошло");
      },
      onError: () => toastError("Сохранено, но проверочное сообщение не дошло"),
    });
  }

  async function handleSaveCredentials(): Promise<boolean> {
    if (update.isPending || sendTest.isPending || isError) return false;
    const botToken = botTokenRef.current?.value?.trim() || undefined;
    const chatId = chatIdRef.current?.value?.trim() || undefined;
    // A field is satisfied if it is already stored (the DB or the server's settings)
    // or entered now: a partial setup lets the owner give only the missing piece.
    const haveToken = settings.botTokenSet || !!botToken;
    const haveChat = !!settings.chatId || !!chatId;
    if (!haveToken || !haveChat) {
      toastError("Нужны и токен бота, и ID чата");
      return false;
    }
    if (!botToken && !chatId) {
      toastError("Нечего сохранять");
      return false;
    }
    try {
      await update.mutateAsync({ botToken, chatId });
      setDetectedChats(null);
      if (botTokenRef.current) botTokenRef.current.value = "";
      verifyAfterSave();
      return true;
    } catch {
      toastError("Не удалось сохранить данные Telegram");
      return false;
    }
  }

  async function handleClearCredentials() {
    if (update.isPending || sendTest.isPending || isError) return;
    setConfirmError(null);
    try {
      await update.mutateAsync({ botToken: null, chatId: null });
      toast.success("Сохранённые данные удалены");
      setDetectedChats(null);
      setBotUsername(null);
      if (botTokenRef.current) botTokenRef.current.value = "";
      if (chatIdRef.current) chatIdRef.current.value = "";
      setConfirm(null);
    } catch {
      setConfirmError("Не удалось удалить данные. Сохранённые токен и чат остались.");
    }
  }

  // Asks the hub to call getMe and getUpdates, so the chat is picked from a list.
  function handleDetectChats() {
    const botToken = botTokenRef.current?.value?.trim() || undefined;
    discoverChats.mutate({ botToken }, {
      onSuccess: (result) => {
        setBotUsername(result.botUsername);
        if (result.chats.length === 0) {
          setDetectedChats(null);
          toast.message("Чатов пока нет: откройте бота в Telegram, напишите ему что-нибудь и нажмите «Найти чат» ещё раз.");
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
        toast.success(`Найдено чатов: ${result.chats.length}, выберите нужный`);
      },
      onError: () => toastError("Не удалось связаться с Telegram"),
    });
  }

  function handlePickChat(id: string) {
    if (chatIdRef.current) chatIdRef.current.value = id;
    setDetectedChats(null);
  }

  function handleSendTest() {
    sendTest.mutate(undefined, {
      onSuccess: (result) => {
        setConfirm(null);
        if (result.status === "sent") toast.success("Проверочное сообщение отправлено");
        else toastError(`Проверочное сообщение не отправилось: ${telegramErrorRu(result.error)}`);
      },
      onError: () => {
        setConfirm(null);
        toastError("Проверочное сообщение не отправилось: Hub не ответил");
      },
    });
  }

  function setEnabled(value: boolean) {
    if (blocked) return;
    setConfirmError(null);
    update.mutate({ enabled: value }, {
      onSuccess: () => setConfirm(null),
      onError: () => {
        if (confirm === "off") setConfirmError("Настройка не сохранилась. Оповещения остались включены.");
        else toastError("Настройка не сохранилась");
      },
    });
  }

  const masterSwitch = (
    <div className="switch-row settings-switch-row">
      <div className="switch-text">
        <span className="font-medium">Оповещения включены</span>
        <small>Если выключить, автоматические оповещения и отчёт по расписанию не отправляются. Ручные действия работают.</small>
      </div>
      <div className="switch-control">
        {settings.enabled ? "Включены" : "Выключены"}
        <Switch
          checked={settings.enabled}
          label="Оповещения включены"
          disabled={blocked}
          onChange={(next) => {
            if (next) setEnabled(true);
            else { setConfirmError(null); setConfirm("off"); }
          }}
        />
      </div>
    </div>
  );

  const chatLine = settings.chatId ? `чат ${settings.chatId}` : "чат не задан";

  return (
    <>
      {!settings.configured ? (
        <section className="card" aria-labelledby="telegram-connect-title">
          <div className="card-header">
            <div className="min-w-0">
              <h2 id="telegram-connect-title" className="card-title">Подключите Telegram</h2>
              <p className="card-description">Hub будет присылать в чат оповещения о сбоях и ежедневный отчёт.</p>
            </div>
          </div>
          <ol className="card-body settings-steps">
            <Step number={1} title="Создайте бота у @BotFather в Telegram и вставьте его токен">
              <input ref={botTokenRef} aria-label="Токен бота" type="password" placeholder="7123456789:AAH…" className="input" />
              {botUsername && <p className="field-hint">Бот найден: @{botUsername}</p>}
              {settings.botTokenSet && (
                <p className="field-hint">
                  Токен уже задан{settings.botTokenSource === "env" ? " (в настройках сервера)" : ""}: оставьте поле пустым, чтобы его не менять.
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
            <Step number={3} title="Сохраните: Hub отправит проверочное сообщение">
              <button type="button" onClick={() => void handleSaveCredentials()} disabled={blocked} className="btn btn-primary">
                {update.isPending ? "Сохраняем…" : sendTest.isPending ? "Проверяем…" : "Сохранить и проверить"}
              </button>
            </Step>
          </ol>
          <div className="settings-card-switches">{masterSwitch}</div>
        </section>
      ) : (
        <section className="card" aria-labelledby="telegram-title">
          <div className="card-header settings-telegram-head">
            <div className="min-w-0">
              <div className="settings-title-line">
                <h2 id="telegram-title" className="card-title">Telegram</h2>
                <StatusBadge status={CONNECTION[settings.connectionStatus as keyof typeof CONNECTION] ?? TELEGRAM_STATUS.unchecked} />
              </div>
              <p className="card-description">
                {settings.chatId ? <>Чат {settings.chatId}{settings.chatIdSource === "env" && " (задан в настройках сервера)"}</> : "Чат не задан"}
                {settings.lastMessageAt && <>. Последнее сообщение {formatMomentAgo(settings.lastMessageAt)}</>}
              </p>
              {settings.connectionStatus === "untested" && (
                <p className="card-description">Отправьте проверочное сообщение, чтобы убедиться, что оно доходит.</p>
              )}
              {settings.lastMessageError && (
                <p className="settings-error-line" title={settings.lastMessageError}>{telegramErrorRu(settings.lastMessageError)}</p>
              )}
            </div>
            <div className="settings-actions">
              <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>Изменить данные</button>
              <button type="button" className="btn btn-sm" disabled={blocked} onClick={() => setConfirm("test")}>
                {sendTest.isPending ? "Отправляем…" : "Отправить проверку"}
              </button>
            </div>
          </div>
          <div className="settings-card-switches">{masterSwitch}</div>
        </section>
      )}

      {editing && (
        <ModalShell title="Данные Telegram" onClose={() => { if (!busy) setEditing(false); }} explicitCloseOnly size="short">
          <div className="space-y-4">
            <label className="block">
              <span className="field-label">Токен бота</span>
              <input ref={botTokenRef} aria-label="Токен бота" type="password" placeholder="Новый токен (пусто: оставить текущий)" className="input" />
              {botUsername && <p className="field-hint">Бот найден: @{botUsername}</p>}
            </label>
            <div>
              <span className="field-label">ID чата</span>
              <ChatIdField
                chatIdRef={chatIdRef}
                defaultValue={settings.chatId ?? ""}
                onDetect={handleDetectChats}
                isDetecting={discoverChats.isPending}
                detectedChats={detectedChats}
                onPick={handlePickChat}
              />
            </div>
            <p className="settings-second">После сохранения Hub отправит проверочное сообщение в этот чат.</p>
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              className="btn btn-danger-outline mr-auto"
              disabled={blocked}
              onClick={() => { setEditing(false); setConfirmError(null); setConfirm("clear"); }}
            >
              Удалить сохранённые данные
            </button>
            <button type="button" onClick={() => setEditing(false)} disabled={busy} className="btn">Отмена</button>
            <button
              type="button"
              onClick={() => void handleSaveCredentials().then((saved) => { if (saved) setEditing(false); })}
              disabled={blocked}
              className="btn btn-primary"
            >
              {update.isPending ? "Сохраняем…" : "Сохранить и проверить"}
            </button>
          </div>
        </ModalShell>
      )}

      {confirm === "test" && (
        <ConfirmModal
          title="Отправить проверочное сообщение?"
          message="Hub отправит короткое сообщение в Telegram."
          facts={[
            { label: "Куда", value: chatLine },
            { label: "Отменить", value: "Нельзя: сообщение останется в чате" },
          ]}
          confirmLabel="Отправить проверку"
          pendingLabel="Отправляем…"
          tone="primary"
          isPending={sendTest.isPending}
          onConfirm={handleSendTest}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "clear" && (
        <ConfirmModal
          title="Удалить сохранённые токен бота и ID чата?"
          message="Если они заданы в настройках сервера, снова начнут действовать те. Чтобы остановить автоматические сообщения, выключите «Оповещения включены»."
          facts={[{ label: "Отменить", value: "Нельзя: токен придётся вставить заново" }]}
          confirmLabel="Удалить данные"
          pendingLabel="Удаляем…"
          initialFocus="cancel"
          error={confirmError ?? undefined}
          isPending={update.isPending}
          onConfirm={() => void handleClearCredentials()}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "off" && (
        <ConfirmModal
          title="Выключить оповещения?"
          message="Перестанут приходить сообщения о сбоях и отчёт по расписанию. Сбои останутся на экране «Сбои»."
          facts={[{ label: "Отменить", value: "Можно: включите обратно" }]}
          confirmLabel="Выключить оповещения"
          pendingLabel="Выключаем…"
          tone="primary"
          error={confirmError ?? undefined}
          isPending={update.isPending}
          onConfirm={() => setEnabled(false)}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}

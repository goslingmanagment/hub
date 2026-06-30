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
import { formatRelativeTime } from "@/lib/format";

type DiscoveredChat = { id: string; type: string; title: string };

function apiErrorMessage(error: unknown): string | undefined {
  return error instanceof Error && error.message ? error.message : undefined;
}

export function NotificationsSettingsTab() {
  const { data, isLoading, isError } = useNotificationsSettings();
  const updateSettings = useUpdateNotificationsSettings();
  const sendTest = useSendTestMessage();
  const discoverChats = useDiscoverTelegramChats();
  const botTokenRef = useRef<HTMLInputElement>(null);
  const chatIdRef = useRef<HTMLInputElement>(null);
  const [detectedChats, setDetectedChats] = useState<DiscoveredChat[] | null>(null);
  const [botUsername, setBotUsername] = useState<string | null>(null);

  if (isLoading) {
    return (
      <StatusPanel
        title="Loading notification settings"
        description="Fetching the current Telegram notification configuration."
      />
    );
  }

  if (isError || !data) {
    return (
      <StatusPanel
        title="Notification settings failed to load"
        description="The notification settings could not be fetched."
        tone="error"
      />
    );
  }

  const settings = data;

  function handleToggle(field: "enabled" | "dailyReportEnabled" | "syncFailureAlertsEnabled", value: boolean) {
    updateSettings.mutate({ [field]: value });
  }

  function handleReportHourChange(hour: number) {
    updateSettings.mutate({ reportHourUtc: hour });
  }

  // After saving credentials, send a real test so the connection status reflects
  // an actual delivery rather than "credentials exist". A single toast reports
  // the connection outcome (and makes clear the creds were saved either way).
  function verifyAfterSave() {
    sendTest.mutate(undefined, {
      onSuccess: (result) => {
        if (result.status === "sent") {
          toast.success("Connected — test message sent");
        } else {
          toast.error(result.error ?? "Saved, but the test message failed");
        }
      },
      onError: () => toast.error("Saved, but the test message failed"),
    });
  }

  function handleSaveCredentials() {
    const botToken = botTokenRef.current?.value?.trim() || undefined;
    const chatId = chatIdRef.current?.value?.trim() || undefined;

    // A field is satisfied if it's already stored (DB or env) or entered now, so
    // a partial env config (e.g. token in env) lets the operator supply just the
    // missing piece instead of being forced to re-paste both.
    const haveToken = settings.botTokenSet || !!botToken;
    const haveChat = !!settings.chatId || !!chatId;
    if (!haveToken || !haveChat) {
      toast.error("Bot token and Chat ID are both required");
      return;
    }

    if (!botToken && !chatId) {
      toast.error("Nothing to update");
      return;
    }

    updateSettings.mutate({ botToken, chatId }, {
      onSuccess: () => {
        setDetectedChats(null);
        if (botTokenRef.current) botTokenRef.current.value = "";
        verifyAfterSave();
      },
      onError: (error) => toast.error(apiErrorMessage(error) ?? "Failed to save credentials"),
    });
  }

  function handleClearCredentials() {
    if (!window.confirm("Clear the stored Telegram bot token and chat ID? Notifications will stop until you reconnect.")) {
      return;
    }
    updateSettings.mutate({ botToken: null, chatId: null }, {
      onSuccess: () => {
        toast.success("Stored credentials cleared");
        setDetectedChats(null);
        setBotUsername(null);
        if (botTokenRef.current) botTokenRef.current.value = "";
        if (chatIdRef.current) chatIdRef.current.value = "";
      },
      onError: () => toast.error("Failed to clear credentials"),
    });
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
          toast.message("No chats yet — open the bot in Telegram, send it any message, then Detect again.");
          return;
        }
        if (result.chats.length === 1) {
          const only = result.chats[0]!;
          if (chatIdRef.current) chatIdRef.current.value = only.id;
          setDetectedChats(null);
          toast.success(`Found ${only.title}`);
          return;
        }
        setDetectedChats(result.chats);
        toast.success(`Found ${result.chats.length} chats — pick one`);
      },
      onError: (error) => toast.error(apiErrorMessage(error) ?? "Could not reach Telegram"),
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
          toast.success("Test message sent");
        } else {
          toast.error(result.error ?? "Failed to send test message");
        }
      },
      onError: () => toast.error("Failed to send test message"),
    });
  }

  const savePending = updateSettings.isPending || sendTest.isPending;

  return (
    <div className="space-y-4">
      {!settings.configured ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="mb-1 text-sm font-semibold text-text-primary">Connect Telegram</h3>
          <p className="mb-4 text-[12px] text-text-muted">
            Create a bot via @BotFather and paste its token below. Send the bot any message in Telegram,
            then click <span className="font-medium text-text-secondary">Detect</span> to pick your chat automatically.
          </p>
          <div className="max-w-md space-y-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-text-secondary">Bot Token</label>
              <input
                ref={botTokenRef}
                type="password"
                placeholder="7123456789:AAH..."
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              {botUsername && (
                <p className="mt-1 text-[12px] text-green">Bot verified: @{botUsername}</p>
              )}
              {settings.botTokenSet && (
                <p className="mt-1 text-[12px] text-text-muted">
                  A bot token is already configured{settings.botTokenSource === "env" ? " via environment" : ""} — leave blank to keep it.
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
              {updateSettings.isPending ? "Saving..." : sendTest.isPending ? "Connecting..." : "Save & Connect"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className={`h-2.5 w-2.5 rounded-full ${
              settings.connectionStatus === "connected" ? "bg-green"
                : settings.connectionStatus === "last_message_failed" ? "bg-danger"
                : "bg-text-muted"
            }`} />
            <div>
              <span className="text-sm font-medium text-text-primary">
                {settings.connectionStatus === "connected" ? "Connected"
                  : settings.connectionStatus === "last_message_failed" ? "Last message failed"
                  : "Not tested yet"}
              </span>
              {settings.chatId && (
                <span className="ml-2 text-[12px] text-text-muted">
                  Chat {settings.chatId}
                  {settings.chatIdSource === "env" && " (from env)"}
                </span>
              )}
              {settings.lastMessageAt && (
                <span className="ml-2 text-[12px] text-text-muted">
                  &middot; {formatRelativeTime(settings.lastMessageAt)}
                </span>
              )}
              {settings.connectionStatus === "untested" && (
                <p className="mt-0.5 text-[12px] text-text-muted">Send a test message to verify delivery.</p>
              )}
              {settings.lastMessageError && (
                <p className="mt-0.5 text-[12px] text-danger">{settings.lastMessageError}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
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
              disabled={sendTest.isPending}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
            >
              {sendTest.isPending ? "Sending..." : "Send Test"}
            </button>
          </div>
        </div>
      )}

      <ToggleRow
        label="Notifications Enabled"
        description="When off, blocks automatic incident alerts and scheduled daily reports. Manual actions still work."
        checked={settings.enabled}
        onChange={(value) => handleToggle("enabled", value)}
      />

      <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
        <div>
          <div className="text-sm font-medium text-text-primary">Report Hour (UTC)</div>
          <div className="text-[12px] text-text-muted">Hour when the daily revenue report is sent</div>
        </div>
        <select
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
        label="Daily Revenue Report"
        description="Send a daily revenue summary via Telegram"
        checked={settings.dailyReportEnabled}
        onChange={(value) => handleToggle("dailyReportEnabled", value)}
      />

      <ToggleRow
        label="Sync Failure Alerts"
        description="Send alerts when sync incidents open or resolve"
        checked={settings.syncFailureAlertsEnabled}
        onChange={(value) => handleToggle("syncFailureAlertsEnabled", value)}
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
          type="text"
          defaultValue={defaultValue}
          placeholder="123456789 or -100..."
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={onDetect}
          disabled={isDetecting}
          className="shrink-0 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-text-secondary hover:bg-hover disabled:opacity-40"
        >
          {isDetecting ? "Detecting..." : "Detect"}
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
  onClear: () => void;
  onSave: () => void;
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
        Edit Credentials
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/20" onClick={() => setOpen(false)}>
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg" onClick={(event) => event.stopPropagation()}>
        <h3 className="mb-3 text-sm font-semibold text-text-primary">Update Telegram Credentials</h3>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-text-secondary">Bot Token</label>
            <input
              ref={botTokenRef}
              type="password"
              placeholder="Paste new token (leave empty to keep current)"
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            {botUsername && (
              <p className="mt-1 text-[12px] text-green">Bot verified: @{botUsername}</p>
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
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => { onClear(); setOpen(false); }}
            disabled={isPending}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-hover disabled:opacity-40"
          >
            Clear Stored Credentials
          </button>
          <button
            onClick={() => setOpen(false)}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-hover"
          >
            Cancel
          </button>
          <button
            onClick={() => { onSave(); setOpen(false); }}
            disabled={isPending}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
      <div>
        <div className="text-sm font-medium text-text-primary">{label}</div>
        <div className="text-[12px] text-text-muted">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
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

import { useState } from "react";
import { toast } from "sonner";
import type { AccountLinkKind } from "@agency_hub_core/contracts";

import { ModalShell } from "@/components/shared/ModalShell";
import { formatDateTime } from "@/lib/format";
import { buildJoinLink, currentOrigin, telegramMessage } from "./teamView.js";

/**
 * Decision 348 — the one and only place a fresh link is ever visible.
 *
 * The secret comes back from the create mutation's RESULT: it is never written
 * to a query cache, never re-fetched, never logged and never put in a URL path
 * (the person's browser carries it in the `#` fragment). It does live on in the
 * MUTATION result until that mutation is reset, so closing this dialog resets
 * it — `onClose` is wired in TeamTab to `.reset()` both link mutations, and the
 * secret leaves memory with the dialog rather than idling in the cache.
 *
 * Escape and backdrop clicks do NOT close it (`explicitCloseOnly`): this is the
 * one dialog whose contents cannot be reopened, and a stray click on the
 * backdrop would destroy the only copy of a link already committed server-side.
 * If it is lost anyway, the cure is a new link, which supersedes this one.
 */

export interface RevealedLink {
  username: string;
  kind: AccountLinkKind;
  secret: string;
  expiresAt: string;
}

export function LinkRevealModal({
  link,
  onClose,
}: {
  link: RevealedLink;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<"link" | "message" | null>(null);
  const joinLink = buildJoinLink(currentOrigin(), link.secret);
  const message = telegramMessage(link.kind, link.username, joinLink);

  async function copy(value: string, what: "link" | "message") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      toast.success("Скопировано");
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error("Буфер обмена недоступен — выделите текст и скопируйте вручную, не закрывая окно.");
    }
  }

  const title = link.kind === "password_reset"
    ? `Ссылка для нового пароля — ${link.username}`
    : `Приглашение для ${link.username}`;

  return (
    <ModalShell title={title} onClose={onClose} closeLabel="Закрыть" explicitCloseOnly>
      <div className="space-y-4">
        <p className="text-sm font-medium text-warning">
          Ссылка показывается один раз. Скопируйте её сейчас и отправьте человеку
          в Telegram — заново её не посмотреть, можно только создать новую.
        </p>

        <div>
          <div className="mb-1 text-sm text-text-secondary">Ссылка</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded-lg border border-border bg-bg px-3 py-2.5 font-mono text-sm text-text-primary">
              {joinLink}
            </code>
            <button
              type="button"
              onClick={() => void copy(joinLink, "link")}
              className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
            >
              {copied === "link" ? "Скопировано" : "Скопировать"}
            </button>
          </div>
          <p className="mt-1 text-xs text-text-muted">
            Действует до {formatDateTime(link.expiresAt)}. Открыть её можно один раз.
          </p>
        </div>

        <div>
          <div className="mb-1 text-sm text-text-secondary">Сообщение для Telegram</div>
          <textarea
            readOnly
            rows={4}
            aria-label="Сообщение для Telegram"
            value={message}
            className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary"
          />
          <button
            type="button"
            onClick={() => void copy(message, "message")}
            className="mt-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover"
          >
            {copied === "message" ? "Скопировано" : "Скопировать сообщение"}
          </button>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover"
        >
          Готово
        </button>
      </div>
    </ModalShell>
  );
}

import { useState } from "react";
import { toast } from "sonner";
import type { AccountLinkKind } from "@agency_hub_core/contracts";

import { ModalShell } from "@/components/shared/ModalShell";
import { formatDateTime } from "@/lib/format";
import { buildJoinLink, currentOrigin, telegramMessage } from "./teamView.js";

/**
 * The one and only place a fresh link is ever visible.
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
  userId: number;
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
      <div className="space-y-5">
        <p className="notice notice-warning">
          Ссылка показывается один раз. Скопируйте её сейчас и отправьте человеку
          в Telegram — заново её не посмотреть, можно только создать новую.
        </p>

        <div>
          <div className="field-label">Ссылка</div>
          <div className="flex flex-wrap items-stretch gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded-lg border border-border bg-hover-alt px-3 py-2 font-mono text-sm text-text-primary">
              {joinLink}
            </code>
            <button type="button" onClick={() => void copy(joinLink, "link")} className="btn btn-primary">
              {copied === "link" ? "Скопировано" : "Скопировать"}
            </button>
          </div>
          <p className="field-hint">
            Действует до {formatDateTime(link.expiresAt)}. Открыть её можно один раз.
          </p>
        </div>

        <div>
          <label htmlFor="link-reveal-message" className="field-label">Сообщение для Telegram</label>
          <textarea
            id="link-reveal-message"
            readOnly
            rows={4}
            aria-label="Сообщение для Telegram"
            value={message}
            className="textarea resize-none"
          />
          <button type="button" onClick={() => void copy(message, "message")} className="btn mt-2">
            {copied === "message" ? "Скопировано" : "Скопировать сообщение"}
          </button>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-end">
        <button type="button" onClick={onClose} className="btn">
          Готово
        </button>
      </div>
    </ModalShell>
  );
}

import { Copy } from "lucide-react";
import { useState } from "react";
import { Button, Modal, Notice, TimeMsk, toast } from "@agency_hub_core/ui";
import { buildJoinLink, currentOrigin, telegramMessage, type LinkKind } from "@agency_hub_core/ui/teamAccess";

/**
 * The one and only place a fresh link is ever visible (the console's
 * LinkRevealModal.tsx). The secret comes from the creating mutation's result:
 * never a query cache, a log or a URL path (the person's browser carries it in
 * the `#`). Only «Готово» closes the window — a stray click would lose the only
 * copy — and closing resets the mutation, so the secret leaves memory with it.
 * What the owner sends is the message (the link is inside it), so that copy is
 * the main button here.
 */

export interface RevealedLink {
  userId: number;
  username: string;
  kind: LinkKind;
  secret: string;
  expiresAt: string;
}

export function LinkReveal({ link, onClose }: { link: RevealedLink; onClose: () => void }) {
  const [copied, setCopied] = useState<"link" | "message" | null>(null);
  const joinLink = buildJoinLink(currentOrigin(), link.secret);
  const message = telegramMessage(link.kind, link.username, joinLink);

  async function copy(value: string, what: "link" | "message") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      toast.success("Скопировано");
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error("Буфер обмена недоступен — выделите текст и скопируйте вручную, не закрывая окно.");
    }
  }

  return (
    <Modal
      title={link.kind === "password_reset" ? `Ссылка для нового пароля — ${link.username}` : `Приглашение для ${link.username}`}
      onClose={onClose}
      explicitCloseOnly
      size="form"
      actions={<Button data-autofocus onClick={onClose}>Готово</Button>}
    >
      <div className="access-reveal">
        <Notice tone="warning">
          Ссылка показывается один раз. Скопируйте её сейчас и отправьте человеку в Telegram — заново её не посмотреть, можно только создать новую.
        </Notice>

        <div className="ui-field">
          <label htmlFor="access-reveal-message" className="ui-field__label">Сообщение для Telegram</label>
          <textarea id="access-reveal-message" readOnly rows={4} value={message} className="access-textarea" onFocus={(event) => event.currentTarget.select()} />
          <div className="access-reveal__row">
            <Button variant="primary" icon={Copy} onClick={() => void copy(message, "message")}>
              {copied === "message" ? "Скопировано" : "Скопировать сообщение"}
            </Button>
            <span className="access-hint">Ссылка уже внутри сообщения.</span>
          </div>
        </div>

        <div className="ui-field">
          <span className="ui-field__label">Только ссылка</span>
          <div className="access-reveal__link">
            <code className="access-code">{joinLink}</code>
            <Button icon={Copy} onClick={() => void copy(joinLink, "link")}>{copied === "link" ? "Скопировано" : "Скопировать"}</Button>
          </div>
          <p className="ui-field__hint">Действует до <TimeMsk at={link.expiresAt} />. Открыть её можно один раз.</p>
        </div>
      </div>
    </Modal>
  );
}

import { Pencil } from "lucide-react";
import { useState } from "react";
import type { AccountStartResponse } from "@agency_hub_core/contracts";
import { PAYOUT_DETAILS_MAX_LENGTH } from "@agency_hub_core/contracts";
import { Button, Textarea } from "@agency_hub_core/ui";
import { formatDate } from "@agency_hub_core/ui/format";
import { PasswordWayIn } from "./PasswordWayIn.js";
import { useSetPayoutDetails } from "./start.js";
import { useMe } from "./useMe.js";

/**
 * Where the person's payouts go, in their own words, saved as written (`accountPayoutDetailsSet`): one card on «Начало»
 * (the newcomer's step, which closes on save) and on «Аккаунт и устройства» (everyone's, any time). A narrow session
 * (opened from the extension, no password) is not told the text — Hub leaves it out of `accountStart` for it — so the
 * card says only whether it is written and when, with the way to the password; never the text, never the form.
 */
export function PayoutDetails({ data }: { data: Pick<AccountStartResponse, "payoutDetails"> }) {
  const { narrow } = useMe();
  const saved = data.payoutDetails;
  // By the answer too, not the session's kind alone: written with no text is «not told here», never an empty form.
  if (narrow || (saved !== null && saved.text === null)) return <PayoutWritten at={saved?.updatedAt ?? null} />;
  return <PayoutEdit savedText={saved?.text ?? null} />;
}

/** «Указано 3 нояб.», «Указано 3 мая.»; a date of another year carries it. One full stop, whatever the month's short name ends with. */
function writtenWords(at: string): string {
  const year = (value: Date) => value.toLocaleDateString("ru-RU", { year: "numeric", timeZone: "Europe/Moscow" });
  const words = `Указано ${formatDate(at, { includeYear: year(new Date(at)) !== year(new Date()) })}`;
  return words.endsWith(".") ? words : `${words}.`;
}

function PayoutWritten({ at }: { at: string | null }) {
  return (
    <div className="wb-payout">
      <p className="wb-payout__text">{at === null ? "Ещё не указано." : writtenWords(at)}</p>
      <div className="wb-payout__foot">
        <PasswordWayIn text={at === null ? "Чтобы указать, войдите на сайте с паролем." : "Чтобы посмотреть или изменить, войдите на сайте с паролем."} />
      </div>
    </div>
  );
}

function PayoutEdit({ savedText }: { savedText: string | null }) {
  const saved = savedText;
  const save = useSetPayoutDetails();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(saved ?? "");
  const open = saved === null || editing;
  if (!open) {
    return (
      <div className="wb-payout">
        <p className="wb-payout__value">{saved}</p>
        <div className="wb-payout__foot">
          <span className="wb-payout__quiet">Видите только вы и владелец.</span>
          <Button size="sm" variant="ghost" icon={Pencil} onClick={() => { setText(saved); setEditing(true); }}>Изменить</Button>
        </div>
      </div>
    );
  }
  const tooLong = text.length > PAYOUT_DETAILS_MAX_LENGTH;
  const submit = () => {
    if (tooLong || (text.trim() === "" && saved === null)) return;
    save.mutate(text, { onSuccess: () => setEditing(false) });
  };
  return (
    <form className="wb-payout" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <label className="ui-sr-only" htmlFor="payout-details-text">Куда переводить выплаты</label>
      <Textarea
        id="payout-details-text"
        rows={2}
        value={text}
        maxLength={PAYOUT_DETAILS_MAX_LENGTH + 50}
        placeholder="Например: Bybit, UID 12 345 678"
        disabled={save.isPending}
        onChange={(event) => { setText(event.target.value); save.reset(); }}
      />
      {tooLong && <p className="ui-field__error" role="alert">Не длиннее {PAYOUT_DETAILS_MAX_LENGTH} знаков.</p>}
      {save.isError && <p className="ui-field__error" role="alert">Не сохранилось: Hub не ответил. Попробуйте ещё раз.</p>}
      <div className="wb-payout__actions">
        <Button type="submit" variant="primary" loading={save.isPending} disabled={tooLong || (text.trim() === "" && saved === null)}>Сохранить</Button>
        {editing && <Button variant="ghost" disabled={save.isPending} onClick={() => setEditing(false)}>Отмена</Button>}
      </div>
    </form>
  );
}

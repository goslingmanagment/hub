import { Pencil } from "lucide-react";
import { useState } from "react";
import type { AccountStartResponse } from "@agency_hub_core/contracts";
import { PAYOUT_DETAILS_MAX_LENGTH } from "@agency_hub_core/contracts";
import { Button, Textarea } from "@agency_hub_core/ui";
import { PasswordWayIn } from "./PasswordWayIn.js";
import { useSetPayoutDetails } from "./start.js";
import { useMe } from "./useMe.js";

/**
 * Where the person's payouts go, in their own words, saved as written (`accountPayoutDetailsSet`): one card on «Начало»
 * (the newcomer's step, which closes on save) and on «Аккаунт и устройства» (everyone's, any time). A narrow session
 * (opened from the extension, no password) shows them and the way to the password, never the form.
 */
export function PayoutDetails({ data }: { data: Pick<AccountStartResponse, "payoutDetails"> }) {
  const { narrow } = useMe();
  if (narrow) return <PayoutRead data={data} />;
  return <PayoutEdit data={data} />;
}

function PayoutRead({ data }: { data: Pick<AccountStartResponse, "payoutDetails"> }) {
  const saved = data.payoutDetails;
  return (
    <div className="wb-payout">
      {saved === null ? <p className="wb-payout__text">Ещё не указано.</p> : <p className="wb-payout__value">{saved.text}</p>}
      <div className="wb-payout__foot">
        <PasswordWayIn text={saved === null ? "Чтобы указать, войдите на сайте с паролем." : undefined} />
      </div>
    </div>
  );
}

function PayoutEdit({ data }: { data: Pick<AccountStartResponse, "payoutDetails"> }) {
  const saved = data.payoutDetails;
  const save = useSetPayoutDetails();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(saved?.text ?? "");
  const open = saved === null || editing;
  if (!open) {
    return (
      <div className="wb-payout">
        <p className="wb-payout__value">{saved.text}</p>
        <div className="wb-payout__foot">
          <span className="wb-payout__quiet">Видите только вы и владелец.</span>
          <Button size="sm" variant="ghost" icon={Pencil} onClick={() => { setText(saved.text); setEditing(true); }}>Изменить</Button>
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

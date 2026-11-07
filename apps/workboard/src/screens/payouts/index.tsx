import { ScreenHeader } from "@/shared/ScreenHeader";
import { ScreenStub } from "@/shared/ScreenStub";

/** Выплаты (spec §4.7): confirmed sales per chatter for the payout sheet. */
export function PayoutsScreen() {
  return (
    <>
      <ScreenHeader title="Выплаты" period />
      <div className="wb-content">
        <ScreenStub title="Выплаты">
          Подтверждённые продажи по чаттерам за период, копия для таблицы выплат и кто ещё не подтвердил.
        </ScreenStub>
      </div>
    </>
  );
}

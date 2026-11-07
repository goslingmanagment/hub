import { ScreenHeader } from "@/shared/ScreenHeader";
import { ScreenStub } from "@/shared/ScreenStub";

/** Смены (home, spec §4.1): who works now, the week by chatter × day, the journal of every shift. */
export function ShiftsScreen() {
  return (
    <>
      <ScreenHeader title="Смены" period pageFilter />
      <div className="wb-content">
        <ScreenStub title="Смены">
          Кто сейчас на смене, как идёт неделя по чаттерам и дням и журнал всех смен. Строка смены открывает разбор.
        </ScreenStub>
      </div>
    </>
  );
}

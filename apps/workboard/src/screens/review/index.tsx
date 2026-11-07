import { useParams } from "react-router";
import { TimeMsk } from "@agency_hub_core/ui";
import { parseShiftKey, useBackTarget } from "@/shared/links";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { ScreenStub } from "@/shared/ScreenStub";

/** Разбор смены (spec §4.2): one shift opened up — pulse, chats, the conversation. */
export function ReviewScreen() {
  const { userId, shiftStart } = useParams();
  const at = parseShiftKey(shiftStart);
  const back = useBackTarget({ to: "/shifts", label: "Смены" });
  return (
    <>
      <ScreenHeader title="Разбор смены" back={back} meta={at ? <>Смена с <TimeMsk at={at} /> · пользователь {userId}</> : "Смена не найдена в адресе"} />
      <div className="wb-content">
        <ScreenStub title="Разбор смены">
          Пульс смены, список чатов с причинами посмотреть и сам разговор справа.
        </ScreenStub>
      </div>
    </>
  );
}

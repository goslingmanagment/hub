import { useDecisionCounts } from "@/shared/decisions";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { ScreenStub } from "@/shared/ScreenStub";

/** Решения (spec §4.6): what waits for the owner — disputes, customs, held sends. */
export function DecisionsScreen() {
  const counts = useDecisionCounts();
  return (
    <>
      <ScreenHeader title="Решения" pageFilter />
      <div className="wb-content">
        <ScreenStub title={counts.total > 0 ? `Ждут решения: ${counts.total}` : "Всё решено"}>
          Споры по продажам, оплаченные и не отданные кастомы, зависшие отправки. Каждый раздел скрыт, когда пуст.
        </ScreenStub>
      </div>
    </>
  );
}

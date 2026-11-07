import { Disclosure } from "@agency_hub_core/ui";
import { formatDuration } from "@agency_hub_core/ui/format";
import {
  CHATTER_SHIFT_END_IDLE_MINUTES,
  CHATTER_SHIFT_IDLE_PAUSE_MINUTES,
  CHATTER_SHIFT_MIN_MESSAGES,
  CHATTER_SHIFT_MIN_WORKED_MINUTES,
  CHATTER_SHIFT_PAGE_MIN_MESSAGES,
} from "@agency_hub_core/contracts";
import { METRICS } from "@/shared/metrics";
import { OUTLIER } from "./data.js";

/**
 * «Как это считается» at the bottom of Смены: the rules of the console's
 * «Заработок» (TeamShiftsPage HowItCounts), shorter, plus the journal's
 * quality columns — the review's own definitions (shared/metrics) — and their marks.
 */
/** A definition after a label and a colon: its first letter small. */
function lower(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

export function HowItCounts({ page }: { page: string | null }) {
  return (
    <Disclosure summary="Как это считается">
      <div className="shifts-how wb-readable">
        <p>
          <b>Смена</b> — по расширению ChatGoose: от первого действия чаттера на странице (клавиша, клик, прокрутка) до
          {" "}{formatDuration(CHATTER_SHIFT_END_IDLE_MINUTES)} без действий. Сменой считается работа от
          {" "}{formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений, меньше — заход, его здесь нет.
          Первые {CHATTER_SHIFT_IDLE_PAUSE_MINUTES} минут без действий — работа, дальше пауза. «Отработал» — смена без пауз.
          Смена относится к дню, на который приходится большая её часть, как в таблице выплат.
        </p>
        <p>
          <b>Продажи</b> — деньги после комиссии на страницах, где чаттер за смену написал от {CHATTER_SHIFT_PAGE_MIN_MESSAGES} сообщений.
          Если страницу вели двое, продажа у того, кто последним писал фану; если никто из них не писал — у обоих. В строке
          «Вся команда» каждая продажа одна. «В час» — продажи на отработанное время без пауз. Проценты — к такому же
          периоду прямо перед выбранным; у идущей недели — к прошлой на это же время.
        </p>
        <p>
          Три числа качества считаются так же, как в разборе смены, и у одной смены везде одинаковы
          {page ? ". С выбранной страницей они — по всей смене, на всех её страницах" : ""}:
        </p>
        <ul className="shifts-how__terms">
          <li><b>{METRICS.reply.label}</b> — {lower(METRICS.reply.hint)}</li>
          <li><b>{METRICS.unanswered.label}</b> — {lower(METRICS.unanswered.hint)} У идущей смены — те, кто ждёт сейчас.</li>
          <li><b>{METRICS.aiUnedited.label}</b> — {lower(METRICS.aiUnedited.hint)}</li>
        </ul>
        <p>
          <b>Выделено</b> то, что заметно хуже обычной смены всей команды за этот период (на всех страницах): ответ вдвое
          дольше обычного и дольше {OUTLIER.replyFloorSeconds / 60} минут; без ответа к концу вдвое больше обычного и от
          {" "}{OUTLIER.unansweredFloor}; ИИ без правки на {Math.round(OUTLIER.aiAbovePoints * 100)} пунктов выше обычного и
          от {Math.round(OUTLIER.aiFloor * 100)} %.
        </p>
        <p>Это ориентир, а не основание для оплаты: к выплате идут подтверждённые отчёты смен.</p>
      </div>
    </Disclosure>
  );
}

import { Check } from "lucide-react";
import { useLocation } from "react-router";
import type { PersonStartStepId } from "@agency_hub_core/contracts";
import { Card, LinkButton, cx } from "@agency_hub_core/ui";
import { formatDay } from "@agency_hub_core/ui/format";
import { personCodePath } from "@/shared/links";
import { deviceWords } from "@/screens/start/words";
import type { OwnerCard } from "./registry.js";

/**
 * «Ввод: 3 из 5» on the owner's card of a newcomer: the same five steps the
 * person sees on «Начало», each closed by what Hub saw, in the owner's words —
 * and where the person's payouts go (the owner's card only). A step that waits
 * for the owner (a page) says so with the way to it; standing on one place for
 * two days is the owner's matter too (people/start-tick.ts on Hub).
 */

/** What the owner does about a step, or what it is: the place's name in «стоит на шаге …». */
const PLACE: Readonly<Record<PersonStartStepId, string>> = {
  install: "Установить расширение",
  extension: "Войти в расширение",
  pages: "Страница",
  activity: "Первая работа на странице",
  payout: "Куда платить",
};

function line(step: PersonStartStepId, done: boolean, card: OwnerCard): { title: string; detail: string | null } {
  const start = card.start!;
  switch (step) {
    case "install":
      return done ? { title: "Расширение установлено", detail: null } : { title: "Расширение не установлено", detail: null };
    case "extension":
      if (!done || start.extension === null) return { title: "Входа в расширение нет", detail: null };
      return {
        title: "Расширение подключено",
        detail: [deviceWords(start.extension.label), formatDay(start.extension.signedInAt)].filter(Boolean).join(", ")
          + (start.extension.active ? "" : "; вход завершён"),
      };
    case "pages":
      return done
        ? { title: "Страницы открыты", detail: start.pages.map((page) => page.pageLabel).join(", ") }
        : { title: "Страница не назначена", detail: "назначаете вы" };
    case "activity":
      return done && start.firstActivity
        ? { title: "Первая работа", detail: `${start.firstActivity.pageLabel}, ${formatDay(start.firstActivity.at)}` }
        : { title: "Работы на странице нет", detail: "доступ к аккаунту страницы даёте вы" };
    case "payout":
      return done && card.payoutDetails
        ? { title: "Куда платить", detail: card.payoutDetails.text }
        : { title: "Куда платить: не написано", detail: null };
  }
}

/** One sentence: «с 11 нояб.» already ends with a dot. */
function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

function lead(card: OwnerCard): string {
  const start = card.start!;
  if (start.current === null) return "Все шаги пройдены. Статус «работает» ставите вы: «График и условия», блок «Человек».";
  const since = start.since ? formatDay(start.since) : null;
  if (!start.signedUp) return sentence(`Приглашение ещё не открыто${since ? `: создано ${since}` : ""}${start.stuck ? ", больше двух суток назад" : ""}`);
  if (start.stuck) return sentence(`Больше двух суток на шаге «${PLACE[start.current]}»${since ? `: с ${since}` : ""}`);
  return sentence(`На шаге «${PLACE[start.current]}»${since ? ` с ${since}` : ""}`);
}

export function IntakeCard({ card }: { card: OwnerCard }) {
  const location = useLocation();
  const start = card.start;
  if (!start?.newcomer) return null;
  const pagesOpen = start.steps.some((step) => step.step === "pages" && !step.done);
  return (
    <Card
      title={`Ввод: ${start.done} из ${start.total}`}
      description={<span className={cx(start.stuck && "intake-late")}>{lead(card)}</span>}
      actions={pagesOpen ? <LinkButton size="sm" variant="primary" to={personCodePath(card.person.code, location.search, "access")}>Назначить страницу</LinkButton> : undefined}
    >
      <ol className="intake-steps">
        {start.steps.map((step) => {
          const words = line(step.step, step.done, card);
          return (
            <li key={step.step} className={cx("intake-step", step.done && "intake-step--done", start.signedUp && start.current === step.step && "intake-step--current")}>
              <span className="intake-mark" aria-hidden>{step.done ? <Check size={14} strokeWidth={2.5} /> : null}</span>
              <span className="intake-step__body">
                <span className="intake-step__title">{words.title}<span className="intake-sr">{step.done ? ": готово" : ": не готово"}</span></span>
                {words.detail && <span className="intake-step__detail">{words.detail}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

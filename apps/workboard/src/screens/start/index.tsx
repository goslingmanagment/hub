import { Check, Copy, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import type { AccountStartResponse, PersonStartStepId } from "@agency_hub_core/contracts";
import { Bar, Button, Card, ErrorState, LinkButton, Skeleton, SkeletonText, cx } from "@agency_hub_core/ui";
import { CHATTER_SITE_ORIGIN } from "@agency_hub_core/ui/sites";
import { copyText } from "@/screens/payouts/copy";
import { PayoutDetails } from "@/shared/PayoutDetails";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { useAccountStart } from "@/shared/start";
import { homePath, useMe } from "@/shared/useMe";
import { firstName, leftWords, pagesWords, shiftRules, stepWords } from "./words.js";
import "./start.css";

/** The site's install block: the button there is the current Firefox file the site serves (no version here). */
const INSTALL_HREF = `${CHATTER_SITE_ORIGIN}/#install`;

/**
 * «Начало» (package J): a newcomer's way from the invitation to the first
 * shift, the person's own. Five lines, each closed by what Hub sees — the
 * extension signed in, a page opened, the first active minute, where payouts
 * go — never ticked by hand; the one open line carries its one action. Beside
 * them, how a shift is handed in and the Telegram groups. Once every line is
 * done the menu drops «Начало» and Workboard opens «Мои смены»; this address
 * still answers a newcomer, with «Всё готово». Anyone else (a person at work
 * for months, a login of nobody) is led home: where payouts go is theirs on
 * «Аккаунт и устройства».
 */
export function StartScreen() {
  const { role } = useMe();
  const read = useAccountStart(true);
  const data = read.data;

  if (!data) {
    return (
      <>
        <ScreenHeader title="Начало" meta={read.isError ? undefined : <Skeleton width={320} />} />
        <div className="wb-content">
          {read.isError ? <ErrorState onRetry={() => void read.refetch()} retrying={read.isFetching}>«Начало» не пришло. Обновите экран через минуту.</ErrorState> : (
            <div className="start-grid">
              <Card><SkeletonText lines={8} /></Card>
              <Card><SkeletonText lines={6} /></Card>
            </div>
          )}
        </div>
      </>
    );
  }

  const start = data.start;
  // «Начало» is a newcomer's: anyone else is not told «остался 1 шаг до первой смены».
  if (data.person === null || start === null || !start.newcomer) return <Navigate to={homePath(role)} replace />;

  const done = start.done === start.total;
  return (
    <>
      <ScreenHeader
        title="Начало"
        meta={<span className="start-hello">Здравствуйте, {firstName(data)}! {done ? "Всё готово к работе." : `${leftWords(start)}: каждая строка закроется сама, когда Hub это увидит.`}</span>}
        updatedAt={read.dataUpdatedAt}
        onRefresh={() => void read.refetch()}
        refreshing={read.isFetching}
      />
      <div className="wb-content">
        <div className="start-grid">
          <div className="start-main">
            {done && (
              <Card className="start-done">
                <div className="start-done__row">
                  <span className="start-mark start-mark--done start-mark--lg" aria-hidden><Check size={20} strokeWidth={2.25} /></span>
                  <div>
                    <h2 className="start-done__title">Всё готово</h2>
                    <p className="start-text">Hub видит расширение, страницу и вашу работу на ней. Дальше ваши смены и отчёты по ним в «Мои смены».</p>
                  </div>
                </div>
                <LinkButton variant="primary" to="/my/shifts">Мои смены</LinkButton>
              </Card>
            )}
            <Card
              title="Путь до первой смены"
              actions={<span className="start-count">{start.done} из {start.total}</span>}
              padding="none"
            >
              <div className="start-progress"><Bar value={start.done} max={start.total} tone="accent" label={`Готово ${start.done} из ${start.total}`} /></div>
              <ol className="start-steps">
                {start.steps.map((step, index) => (
                  <Step key={step.step} id={step.step} index={index} done={step.done} current={start.current === step.step} data={data} />
                ))}
              </ol>
            </Card>
          </div>
          <aside className="start-side">
            <ShiftRules submitsShift={data.submitsShift} />
            <Groups data={data} />
          </aside>
        </div>
      </div>
    </>
  );
}

function Step({ id, index, done, current, data }: { id: PersonStartStepId; index: number; done: boolean; current: boolean; data: AccountStartResponse }) {
  const words = stepWords(id, done, data);
  return (
    <li className={cx("start-step", done && "start-step--done", current && "start-step--current")} aria-current={current ? "step" : undefined}>
      <span className={cx("start-mark", done && "start-mark--done", current && "start-mark--current")} aria-hidden>
        {done ? <Check size={16} strokeWidth={2.5} /> : index + 1}
      </span>
      <div className="start-step__body">
        <p className="start-step__title">
          {words.title}
          <span className="start-sr">{done ? ": готово" : current ? ": следующий шаг" : ": ещё впереди"}</span>
        </p>
        {words.text && <p className="start-text">{words.text}</p>}
        <StepMore id={id} done={done} data={data} />
      </div>
    </li>
  );
}

/** A line's one action, or what Hub saw beyond its sentence. */
function StepMore({ id, done, data }: { id: PersonStartStepId; done: boolean; data: AccountStartResponse }): ReactNode {
  const start = data.start!;
  if (id === "install" && !done) {
    return (
      <div className="start-actions">
        <a className="ui-btn ui-btn--primary" href={INSTALL_HREF} target="_blank" rel="noreferrer">
          Открыть установку
          <ExternalLink size={16} strokeWidth={1.75} aria-hidden />
        </a>
      </div>
    );
  }
  if (id === "extension" && !done) {
    return (
      <div className="start-login">
        <span className="start-login__label">Логин</span>
        <code className="start-login__value">{data.username}</code>
        <Button size="sm" icon={Copy} onClick={() => void copyText(data.username, "Логин скопирован")}>Скопировать</Button>
      </div>
    );
  }
  if (id === "pages" && done) {
    return (
      <ul className="start-pages">
        {pagesWords(start.pages).map((line) => <li key={line}>{line}</li>)}
      </ul>
    );
  }
  if (id === "payout") return <PayoutDetails data={data} />;
  return null;
}

function ShiftRules({ submitsShift }: { submitsShift: boolean }) {
  return (
    <Card title="Как сдаётся смена" as="h2">
      <div className="start-rules">
        {shiftRules(submitsShift).map((rule) => (
          <section key={rule.title} className="start-rule">
            <h3 className="start-rule__title">{rule.title}</h3>
            <p className="start-text">{rule.text}</p>
            {rule.list && <ul className="start-rule__list">{rule.list.map((line) => <li key={line}>{line}</li>)}</ul>}
            {rule.after && <p className="start-text">{rule.after}</p>}
          </section>
        ))}
      </div>
    </Card>
  );
}

/** The Telegram groups by plain names: Hub keeps no links to them, the owner adds the person. */
function Groups({ data }: { data: AccountStartResponse }) {
  const models = [...new Set(data.start!.pages.map((page) => page.modelName))];
  return (
    <Card title="Группы в Telegram" description="В группы добавляет владелец.">
      <ul className="start-groups">
        {models.length === 0 ? (
          <li><span className="start-groups__name">Рабочая группа модели</span><span className="start-quiet">назовёт владелец вместе со страницей</span></li>
        ) : models.map((model) => (
          <li key={model}><span className="start-groups__name">Рабочая группа {model}</span><span className="start-quiet">топик «Отчётность» и Генгар</span></li>
        ))}
        <li><span className="start-groups__name">Канал ChatGoose</span><span className="start-quiet">что нового в расширении</span></li>
      </ul>
    </Card>
  );
}

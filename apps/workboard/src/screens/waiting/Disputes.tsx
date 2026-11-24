import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OffPlatformPendingResponse, SaleDisputeResponse, ShiftReportLineFacts } from "@agency_hub_core/contracts";
import { Badge, Button, ErrorState, Fan, Modal, Money, Notice, PageLabel, Select, Skeleton, TextInput, toast } from "@agency_hub_core/ui";
import { formatDateTime, formatDay, formatMills } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { KernelApiError } from "@agency_hub_core/ui/hubClient";
import { kernel } from "@/shared/hub";
import { ChainMoney } from "@/shared/saleChain";

/**
 * «Ждут вас» of the owner, package G: the dispute of a sale (both statements,
 * the facts the rule read, the four answers and what each gives), a report's
 * «мимо площадки» (confirm on a page, or reject), the week's sales nobody
 * claimed (leave them nobody's), and the decisions carried over from the ledger
 * that wait to be tied to their sale. Each opens from its line; each answer is
 * one press, with an optional line of why kept beside the decision.
 */

const KIND_WORDS: Readonly<Record<string, string>> = {
  message_purchase: "PPV",
  post_purchase: "пост",
  tip: "чаевые",
  stream_tip: "чаевые",
  subscription: "подписка",
};
const kindWord = (kind: string) => KIND_WORDS[kind] ?? kind;
const plural = (count: number, one: string, few: string, many: string) => `${count} ${ruPlural(count, one, few, many)}`;

function useDone(onClose: () => void) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["matters"] });
    void queryClient.invalidateQueries({ queryKey: ["sale-claims"] });
    onClose();
  };
}

/** The facts the rule read of the sale, in words (the same facts the person's «почему» shows). */
function FactsList({ facts }: { facts: ShiftReportLineFacts }) {
  const items: string[] = [];
  if (facts.ppv !== null) {
    if (facts.ppv.senderName !== null) items.push(`PPV отправил ${facts.ppv.senderName}${facts.ppv.sentAt ? ` ${formatDateTime(facts.ppv.sentAt)}` : ""}`);
    else if (facts.ppv.withoutAuthor) items.push("PPV отправлен без автора: с телефона или рассылкой");
    else items.push("сообщение с этим PPV в Hub не найдено");
  }
  if (facts.holders !== null) {
    items.push(facts.holders.length === 0
      ? "страницу держала только смена заявителя"
      : `страницу держали ${facts.holders.map((one) => `${one.name}${one.slotRunning === true ? " (шёл его слот)" : one.slotRunning === false ? " (не его слот)" : ""}`).join(", ")}`);
  }
  if (facts.ownSlotRunning !== null) items.push(facts.ownSlotRunning ? "слот заявителя в это время шёл" : "слот заявителя в это время не шёл");
  items.push(facts.lastWriter === null
    ? "за 60 дней фану никто не писал из расширения"
    : `последним фану писал ${facts.lastWriter.name} ${formatDateTime(facts.lastWriter.at)}${facts.lastWriter.within48h ? "" : ", больше 48 часов назад"}`);
  if (facts.writers.length > 1) items.push(`писали за 48 часов: ${facts.writers.map((writer) => `${writer.name} ${writer.messages}`).join(", ")}`);
  for (const other of facts.otherReports) items.push(`в отчёте: ${other.name}, ${formatDay(other.reportDate)}`);
  if (facts.pot !== null) items.push("по правилу это общак страницы");
  if (facts.renewalOf !== null) items.push(`автопродление: такое же списание было ${formatDateTime(facts.renewalOf)}`);
  return <ul className="wt-facts">{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

function SaleLine({ sale }: { sale: NonNullable<SaleDisputeResponse["sale"]> }) {
  return (
    <div className="wt-sale">
      <PageLabel label={sale.pageLabel} />
      <Fan name={sale.fan.name} username={sale.fan.username} fanRef={sale.fan.fanRef ?? ""} showLogin />
      <span className="wt-sale__kind">{kindWord(sale.kind)}</span>
      <span className="wt-sale__when">{formatDateTime(sale.occurredAt)}</span>
      <span className="wt-sale__money"><ChainMoney saleId={sale.transactionId}><Money mills={sale.netMills} strong /></ChainMoney></span>
    </div>
  );
}

/** The owner's dispute of a sale: both statements, the facts, the four answers with what each gives. */
export function DisputeModal({ transactionId, claimId, onClose }: { transactionId: number | null; claimId: number | null; onClose: () => void }) {
  const done = useDone(onClose);
  const read = useQuery({
    queryKey: ["sale-claims", "dispute", transactionId, claimId],
    queryFn: () => (transactionId !== null
      ? kernel.saleDispute({ params: { transactionId } })
      : kernel.saleDisputeOfClaim({ params: { claimId: claimId! } })),
  });
  const [why, setWhy] = useState("");
  const decide = useMutation({
    // A button names its people (`shares`) and the sides the window showed: the server gives the sale to them, or answers
    // 409 `sides_changed` when the sides are no longer those — the window reads again.
    mutationFn: (one: SaleDisputeResponse["outcomes"][number]) => kernel.saleDisputeDecide({
      body: {
        ...(transactionId !== null ? { transactionId } : { claimId: claimId! }), outcome: one.outcome, note: why.trim() === "" ? null : why.trim(),
        ...(one.shares.length > 0 ? { shares: one.shares } : {}),
        seenSides: (read.data?.parties ?? []).map((party) => party.userId),
      },
    }),
    onError: (error) => {
      const body = error instanceof KernelApiError ? error.body as { reason?: unknown } | null : null;
      if (body?.reason === "sides_changed") {
        toast.error("Пока вы смотрели, стороны спора изменились: окно обновлено");
        void read.refetch();
      }
    },
    onSuccess: (answer) => {
      toast.success(answer.versions.length > 0
        ? `Решение записано: ${plural(answer.versions.length, "отчёт получил", "отчёта получили", "отчётов получили")} новую версию`
        : "Решение записано");
      done();
    },
  });
  const data = read.data;
  const nameOf = (userId: number) => data?.parties.find((one) => one.userId === userId)?.name ?? "";
  return (
    <Modal title={data?.potOffer ? "Продажа в общак" : "Спор о продаже"} size="wide" onClose={onClose}>
      {read.isPending && <div className="wt-modal"><Skeleton width="70%" /><Skeleton width="90%" /><Skeleton width="60%" /></div>}
      {read.isError && <ErrorState compact onRetry={() => void read.refetch()} retrying={read.isFetching}>Спор не пришёл.</ErrorState>}
      {data && (
        <div className="wt-modal">
          {data.sale
            ? <SaleLine sale={data.sale} />
            : <Notice tone="warning" title="Продажа не привязана">Вопрос перенесён из ledger, и по его тексту продажа не нашлась.</Notice>}
          {data.claims[0]?.question && <p className="wt-question">{data.claims[0].question}</p>}
          {data.home && (
            <p className="wt-home">
              <span className="wt-home__label">По правилу сейчас:</span> {data.home.words}
              {data.home.shares.length > 0 && <> ({data.home.shares.map((share) => `${share.name} ${formatMills(share.mills)}`).join(", ")})</>}
            </p>
          )}
          {data.parties.length > 0 && (
            <div className="wt-parties">
              {data.parties.map((party) => (
                <section key={party.userId} className="wt-party" aria-label={party.name}>
                  <h3 className="wt-party__name">{party.name}</h3>
                  <ul className="wt-party__says">{party.says.map((line) => <li key={line}>{line}</li>)}</ul>
                  <p className="wt-party__counted">
                    {party.countedMills === null ? "в сданном отчёте этой продажи нет"
                      : (party.claimedMills ?? 0) > 0 ? <>в сданном отчёте: спорно, ждёт решения: <Money mills={party.claimedMills!} /></>
                        : <>в сданном отчёте: <Money mills={party.countedMills} /></>}
                  </p>
                </section>
              ))}
            </div>
          )}
          {data.cards.length > 0 && (
            <Notice tone="warning" title="Генгар предлагал иначе">
              {data.cards.map((card) => <p key={`${card.words}:${card.why}`}>«{card.words}»: {card.why}</p>)}
            </Notice>
          )}
          {data.facts && (
            <section className="wt-modal__block" aria-label="Факты">
              <h3 className="wt-modal__title">Факты</h3>
              <FactsList facts={data.facts} />
            </section>
          )}
          {data.decision ? (
            <Notice tone="success" title={`Решено ${formatDateTime(data.decision.decidedAt)}${data.decision.by ? `: ${data.decision.by}` : ""}`}>
              {data.decision.note ?? "без пояснения"}
            </Notice>
          ) : (
            <section className="wt-modal__block" aria-label="Решение">
              <h3 className="wt-modal__title">Ваше решение</h3>
              <TextInput value={why} onChange={(event) => setWhy(event.target.value)} maxLength={1000} placeholder="Почему так: одной строкой, по желанию" aria-label="Почему так" />
              <div className="wt-outcomes">
                {data.outcomes.map((one) => (
                  <Button
                    key={one.key || one.outcome}
                    size="md"
                    variant={one.outcome === "nobody" || one.outcome === "dismiss" ? "ghost" : "secondary"}
                    loading={decide.isPending && decide.variables === one}
                    disabled={decide.isPending}
                    onClick={() => decide.mutate(one)}
                    className="wt-outcome"
                  >
                    <span className="wt-outcome__label">{one.label}</span>
                    {one.gives.length > 0 && one.outcome !== "nobody" && (
                      <span className="wt-outcome__gives">{one.gives.map((give) => `${nameOf(give.userId)} ${formatMills(give.mills)}`).join(" · ")}</span>
                    )}
                  </Button>
                ))}
              </div>
              <p className="wt-modal__hint">
                {data.home?.kind === "before_rule"
                  ? "Продажа раньше 2 нояб., до правила: решение запишется для истории, но чья она и отчёты не изменятся."
                  : <>
                    {"Решение встанет выше правила. "}
                    {data.reports.length > 0
                      ? `Новую версию с вашим решением получат отчёты, сданные в системе (сдавать заново не нужно): ${data.reports.map((one) => `${one.name} за ${formatDay(one.reportDate)}`).join(", ")} `
                      : "Отчётов, сданных в системе, с этой продажей нет. "}
                    {"Отчёт постом в «Отчётности» никто не пересчитает: решение возьмёт следующий отчёт."}
                  </>}
              </p>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

type PendingReport = OffPlatformPendingResponse["reports"][number];

function OffPlatformLine({ report, line, onDone }: { report: PendingReport; line: PendingReport["lines"][number]; onDone: () => void }) {
  const [page, setPage] = useState(report.pages[0] ?? "");
  const decide = useMutation({
    mutationFn: (decision: "confirm" | "reject") => kernel.offPlatformDecide({
      params: { offPlatformId: line.id },
      body: decision === "confirm" ? { decision, pageLabel: page } : { decision },
    }),
    onSuccess: (answer) => {
      toast.success(answer.state === "confirmed" ? `Подтверждено: ${formatMills(line.amountMills)} в сумме ${page}` : "Отклонено: в итог не входит");
      onDone();
    },
  });
  return (
    <li className="wt-off">
      <div className="wt-off__main">
        <p className="wt-off__what"><Money mills={line.amountMills} strong /> <span>от {line.fromWhom}</span></p>
        <p className="wt-off__why">{line.whatFor}</p>
      </div>
      <div className="wt-off__act">
        {report.pages.length > 1 && (
          <Select value={page} onChange={(event) => setPage(event.target.value)} aria-label="На какую страницу">
            {report.pages.map((one) => <option key={one} value={one}>{one}</option>)}
          </Select>
        )}
        <Button size="sm" variant="primary" loading={decide.isPending && decide.variables === "confirm"} disabled={decide.isPending} onClick={() => decide.mutate("confirm")}>Подтвердить</Button>
        <Button size="sm" variant="ghost" loading={decide.isPending && decide.variables === "reject"} disabled={decide.isPending} onClick={() => decide.mutate("reject")}>Отклонить</Button>
      </div>
    </li>
  );
}

/** A report's «мимо площадки»: each line confirmed on a page of the report (it enters its sum) or rejected. */
export function OffPlatformModal({ shiftId, onClose }: { shiftId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const read = useQuery({ queryKey: ["sale-claims", "off-platform", shiftId], queryFn: () => kernel.offPlatformPending({ query: { shiftId } }) });
  const report = read.data?.reports[0];
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["matters"] });
    void read.refetch().then((answer) => {
      if ((answer.data?.reports.length ?? 0) === 0) onClose();
    });
  };
  return (
    <Modal title="Мимо площадки" size="form" onClose={onClose}>
      {read.isPending && <div className="wt-modal"><Skeleton width="80%" /><Skeleton width="60%" /></div>}
      {read.isError && <ErrorState compact onRetry={() => void read.refetch()} retrying={read.isFetching}>Строки не пришли.</ErrorState>}
      {read.data && !report && <p className="wt-modal__hint">Здесь больше ничего не ждёт.</p>}
      {report && (
        <div className="wt-modal">
          <p className="wt-off__head">
            <strong>{report.person.name}</strong>, отчёт за {formatDay(`${report.reportDate}T12:00:00+03:00`)}
            <span className="wt-off__total"> · в отчёте <Money mills={report.totalMills} /></span>
          </p>
          <p className="wt-modal__hint">Со слов чаттера. Подтверждённая сумма войдёт в сумму страницы отчёта новой версией: чаттер сдавать заново не будет.</p>
          <ul className="wt-offs">{report.lines.map((line) => <OffPlatformLine key={line.id} report={report} line={line} onDone={refresh} />)}</ul>
        </div>
      )}
    </Modal>
  );
}

/** All open nobody sales (owner-only, H8): live solo-page suggestion, «Отдать <имя>», pick another person, «Оставить», and «Ждёт отчёта». */
export function NobodyModal({ week, onClose }: { week?: string | undefined; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<Record<number, number>>({});
  const read = useQuery({
    queryKey: ["sale-claims", "nobody", week ?? "all"],
    queryFn: () => kernel.saleNobody({ query: week ? { week } : {} }),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["matters"] });
    void queryClient.invalidateQueries({ queryKey: ["sale-claims"] });
    void read.refetch();
  };
  const give = useMutation({
    mutationFn: (input: { transactionId: number; userId: number; name: string }) =>
      kernel.saleNobodyGive({ body: { transactionId: input.transactionId, userId: input.userId } }),
    onError: (error) => {
      const reason = error instanceof KernelApiError ? (error.body as { reason?: unknown } | null)?.reason : undefined;
      if (reason === "already_decided" || reason === "not_nobody") {
        toast.error("Эта продажа уже решена: список обновлён");
        refresh();
      }
    },
    onSuccess: (answer, vars) => {
      toast.success(
        answer.status === "delivered"
          ? `Отдано ${vars.name}: отчёт получил новую версию`
          : answer.status === "draft"
            ? `Отдано ${vars.name}: добавлено в открытый черновик`
            : `Отдано ${vars.name}: ждёт следующего отчёта`,
      );
      refresh();
    },
  });
  const keep = useMutation({
    mutationFn: (transactionIds?: number[]) =>
      kernel.saleNobodyKeep({ body: { ...(week ? { week } : {}), ...(transactionIds ? { transactionIds } : {}) } }),
    onError: (error) => {
      const reason = error instanceof KernelApiError ? (error.body as { reason?: unknown } | null)?.reason : undefined;
      if (reason === "already_decided") {
        toast.error("Часть продаж уже решена: список обновлён");
        refresh();
      }
    },
    onSuccess: (answer, vars) => {
      toast.success(`Оставлены ничьими: ${answer.kept}`);
      if (vars === undefined) {
        void queryClient.invalidateQueries({ queryKey: ["matters"] });
        void queryClient.invalidateQueries({ queryKey: ["sale-claims"] });
        onClose();
      } else {
        refresh();
      }
    },
  });
  const data = read.data;
  const candidates = data?.candidates ?? [];
  const waiting = data?.waitingDecisions ?? [];
  const busy = give.isPending || keep.isPending;
  return (
    <Modal
      title="Ничьи продажи"
      size="wide"
      onClose={onClose}
      actions={data && data.sales.length > 0 ? (
        <>
          <Button variant="ghost" onClick={onClose}>Закрыть</Button>
          <Button variant="primary" loading={keep.isPending && keep.variables === undefined} disabled={busy} onClick={() => keep.mutate(undefined)}>Оставить все ничьими</Button>
        </>
      ) : undefined}
    >
      {read.isPending && <div className="wt-modal"><Skeleton width="80%" /><Skeleton width="70%" /></div>}
      {read.isError && <ErrorState compact onRetry={() => void read.refetch()} retrying={read.isFetching}>Список не пришёл.</ErrorState>}
      {data && (
        <div className="wt-modal">
          <p className="wt-modal__hint">
            Все открытые ничьи продажи независимо от закрытия недели. Чаттеры и тимлиды их не видят.
            Если на странице один активный чаттер, показана подсказка — решение всё равно за вами.
          </p>
          {data.sales.length === 0 ? <p className="wt-modal__hint">Открытых ничьих продаж нет.</p> : (
            <>
              <ul className="wt-nobody">
                {data.sales.map((sale) => {
                  const chosenId = picked[sale.transactionId] ?? 0;
                  const chosen = candidates.find((candidate) => candidate.userId === chosenId) ?? null;
                  return (
                    <li key={sale.transactionId} className="wt-nobody__line wt-nobody__line--rich">
                      <span className="wt-nobody__when">{formatDateTime(sale.occurredAt)}</span>
                      <span className="wt-nobody__what">
                        <PageLabel label={sale.pageLabel} />
                        <Fan name={sale.fan.name} username={sale.fan.username} fanRef={sale.fan.fanRef ?? ""} />
                        <span className="wt-sale__kind">{kindWord(sale.kind)}</span>
                        <span className="wt-nobody__why">{sale.words}</span>
                        {sale.suggestion && (
                          <Badge tone="info">один чаттер на странице: {sale.suggestion.name}</Badge>
                        )}
                      </span>
                      <span className="wt-sale__money"><ChainMoney saleId={sale.transactionId}><Money mills={sale.netMills} /></ChainMoney></span>
                      <div className="wt-nobody__act">
                        {sale.suggestion && (
                          <Button
                            size="sm"
                            variant="primary"
                            loading={give.isPending && give.variables?.transactionId === sale.transactionId && give.variables.userId === sale.suggestion.userId}
                            disabled={busy}
                            onClick={() => give.mutate({ transactionId: sale.transactionId, userId: sale.suggestion!.userId, name: sale.suggestion!.name })}
                          >
                            Отдать {sale.suggestion.name}
                          </Button>
                        )}
                        {candidates.length > 0 && (
                          <span className="wt-nobody__pick">
                            <Select
                              value={chosenId === 0 ? "" : String(chosenId)}
                              onChange={(event) => setPicked((prev) => ({ ...prev, [sale.transactionId]: Number(event.target.value) || 0 }))}
                              aria-label="Кому отдать продажу"
                            >
                              <option value="">{sale.suggestion ? "Другому…" : "Кому отдать…"}</option>
                              {candidates.map((candidate) => (
                                <option key={candidate.userId} value={String(candidate.userId)}>
                                  {candidate.name}{candidate.workingPageLabels.includes(sale.pageLabel) ? " (страница)" : ""}
                                </option>
                              ))}
                            </Select>
                            {chosen && (
                              <Button
                                size="sm"
                                variant="secondary"
                                loading={give.isPending && give.variables?.transactionId === sale.transactionId && give.variables.userId === chosen.userId}
                                disabled={busy}
                                onClick={() => give.mutate({ transactionId: sale.transactionId, userId: chosen.userId, name: chosen.name })}
                              >
                                Отдать
                              </Button>
                            )}
                          </span>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={keep.isPending && keep.variables?.includes(sale.transactionId)}
                          disabled={busy}
                          onClick={() => keep.mutate([sale.transactionId])}
                        >
                          Никому
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="wt-nobody__total">{plural(data.sales.length, "продажа", "продажи", "продаж")} на <Money mills={data.totalMills} strong /></p>
            </>
          )}
          {waiting.length > 0 && (
            <section className="wt-modal__block" aria-label="Ждёт отчёта">
              <h3 className="wt-modal__title">Ждёт отчёта <Badge tone="warning">{waiting.length}</Badge></h3>
              <p className="wt-modal__hint">Отдано владельцем: попадёт в черновик следующей смены получателя. Ушедшему человеку отметьте применение командой sale applied.</p>
              <ul className="wt-nobody">
                {waiting.map((one) => (
                  <li key={one.decisionId} className="wt-nobody__line">
                    <span className="wt-nobody__when">{formatDateTime(one.occurredAt)}</span>
                    <span className="wt-nobody__what">
                      <PageLabel label={one.pageLabel} />
                      <Fan name={one.fan.name} username={one.fan.username} fanRef={one.fan.fanRef ?? ""} />
                      <span className="wt-sale__kind">{kindWord(one.kind)}</span>
                      {one.recipients.map((recipient) => (
                        <Badge key={recipient.userId} tone={recipient.isLeft ? "off" : "warning"}>
                          {recipient.name}{recipient.percent < 100 ? ` ${recipient.percent}%` : ""} · {recipient.isLeft ? "ушёл, ждёт sale applied" : "ждёт отчёта"}
                        </Badge>
                      ))}
                    </span>
                    <ChainMoney saleId={one.transactionId}><Money mills={one.netMills} /></ChainMoney>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Decisions carried over from the ledger whose sale its text did not name: each with the sales it may be. */
export function UnlinkedModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const read = useQuery({ queryKey: ["sale-claims", "unlinked"], queryFn: () => kernel.saleDecisionsUnlinked() });
  const link = useMutation({
    mutationFn: (input: { decisionId: number; transactionId: number }) => kernel.saleDecisionLink({ params: { decisionId: input.decisionId }, body: { transactionId: input.transactionId } }),
    onSuccess: () => {
      toast.success("Привязано: решение встало на продажу");
      void queryClient.invalidateQueries({ queryKey: ["matters"] });
      void read.refetch();
    },
  });
  return (
    <Modal title="Решения из ledger без продажи" size="wide" onClose={onClose}>
      {read.isPending && <div className="wt-modal"><Skeleton width="80%" /><Skeleton width="70%" /></div>}
      {read.isError && <ErrorState compact onRetry={() => void read.refetch()} retrying={read.isFetching}>Список не пришёл.</ErrorState>}
      {read.data && (
        <div className="wt-modal">
          <p className="wt-modal__hint">По тексту этих решений продажа не нашлась точно. Выберите её среди продаж страницы рядом с датой: решение встанет выше правила.</p>
          {read.data.decisions.length === 0 && <p className="wt-modal__hint">Всё привязано.</p>}
          {read.data.decisions.map((decision) => (
            <section key={decision.id} className="wt-modal__block">
              <h3 className="wt-modal__title">
                {decision.pageLabel && <PageLabel label={decision.pageLabel} />}{" "}
                {decision.kind === "nobody" ? "никому" : decision.kind === "pot" ? "в общак" : decision.shares.map((share) => `${share.name}${share.percent === 100 ? "" : ` ${share.percent}%`}`).join(" и ")}
                {decision.ledgerDecisionId !== null && <Badge tone="off" className="wt-unlinked__id">ledger №{decision.ledgerDecisionId}</Badge>}
              </h3>
              <p className="wt-question">{decision.words}{decision.saidBy ? ` · сказал ${decision.saidBy}` : ""}</p>
              {decision.candidates.length === 0 ? <p className="wt-modal__hint">Похожих продаж рядом с датой нет.</p> : (
                <ul className="wt-nobody">
                  {decision.candidates.map((sale) => (
                    <li key={sale.transactionId} className="wt-nobody__line">
                      <span className="wt-nobody__when">{formatDateTime(sale.occurredAt)}</span>
                      <span className="wt-nobody__what">
                        <Fan name={sale.fan.name} username={sale.fan.username} fanRef={sale.fan.fanRef ?? ""} showLogin />
                        <span className="wt-sale__kind">{kindWord(sale.kind)}</span>
                      </span>
                      <Money mills={sale.netMills} />
                      <Button size="sm" variant="secondary" loading={link.isPending && link.variables?.transactionId === sale.transactionId}
                        onClick={() => link.mutate({ decisionId: decision.id, transactionId: sale.transactionId })}>Это она</Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PotDistributionItem,
  PotDistributionPreviewResponse,
  PotEligibleSale,
  PotFormula,
  PotSummary,
  PotsListResponse,
} from "@agency_hub_core/contracts";
import { millsFromDollars, millsFromInteger, millsToNumber } from "@agency_hub_core/shared";
import {
  Badge,
  Button,
  Checkbox,
  Confirm,
  Drawer,
  EmptyState,
  ErrorState,
  Facts,
  Field,
  Modal,
  Money,
  Notice,
  PageLabels,
  Select,
  Skeleton,
  Table,
  TextInput,
  Textarea,
  toast,
  type Column,
} from "@agency_hub_core/ui";
import { formatDateTime, formatDay } from "@agency_hub_core/ui/format";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { kernel } from "@/shared/hub";
import { ChainMoney } from "@/shared/saleChain";
import { PotFormModal } from "./PotFormModal";

const FORMULA_LABEL: Readonly<Record<PotFormula["kind"], string>> = {
  equal: "Поровну",
  weights: "По весам",
  manual: "Вручную",
};

interface PotDetailDrawerProps {
  pot: PotSummary;
  models: PotsListResponse["models"];
  people: PotsListResponse["people"];
  onClose: () => void;
}

export function PotDetailDrawer({ pot, models, people, onClose }: PotDetailDrawerProps) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["pot", pot.id] as const,
    queryFn: () => kernel.potDetail({ params: { potId: pot.id } }),
  });

  const [editOpen, setEditOpen] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [postConfirm, setPostConfirm] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<PotDistributionItem | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseError, setReverseError] = useState<string | null>(null);

  // Distribution composer state
  const [day, setDay] = useState<string>(() => moscowToday());
  const [formulaKind, setFormulaKind] = useState<PotFormula["kind"]>(pot.formula.kind);
  const [excludedTxIds, setExcludedTxIds] = useState<Set<number>>(() => new Set());
  const [weightInputs, setWeightInputs] = useState<Record<string, string>>(() => {
    const raw = pot.formula.kind === "weights" && typeof pot.formula.params.weights === "object" && pot.formula.params.weights !== null
      ? (pot.formula.params.weights as Record<string, unknown>)
      : {};
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
  });
  const [manualInputs, setManualInputs] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PotDistributionPreviewResponse | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);

  const detail = detailQuery.data;
  const currentPot = detail?.pot ?? pot;
  const peopleByCode = useMemo(() => new Map(people.map((p) => [p.code, p.displayName])), [people]);
  const personLabel = (code: string) => {
    const display = peopleByCode.get(code);
    return display ? `${display} (${code})` : code;
  };

  const remainingSales = useMemo(
    () => (detail?.sales ?? []).filter((s) => s.remainingBaseMills > 0),
    [detail?.sales],
  );
  const selectedParts = useMemo(
    () => remainingSales
      .filter((s) => !excludedTxIds.has(s.transactionId))
      .map((s) => ({ transactionId: s.transactionId, baseMills: s.remainingBaseMills })),
    [remainingSales, excludedTxIds],
  );
  const selectedTotalMills = useMemo(
    () => selectedParts.reduce((sum, p) => sum + p.baseMills, 0),
    [selectedParts],
  );

  function buildFormulaPayload(): PotFormula {
    const participants = detail?.activeParticipants ?? [];
    if (formulaKind === "equal") return { kind: "equal", params: {} };
    if (formulaKind === "weights") {
      const weights: Record<string, number> = {};
      for (const code of participants) {
        const raw = weightInputs[code];
        const parsed = raw === undefined || raw.trim() === "" ? 1 : Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Укажите положительный вес для ${personLabel(code)}`);
        }
        weights[code] = parsed;
      }
      return { kind: "weights", params: { weights } };
    }
    const shares: Record<string, number> = {};
    for (const code of participants) {
      const raw = (manualInputs[code] ?? "").trim();
      if (raw === "") {
        shares[code] = 0;
        continue;
      }
      const parsedMills = millsToNumber(millsFromDollars(raw));
      if (parsedMills < 0) throw new Error(`Сумма для ${personLabel(code)} не может быть отрицательной`);
      shares[code] = parsedMills;
    }
    return { kind: "manual", params: { shares } };
  }

  const previewMutation = useMutation({
    mutationFn: async () => {
      const formula = buildFormulaPayload();
      return kernel.potDistributionPreview({
        params: { potId: currentPot.id },
        body: { day, formula, parts: selectedParts },
      });
    },
    onSuccess: (res) => {
      setComposerError(null);
      setPreview(res);
    },
    onError: (err) => {
      setPreview(null);
      setComposerError(err instanceof Error ? err.message : "Не удалось построить предпросмотр");
    },
  });

  const postMutation = useMutation({
    mutationFn: async () => {
      const formula = buildFormulaPayload();
      return kernel.potDistributionPost({
        params: { potId: currentPot.id },
        body: { day, formula, parts: selectedParts },
      });
    },
    onSuccess: () => {
      setPostConfirm(false);
      setPreview(null);
      setExcludedTxIds(new Set());
      void queryClient.invalidateQueries({ queryKey: ["pots"] });
      void queryClient.invalidateQueries({ queryKey: ["pot", currentPot.id] });
      toast.success("Раздача проведена");
    },
    onError: (err) => {
      setPostConfirm(false);
      setComposerError(err instanceof Error ? err.message : "Не удалось провести раздачу");
    },
  });

  const closeMutation = useMutation({
    mutationFn: () => kernel.potClose({ params: { potId: currentPot.id } }),
    onSuccess: () => {
      setCloseConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ["pots"] });
      void queryClient.invalidateQueries({ queryKey: ["pot", currentPot.id] });
      toast.success(`Общак «${currentPot.name}» закрыт`);
    },
  });

  const reverseMutation = useMutation({
    mutationFn: async () => {
      if (!reverseTarget) throw new Error("Раздача не выбрана");
      const reason = reverseReason.trim();
      if (reason === "") throw new Error("Укажите причину сторно");
      return kernel.potDistributionReverse({
        params: { distributionId: reverseTarget.id },
        body: { reason },
      });
    },
    onSuccess: () => {
      setReverseTarget(null);
      setReverseReason("");
      setReverseError(null);
      void queryClient.invalidateQueries({ queryKey: ["pots"] });
      void queryClient.invalidateQueries({ queryKey: ["pot", currentPot.id] });
      toast.success("Раздача сторнирована, база вернулась в остаток");
    },
    onError: (err) => {
      setReverseError(err instanceof Error ? err.message : "Не удалось сторнировать");
    },
  });

  const salesColumns: Column<PotEligibleSale>[] = [
    {
      key: "pick",
      header: "",
      cell: (sale) => (
        <Checkbox
          aria-label={`Выбрать продажу ${sale.transactionId}`}
          disabled={sale.remainingBaseMills <= 0 || currentPot.state !== "open"}
          checked={sale.remainingBaseMills > 0 && !excludedTxIds.has(sale.transactionId)}
          onChange={(checked) => {
            setPreview(null);
            setExcludedTxIds((prev) => {
              const next = new Set(prev);
              if (checked) next.delete(sale.transactionId);
              else next.add(sale.transactionId);
              return next;
            });
          }}
        />
      ),
    },
    {
      key: "day",
      header: "День",
      cell: (sale) => (
        <span>
          {formatDay(sale.day)}
          <span className="pots-sub">{sale.pageLabel} · {sale.kind}</span>
        </span>
      ),
    },
    {
      key: "net",
      header: "Продажа",
      numeric: true,
      cell: (sale) => (
        <ChainMoney saleId={sale.transactionId}>
          <Money mills={millsFromInteger(sale.netMills)} />
        </ChainMoney>
      ),
    },
    {
      key: "remaining",
      header: "Свободно в базе",
      numeric: true,
      cell: (sale) => (
        <span>
          <Money mills={millsFromInteger(sale.remainingBaseMills)} strong={sale.remainingBaseMills > 0} muted={sale.remainingBaseMills === 0} />
          {sale.distributedElsewhereMills > 0 && (
            <span className="pots-sub">в другом: <Money mills={millsFromInteger(sale.distributedElsewhereMills)} /></span>
          )}
        </span>
      ),
    },
  ];

  const isPagePot = currentPot.intakeReasons.length > 0;
  const canPost = currentPot.state === "open" && preview !== null && preview.error === null && preview.lines.length > 0;

  return (
    <>
      <Drawer
        open
        size="lg"
        onClose={onClose}
        title={currentPot.name}
        subtitle={`${currentPot.code} · ${currentPot.modelName} · ${isPagePot ? "общак страницы" : "событийный общак"}`}
        actions={
          currentPot.state === "open" ? (
            <div className="pots-badges">
              <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)}>Изменить</Button>
              <Button size="sm" variant="ghost" onClick={() => setCloseConfirm(true)}>Закрыть</Button>
            </div>
          ) : (
            <Badge tone="neutral">Закрыт</Badge>
          )
        }
      >
        <div className="pots-drawer">
          <Facts
            items={[
              { label: "Статус", value: currentPot.state === "open" ? <Badge tone="success">Открыт</Badge> : <Badge tone="neutral">Закрыт</Badge> },
              { label: "Страницы", value: <PageLabels labels={currentPot.pageLabels} /> },
              { label: "Период", value: `${formatDay(currentPot.opensOn)} — ${currentPot.closesOn ? formatDay(currentPot.closesOn) : "без конца"}` },
              {
                label: "Формула",
                value: `${FORMULA_LABEL[currentPot.formula.kind]}${currentPot.autoPost ? " · автопроведение" : ""}`,
              },
              { label: "Баланс в базе", value: <Money mills={millsFromInteger(currentPot.balanceMills)} strong /> },
              { label: "Проведено", value: <Money mills={millsFromInteger(currentPot.postedBaseMills)} /> },
            ]}
          />

          {detailQuery.isError && (
            <ErrorState onRetry={() => void detailQuery.refetch()} retrying={detailQuery.isFetching} />
          )}

          {detailQuery.isLoading && <Skeleton height={160} />}

          {detail && (
            <>
              {currentPot.state === "open" && (
                <section className="pots-block">
                  <div className="pots-block__head">
                    <h3 className="pots-block__title">Распределить базу</h3>
                    <span className="pots-sub">
                      Выбрано {selectedParts.length} из {remainingSales.length} на <Money mills={millsFromInteger(selectedTotalMills)} strong />
                    </span>
                  </div>

                  {detail.potsFrom === null && (
                    <Notice tone="warning" title="Общаки ещё не включены">
                      Дата запуска <code>pots_from</code> не задана — предпросмотр и проведение откроются после включения <code>pots:from</code>.
                    </Notice>
                  )}

                  {composerError && <Notice tone="danger" title="Ошибка">{composerError}</Notice>}

                  <Table
                    label="Продажи в общаке"
                    columns={salesColumns}
                    rows={detail.sales}
                    rowKey={(s) => String(s.transactionId)}
                    empty={<EmptyState compact title="В общаке нет продаж">Продажи, попавшие в этот общак после даты включения, появятся здесь.</EmptyState>}
                  />

                  <div className="pots-form__grid">
                    <Field label="День раздачи (Москва)">
                      {(control) => (
                        <TextInput
                          {...control}
                          type="date"
                          value={day}
                          onChange={(e) => {
                            setDay(e.target.value);
                            setPreview(null);
                          }}
                        />
                      )}
                    </Field>
                    <Field label="Формула этой раздачи">
                      {(control) => (
                        <Select
                          {...control}
                          value={formulaKind}
                          onChange={(e) => {
                            setFormulaKind(e.target.value as PotFormula["kind"]);
                            setPreview(null);
                          }}
                        >
                          <option value="equal">Поровну (equal)</option>
                          <option value="weights">По весам (weights)</option>
                          <option value="manual">Вручную по суммам (manual)</option>
                        </Select>
                      )}
                    </Field>
                  </div>

                  {detail.activeParticipants.length === 0 ? (
                    <Notice tone="warning" title="Нет активных участников">
                      Проверьте список участников или расписание работы на страницах этого общака.
                    </Notice>
                  ) : formulaKind === "weights" ? (
                    <div className="pots-param-grid">
                      {detail.activeParticipants.map((code) => (
                        <Field key={code} label={personLabel(code)}>
                          {(control) => (
                            <TextInput
                              {...control}
                              type="number"
                              min="0.01"
                              step="0.5"
                              value={weightInputs[code] ?? "1"}
                              onChange={(e) => {
                                setWeightInputs((prev) => ({ ...prev, [code]: e.target.value }));
                                setPreview(null);
                              }}
                            />
                          )}
                        </Field>
                      ))}
                    </div>
                  ) : formulaKind === "manual" ? (
                    <div className="pots-param-grid">
                      {detail.activeParticipants.map((code) => (
                        <Field key={code} label={`${personLabel(code)}, $`}>
                          {(control) => (
                            <TextInput
                              {...control}
                              type="text"
                              inputMode="decimal"
                              placeholder="0.00"
                              value={manualInputs[code] ?? ""}
                              onChange={(e) => {
                                setManualInputs((prev) => ({ ...prev, [code]: e.target.value }));
                                setPreview(null);
                              }}
                            />
                          )}
                        </Field>
                      ))}
                    </div>
                  ) : (
                    <p className="pots-sub">
                      Участники ({detail.activeParticipants.length}): {detail.activeParticipants.map(personLabel).join(", ")}
                    </p>
                  )}

                  <div className="pots-bar__actions">
                    <Button
                      onClick={() => previewMutation.mutate()}
                      disabled={previewMutation.isPending || selectedParts.length === 0 || detail.potsFrom === null}
                    >
                      {previewMutation.isPending ? "Считаем…" : "Распределить (предпросмотр)"}
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => setPostConfirm(true)}
                      disabled={!canPost || postMutation.isPending}
                    >
                      Провести
                    </Button>
                  </div>

                  {preview && (
                    <div className="pots-preview">
                      {preview.error ? (
                        <Notice tone="danger" title="Нельзя провести">{preview.error.message}</Notice>
                      ) : (
                        <>
                          <div className="pots-dist-card__head">
                            <strong>Предпросмотр на {formatDay(preview.day)}</strong>
                            <Money mills={millsFromInteger(preview.baseMills)} strong />
                          </div>
                          <ul className="pots-dist-lines">
                            {preview.lines.map((line) => (
                              <li key={line.personCode}>
                                <span>{personLabel(line.personCode)} <span className="pots-sub">{line.basis}</span></span>
                                <Money mills={millsFromInteger(line.baseMills)} />
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                </section>
              )}

              <section className="pots-block">
                <h3 className="pots-block__title">Проведённые раздачи ({detail.distributions.length})</h3>
                {detail.distributions.length === 0 ? (
                  <EmptyState compact title="Раздач пока нет">
                    После проведения раздача появится здесь и попадёт в ленту ledger.
                  </EmptyState>
                ) : (
                  detail.distributions.map((dist) => (
                    <div
                      key={dist.id}
                      className={`pots-dist-card${dist.reversedAt ? " pots-dist-card--reversed" : ""}`}
                    >
                      <div className="pots-dist-card__head">
                        <span>
                          <strong>#{dist.id}</strong> · {formatDay(dist.day)} · {FORMULA_LABEL[dist.formula.kind]}
                          {dist.postedByName === null ? " (авто)" : ` · ${dist.postedByName}`}
                        </span>
                        <span className="pots-badges">
                          <Money mills={millsFromInteger(dist.baseMills)} strong />
                          {dist.reversedAt ? (
                            <Badge tone="warning">Сторнирована</Badge>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setReverseTarget(dist);
                                setReverseReason("");
                                setReverseError(null);
                              }}
                            >
                              Сторнировать
                            </Button>
                          )}
                        </span>
                      </div>
                      <span className="pots-sub">
                        Проведена {formatDateTime(dist.postedAt)} · продаж: {dist.parts.length}
                      </span>
                      {dist.reversedAt && (
                        <span className="pots-sub">
                          Сторно {formatDateTime(dist.reversedAt)}
                          {dist.reversedByName ? ` (${dist.reversedByName})` : " (авто)"}: {dist.reversedReason}
                        </span>
                      )}
                      <ul className="pots-dist-lines">
                        {dist.lines.map((line) => (
                          <li key={line.personCode}>
                            <span>{personLabel(line.personCode)} ({line.basis})</span>
                            <Money mills={millsFromInteger(line.baseMills)} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </section>
            </>
          )}
        </div>
      </Drawer>

      {editOpen && (
        <PotFormModal
          mode="edit"
          pot={currentPot}
          models={models}
          people={people}
          onClose={() => setEditOpen(false)}
        />
      )}

      {closeConfirm && (
        <Confirm
          title={`Закрыть общак «${currentPot.name}»?`}
          message="Новые продажи и раздачи в этот общак приниматься не будут. Проведённые ранее раздачи сохранятся."
          confirmLabel="Закрыть общак"
          pendingLabel="Закрываем…"
          isPending={closeMutation.isPending}
          error={closeMutation.isError ? (closeMutation.error instanceof Error ? closeMutation.error.message : "Ошибка") : undefined}
          onConfirm={() => closeMutation.mutate()}
          onClose={() => setCloseConfirm(false)}
        />
      )}

      {postConfirm && preview && !preview.error && (
        <Confirm
          title={`Провести раздачу общака «${currentPot.name}»?`}
          message="Раздача неизменяема и сразу попадёт в ленту ledger. При ошибке её можно только сторнировать целиком."
          tone="primary"
          facts={[
            { label: "День", value: formatDay(preview.day) },
            { label: "База", value: <Money mills={millsFromInteger(preview.baseMills)} strong /> },
            { label: "Участников", value: String(preview.lines.length) },
            { label: "Продаж", value: String(preview.parts.length) },
          ]}
          confirmLabel="Провести"
          pendingLabel="Проводим…"
          isPending={postMutation.isPending}
          onConfirm={() => postMutation.mutate()}
          onClose={() => setPostConfirm(false)}
        />
      )}

      {reverseTarget && (
        <Modal
          title={`Сторнировать раздачу #${reverseTarget.id}`}
          size="form"
          onClose={() => setReverseTarget(null)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setReverseTarget(null)} disabled={reverseMutation.isPending}>Отмена</Button>
              <Button variant="danger" onClick={() => reverseMutation.mutate()} disabled={reverseMutation.isPending}>
                {reverseMutation.isPending ? "Сторнируем…" : "Сторнировать"}
              </Button>
            </>
          }
        >
          <div className="pots-form">
            {reverseError && <Notice tone="danger" title="Ошибка">{reverseError}</Notice>}
            <p className="pots-sub">
              База <Money mills={millsFromInteger(reverseTarget.baseMills)} strong /> вернётся в свободный остаток продаж, а ledger получит событие сторно.
            </p>
            <Field label="Причина сторно">
              {(control) => (
                <Textarea
                  {...control}
                  value={reverseReason}
                  onChange={(e) => setReverseReason(e.target.value)}
                  placeholder="Например: перерасчёт весов или ошибка выбора продаж"
                  data-autofocus
                />
              )}
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}

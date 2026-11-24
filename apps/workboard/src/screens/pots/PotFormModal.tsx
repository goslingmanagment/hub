import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PotFormula, PotParticipantPeriod, PotSummary, PotsListResponse } from "@agency_hub_core/contracts";
import { Button, Checkbox, Field, Modal, Notice, Select, TextInput, toast } from "@agency_hub_core/ui";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { kernel } from "@/shared/hub";

type CatalogModel = PotsListResponse["models"][number];
type CatalogPerson = PotsListResponse["people"][number];

interface PotFormModalProps {
  mode: "create" | "edit";
  pot?: PotSummary;
  models: readonly CatalogModel[];
  people: readonly CatalogPerson[];
  closedPageIds?: readonly number[];
  defaultOpensOn?: string | null;
  onClose: () => void;
  onSaved?: (pot: PotSummary) => void;
}

interface WeightEntry {
  personCode: string;
  weight: string;
}

function initialWeights(formula: PotFormula | undefined): WeightEntry[] {
  if (formula?.kind !== "weights") return [];
  const raw = formula.params.weights;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).map(([personCode, val]) => ({
    personCode,
    weight: typeof val === "number" || typeof val === "string" ? String(val) : "1",
  }));
}

export function PotFormModal({ mode, pot, models, people, defaultOpensOn, closedPageIds = [], onClose, onSaved }: PotFormModalProps) {
  const queryClient = useQueryClient();
  const today = moscowToday();
  const firstModel = models[0];

  const [code, setCode] = useState(pot?.code ?? "");
  const [name, setName] = useState(pot?.name ?? "");
  const [modelId, setModelId] = useState<number>(pot?.modelId ?? firstModel?.id ?? 0);
  const currentModel = models.find((m) => m.id === modelId) ?? firstModel;
  const [pageIds, setPageIds] = useState<number[]>(
    pot?.pageIds ?? (firstModel ? firstModel.pages.map((p) => p.id) : []),
  );
  const [postTip, setPostTip] = useState<boolean>(pot ? pot.intakeReasons.includes("post_tip") : false);
  const [campaign, setCampaign] = useState<boolean>(pot ? pot.intakeReasons.includes("campaign") : false);
  const [chosenOpensOn, setOpensOn] = useState<string | undefined>(pot?.opensOn);
  const replacement = pageIds.some((id) => closedPageIds.includes(id));
  const opensOn = chosenOpensOn ?? (replacement && today > (defaultOpensOn ?? "") ? today : defaultOpensOn ?? today);
  const [closesOn, setClosesOn] = useState<string>(pot?.closesOn ?? "");
  const [participantsMode, setParticipantsMode] = useState<"page_workers" | "listed">(pot?.participantsMode ?? "page_workers");
  const [participants, setParticipants] = useState<PotParticipantPeriod[]>(pot?.participants ?? []);
  const [formulaKind, setFormulaKind] = useState<"equal" | "weights" | "manual">(pot?.formula.kind ?? "equal");
  const [weights, setWeights] = useState<WeightEntry[]>(() => initialWeights(pot?.formula));
  const [autoPost, setAutoPost] = useState<boolean>(pot?.autoPost ?? false);
  const [localError, setLocalError] = useState<string | null>(null);

  const activePeople = people.filter((p) => p.state !== "left");

  const mutation = useMutation({
    mutationFn: async () => {
      const intakeReasons: Array<"post_tip" | "campaign"> = [
        ...(campaign ? (["campaign"] as const) : []),
        ...(postTip ? (["post_tip"] as const) : []),
      ];
      let formula: PotFormula;
      if (formulaKind === "weights") {
        const map: Record<string, number> = {};
        for (const entry of weights) {
          const codeKey = entry.personCode.trim();
          const num = Number(entry.weight);
          if (!codeKey || !Number.isFinite(num) || num <= 0) {
            throw new Error("Веса участников должны быть положительными числами");
          }
          map[codeKey] = num;
        }
        formula = { kind: "weights", params: { weights: map } };
      } else {
        formula = { kind: formulaKind, params: {} };
      }
      const cleanParticipants = participantsMode === "listed"
        ? participants.map((p) => ({
            personCode: p.personCode.trim(),
            fromDay: p.fromDay,
            toDay: p.toDay && p.toDay.trim() !== "" ? p.toDay.trim() : null,
          }))
        : [];
      const cleanClosesOn = closesOn.trim() === "" ? null : closesOn.trim();
      const effectiveAutoPost = formulaKind === "equal" ? autoPost : false;

      if (mode === "create") {
        const res = await kernel.potCreate({
          body: {
            code: code.trim().toLowerCase(),
            name: name.trim(),
            modelId,
            pageIds,
            intakeReasons,
            opensOn,
            closesOn: cleanClosesOn,
            participantsMode,
            participants: cleanParticipants,
            formula,
            autoPost: effectiveAutoPost,
          },
        });
        return res.pot;
      }
      const res = await kernel.potUpdate({
        params: { potId: pot!.id },
        body: {
          name: name.trim(),
          pageIds,
          intakeReasons,
          opensOn,
          closesOn: cleanClosesOn,
          participantsMode,
          participants: cleanParticipants,
          formula,
          autoPost: effectiveAutoPost,
        },
      });
      return res.pot;
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["pots"] });
      void queryClient.invalidateQueries({ queryKey: ["pot", saved.id] });
      toast.success(mode === "create" ? `Общак «${saved.name}» создан` : `Общак «${saved.name}» обновлён`);
      onSaved?.(saved);
      onClose();
    },
    onError: (err) => {
      setLocalError(err instanceof Error ? err.message : "Не удалось сохранить общак");
    },
  });

  function handleModelChange(nextId: number) {
    setModelId(nextId);
    const nextModel = models.find((m) => m.id === nextId);
    setPageIds(nextModel ? nextModel.pages.map((p) => p.id) : []);
  }

  function togglePage(id: number, checked: boolean) {
    setPageIds((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((item) => item !== id)));
  }

  function addParticipant() {
    const fallbackPerson = activePeople[0]?.code ?? people[0]?.code ?? "";
    setParticipants((prev) => [...prev, { personCode: fallbackPerson, fromDay: opensOn || today, toDay: null }]);
  }

  function addWeight() {
    const fallbackPerson = activePeople[0]?.code ?? people[0]?.code ?? "";
    setWeights((prev) => [...prev, { personCode: fallbackPerson, weight: "1" }]);
  }

  function submit() {
    setLocalError(null);
    if (mode === "create" && code.trim() === "") {
      setLocalError("Укажите код общака (латиница, цифры, дефис или подчёркивание)");
      return;
    }
    if (name.trim() === "") {
      setLocalError("Укажите название общака");
      return;
    }
    if (pageIds.length === 0) {
      setLocalError("Выберите хотя бы одну страницу");
      return;
    }
    mutation.mutate();
  }

  return (
    <Modal
      title={mode === "create" ? "Новый общак" : `Изменить «${pot?.name ?? ""}»`}
      size="wide"
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>Отмена</Button>
          <Button variant="primary" onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? "Сохраняем…" : mode === "create" ? "Создать" : "Сохранить"}
          </Button>
        </>
      }
    >
      <div className="pots-form">
        {localError && <Notice tone="danger" title="Не удалось сохранить">{localError}</Notice>}

        <div className="pots-form__grid">
          <Field label="Код" hint="Уникальный слаг (a-z, 0-9, -, _)">
            {(control) => (
              <TextInput
                {...control}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={mode === "edit"}
                placeholder="event-spring"
                data-autofocus={mode === "create" ? true : undefined}
              />
            )}
          </Field>
          <Field label="Название">
            {(control) => (
              <TextInput
                {...control}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Событийный общак"
                data-autofocus={mode === "edit" ? true : undefined}
              />
            )}
          </Field>
        </div>

        <Field label="Модель">
          {(control) => (
            <Select
              {...control}
              value={String(modelId)}
              onChange={(e) => handleModelChange(Number(e.target.value))}
              disabled={mode === "edit"}
            >
              {models.map((m) => (
                <option key={m.id} value={String(m.id)}>{m.name} ({m.slug})</option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Страницы модели" hint="Продажи только этих страниц попадают в общак.">
          {() => (
            <div className="pots-checks">
              {(currentModel?.pages ?? []).map((p) => (
                <Checkbox
                  key={p.id}
                  checked={pageIds.includes(p.id)}
                  onChange={(checked) => togglePage(p.id, checked)}
                  label={p.label}
                />
              ))}
            </div>
          )}
        </Field>

        <Field
          label="Автоматический приём"
          hint="Пусто — событийный общак (продажи попадают по решению). Отмечено — общак страницы для пост-типов и кампаний."
        >
          {() => (
            <div className="pots-checks">
              <Checkbox checked={postTip} onChange={setPostTip} label="Типы на пост (post_tip)" />
              <Checkbox checked={campaign} onChange={setCampaign} label="Кампании (campaign)" />
            </div>
          )}
        </Field>

        <div className="pots-form__grid">
          <Field label="Открыт с (Москва)">
            {(control) => <TextInput {...control} type="date" value={opensOn} onChange={(e) => setOpensOn(e.target.value)} />}
          </Field>
          <Field label="Закрыт после (необязательно)">
            {(control) => <TextInput {...control} type="date" value={closesOn} onChange={(e) => setClosesOn(e.target.value)} />}
          </Field>
        </div>

        <div className="pots-form__grid">
          <Field label="Участники">
            {(control) => (
              <Select
                {...control}
                value={participantsMode}
                onChange={(e) => setParticipantsMode(e.target.value as "page_workers" | "listed")}
              >
                <option value="page_workers">Кто работает на страницах (page_workers)</option>
                <option value="listed">Списком с датами (listed)</option>
              </Select>
            )}
          </Field>
          <Field label="Формула деления базы">
            {(control) => (
              <Select
                {...control}
                value={formulaKind}
                onChange={(e) => {
                  const next = e.target.value as "equal" | "weights" | "manual";
                  setFormulaKind(next);
                  if (next !== "equal") setAutoPost(false);
                }}
              >
                <option value="equal">Поровну (equal)</option>
                <option value="weights">По весам (weights)</option>
                <option value="manual">Вручную по суммам (manual)</option>
              </Select>
            )}
          </Field>
        </div>

        {formulaKind === "equal" && (
          <Checkbox
            checked={autoPost}
            onChange={setAutoPost}
            label="Проводить автоматически по мере прихода продаж (auto_post)"
            hint="Подходит для общаков страниц: каждая продажа сразу делится поровну и попадает в ленту ledger."
          />
        )}

        {participantsMode === "listed" && (
          <div className="pots-list-editor">
            <div className="pots-block__head">
              <span className="ui-field__label">Список участников с датами</span>
              <Button size="sm" variant="ghost" onClick={addParticipant}>+ Участник</Button>
            </div>
            {participants.map((entry, idx) => (
              <div key={idx} className="pots-list-editor__row">
                <Select
                  value={entry.personCode}
                  onChange={(e) => setParticipants((prev) => prev.map((row, i) => (i === idx ? { ...row, personCode: e.target.value } : row)))}
                >
                  {people.map((p) => (
                    <option key={p.code} value={p.code}>{p.displayName} ({p.code})</option>
                  ))}
                </Select>
                <TextInput
                  type="date"
                  value={entry.fromDay}
                  onChange={(e) => setParticipants((prev) => prev.map((row, i) => (i === idx ? { ...row, fromDay: e.target.value } : row)))}
                />
                <TextInput
                  type="date"
                  value={entry.toDay ?? ""}
                  onChange={(e) => setParticipants((prev) => prev.map((row, i) => (i === idx ? { ...row, toDay: e.target.value || null } : row)))}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setParticipants((prev) => prev.filter((_, i) => i !== idx))}
                >
                  Убрать
                </Button>
              </div>
            ))}
          </div>
        )}

        {formulaKind === "weights" && (
          <div className="pots-list-editor">
            <div className="pots-block__head">
              <span className="ui-field__label">Веса по умолчанию (для предпросмотра и раздачи)</span>
              <Button size="sm" variant="ghost" onClick={addWeight}>+ Вес</Button>
            </div>
            {weights.map((entry, idx) => (
              <div key={idx} className="pots-param-grid">
                <Select
                  value={entry.personCode}
                  onChange={(e) => setWeights((prev) => prev.map((row, i) => (i === idx ? { ...row, personCode: e.target.value } : row)))}
                >
                  {people.map((p) => (
                    <option key={p.code} value={p.code}>{p.displayName} ({p.code})</option>
                  ))}
                </Select>
                <div style={{ display: "flex", gap: 8 }}>
                  <TextInput
                    type="number"
                    min="0.01"
                    step="0.5"
                    value={entry.weight}
                    onChange={(e) => setWeights((prev) => prev.map((row, i) => (i === idx ? { ...row, weight: e.target.value } : row)))}
                  />
                  <Button size="sm" variant="ghost" onClick={() => setWeights((prev) => prev.filter((_, i) => i !== idx))}>Убрать</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

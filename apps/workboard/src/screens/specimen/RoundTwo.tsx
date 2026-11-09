import { ChevronDown, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, Card, Delta, Facts, Money, PeriodControl, Section, Switch, Table, type Column } from "@agency_hub_core/ui";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { currentWeek, type PeriodSpec } from "@agency_hub_core/ui/period";
import { METRICS } from "@/shared/metrics";
import { PageFilterSlot } from "@/shared/PageFilter";

/**
 * The rules of round 2 of the loop, as the screens must use them: one rule of
 * a change (D13), a definition on the term (D14), the action in the filter's
 * place (D15), the quiet switch in a row, the table's density and width (D18).
 */

interface ApproachRow {
  id: string;
  name: string;
  written: number;
}

const APPROACHES: ApproachRow[] = [
  { id: "miss", name: "Мягкое «скучаю» с новым селфи", written: 41 },
  { id: "discount", name: "Скидка на прошлый альбом", written: 18 },
  { id: "voice", name: "Голосовое по имени", written: 9 },
];

function Example({ children, note }: { children: ReactNode; note: string }) {
  return (
    <span className="inline-flex min-w-[132px] flex-col gap-1">
      <span className="text-15">{children}</span>
      <span className="text-14 text-ink-3">{note}</span>
    </span>
  );
}

function Rule({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_minmax(0,1fr)] items-start gap-6 border-t border-line-soft py-4 first:border-t-0 first:pt-0 last:pb-0">
      <span className="pt-0.5 text-14 text-ink-2">{label}</span>
      <div className="flex min-w-0 flex-wrap items-start gap-x-8 gap-y-4">{children}</div>
    </div>
  );
}

/** A header's right end as the app draws it: the period, then the filter's place — the filter, or the action. */
function HeaderEnd({ slot, value, onChange }: { slot: ReactNode; value: PeriodSpec; onChange: (spec: PeriodSpec) => void }) {
  return (
    <div className="wb-header__controls" style={{ justifyContent: "flex-start" }}>
      <PeriodControl value={value} today={moscowToday()} onChange={onChange} />
      <span className="wb-header__slot">
        <PageFilterSlot />
        {slot}
      </span>
    </div>
  );
}

export function RoundTwoSection() {
  const today = moscowToday();
  const [on, setOn] = useState<Record<string, boolean>>({ miss: true, discount: true, voice: false });
  const [pending, setPending] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodSpec>(currentWeek(today));

  const columns: Column<ApproachRow>[] = [
    { key: "name", header: "Подход", cell: (row) => row.name },
    { key: "written", header: "Написали", numeric: true, cell: (row) => row.written },
    {
      key: "on",
      header: "В расширении",
      numeric: true,
      cell: (row) => (
        <Switch
          variant="quiet"
          labelHidden
          label={`«${row.name}» в расширении`}
          checked={on[row.id] ?? false}
          pending={pending === row.id}
          onChange={(value) => {
            setPending(row.id);
            window.setTimeout(() => {
              setOn((current) => ({ ...current, [row.id]: value }));
              setPending(null);
            }, 500);
          }}
        />
      ),
    },
  ];

  return (
    <Section
      title="Круг 2: одно правило на всё"
      description="Как экраны показывают изменение, определения, главное действие, переключатели в строках, плотность и ширину таблиц."
    >
      <Card>
        <Rule label="Изменение (D13)">
          <Example note="лучше: спокойный зелёный"><Delta current={1_130_000} previous={1_000_000} /></Example>
          <Example note="хуже: коричневый, не красный"><Delta current={710_000} previous={1_000_000} /></Example>
          <Example note="малая база (меньше $50)"><Delta current={31_980} previous={16_000} /></Example>
          <Example note="раньше был ноль"><Delta current={52_000} previous={0} /></Example>
          <Example note="сейчас ноль"><Delta current={0} previous={419_940} /></Example>
          <Example note="ответ дольше — хуже"><Delta current={174} previous={118} unit="count" better="down" /></Example>
          <Example note="сравнить не с чем"><Delta current={null} previous={null} noneText="не с чем сравнить" /></Example>
        </Rule>
        <Rule label="Подсказка (D14)">
          <div className="grid gap-2">
            <Facts
              label="Смена alex.k"
              items={[
                { label: "Продажи", value: <Money mills={412_500} />, strong: true },
                { label: "Сообщений", value: "214" },
                { label: METRICS.reply.label, value: "1 мин 58 с", hint: METRICS.reply.hint },
                { label: METRICS.aiUnedited.label, value: "31 %", hint: METRICS.aiUnedited.hint },
              ]}
            />
            <span className="text-14 text-ink-3">Пунктир — у подписи термина, не у числа; у «Продаж» и «Сообщений» его нет. Не больше 2–3 в строке.</span>
          </div>
        </Rule>
        <Rule label="Главное действие (D15)">
          <div className="grid gap-3">
            <HeaderEnd value={period} onChange={setPeriod} slot={(
              <span className="ui-chip ui-chip--md">
                <span className="ui-chip__text">Все страницы</span>
                <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
              </span>
            )} />
            <HeaderEnd value={period} onChange={setPeriod} slot={<Button variant="primary" icon={Copy}>Скопировать</Button>} />
            <span className="text-14 text-ink-3">Без фильтра страниц главное действие встаёт на его место справа. Период стоит в одной точке на всех экранах и при любой длине.</span>
          </div>
        </Rule>
        <Rule label="Переключатель в строке">
          <div className="grid w-full gap-2">
            <div className="max-w-[720px] overflow-clip rounded-lg border border-line">
              <Table label="Подходы возврата" columns={columns} rows={APPROACHES} rowKey={(row) => row.id} frame="bare" />
            </div>
            <span className="text-14 text-ink-3">В строках таблицы — тихий: тонкий контур, включённый — мягкие чернила. Обычный (36 × 20) — для одной настройки в форме.</span>
          </div>
        </Rule>
        <Rule label="Плотность и ширина (D18)">
          <span className="max-w-[72ch] text-15 text-ink-2">
            Строка в одну линию — 52 px, с подписью под именем — 64 px, текст тот же. На широком экране таблица шириной по своему
            содержимому плюс немного воздуха (не уже 720 px) и стоит слева; между столбцами нет дыр. Близко к полной ширине — берёт полную.
          </span>
        </Rule>
      </Card>
    </Section>
  );
}

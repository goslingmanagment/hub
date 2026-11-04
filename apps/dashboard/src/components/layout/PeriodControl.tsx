import { Segmented } from "@/components/ui/Segmented";
import { PERIOD_LABELS } from "@/lib/period";
import { useScreenPeriod } from "./useScreenPeriod.js";

/** One look and one place for time: segments in the screen's header. */
export function PeriodControl() {
  const { period, key, select, forced } = useScreenPeriod();
  if (!period) return null;
  return (
    <Segmented
      label="Период"
      value={key}
      onChange={select}
      options={period.options.map((option) => ({
        value: option,
        label: PERIOD_LABELS[option],
        disabled: forced !== null && option !== forced.key,
        title: forced !== null && option !== forced.key ? forced.title : undefined,
      }))}
    />
  );
}

/** Beside the dates: the screen says out loud that it could not show what was asked. */
export function PeriodMissingNote() {
  const { missing, key, forced } = useScreenPeriod();
  if (forced) return <span className="page-window-note">{forced.note}. </span>;
  if (!missing) return null;
  return (
    <span className="page-window-note">
      {PERIOD_LABELS[missing]} здесь нет, показано: {PERIOD_LABELS[key].toLowerCase()}.{" "}
    </span>
  );
}

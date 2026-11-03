import { Segmented } from "@/components/ui/Segmented";
import { PERIOD_LABELS } from "@/lib/period";
import { useScreenPeriod } from "./useScreenPeriod.js";

/** One look and one place for time: segments in the screen's header. */
export function PeriodControl() {
  const { period, key, select } = useScreenPeriod();
  if (!period) return null;
  return (
    <Segmented
      label="Период"
      value={key}
      onChange={select}
      options={period.options.map((option) => ({ value: option, label: PERIOD_LABELS[option] }))}
    />
  );
}

/** Beside the dates: the screen says out loud that it could not show what was asked. */
export function PeriodMissingNote() {
  const { missing, key } = useScreenPeriod();
  if (!missing) return null;
  return (
    <span className="page-window-note">
      {PERIOD_LABELS[missing]} здесь нет, показано: {PERIOD_LABELS[key].toLowerCase()}.{" "}
    </span>
  );
}

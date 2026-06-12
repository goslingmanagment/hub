import { useId } from "react";

import { SEVERITY_HEX, valueTierRadius, type UrgencySeverity, type ValueTier } from "./tone.js";

/**
 * A 14×14 value × urgency glyph: a single dot plotted on value (x) × urgency (y),
 * with a faint crosshair. Pre-attentive "is this both valuable and urgent?".
 * Low-coverage rows draw a dashed outline (estimated position).
 */
export function QuadrantGlyph({
  value,
  urgency,
  severity,
  tier,
  estimated = false,
  size = 16,
}: {
  value: number;
  urgency: number;
  severity: UrgencySeverity;
  tier: ValueTier;
  estimated?: boolean;
  size?: number;
}) {
  const titleId = useId();
  const pad = 2.5;
  const span = size - 2 * pad;
  const cx = pad + Math.min(1, Math.max(0, value / 100)) * span;
  const cy = size - pad - Math.min(1, Math.max(0, urgency / 100)) * span;
  const fill = SEVERITY_HEX[severity];
  const r = valueTierRadius(tier);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby={titleId}>
      <title id={titleId}>{`Ценность ${Math.round(value)} · Срочность ${Math.round(urgency)}`}</title>
      <line x1={size / 2} y1={pad} x2={size / 2} y2={size - pad} stroke="#e8e5e0" strokeWidth={0.5} />
      <line x1={pad} y1={size / 2} x2={size - pad} y2={size / 2} stroke="#e8e5e0" strokeWidth={0.5} />
      {estimated ? (
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={fill} strokeWidth={1} strokeDasharray="1.5 1" />
      ) : (
        <circle cx={cx} cy={cy} r={r} fill={fill} />
      )}
    </svg>
  );
}

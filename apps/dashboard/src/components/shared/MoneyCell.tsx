import { formatUsdFromMills } from "@agency_hub_core/shared";

const variantClasses = {
  primary: "text-text-primary font-bold text-lg",
  secondary: "text-text-secondary text-[15px] font-medium",
  muted: "text-text-muted",
} as const;

interface MoneyCellProps {
  mills: number;
  variant?: "primary" | "secondary" | "muted";
  className?: string;
}

export function MoneyCell({ mills, variant = "primary", className = "" }: MoneyCellProps) {
  return (
    <span className={`tabular-nums ${variantClasses[variant]} ${className}`}>
      {formatUsdFromMills(mills)}
    </span>
  );
}

import type { ReactNode } from "react";

const variantClasses = {
  new: "bg-green/15 text-green",
  exp: "bg-warning/15 text-warning-dark",
  subscriber: "bg-fansly/15 text-fansly",
  follower: "bg-green/15 text-green",
} as const;

interface BadgeProps {
  variant: "new" | "exp" | "subscriber" | "follower";
  children: ReactNode;
}

export function Badge({ variant, children }: BadgeProps) {
  return (
    <span
      className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${variantClasses[variant]}`}
    >
      {children}
    </span>
  );
}

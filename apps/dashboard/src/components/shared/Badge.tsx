import type { ReactNode } from "react";

const variantClasses = {
  new: "badge-success",
  exp: "badge-warning",
  subscriber: "badge-accent",
  follower: "",
} as const;

interface BadgeProps {
  variant: "new" | "exp" | "subscriber" | "follower";
  children: ReactNode;
}

export function Badge({ variant, children }: BadgeProps) {
  return (
    <span
      className={`badge ${variantClasses[variant]}`}
    >
      {children}
    </span>
  );
}

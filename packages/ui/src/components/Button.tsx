import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from "react";
import { Link, type LinkProps } from "react-router";
import { cx } from "./cx.js";
import { Spinner } from "./Skeleton.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-outline";
export type ButtonSize = "sm" | "md" | "lg";

/** A lucide icon, or any component that takes a size. */
export type IconComponent = ComponentType<{ size?: number | string; strokeWidth?: number; "aria-hidden"?: boolean | "true" | "false"; className?: string }>;

const ICON_SIZE: Record<ButtonSize, number> = { sm: 16, md: 16, lg: 18 };

function buttonClass(variant: ButtonVariant, size: ButtonSize, extra?: string, iconOnly = false) {
  return cx(
    "ui-btn",
    variant !== "secondary" && `ui-btn--${variant}`,
    size !== "md" && `ui-btn--${size}`,
    iconOnly && "ui-btn--icon",
    extra,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary`: one per screen or card, the owner's next step. `danger`: only the last step of a confirmation. */
  variant?: ButtonVariant;
  /** 32 · 36 · 44 px. */
  size?: ButtonSize;
  /** An icon left of the words. */
  icon?: IconComponent;
  /** Waiting for Hub: a spinner, the button off. Pass the verb in progress as children («Сохраняем…»). */
  loading?: boolean;
}

/**
 * The one button. Words are a verb and its object («Пригласить чаттера»); one
 * press is one request: while `loading` it is disabled and says what it does.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Icon, loading = false, disabled, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, className)}
      {...rest}
    >
      {loading ? <Spinner /> : Icon ? <Icon size={ICON_SIZE[size]} strokeWidth={1.75} aria-hidden /> : null}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** What it does, in words: read aloud and shown on hover. */
  label: string;
  icon: IconComponent;
  variant?: Exclude<ButtonVariant, "danger">;
  size?: ButtonSize;
}

/** A square button with an icon only; `label` is its name and its hover hint. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon: Icon, variant = "ghost", size = "md", className, type = "button", title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={buttonClass(variant, size, className, true)}
      {...rest}
    >
      <Icon size={ICON_SIZE[size]} strokeWidth={1.75} aria-hidden />
    </button>
  );
});

export interface LinkButtonProps extends LinkProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconComponent;
  children?: ReactNode;
}

/** A link that looks like a button: when the action is to go somewhere. */
export function LinkButton({ variant = "secondary", size = "md", icon: Icon, className, children, ...rest }: LinkButtonProps) {
  return (
    <Link className={buttonClass(variant, size, typeof className === "string" ? className : undefined)} {...rest}>
      {Icon ? <Icon size={ICON_SIZE[size]} strokeWidth={1.75} aria-hidden /> : null}
      {children}
    </Link>
  );
}

import React from "react";
import clsx from "clsx";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  const variants = {
    primary: "bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500/30",
    secondary: "bg-white/10 hover:bg-white/15 text-slate-200 border-white/10",
    danger: "bg-rose-600 hover:bg-rose-500 text-white border-rose-500/30",
    ghost: "bg-transparent hover:bg-white/5 text-slate-300 border-transparent",
  };
  const sizes = {
    sm: "px-2 py-1 text-xs",
    md: "px-3 py-1.5 text-sm",
    lg: "px-4 py-2 text-base",
  };

  return (
    <button
      className={clsx(
        "inline-flex items-center justify-center font-medium rounded-lg border transition-colors focus:outline-none focus:ring-2 focus:ring-sky-400/50 disabled:opacity-50 disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        className
      )}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}

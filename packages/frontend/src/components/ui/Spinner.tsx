import React from "react";
import clsx from "clsx";
import { Loader2 } from "lucide-react";

export function Spinner({
  size = "md",
  className,
}: {
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const sizeMap = {
    sm: "h-3.5 w-3.5",
    md: "h-4 w-4",
    lg: "h-6 w-6",
  };

  return (
    <Loader2
      className={clsx("animate-spin text-slate-400", sizeMap[size], className)}
      aria-label="Loading"
    />
  );
}

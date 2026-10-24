import clsx from "clsx";
import React from "react";

const tones = {
  neutral: "bg-white/5 text-slate-300 border-white/10",
  amber: "bg-amber-400/10 text-amber-300 border-amber-400/30",
  sky: "bg-sky-400/10 text-sky-300 border-sky-400/30",
  green: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  red: "bg-rose-400/10 text-rose-300 border-rose-400/30",
  replay: "bg-fuchsia-400/10 text-fuchsia-300 border-fuchsia-400/30",
} as const;

export function Badge({
  tone = "neutral",
  children,
  title,
  className,
}: {
  tone?: keyof typeof tones;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

export const ReplayBadge = () => (
  <Badge tone="replay" title="Played back from a recording of an earlier live run">
    REPLAY
  </Badge>
);

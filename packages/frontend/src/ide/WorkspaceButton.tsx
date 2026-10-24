import { Button, type ButtonProps } from "react-aria-components";
import { cn } from "../lib/cn";

export function WorkspaceButton({
  primary = false,
  className,
  ...props
}: ButtonProps & { primary?: boolean; className?: string }) {
  return (
    <Button
      {...props}
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950 disabled:cursor-not-allowed disabled:opacity-40",
        primary
          ? "bg-amber-400 text-stone-950 hover:bg-amber-300"
          : "text-stone-300 hover:bg-stone-800 hover:text-stone-100",
        className,
      )}
    />
  );
}

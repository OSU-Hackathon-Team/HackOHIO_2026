import { Button, type ButtonProps, TextField, Label, Input, TextArea } from "react-aria-components";
import { cn } from "../lib/cn";
export function Action({ tone = "neutral", className, ...props }: ButtonProps & { tone?: "neutral" | "primary" | "quiet" | "danger"; className?: string }) {
  return <Button {...props} className={cn("inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40", tone === "primary" ? "bg-blue-600 text-white hover:bg-blue-700" : tone === "danger" ? "border border-red-200 text-red-700 hover:bg-red-50" : tone === "quiet" ? "text-slate-600 hover:bg-slate-100" : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50", className)} />;
}
export function Field({ label, value, onChange, multiline = false, placeholder, maxLength = 2000 }: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean; placeholder?: string; maxLength?: number }) {
  return <TextField value={value} onChange={onChange} className="grid gap-2"><Label className="text-sm font-medium text-slate-700">{label}</Label>{multiline ? <TextArea maxLength={maxLength} placeholder={placeholder} className="min-h-24 w-full resize-y rounded-lg border border-slate-200 bg-white p-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" /> : <Input maxLength={maxLength} placeholder={placeholder} className="min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />}</TextField>;
}
export const modalOverlay = "builder-modal fixed inset-0 z-40 flex items-center justify-center bg-slate-950/30 p-4";
export const modalPanel = "max-h-[90dvh] w-full max-w-lg overflow-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-lg outline-none";


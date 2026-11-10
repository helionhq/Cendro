import { cn } from "@/lib/utils";

const tones = {
  neutral: "bg-[var(--surface-pressed)] text-[var(--ink-muted)]",
  blue: "bg-[var(--badge-blue-bg)] text-[var(--badge-blue-fg)]",
  green: "bg-[var(--badge-green-bg)] text-[var(--badge-green-fg)]",
  red: "bg-[var(--badge-red-bg)] text-[var(--badge-red-fg)]",
  yellow: "bg-[var(--badge-yellow-bg)] text-[var(--badge-yellow-fg)]",
};

export function Badge({ className, tone = "neutral", children, title }: { className?: string; tone?: keyof typeof tones; children: React.ReactNode; title?: string }) {
  return <span title={title} className={cn("inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs font-medium", tones[tone], className)}>{children}</span>;
}

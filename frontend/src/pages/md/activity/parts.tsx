import type { ComponentType, ReactNode } from "react";
import {
  Activity,
  Banknote,
  DatabaseBackup,
  FileDown,
  KeyRound,
  Layers,
  Settings,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SEVERITY_LABEL } from "./logic";
import type { CategoryId, Severity } from "./types";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** Written out in full because Tailwind cannot build class names from variables. */
export const SEVERITY_STYLE: Record<Severity, { chip: string; tile: string }> = {
  critical: { chip: "border-red-200 bg-red-100 text-red-800", tile: "bg-red-100 text-red-700" },
  high: { chip: "border-amber-200 bg-amber-100 text-amber-800", tile: "bg-amber-100 text-amber-700" },
  medium: { chip: "border-blue-200 bg-blue-50 text-blue-800", tile: "bg-blue-50 text-blue-700" },
};

export const CATEGORY_ICON: Record<CategoryId, IconType> = {
  access: KeyRound,
  deletion: Trash2,
  payroll: Banknote,
  bulk: Layers,
  export: FileDown,
  settings: Settings,
  backup: DatabaseBackup,
};

export const ROUTINE_ICON: IconType = Activity;

/** A small label pill. Not clickable. */
export function Chip({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SeverityChip({ severity }: { severity: Severity }) {
  return (
    <Chip className={SEVERITY_STYLE[severity].chip} title={`${SEVERITY_LABEL[severity]} severity`}>
      {SEVERITY_LABEL[severity]}
    </Chip>
  );
}

/** A person: their name as the audit trail shows it, and their role under it. */
export function PersonCell({ name, role, privileged }: { name: string; role?: string | null; privileged?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1 text-sm font-semibold text-[#1a3a4a]">
        <span className="truncate">{name}</span>
        {privileged && <ShieldCheck size={13} className="shrink-0 text-[#006496]" aria-label="Privileged account" />}
      </p>
      {role && <p className="truncate text-[11px] text-[#006496]/60">{role}</p>}
    </div>
  );
}

/** A filter chip with a count: used for the categories of the sensitive feed. */
export function FilterChip({
  active,
  onClick,
  count,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
        active
          ? "border-[#006496] bg-[#006496] text-white"
          : "border-[#006496]/15 bg-white text-[#006496] hover:border-[#006496]/35 hover:bg-[#006496]/[0.05]",
      )}
    >
      {children}
      {count != null && (
        <span
          className={cn(
            "rounded-full px-1.5 text-[10px] tabular-nums",
            active ? "bg-white/25 text-white" : "bg-[#006496]/10 text-[#006496]",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/** One figure with a caption inside a card (the sign-ins strip). */
export function MiniStat({
  label,
  value,
  sub,
  tone = "neutral",
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "neutral" | "bad" | "good";
  testId?: string;
}) {
  return (
    <div className="rounded-xl bg-[#006496]/[0.04] px-3 py-2.5" data-testid={testId}>
      <p className="text-[11px] font-medium text-[#006496]/60">{label}</p>
      <p
        className={cn(
          "text-lg font-black leading-tight tabular-nums",
          tone === "bad" ? "text-red-700" : tone === "good" ? "text-green-700" : "text-[#1a3a4a]",
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] leading-snug text-[#006496]/55">{sub}</p>}
    </div>
  );
}

/** Scroll to one of the page's cards (the headline tiles are shortcuts to them). */
export function scrollToCard(id: string) {
  document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

/** A short heading above a list inside a card. */
export function ListHeading({ children }: { children: ReactNode }) {
  return <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">{children}</h4>;
}

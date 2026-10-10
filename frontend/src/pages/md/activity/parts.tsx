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
import { SEVERITY_LABEL, initialsOf } from "./logic";
import type { CategoryId, Severity } from "./types";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** The glass chip each tone uses (md-theme/glass.css, and the periwinkle "information" chip in areas/people.css). Statuses
 *  keep their meaning: success is good, warning is watch, danger is bad; wine, ink and sand are accents. */
export type ChipTone = "neutral" | "wine" | "ink" | "sand" | "success" | "warning" | "danger" | "info";

const CHIP_TONE: Record<ChipTone, string> = {
  neutral: "",
  wine: "md-chip-wine",
  ink: "md-chip-ink",
  sand: "md-chip-sand",
  success: "md-chip-success",
  warning: "md-chip-warning",
  danger: "md-chip-danger",
  info: "md-people-chip-info",
};

/** How serious a sensitive action is, as a chip tone: crimson, ochre, periwinkle. The word is always written next to it. */
export const SEVERITY_CHIP: Record<Severity, ChipTone> = {
  critical: "danger",
  high: "warning",
  medium: "info",
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
export function Chip({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: ReactNode;
  tone?: ChipTone;
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className={cn("md-chip whitespace-nowrap", CHIP_TONE[tone], className)}>
      {children}
    </span>
  );
}

export function SeverityChip({ severity }: { severity: Severity }) {
  return (
    <Chip tone={SEVERITY_CHIP[severity]} title={`${SEVERITY_LABEL[severity]} severity`}>
      {SEVERITY_LABEL[severity]}
    </Chip>
  );
}

/** A round badge with a person's initials (drawn by CSS, so only the name is read out and searched). */
export function Avatar({ name, className }: { name: string; className?: string }) {
  return <span className={cn("md-people-avatar", className)} data-initials={initialsOf(name)} aria-hidden="true" />;
}

/** A person: their name as the audit trail shows it, and their role under it. */
export function PersonCell({ name, role, privileged }: { name: string; role?: string | null; privileged?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar name={name} className={cn("md-people-avatar-sm", !privileged && "md-people-avatar-ink")} />
      <div className="min-w-0">
        <p className="flex items-center gap-1 text-sm font-semibold text-md-ink">
          <span className="truncate">{name}</span>
          {privileged && <ShieldCheck size={13} className="shrink-0 text-md-wine" aria-label="Privileged account" />}
        </p>
        {role && <p className="truncate text-[11px] text-md-ink-soft">{role}</p>}
      </div>
    </div>
  );
}

/** A filter pill with a count: used for the categories of the sensitive feed. Off is frosted white, on is wine glass. */
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
    <button type="button" onClick={onClick} aria-pressed={active} data-testid={testId} className="md-people-pill">
      {children}
      {count != null && <span className="md-people-pill-count">{count}</span>}
    </button>
  );
}

/** One figure with a caption inside a card (the sign-ins strip). A bad figure is tinted crimson and a good one sage, and the
 *  caption under it says why, so the colour is never the only signal. */
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
    <div className="md-people-mini" data-tone={tone} data-testid={testId}>
      <p className="text-[11px] font-semibold leading-snug text-md-ink-soft">{label}</p>
      <p
        className={cn(
          "md-people-figure mt-0.5 text-xl font-black leading-tight",
          tone === "bad" ? "text-md-danger-700" : tone === "good" ? "text-md-success-700" : "text-md-ink",
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] leading-snug text-md-ink-soft">{sub}</p>}
    </div>
  );
}

/** Scroll to one of the page's cards (the headline tiles are shortcuts to them). */
export function scrollToCard(id: string) {
  document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

/** A short heading above a list inside a card. */
export function ListHeading({ children }: { children: ReactNode }) {
  return <h4 className="md-people-overline mb-2.5">{children}</h4>;
}

import type { ComponentType, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { ShieldLoader } from "@/components/ui/ShieldLoader";
import { Skeleton } from "@/components/ui/skeleton";
import type { IssueSeverity } from "@/lib/api-client/custom-hooks";
import { TONE, type Tone } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { initials } from "./format";
import { payStatusLabel } from "./pay-status";
import { SEVERITY_META, issueIcon, issueLabel } from "./issue-meta";

type IconType = ComponentType<{ size?: number; className?: string }>;

// The small pieces every redesigned payroll screen is made of, so the staff page, the production pages, the details
// page and the statement all look like one product: clay cards, tinted KPI tiles, one chip, one set of loaders.

/** A labelled surface: icon + title + one-line purpose on the left, actions on the right, then the body. */
export function SectionCard({
  title,
  description,
  icon: Icon,
  actions,
  children,
  className,
  bodyClassName,
  testId,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: IconType;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  testId?: string;
  /** An anchor id, so a page's mini navigation can scroll to the section. */
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn("clay-card scroll-mt-24 rounded-2xl border border-slate-100", className)}
      data-testid={testId}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="flex min-w-0 items-start gap-3">
          {Icon && (
            <span className="mt-0.5 rounded-xl bg-slate-50 p-2 text-slate-600 ring-1 ring-slate-100">
              <Icon size={16} />
            </span>
          )}
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-gray-900">{title}</h3>
            {description && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className={cn("px-5 pb-5 pt-3", bodyClassName)}>{children}</div>
    </section>
  );
}

/** One figure, tinted like the stat cards on the other HR pages; shows its own skeleton while the figure is on its way. */
export function KpiTile({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  loading,
  onClick,
  testId,
  active,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon: IconType;
  /** Tailwind background + text classes: "bg-blue-50 text-blue-800". */
  tone: string;
  loading?: boolean;
  onClick?: () => void;
  testId?: string;
  active?: boolean;
  className?: string;
}) {
  const body = (
    <>
      <div className="mt-0.5 shrink-0 rounded-xl bg-white/60 p-2">
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium opacity-70">{label}</p>
        {loading ? (
          <Skeleton className="mt-1.5 h-6 w-24 bg-black/10" />
        ) : (
          <p
            className="text-xl font-black leading-tight tabular-nums"
            data-testid={testId ? `${testId}-value` : undefined}
          >
            {value}
          </p>
        )}
        {loading ? (
          <Skeleton className="mt-1.5 h-3 w-16 bg-black/10" />
        ) : (
          sub && <p className="mt-0.5 text-[11px] leading-snug opacity-60">{sub}</p>
        )}
      </div>
    </>
  );
  const classes = cn(
    "flex items-start gap-3 rounded-2xl p-4 text-left transition-shadow",
    tone,
    onClick && "cursor-pointer hover:shadow-md",
    active && "ring-2 ring-current/40",
    className,
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={classes} data-testid={testId} aria-pressed={active}>
      {body}
    </button>
  ) : (
    <div className={classes} data-testid={testId}>
      {body}
    </div>
  );
}

/** A small label pill in one of the portal's status tones. */
export function Chip({
  tone = "neutral",
  children,
  className,
  title,
  icon: Icon,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
  icon?: IconType;
}) {
  return (
    <span
      data-tone={tone}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        TONE[tone],
        className,
      )}
    >
      {Icon && <Icon size={11} />}
      {children}
    </span>
  );
}

export function SeverityChip({ severity, className }: { severity: IssueSeverity; className?: string }) {
  const meta = SEVERITY_META[severity];
  return (
    <Chip tone={meta.tone} className={className}>
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </Chip>
  );
}

/** "Late arrival" with its icon, in the tone of its severity. */
export function IssueChip({
  code,
  severity,
  label,
  className,
}: {
  code: string;
  severity: IssueSeverity;
  label?: string;
  className?: string;
}) {
  return (
    <Chip tone={SEVERITY_META[severity].tone} icon={issueIcon(code)} className={className}>
      {label ?? issueLabel(code)}
    </Chip>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  pending: "warning",
  paid: "success",
  draft: "neutral",
  approved: "info",
  locked: "accent",
};

export function PayStatusChip({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "neutral";
  return <Chip tone={tone}>{payStatusLabel(status)}</Chip>;
}

const AVATAR_TONES = [
  "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-violet-100 text-violet-700",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-700",
  "bg-cyan-100 text-cyan-700",
];

export function Avatar({
  name,
  size = 36,
  className,
}: {
  name: string | null | undefined;
  size?: number;
  className?: string;
}) {
  let hash = 0;
  for (const ch of name ?? "") hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-xl text-xs font-bold",
        AVATAR_TONES[hash % AVATAR_TONES.length],
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

/** Nothing to show here, and why. */
export function EmptyNote({
  icon: Icon,
  title,
  hint,
  action,
  className,
  testId,
}: {
  icon: IconType;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-gray-200 px-6 py-12 text-center",
        className,
      )}
      data-testid={testId}
    >
      <Icon size={30} className="text-gray-300" />
      <p className="text-sm font-semibold text-gray-700">{title}</p>
      {hint && <p className="max-w-md text-xs text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}

// ── Loaders ───────────────────────────────────────────────────────────────────

/** The portal's shield-and-rupee loader with a caption: for a whole panel that is loading its first data. */
export function PayrollLoader({ label = "Loading payroll", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center", className)} data-testid="payroll-loader">
      <ShieldLoader />
      <p className="-mt-4 pb-6 text-xs font-medium text-muted-foreground">{label}…</p>
    </div>
  );
}

/** A row of KPI skeletons: the page keeps its shape while the figures load. */
export function SkeletonKpis({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6", className)} data-testid="skeleton-kpis">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 rounded-2xl bg-slate-50 p-4">
          <Skeleton className="h-9 w-9 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Rows that look like the list that is about to appear. */
export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} data-testid="skeleton-rows">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl border bg-white px-4 py-3">
          <Skeleton className="h-9 w-9 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
          <Skeleton className="hidden h-6 w-20 sm:block" />
          <Skeleton className="h-8 w-20 rounded-lg" />
        </div>
      ))}
    </div>
  );
}

/** A spinner inside a button while its action runs. */
export function BusyIcon({ busy, icon: Icon, size = 14 }: { busy: boolean; icon: IconType; size?: number }) {
  return busy ? <Loader2 size={size} className="animate-spin" /> : <Icon size={size} />;
}

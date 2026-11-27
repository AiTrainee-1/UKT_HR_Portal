import { useRef, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import { AlertOctagon, AlertTriangle, Ban, CalendarDays, CheckCircle2, Scissors, XCircle } from "lucide-react";
import type { AdvanceLeaveCheck } from "@/lib/api-client";
import { TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { leaveChipOf, leaveDaysText } from "@/pages/hr/settlement/leave";
import { formatMoney } from "@/pages/hr/settlement/shared";
import type { PortalItem } from "./api";
import { rowStatus, type RowStatus } from "./logic";

// The Auditor Review Portal's own small pieces (owner 2026-11-27 redesign): a financial-review look in the HRMS colours
// (deep blue #006496 with indigo accents on slate neutrals), white cards on a cool grey page, tabular figures.

export const HEADING_FONT = "'Hanken Grotesk', 'Inter', sans-serif";
export const BODY_FONT = "'Inter', 'Hanken Grotesk', sans-serif";
/** A keyboard focus ring in the brand colour, for every control the portal draws itself. */
export const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#006496] focus-visible:ring-offset-2";
export const CARD = "rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";

type IconType = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;

const STAT_TONE = {
  neutral: { icon: "bg-slate-100 text-slate-600", value: "text-slate-900" },
  brand: { icon: "bg-[#006496]/10 text-[#006496]", value: "text-[#00466a]" },
  success: { icon: "bg-emerald-50 text-emerald-700", value: "text-emerald-800" },
  warning: { icon: "bg-amber-50 text-amber-700", value: "text-amber-800" },
  danger: { icon: "bg-rose-50 text-rose-700", value: "text-rose-800" },
  indigo: { icon: "bg-indigo-50 text-indigo-700", value: "text-indigo-900" },
} as const;
export type StatTone = keyof typeof STAT_TONE;

/** A summary card: an icon, the label, the figure, a line under it. */
export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = "neutral",
  testId,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  icon: IconType;
  tone?: StatTone;
  testId?: string;
}) {
  const t = STAT_TONE[tone];
  return (
    <div className={cn(CARD, "flex min-w-0 flex-col gap-3 p-4")} data-testid={testId} data-tone={tone}>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium text-slate-500">{label}</p>
        <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", t.icon)}>
          <Icon size={16} aria-hidden />
        </span>
      </div>
      <div className="min-w-0">
        <p
          className={cn("truncate text-[22px] font-bold leading-none tabular-nums sm:text-2xl", t.value)}
          style={{ fontFamily: HEADING_FONT }}
          data-testid={testId ? `${testId}-value` : undefined}
        >
          {value}
        </p>
        {sub && <p className="mt-1.5 text-[12px] leading-snug text-slate-500">{sub}</p>}
      </div>
    </div>
  );
}

/** A small figure of the time card's month counts. */
export function Tile({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5" data-testid={testId}>
      <p className="text-[11px] font-medium text-slate-500">{label}</p>
      <p className="text-lg font-bold leading-tight tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

/** A white card with a heading (and something beside it). */
export function Panel({
  title,
  description,
  children,
  testId,
  aside,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  testId?: string;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(CARD, "p-4 sm:p-5", className)} data-testid={testId}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold text-slate-900" style={{ fontFamily: HEADING_FONT }}>
            {title}
          </h2>
          {description && <p className="mt-0.5 text-[13px] text-slate-500">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

const STATUS_VIEW: Record<RowStatus, { text: string; by?: string; className: string; icon: IconType }> = {
  approved: { text: "Approved", className: "border-emerald-200 bg-emerald-50 text-emerald-800", icon: CheckCircle2 },
  reduced: { text: "Reduced", className: "border-amber-200 bg-amber-50 text-amber-800", icon: Scissors },
  rejected_by_auditor: {
    text: "Rejected",
    by: "by you",
    className: "border-rose-200 bg-rose-50 text-rose-800",
    icon: Ban,
  },
  rejected_by_hr: {
    text: "Rejected",
    by: "by HR",
    className: "border-slate-200 bg-slate-100 text-slate-600",
    icon: XCircle,
  },
};

/** The request's state in words and an icon (never the colour alone). `short` (a table column that already says whose
 *  decision it is) keeps "by HR" / "by you" for screen readers only. */
export function StatusTag({ status, short, className }: { status: RowStatus; short?: boolean; className?: string }) {
  const v = STATUS_VIEW[status];
  const Icon = v.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        v.className,
        className,
      )}
      data-status={status}
    >
      <Icon size={11} aria-hidden />
      {v.text}
      {v.by && <span className={short ? "sr-only" : undefined}> {v.by}</span>}
    </span>
  );
}

/** A request's leave check as a compact count ("3 days") in the check's tone, with an icon and the words for a screen
 *  reader (never the colour alone); "-" when there is none. The HRMS's own wording (leave.ts leaveChipOf). */
export function LeaveCount({ check, testId }: { check: AdvanceLeaveCheck | null | undefined; testId?: string }) {
  const view = leaveChipOf(check);
  if (!view || !check) return <span className="pl-1.5 text-[12px] font-medium text-slate-500">View</span>;
  const Icon = view.flag === "critical" ? AlertOctagon : view.flag === "warning" ? AlertTriangle : CalendarDays;
  return (
    <span
      title={view.title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        TONE[view.tone],
      )}
      data-testid={testId}
      data-flag={view.flag}
    >
      <Icon size={11} aria-hidden className="shrink-0" />
      <span className="sr-only">{view.srPrefix} </span>
      {leaveDaysText(check.days)}
      <span className="sr-only"> of leave</span>
    </span>
  );
}

/** HR's approved amount, or HR's rejection. */
export function HrAmount({ item }: { item: PortalItem }) {
  if (item.final.decision !== "approved") return <StatusTag status="rejected_by_hr" short />;
  return <span className="font-semibold tabular-nums text-slate-900">{formatMoney(item.final.amount)}</span>;
}

/** What is paid after the audit: HR's amount as it stands, the auditor's reduced amount (from -> to, HR's struck
 *  through), the auditor's rejection, or nothing (HR rejected it). */
export function AfterAudit({ item, align = "right" }: { item: PortalItem; align?: "right" | "left" }) {
  const status = rowStatus(item);
  const box = cn("flex flex-col gap-0.5", align === "right" ? "items-end text-right" : "items-start text-left");
  if (status === "rejected_by_hr") return <span className="text-[12px] text-slate-400">Not paid</span>;
  if (status === "rejected_by_auditor")
    return (
      <div className={box}>
        <span className="text-[11px] tabular-nums text-slate-400 line-through">{formatMoney(item.final.amount)}</span>
        <StatusTag status="rejected_by_auditor" short />
      </div>
    );
  if (status === "reduced") {
    const less = (item.final.amount ?? 0) - (item.auditor.amount ?? 0);
    return (
      <div className={box}>
        <span className="text-[11px] tabular-nums text-slate-400">
          <span className="line-through">{formatMoney(item.final.amount)}</span>
          <span aria-hidden> → </span>
          <span className="sr-only"> reduced to </span>
        </span>
        <span className="font-bold tabular-nums text-amber-800">{formatMoney(item.auditor.amount)}</span>
        <span className="text-[10.5px] font-semibold text-amber-700">−{formatMoney(Math.round(less * 100) / 100)}</span>
      </div>
    );
  }
  return <span className="font-semibold tabular-nums text-slate-900">{formatMoney(item.final.amount)}</span>;
}

/** The auditor's remark on a request (a dash when none). */
export function RemarkText({ item, clamp = true }: { item: PortalItem; clamp?: boolean }) {
  const remark = (item.auditor.remark ?? "").trim();
  if (!remark) return <span className="text-[12px] text-slate-300">—</span>;
  return (
    <p className={cn("text-[12px] leading-snug text-slate-700", clamp && "line-clamp-3 max-w-[15rem]")} title={remark}>
      {remark}
    </p>
  );
}

/** The portal's one row of tabs (owner: never a tab inside a tab): a real tablist, arrow keys move between tabs. */
export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: T; label: ReactNode; icon: IconType; badge?: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const n = tabs.length;
    const to =
      e.key === "ArrowRight"
        ? (index + 1) % n
        : e.key === "ArrowLeft"
          ? (index - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : null;
    if (to == null) return;
    e.preventDefault();
    refs.current[to]?.focus();
    onChange(tabs[to].value);
  };
  return (
    <div
      role="tablist"
      aria-label="Review sections"
      className="flex w-full gap-1 overflow-x-auto overflow-y-hidden"
      data-testid="portal-tabs"
    >
      {tabs.map((t, i) => {
        const active = t.value === value;
        const Icon = t.icon;
        return (
          <button
            key={t.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`portal-tab-${t.value}`}
            aria-selected={active}
            aria-controls={`portal-panel-${t.value}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              "relative inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-t-lg px-2 py-3 text-[13px] font-semibold transition-colors sm:flex-none sm:gap-2 sm:px-4 sm:text-[13.5px]",
              FOCUS,
              "focus-visible:ring-offset-0",
              active ? "text-[#006496]" : "text-slate-500 hover:text-slate-800",
            )}
            data-testid={`portal-tab-${t.value}`}
          >
            <Icon size={16} aria-hidden className="hidden shrink-0 sm:block" />
            <span className="whitespace-nowrap">{t.label}</span>
            {t.badge}
            <span
              aria-hidden
              className={cn(
                "absolute inset-x-2 bottom-0 h-[3px] rounded-full transition-colors",
                active ? "bg-[#006496]" : "bg-transparent",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

/** A count on a tab. */
export function TabBadge({ children, tone = "brand" }: { children: ReactNode; tone?: "brand" | "warning" }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-px text-[11px] font-bold tabular-nums",
        tone === "warning" ? "bg-amber-100 text-amber-800" : "bg-[#006496]/10 text-[#006496]",
      )}
    >
      {children}
    </span>
  );
}

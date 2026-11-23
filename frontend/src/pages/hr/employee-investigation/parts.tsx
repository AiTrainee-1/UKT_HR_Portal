import { useState, type ReactNode } from "react";
import { AlertTriangle, CalendarCheck2, Info, ShieldCheck, UserCheck, UserX, X, type LucideIcon } from "lucide-react";
import { Chip, EmptyNote } from "@/components/payroll/kit/parts";
import { dateShort } from "@/components/payroll/kit/format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { InvestigationRow, InvestigationSettings } from "@/lib/api-client/custom-hooks/employee-investigation";
import { cn } from "@/lib/utils";
import { Panel } from "../salary-slip-center/parts";
import {
  NO_DATA_HELP,
  autoChip,
  awaySince,
  dayCount,
  decisionIsCurrent,
  decisionText,
  lastAttendedText,
  leaveText,
  noDataText,
  type ResultReport,
} from "./logic";

/** The page's accent (the Employees group's indigo), on its tabs and main buttons. */
export const ACCENT = "#4f46e5";

const KIND_CLASS = {
  staff: "border-indigo-200 bg-indigo-50 text-indigo-700",
  production: "border-amber-200 bg-amber-50 text-amber-800",
} as const;

/** Staff / Production. */
export function KindChip({ kind }: { kind: "staff" | "production" }) {
  return (
    <Chip className={cn("px-1.5 py-0 text-[10px]", KIND_CLASS[kind] ?? KIND_CLASS.staff)}>
      {kind === "production" ? "Production" : "Staff"}
    </Chip>
  );
}

/** Active / Inactive, as the employee's status is now. */
export function EmployeeStatusChip({ status }: { status: string }) {
  return status === "active" ? (
    <Chip tone="success" icon={UserCheck}>
      Active
    </Chip>
  ) : (
    <Chip tone="neutral" icon={UserX}>
      Inactive
    </Chip>
  );
}

/**
 * A short label with an explanation: on hover or keyboard focus, and on a tap (phones have no hover). The explanation is
 * also the button's accessible name, so a screen reader reads it without opening anything.
 */
export function InfoTip({ label, text, testId }: { label: ReactNode; text: string; testId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              // Radix closes the tip on a click; a tap must open it instead
              e.preventDefault();
              setOpen((o) => !o);
            }}
            aria-label={`${typeof label === "string" ? `${label}. ` : ""}${text}`}
            className="inline-flex items-center gap-1 rounded text-[11px] font-medium text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            data-testid={testId}
          >
            {label}
            <Info size={11} aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs leading-snug">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** "42 days" away, since when, and the no-data days left out. */
export function AwayCell({ row }: { row: InvestigationRow }) {
  const gaps = noDataText(row.noDataDays);
  const since = awaySince(row);
  return (
    <div className="min-w-0 leading-tight">
      <p className="text-base font-black tabular-nums text-gray-900" data-testid={`inv-away-${row.code}`}>
        {dayCount(row.absentDays)}
      </p>
      {since && <p className="text-[11px] text-gray-500">{since}</p>}
      {gaps && (
        <div className="mt-0.5">
          <InfoTip label={gaps} text={NO_DATA_HELP} testId={`inv-nodata-${row.code}`} />
        </div>
      )}
    </div>
  );
}

/** The last attended day, or "Never attended" counted from the join date. */
export function LastAttendedCell({ row }: { row: InvestigationRow }) {
  const { main, note } = lastAttendedText(row);
  return (
    <div className="min-w-0 leading-tight">
      <p className={cn("text-sm", row.neverAttended ? "font-semibold text-amber-800" : "text-gray-800")}>{main}</p>
      {note && <p className="text-[11px] text-gray-500">{note}</p>}
    </div>
  );
}

/** Approved leave on the working days away; "On approved leave" when it covers them all. */
export function LeaveCell({ row }: { row: InvestigationRow }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1 leading-tight">
      <p className="text-xs text-gray-700">
        <span className="font-semibold tabular-nums text-gray-900">{leaveText(row)}</span>
      </p>
      {row.coveredByLeave && (
        <Chip
          tone="info"
          icon={CalendarCheck2}
          title="Every working day away is approved leave: listed, never marked inactive automatically"
        >
          On approved leave
        </Chip>
      )}
    </div>
  );
}

/** The latest decision, the Auto tonight chip and (30 Days) why the Auto Trigger leaves the row alone. */
export function DecisionCell({
  row,
  settings,
  showWhyNot,
}: {
  row: InvestigationRow;
  settings: InvestigationSettings | undefined;
  showWhyNot: boolean;
}) {
  const chip = autoChip(row, settings);
  const current = decisionIsCurrent(row);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1 leading-snug" data-testid={`inv-decision-${row.code}`}>
      {row.keptActive && (
        <Chip tone="success" icon={ShieldCheck} title="The Auto Trigger leaves them alone until they attend again">
          Kept active
        </Chip>
      )}
      {chip && (
        <Chip tone={chip.tone} icon={AlertTriangle} title={chip.title}>
          <span data-testid={`inv-auto-${row.code}`}>{chip.label}</span>
        </Chip>
      )}
      {row.decision && (
        <p className={cn("text-xs", current ? "text-gray-800" : "text-gray-500")}>
          {!current && <span className="font-semibold">Earlier absence: </span>}
          {decisionText(row.decision)}
          {row.decision.at && <span className="text-gray-400"> · {dateShort(row.decision.at)}</span>}
        </p>
      )}
      {showWhyNot && !row.autoTonight && row.autoWhyNot && !row.keptActive && (
        <p className="text-[11px] text-gray-500" data-testid={`inv-whynot-${row.code}`}>
          {row.autoWhyNot}
        </p>
      )}
      {!row.decision && !chip && !(showWhyNot && row.autoWhyNot) && <span className="text-xs text-gray-400">—</span>}
    </div>
  );
}

/** A one-line note in the page (view only, a unit login, the switch off ...). */
export function Banner({
  tone,
  icon: Icon,
  children,
  testId,
}: {
  tone: "amber" | "slate" | "indigo" | "red";
  icon: LucideIcon;
  children: ReactNode;
  testId: string;
}) {
  const toneClass = {
    amber: "bg-amber-50 text-amber-900",
    slate: "bg-slate-50 text-slate-700",
    indigo: "bg-indigo-50 text-indigo-900",
    red: "bg-red-50 text-red-900",
  }[tone];
  return (
    <p className={cn("flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-sm", toneClass)} data-testid={testId}>
      <Icon size={15} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Who a decision did not change, and why (the server's own reasons). */
export function ResultPanel({ report, onClose }: { report: ResultReport; onClose: () => void }) {
  return (
    <Panel tone="amber" testId="inv-result">
      <div className="flex items-start gap-2" role="status" aria-live="polite">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm font-semibold text-amber-950" data-testid="inv-result-title">
            {report.title}
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto pr-1 text-xs text-amber-950">
            {report.items.map((s, i) => (
              <li key={`${s.employeeId}-${i}`} className="flex flex-wrap gap-x-2" data-testid="inv-result-item">
                <span className="font-mono text-amber-800">{s.employeeCode}</span>
                <span className="font-semibold">{s.name}</span>
                <span className="text-amber-800">— {s.reason}</span>
              </li>
            ))}
          </ul>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose} aria-label="Close this list">
          <X size={14} />
        </Button>
      </div>
    </Panel>
  );
}

export function ListSkeleton({ testId = "inv-loading" }: { testId?: string }) {
  return (
    <div className="space-y-2 rounded-2xl border bg-white p-3" data-testid={testId} aria-busy="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-1 py-1.5">
          <Skeleton className="h-4 w-4 rounded" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-44 max-w-full" />
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="hidden h-5 w-20 md:block" />
          <Skeleton className="hidden h-5 w-24 rounded-full md:block" />
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
      ))}
    </div>
  );
}

export function LoadError({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-4"
      data-testid="inv-load-error"
      role="alert"
    >
      <p className="text-sm text-red-800">
        <b>Could not load {what}.</b> {error}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export { EmptyNote };

import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Landmark, ReceiptText, SearchX } from "lucide-react";
import { Chip, EmptyNote } from "@/components/payroll/kit/parts";
import { dateShort, dateTime, inr } from "@/components/payroll/kit/format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { SlipCalendarStatus, SlipCenterEmployee } from "@/lib/api-client/custom-hooks/salary-slip-center";
import { cn } from "@/lib/utils";
import { isActiveEmployee, salaryOf, type EmptyInfo } from "./logic";

/** The page's accent (the Payroll group's indigo), on its tabs and main buttons. */
export const ACCENT = "#4f46e5";

const CATEGORY_CLASS = {
  staff: "border-indigo-200 bg-indigo-50 text-indigo-700",
  production: "border-amber-200 bg-amber-50 text-amber-800",
} as const;

export function CategoryChip({ category }: { category: SlipCenterEmployee["category"] }) {
  return (
    <Chip className={CATEGORY_CLASS[category] ?? CATEGORY_CLASS.staff}>
      {category === "production" ? "Production" : "Staff"}
    </Chip>
  );
}

/** HOLD / NEW / INACTIVE beside a name (the tabs overlap, so a row says which of them it is in). */
export function RowBadges({ row }: { row: SlipCenterEmployee }) {
  const holdTitle = [
    "On hold for this month: left out of the bank file",
    row.holdReason ? `Reason: ${row.holdReason}` : "",
    row.heldBy ? `By ${row.heldBy}${row.heldAt ? `, ${dateTime(row.heldAt)}` : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <>
      {row.onHold && (
        <Chip tone="caution" title={holdTitle} className="px-1.5 py-0 text-[10px]">
          HOLD
        </Chip>
      )}
      {row.isNewJoiner && (
        <Chip tone="info" title={`New joiner: joined ${dateShort(row.joinDate)}`} className="px-1.5 py-0 text-[10px]">
          NEW
        </Chip>
      )}
      {!isActiveEmployee(row) && (
        <Chip tone="neutral" title="Inactive employee" className="px-1.5 py-0 text-[10px]">
          INACTIVE
        </Chip>
      )}
    </>
  );
}

/** "₹25,000 / month" or "₹650 / shift"; amber "Not set" when the profile has no salary. */
export function SalaryCell({ row }: { row: SlipCenterEmployee }) {
  const salary = salaryOf(row);
  if (!salary) {
    return (
      <Chip
        tone="warning"
        icon={AlertTriangle}
        title={row.payIssue ?? "No salary on the profile: no slip can be worked out"}
      >
        Not set
      </Chip>
    );
  }
  return (
    <span className="whitespace-nowrap tabular-nums">
      <span className="font-semibold text-gray-900">{inr(salary.amount, Number.isInteger(salary.amount) ? 0 : 2)}</span>
      <span className="text-xs text-gray-400"> / {salary.per}</span>
    </span>
  );
}

/** The masked account, or what keeps the employee out of the bank file. */
export function BankCell({ row }: { row: SlipCenterEmployee }) {
  if (row.bankIssue) {
    return (
      <Chip tone="danger" icon={Landmark} title={`${row.bankIssue}: left out of the bank file`}>
        {row.bankIssue}
      </Chip>
    );
  }
  return row.bankAccountMasked ? (
    <span className="font-mono text-xs text-gray-700">{row.bankAccountMasked}</span>
  ) : (
    <span className="text-gray-400">—</span>
  );
}

/** Generated (date + Net) or Not generated; why a slip cannot be worked out, when it cannot. */
export function SlipCell({ row }: { row: SlipCenterEmployee }) {
  return (
    <div className="flex flex-col items-start gap-1">
      {row.slip ? (
        <div className="leading-tight" title={`${row.slip.slipNumber} · by ${row.slip.generatedBy ?? "—"}`}>
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
            <CheckCircle2 size={12} /> Generated {dateShort(row.slip.generatedAt.slice(0, 10))}
          </span>
          <p className="text-sm font-bold tabular-nums text-gray-900">
            {inr(row.slip.net)} <span className="text-[11px] font-medium text-gray-400">net</span>
          </p>
        </div>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500">
          <CircleDashed size={12} /> Not generated
        </span>
      )}
      {row.payIssue && (
        <Chip tone="warning" icon={AlertTriangle} title="Fix it on the employee's profile to generate a slip">
          {row.payIssue}
        </Chip>
      )}
    </div>
  );
}

/** The colour and name of each day of the slip's calendar. */
export const CALENDAR_META: Record<SlipCalendarStatus, { label: string; cell: string; dot: string }> = {
  present: { label: "Present", cell: "bg-emerald-100 text-emerald-900", dot: "bg-emerald-500" },
  half_shift: { label: "Half shift", cell: "bg-amber-100 text-amber-900", dot: "bg-amber-500" },
  absent: { label: "Absent", cell: "bg-red-100 text-red-800", dot: "bg-red-500" },
  leave: { label: "Leave", cell: "bg-sky-100 text-sky-900", dot: "bg-sky-500" },
  holiday: { label: "Holiday", cell: "bg-violet-100 text-violet-900", dot: "bg-violet-500" },
  sunday: { label: "Sunday", cell: "bg-slate-100 text-slate-500", dot: "bg-slate-400" },
  weekly_off: { label: "Weekly off", cell: "bg-slate-100 text-slate-500", dot: "bg-slate-400" },
  not_joined: { label: "Not joined yet", cell: "bg-gray-50 text-gray-300", dot: "bg-gray-300" },
  future: {
    label: "Not counted yet",
    cell: "border border-dashed border-gray-200 bg-white text-gray-300",
    dot: "bg-white",
  },
};

export const calendarMeta = (status: string) =>
  CALENDAR_META[status as SlipCalendarStatus] ?? {
    label: status.replace(/_/g, " "),
    cell: "bg-gray-100 text-gray-600",
    dot: "bg-gray-400",
  };

/** Why the list is empty, with the way out. */
export function EmptyState({
  info,
  onClear,
  onAll,
  onPrevious,
}: {
  info: EmptyInfo;
  onClear: () => void;
  onAll: () => void;
  onPrevious: () => void;
}) {
  const action =
    info.action === "clear" ? (
      <Button variant="outline" size="sm" className="mt-1" onClick={onClear}>
        Clear filters
      </Button>
    ) : info.action === "all" ? (
      <Button variant="outline" size="sm" className="mt-1" onClick={onAll}>
        Show all employees
      </Button>
    ) : info.action === "previous" ? (
      <Button variant="outline" size="sm" className="mt-1" onClick={onPrevious}>
        Open the previous month
      </Button>
    ) : null;
  return (
    <EmptyNote
      icon={info.action === "clear" ? SearchX : ReceiptText}
      title={info.title}
      hint={info.hint}
      action={action}
      className="bg-white"
      testId="ssc-empty"
    />
  );
}

/** The list while it loads: the page keeps its shape. */
export function ListSkeleton() {
  return (
    <div className="space-y-2 rounded-2xl border bg-white p-3" data-testid="ssc-loading">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-1 py-1.5">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-4 w-14" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-44 max-w-full" />
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="hidden h-5 w-20 rounded-full md:block" />
          <Skeleton className="hidden h-5 w-24 md:block" />
          <Skeleton className="h-8 w-20 rounded-lg" />
        </div>
      ))}
    </div>
  );
}

/** A small labelled panel inside the page (progress, the skipped list, the bank check). */
export function Panel({
  tone,
  children,
  className,
  testId,
}: {
  tone: "indigo" | "amber" | "emerald" | "red";
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const toneClass = {
    indigo: "border-indigo-200 bg-indigo-50/70",
    amber: "border-amber-200 bg-amber-50/80",
    emerald: "border-emerald-200 bg-emerald-50/70",
    red: "border-red-200 bg-red-50/80",
  }[tone];
  return (
    <div className={cn("rounded-2xl border px-4 py-3", toneClass, className)} data-testid={testId}>
      {children}
    </div>
  );
}

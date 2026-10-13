import type { ComponentType, ReactNode } from "react";
import { Link } from "wouter";
import { AlertTriangle, ChevronDown, Factory, Info, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PAY_CYCLES,
  PAY_CYCLE_INFO,
  isPayCycle,
  type PayCycle,
  type ProductionEmployeeRow,
} from "@/lib/api-client/custom-hooks";
import { TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { Chip } from "../account-management/parts";
import { formatPeriod, formatRupees, payrollStatus, type EmptyInfo } from "./logic";

export { LoadError } from "../org-structure/parts";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** Each cycle's colour, the same on its tab, its stat card and its chip. Unassigned is amber: production's accent,
 *  and the colour of "needs attention" everywhere else in the portal. */
export const CYCLE_STYLE: Record<PayCycle, { fill: string; card: string; chip: string }> = {
  weekly: { fill: "#0284c7", card: "bg-sky-50 text-sky-900", chip: "border-sky-200 bg-sky-50 text-sky-800" },
  biweekly: {
    fill: "#7c3aed",
    card: "bg-violet-50 text-violet-900",
    chip: "border-violet-200 bg-violet-50 text-violet-800",
  },
  monthly: {
    fill: "#059669",
    card: "bg-emerald-50 text-emerald-900",
    chip: "border-emerald-200 bg-emerald-50 text-emerald-800",
  },
};

export const UNASSIGNED_FILL = "#d97706";
export const AMBER_CHIP = "border-amber-200 bg-amber-50 text-amber-800";

export const SETTINGS_PATH = "/hr/settings?tab=production_payroll";

/** A figure that is also the way to its tab. Looks like the StatCard of the other HR pages, with a pressed state. */
export function StatButton({
  testId,
  label,
  value,
  sub,
  icon: Icon,
  tone,
  ring,
  selected,
  onClick,
  hint,
  className,
}: {
  testId: string;
  label: string;
  value: number | string;
  sub?: string;
  icon: IconType;
  tone: string;
  /** Extra classes for the card, e.g. to span both columns of the phone grid. */
  className?: string;
  /** The colour of the outline when selected. */
  ring: string;
  selected: boolean;
  onClick: () => void;
  /** Something to fix about this cycle, shown under the figure. */
  hint?: ReactNode;
}) {
  return (
    <div
      className={cn("flex flex-col rounded-2xl transition-shadow", tone, className)}
      style={selected ? { boxShadow: `0 0 0 2px ${ring}` } : undefined}
      data-testid={testId}
      data-selected={selected ? "true" : undefined}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onClick}
        className="flex flex-1 items-start gap-3 rounded-2xl p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="mt-0.5 rounded-xl bg-white/60 p-2">
          <Icon size={16} />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium opacity-70">{label}</p>
          <p className="text-2xl font-black leading-tight" data-testid={`${testId}-value`}>
            {value}
          </p>
          {sub && <p className="mt-0.5 text-xs leading-snug opacity-60">{sub}</p>}
        </div>
      </button>
      {hint && <div className="-mt-1 px-4 pb-3">{hint}</div>}
    </div>
  );
}

/** BiWeekly and Monthly need a first period start before their payroll can run; this points to where it is set. */
export function ConfigHint({ cycle }: { cycle: PayCycle }) {
  return (
    <Link
      href={SETTINGS_PATH}
      className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800 underline-offset-2 hover:underline"
      data-testid={`pe-hint-${cycle}`}
    >
      <AlertTriangle size={11} /> Set its first period start in Settings
    </Link>
  );
}

/** The cycle an employee is on, or the amber "Not assigned". */
export function CycleChip({ cycle }: { cycle: PayCycle | null }) {
  return cycle ? (
    <span className="inline-flex" data-testid="pe-cycle-chip" data-cycle={cycle}>
      <Chip className={CYCLE_STYLE[cycle].chip}>{PAY_CYCLE_INFO[cycle].label}</Chip>
    </span>
  ) : (
    <span
      className="inline-flex"
      title="Not in any payroll until assigned to a cycle"
      data-testid="pe-cycle-chip"
      data-cycle="none"
    >
      <Chip className={AMBER_CHIP}>Not assigned</Chip>
    </span>
  );
}

/** Salary per shift in rupees, or an amber "Not set": payroll skips an employee with no rate. */
export function RateCell({ value }: { value: number | null }) {
  const text = formatRupees(value);
  return text ? (
    <span className="font-semibold tabular-nums text-gray-900">{text}</span>
  ) : (
    <span
      className="inline-flex"
      title="No salary per shift: payroll skips this employee until it is set on their employee record"
      data-testid="pe-rate-unset"
    >
      <Chip className={AMBER_CHIP}>
        <AlertTriangle size={11} /> Not set
      </Chip>
    </span>
  );
}

/** The latest payslip: its period and status, and the cycle it was generated on when that is not the current one. */
export function LastPayrollCell({
  payroll,
  currentCycle,
}: {
  payroll: ProductionEmployeeRow["lastPayroll"];
  currentCycle: PayCycle | null;
}) {
  if (!payroll) return <span className="text-gray-400">—</span>;
  const status = payrollStatus(payroll.status);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="whitespace-nowrap text-xs text-gray-700">
        {formatPeriod(payroll.periodStart, payroll.periodEnd)}
      </span>
      <Chip className={TONE[status.tone]}>{status.label}</Chip>
      {payroll.payCycle && payroll.payCycle !== currentCycle && (
        <span className="text-[11px] text-gray-400">on {PAY_CYCLE_INFO[payroll.payCycle].label}</span>
      )}
    </div>
  );
}

/** A row's Assign menu: the three cycles (the current one ticked and disabled) and, when on one, Remove from cycle. */
export function AssignMenu({
  row,
  disabled,
  onAssign,
}: {
  row: ProductionEmployeeRow;
  disabled?: boolean;
  onAssign: (row: ProductionEmployeeRow, cycle: PayCycle | null) => void;
}) {
  const code = row.employeeCode;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1"
          disabled={disabled}
          aria-label={`Assign ${row.name} to a pay cycle`}
          data-testid={`pe-row-assign-${code}`}
        >
          Assign <ChevronDown size={13} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs text-gray-500">Pay cycle</DropdownMenuLabel>
        {/* one cycle per employee: radio items, the current one checked and not offered */}
        <DropdownMenuRadioGroup
          value={row.payCycle ?? ""}
          onValueChange={(value) => isPayCycle(value) && onAssign(row, value)}
        >
          {PAY_CYCLES.map((cycle) => (
            <DropdownMenuRadioItem
              key={cycle}
              value={cycle}
              disabled={row.payCycle === cycle}
              data-testid={`pe-row-assign-${code}-${cycle}`}
            >
              <span className="font-medium">{PAY_CYCLE_INFO[cycle].label}</span>
              <span className="ml-auto text-[11px] text-gray-400">{PAY_CYCLE_INFO[cycle].days}-day</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {row.payCycle && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              inset
              className="text-red-700 focus:text-red-800"
              onSelect={() => onAssign(row, null)}
              data-testid={`pe-row-assign-${code}-none`}
            >
              Remove from cycle
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Why the list is empty, with the way out: clear the filters, or go to Unassigned and assign. */
export function EmptyState({
  info,
  onClear,
  onOpenUnassigned,
}: {
  info: EmptyInfo;
  onClear: () => void;
  onOpenUnassigned: () => void;
}) {
  const filtered = info.kind === "filtered";
  return (
    <Card className="rounded-2xl">
      <CardContent
        className="flex flex-col items-center gap-3 px-6 py-14 text-center"
        data-testid="pe-empty"
        data-kind={info.kind}
      >
        <div className={cn("rounded-2xl p-4", filtered ? "bg-gray-100 text-gray-500" : "bg-amber-50 text-amber-700")}>
          {filtered ? <SearchX size={26} /> : <Factory size={26} />}
        </div>
        <div>
          <p className="font-bold text-gray-900">{info.title}</p>
          <p className="mt-0.5 max-w-md text-sm text-muted-foreground">{info.hint}</p>
        </div>
        {info.action === "clear" && (
          <Button variant="outline" onClick={onClear}>
            Clear filters
          </Button>
        )}
        {info.action === "open-unassigned" && (
          <Button variant="outline" onClick={onOpenUnassigned}>
            Open Unassigned
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** The one explanation of what assigning does, at the bottom of the page. */
export function HowItWorks() {
  return (
    <Card className="border-0 bg-gray-50">
      <CardContent className="p-4" data-testid="pe-how-it-works">
        <div className="flex items-start gap-2">
          <Info size={14} className="mt-0.5 shrink-0 text-amber-500" />
          <div className="space-y-1 text-xs text-gray-600">
            <p className="font-bold text-gray-800">How it works</p>
            <p>
              Assigned employees are paid on their cycle&apos;s Production Payroll page:{" "}
              {PAY_CYCLES.map((cycle, i) => (
                <span key={cycle}>
                  {i > 0 && " · "}
                  <Link href={PAY_CYCLE_INFO[cycle].path} className="font-semibold text-sky-700 hover:underline">
                    {PAY_CYCLE_INFO[cycle].label}
                  </Link>{" "}
                  <span className="text-gray-400">({PAY_CYCLE_INFO[cycle].calculation.toLowerCase()})</span>
                </span>
              ))}
              .
            </p>
            <p>
              Payroll that was already generated keeps the cycle it was generated on; moving an employee changes only
              the periods that come next.
            </p>
            <p>
              New production employees start Unassigned: until they are assigned, no cycle&apos;s payroll includes them.
              An employee with no salary per shift is skipped by payroll even when assigned.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** The list while the first load is in flight. */
export function ListSkeleton() {
  return (
    <div className="space-y-3 rounded-2xl border bg-white p-4" data-testid="pe-loading">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-4 rounded" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="hidden h-5 w-20 rounded-full sm:block" />
          <Skeleton className="hidden h-8 w-20 rounded-xl sm:block" />
        </div>
      ))}
    </div>
  );
}

/** A toast description of several sentences. */
export function Lines({ lines }: { lines: string[] }) {
  return (
    <div className="space-y-1">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

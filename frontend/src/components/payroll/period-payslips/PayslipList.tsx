import type { ComponentType, ReactNode } from "react";
import { Download, FileSearch, Mail, MessageCircle, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ACCENT_UI, accentOf } from "@/components/payroll/kit/accent-ui";
import { inr } from "@/components/payroll/kit/format";
import { BusyIcon, PayStatusChip, PaymentChip } from "@/components/payroll/kit/parts";
import type { PayrollKind, PayslipRow } from "@/lib/api-client/custom-hooks";
import { Gate } from "@/lib/tab-access";
import { cn } from "@/lib/utils";
import { countText, paidDaysText, type PayslipTotals } from "./logic";
import { noSlipReason, type PayslipActions } from "./use-payslip-actions";

type IconType = ComponentType<{ size?: number; className?: string }>;

// The columns at tablet width and up (each wrapper below is `md:contents`, so its cells sit in the row's grid); under
// that each row is a card with its figures in a grid of three. The list scrolls sideways inside its own box when the
// screen is narrower than the columns.
//   staff:      Pick | Employee | Paid days | Earned | Excess | Detection | Deductions | NET | Status | Actions
//   production: Pick | Employee | Rate / shift | Shifts | Days worked | Earned | Excess | Detection | Deductions | NET | ...
const GRID: Record<PayrollKind, string> = {
  staff:
    "md:grid md:grid-cols-[1.5rem_minmax(0,1.8fr)_4.75rem_repeat(5,minmax(0,1fr))_6.5rem_8.75rem] md:items-center md:gap-3",
  production:
    "md:grid md:grid-cols-[1.5rem_minmax(0,1.8fr)_4.75rem_3.75rem_4.25rem_repeat(5,minmax(0,1fr))_6.5rem_8.75rem] md:items-center md:gap-3",
};
const MIN_WIDTH: Record<PayrollKind, string> = { staff: "md:min-w-[1040px]", production: "md:min-w-[1220px]" };
/** The footer's "Total" cell spans the columns before the money. */
const TOTAL_SPAN: Record<PayrollKind, string> = { staff: "md:col-span-3", production: "md:col-span-5" };

/** "+₹2,000" / "−₹500" / "—": an Excess or Detection figure, zero as a dash. */
function signed(value: number, sign: "+" | "−"): string {
  return value ? `${sign}${inr(Math.abs(value))}` : "—";
}

function Figure({
  label,
  children,
  className,
  testId,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg bg-slate-50 px-2 py-1.5 md:bg-transparent md:p-0 md:text-right">
      <span className="block text-[10px] font-medium text-muted-foreground md:sr-only">{label}</span>
      <span className={cn("block truncate text-sm font-semibold tabular-nums", className)} data-testid={testId}>
        {children}
      </span>
    </div>
  );
}

function RowButton({
  icon,
  busy,
  label,
  disabled,
  title,
  onClick,
  className,
  testId,
}: {
  icon: IconType;
  busy: boolean;
  label: string;
  disabled: boolean;
  title?: string;
  onClick: () => void;
  className?: string;
  testId: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={cn("h-8 w-8 shrink-0", className)}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      <BusyIcon busy={busy} icon={icon} size={14} />
    </Button>
  );
}

function PayslipRowItem({
  row,
  kind,
  picked,
  onPick,
  onOpen,
  actions,
}: {
  row: PayslipRow;
  kind: PayrollKind;
  picked: boolean;
  onPick: () => void;
  onOpen: () => void;
  actions: PayslipActions;
}) {
  const ui = ACCENT_UI[accentOf(kind)];
  const id = row.payrollId;
  const noSlip = noSlipReason(row);
  // one row action at a time: while one runs, every other waits (its own button spins)
  const anyBusy = actions.busy !== null;
  return (
    <li
      className={cn(
        GRID[kind],
        "flex flex-col gap-3 px-4 py-3 transition-colors hover:bg-slate-50/70",
        picked && ui.pickedRow,
      )}
      data-testid={`ps-row-${id}`}
      data-status={row.status}
    >
      <div className="flex min-w-0 items-start gap-3 md:contents">
        <div className="pt-0.5 md:pt-0">
          <Checkbox
            checked={picked}
            onCheckedChange={onPick}
            aria-label={`Pick the payslip of ${row.name}`}
            className={cn("border-slate-300", ui.check)}
            data-testid={`ps-row-${id}-pick`}
          />
        </div>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              "block max-w-full truncate text-left text-sm font-bold text-gray-900 hover:underline",
              kind === "production" ? "hover:text-amber-700" : "hover:text-indigo-700",
            )}
            title={`Show the payslip of ${row.name}`}
            data-testid={`ps-row-${id}-open`}
          >
            {row.name}
          </button>
          <p className="truncate text-xs text-muted-foreground">
            <span className="font-mono">{row.code}</span>
            {row.department && <> · {row.department}</>}
          </p>
          {row.designation && <p className="truncate text-[11px] text-muted-foreground">{row.designation}</p>}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1.5 md:contents">
        {kind === "production" ? (
          <>
            <Figure label="Rate / shift" className="text-gray-700" testId={`ps-row-${id}-rate`}>
              {row.salaryPerShift ? inr(row.salaryPerShift) : "—"}
            </Figure>
            <Figure label="Shifts" className="text-gray-700" testId={`ps-row-${id}-shifts`}>
              {countText(row.shifts)}
            </Figure>
            <Figure label="Days worked" className="text-gray-700" testId={`ps-row-${id}-days`}>
              {countText(row.daysWorked)}
            </Figure>
          </>
        ) : (
          <Figure label="Paid days" className="text-gray-700" testId={`ps-row-${id}-days`}>
            {paidDaysText(row)}
          </Figure>
        )}
        <Figure label="Earned" className="text-gray-900">
          {inr(row.earned)}
          {row.ot > 0 && (
            <span className="block text-[10px] font-medium text-muted-foreground">+ OT {inr(row.ot)}</span>
          )}
        </Figure>
        <Figure
          label="Excess"
          className={row.excess ? "text-emerald-700" : "text-gray-400"}
          testId={`ps-row-${id}-excess`}
        >
          {signed(row.excess, "+")}
        </Figure>
        <Figure
          label="Detection"
          className={row.detection ? "text-rose-700" : "text-gray-400"}
          testId={`ps-row-${id}-detection`}
        >
          {signed(row.detection, "−")}
        </Figure>
        <Figure label="Deductions" className={row.totalDeduction ? "text-red-600" : "text-gray-400"}>
          {row.totalDeduction ? inr(row.totalDeduction) : "—"}
        </Figure>
        <Figure label="NET" className="font-black text-green-700" testId={`ps-row-${id}-net`}>
          {inr(row.net)}
        </Figure>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 md:contents">
        <div className="flex flex-wrap items-center gap-1 md:flex-col md:items-start">
          <span className="sr-only">Status</span>
          <PayStatusChip status={row.status} />
          <PaymentChip
            status={row.paymentStatus}
            title={
              row.paymentStatus === "paid"
                ? "Paid: the month was marked as paid"
                : "Not paid yet: the month has not been marked as paid"
            }
          />
        </div>
        <div className="flex items-center gap-1 md:justify-end">
          <RowButton
            icon={Receipt}
            busy={false}
            label={`Show the payslip of ${row.name}`}
            disabled={false}
            onClick={onOpen}
            className="md:hidden"
            testId={`ps-row-${id}-breakdown`}
          />
          <RowButton
            icon={FileSearch}
            busy={actions.isBusy(row, "preview")}
            label={`Preview the payslip PDF of ${row.name}`}
            disabled={anyBusy}
            onClick={() => void actions.preview(row)}
            testId={`ps-row-${id}-preview`}
          />
          <RowButton
            icon={Download}
            busy={actions.isBusy(row, "download")}
            label={`Download the payslip PDF of ${row.name}`}
            disabled={anyBusy}
            onClick={() => void actions.download(row)}
            testId={`ps-row-${id}-download`}
          />
          {/* sending payslips (email / WhatsApp) is a switch of its own: salary_slip.send */}
          <Gate k="salary_slip.send">
            <RowButton
              icon={Mail}
              busy={actions.isBusy(row, "email")}
              label={`Send the payslip of ${row.name} by email`}
              title={noSlip ?? undefined}
              disabled={!!noSlip || anyBusy}
              onClick={() => void actions.email(row)}
              className="border-purple-200 text-purple-700 hover:bg-purple-50"
              testId={`ps-row-${id}-email`}
            />
            <RowButton
              icon={MessageCircle}
              busy={actions.isBusy(row, "whatsapp")}
              label={`Send the payslip of ${row.name} on WhatsApp`}
              title={noSlip ?? undefined}
              disabled={!!noSlip || anyBusy}
              onClick={() => void actions.whatsapp(row)}
              className="border-emerald-200 text-emerald-700 hover:bg-emerald-50"
              testId={`ps-row-${id}-whatsapp`}
            />
          </Gate>
        </div>
      </div>
    </li>
  );
}

/**
 * The month's payslips, one line each: a checkbox (for one PDF of many), the employee, the paid days and the money
 * (Earned, Excess, Detection, Deductions, NET), the status and the row's actions; a footer with the totals of the list.
 */
export function PayslipList({
  kind = "staff",
  rows,
  totals,
  listedCount,
  selected,
  onPick,
  onOpen,
  actions,
  dimmed,
}: {
  /** Staff (paid days) or production (rate, shifts and days worked) columns. */
  kind?: PayrollKind;
  /** The rows of the page shown. */
  rows: readonly PayslipRow[];
  /** The figures of every payslip listed (all pages). */
  totals: PayslipTotals;
  listedCount: number;
  selected: ReadonlySet<number>;
  onPick: (payrollId: number) => void;
  onOpen: (payrollId: number) => void;
  actions: PayslipActions;
  dimmed?: boolean;
}) {
  return (
    <div
      className={cn(
        "clay-card overflow-hidden rounded-2xl border border-slate-100 transition-opacity",
        dimmed && "opacity-60",
      )}
    >
      {/* relative: the rows' screen-reader labels (absolute) stay inside this scroll box instead of widening the page */}
      <div className="relative overflow-x-auto">
        <div className={MIN_WIDTH[kind]}>
          <div
            className={cn(
              GRID[kind],
              "hidden border-b bg-gray-50 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-gray-500",
            )}
            aria-hidden="true"
          >
            <span />
            <span>Employee</span>
            {kind === "production" ? (
              <>
                <span className="text-right">Rate / shift</span>
                <span className="text-right">Shifts</span>
                <span className="text-right">Days worked</span>
              </>
            ) : (
              <span className="text-right">Paid days</span>
            )}
            <span className="text-right">Earned</span>
            <span className="text-right">Excess</span>
            <span className="text-right">Detection</span>
            <span className="text-right">Deductions</span>
            <span className="text-right">NET</span>
            <span>Status</span>
            <span className="text-right">Actions</span>
          </div>
          <ul className="divide-y divide-gray-100" aria-label="Payslips" data-testid="ps-list">
            {rows.map((row) => (
              <PayslipRowItem
                key={row.payrollId}
                row={row}
                kind={kind}
                picked={selected.has(row.payrollId)}
                onPick={() => onPick(row.payrollId)}
                onOpen={() => onOpen(row.payrollId)}
                actions={actions}
              />
            ))}
          </ul>
          <div
            className={cn(
              GRID[kind],
              "flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-gray-100 bg-gray-50/60 px-4 py-3 text-xs text-gray-500",
            )}
            data-testid="ps-footer"
          >
            <span className={cn("font-semibold text-gray-700", TOTAL_SPAN[kind])}>Total · {listedCount} listed</span>
            <span className="md:text-right">
              <span className="md:sr-only">Earned </span>
              <b className="tabular-nums text-gray-800">{inr(totals.earned)}</b>
            </span>
            <span className="md:text-right">
              <span className="md:sr-only">Excess </span>
              <b className="tabular-nums text-emerald-700">{signed(totals.excess, "+")}</b>
            </span>
            <span className="md:text-right">
              <span className="md:sr-only">Detection </span>
              <b className="tabular-nums text-rose-700">{signed(totals.detection, "−")}</b>
            </span>
            <span className="md:text-right">
              <span className="md:sr-only">Deductions </span>
              <b className="tabular-nums text-red-600">{inr(totals.deductions)}</b>
            </span>
            <span className="md:text-right">
              <span className="md:sr-only">NET </span>
              <b className="tabular-nums text-green-700" data-testid="ps-footer-net">
                {inr(totals.net)}
              </b>
            </span>
            <span className="hidden md:block" />
            <span className="hidden md:block" />
          </div>
        </div>
      </div>
    </div>
  );
}

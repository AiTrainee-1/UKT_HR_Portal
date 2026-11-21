import type { ReactNode } from "react";
import { ArrowRight, Download, FileSearch, Mail, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ACCENT_UI, accentOf } from "@/components/payroll/kit/accent-ui";
import { dateShort, inr2 } from "@/components/payroll/kit/format";
import { Avatar, BusyIcon, PayStatusChip, PaymentChip } from "@/components/payroll/kit/parts";
import type { PayrollKind, PayslipLine, PayslipRow } from "@/lib/api-client/custom-hooks";
import { Gate } from "@/lib/tab-access";
import { cn } from "@/lib/utils";
import { dayLines, dayValueText, lineAmountText } from "./logic";
import { noSlipReason, type PayslipActions } from "./use-payslip-actions";

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-semibold text-gray-800">{children}</dd>
    </div>
  );
}

function Lines({
  title,
  lines,
  totalLabel,
  total,
  empty,
  tone,
  testId,
}: {
  title: string;
  lines: readonly PayslipLine[];
  totalLabel: string;
  total: number;
  empty: string;
  tone: "earn" | "deduct";
  testId: string;
}) {
  return (
    <section className="overflow-hidden rounded-xl border bg-white" data-testid={testId} aria-label={title}>
      <h4 className="border-b bg-gray-50 px-3 py-2 text-xs font-bold uppercase tracking-wider text-gray-500">
        {title}
      </h4>
      {lines.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {lines.map((line, i) => (
            <li key={`${line.label}-${i}`} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 text-gray-700">{line.label}</span>
              <span
                className={cn(
                  "shrink-0 font-semibold tabular-nums",
                  line.amount < 0 || tone === "deduct" ? "text-red-600" : "text-gray-900",
                  line.amount === 0 && "text-gray-400",
                )}
              >
                {lineAmountText(line.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-baseline justify-between gap-3 border-t bg-gray-50/70 px-3 py-2 text-sm">
        <span className="font-bold text-gray-800">{totalLabel}</span>
        <span
          className={cn("font-black tabular-nums", tone === "deduct" && total > 0 ? "text-red-700" : "text-gray-900")}
          data-testid={`${testId}-total`}
        >
          {inr2(total)}
        </span>
      </div>
    </section>
  );
}

/**
 * One employee's payslip in full, as the PDF prints it: the employee, the days (staff) or shifts (production), the earning
 * and deduction lines exactly as the server gives them, the totals and the NET; with the PDF, email and WhatsApp actions.
 */
export function PayslipSheet({
  kind = "staff",
  row,
  periodLabel,
  actions,
  onClose,
  onOpenPayroll,
}: {
  kind?: PayrollKind;
  row: PayslipRow | null;
  periodLabel: string;
  actions: PayslipActions;
  onClose: () => void;
  /** Opens the payroll's details page; left out for a role without the Payroll tab. */
  onOpenPayroll?: (payrollId: number) => void;
}) {
  const noSlip = row ? noSlipReason(row) : null;
  const production = kind === "production";
  return (
    <Sheet open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg" data-testid="ps-sheet">
        {row && (
          <div className="space-y-4 pb-6 pt-1">
            <SheetHeader className="space-y-3 text-left">
              <div className="flex items-center gap-3 pr-6">
                <Avatar name={row.name} size={44} />
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-base">{row.name}</SheetTitle>
                  <SheetDescription className="truncate text-xs">
                    Payslip · {periodLabel} · <span className="font-mono">{row.code}</span>
                  </SheetDescription>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
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
            </SheetHeader>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-xl bg-gray-50 p-3" aria-label="Employee">
              <Detail label="Employee code">
                <span className="font-mono">{row.code}</span>
              </Detail>
              <Detail label="Department">{row.department ?? "—"}</Detail>
              <Detail label="Designation">{row.designation ?? "—"}</Detail>
              <Detail label="Unit">{row.unit ?? "—"}</Detail>
              <Detail label="Joined">{dateShort(row.joinDate)}</Detail>
              {production ? (
                <Detail label="Rate per shift">{row.salaryPerShift ? inr2(row.salaryPerShift) : "Not set"}</Detail>
              ) : (
                <Detail label="Monthly salary">{inr2(row.fixedSalary)}</Detail>
              )}
              <Detail label="Bank account">{row.bankAccountMasked ?? "Not on the profile"}</Detail>
              <Detail label="PF number">{row.pfNumber ?? "—"}</Detail>
              <Detail label="ESI number">{row.esiNumber ?? "—"}</Detail>
            </dl>

            <section aria-label={production ? "Shifts" : "Days"} data-testid="ps-sheet-days">
              <h4 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-gray-500">
                {production ? "Shifts and days" : "Days"}
              </h4>
              <dl className="grid grid-cols-3 gap-2">
                {dayLines(row, kind).map((d) => (
                  <div key={d.key} className="min-w-0 rounded-xl border bg-white px-2.5 py-2">
                    <dt className="truncate text-[11px] text-muted-foreground">{d.label}</dt>
                    <dd className="text-sm font-bold tabular-nums text-gray-900" data-testid={`ps-sheet-day-${d.key}`}>
                      {dayValueText(d.value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            <Lines
              title="Earnings"
              lines={row.earnings ?? []}
              totalLabel="Total earnings"
              total={row.eSalary}
              empty="No earning line."
              tone="earn"
              testId="ps-sheet-earnings"
            />
            <Lines
              title="Deductions"
              lines={row.deductions ?? []}
              totalLabel="Total deductions"
              total={row.totalDeduction}
              empty={production ? "No deduction this period." : "No deduction this month."}
              tone="deduct"
              testId="ps-sheet-deductions"
            />

            <div
              className="flex items-center justify-between gap-3 rounded-xl border border-green-200 bg-green-50 px-3.5 py-3"
              data-testid="ps-sheet-net"
            >
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-green-800">Net pay</p>
                <p className="text-[11px] text-green-700">Earnings less deductions</p>
              </div>
              <p className="text-2xl font-black tabular-nums text-green-700">{inr2(row.net)}</p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-9 gap-1.5"
                disabled={actions.busy !== null}
                onClick={() => void actions.preview(row)}
                data-testid="ps-sheet-preview"
              >
                <BusyIcon busy={actions.isBusy(row, "preview")} icon={FileSearch} /> Preview PDF
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-9 gap-1.5"
                disabled={actions.busy !== null}
                onClick={() => void actions.download(row)}
                data-testid="ps-sheet-download"
              >
                <BusyIcon busy={actions.isBusy(row, "download")} icon={Download} /> Download PDF
              </Button>
              <Gate k="salary_slip.send">
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 gap-1.5 border-purple-200 text-purple-700 hover:bg-purple-50"
                  disabled={actions.busy !== null || !!noSlip}
                  title={noSlip ?? `Send the payslip of ${row.name} by email`}
                  aria-label={`Send the payslip of ${row.name} by email`}
                  onClick={() => void actions.email(row)}
                  data-testid="ps-sheet-email"
                >
                  <BusyIcon busy={actions.isBusy(row, "email")} icon={Mail} /> Email
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                  disabled={actions.busy !== null || !!noSlip}
                  title={noSlip ?? `Send the payslip of ${row.name} on WhatsApp`}
                  aria-label={`Send the payslip of ${row.name} on WhatsApp`}
                  onClick={() => void actions.whatsapp(row)}
                  data-testid="ps-sheet-whatsapp"
                >
                  <BusyIcon busy={actions.isBusy(row, "whatsapp")} icon={MessageCircle} /> WhatsApp
                </Button>
              </Gate>
            </div>
            {onOpenPayroll && (
              <button
                type="button"
                onClick={() => onOpenPayroll(row.payrollId)}
                className={cn(
                  "inline-flex items-center gap-1 text-xs font-semibold hover:underline",
                  ACCENT_UI[accentOf(kind)].link,
                )}
                data-testid="ps-sheet-open-payroll"
              >
                Open the payroll details <ArrowRight size={12} />
              </button>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

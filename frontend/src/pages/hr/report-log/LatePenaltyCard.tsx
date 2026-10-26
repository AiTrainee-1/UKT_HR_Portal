import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAttendanceLateSummary, usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { EmptyState } from "../leave/parts";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const inr = (amount: string) =>
  `₹${parseFloat(amount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The Late-Penalty Breakdown of the Monthly Report (collapsed until opened): who is over the free late occurrences this month
 * and what payroll will deduct. Payroll-adjacent and monthly-only, so it is kept apart from the sheet's own Day / Week / Month
 * controls above it.
 */
export default function LatePenaltyCard() {
  const { data: settings } = usePayrollSettings();
  const freeAllowance = settings?.lateFreeAllowance ?? 3;
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const { data, isLoading } = useAttendanceLateSummary(month, year, open);
  // Late-in + early-out + excess-permission pooling (and so an "Excess Permissions" / "Pool Total" column) only exists on the
  // rewritten backend: the report says so itself by carrying the split (lateInCount), and that backend also reports
  // permissionMonthlyCap in Settings. On an older one the legacy columns are shown exactly as they were, since adding
  // permissionOverageCount to its totalLateCount would give a pool total it never computed.
  const pooled =
    (data?.employees ?? []).some((row) => row.lateInCount != null) || settings?.permissionMonthlyCap != null;

  const heads = [
    "Employee",
    "Department",
    ...(pooled ? ["Late-In + Early-Out", "Excess Permissions", "Pool Total"] : ["Total Late"]),
    `Free (${freeAllowance})`,
    "Billable",
    "Shift Deductions",
    "Salary Deduction",
  ];

  return (
    <Card className="overflow-hidden rounded-2xl" data-testid="late-penalty">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-amber-50/40"
        data-testid="late-penalty-toggle"
      >
        {open ? (
          <ChevronUp size={15} className="text-amber-600" />
        ) : (
          <ChevronDown size={15} className="text-amber-600" />
        )}
        <span className="text-sm font-bold text-amber-700">Late-Penalty Breakdown</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          who&apos;s over their {freeAllowance} free late occurrences this month
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t p-4">
          <div className="flex items-center gap-2">
            <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
              <SelectTrigger className="h-9 w-24" aria-label="Month">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTH_NAMES.map((m, i) => (
                  <SelectItem key={m} value={String(i + 1)}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="number"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="h-9 w-24"
              min={2020}
              max={2035}
              aria-label="Year"
            />
          </div>

          <div className="flex items-start gap-2 rounded-xl border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
            <span>
              <strong>Deduction Rule:</strong>{" "}
              {pooled
                ? "Morning Late-In days, Evening Early-Out days and approved Permissions beyond the monthly cap share one pool per employee."
                : "Late occurrences are counted per employee per month."}{" "}
              The first {freeAllowance} in a month are free; the rest are billable and priced by the slabs in Settings →
              Late Detection. These deductions are applied automatically when payroll is generated.
            </span>
          </div>

          <div className="overflow-hidden rounded-xl border bg-white">
            {isLoading ? (
              <div className="space-y-3 p-4" aria-busy="true">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : !data || data.employees.length === 0 ? (
              <EmptyState
                icon={AlertTriangle}
                tone="bg-amber-50 text-amber-600"
                title={`No late summary for ${MONTH_NAMES[month - 1]} ${year}`}
                text="Nobody has a late occurrence in this month."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    {heads.map((h) => (
                      <TableHead key={h} className="whitespace-nowrap text-xs uppercase">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.employees.map((row) => {
                    const overage = row.permissionOverageCount ?? 0;
                    const deduction = parseFloat(row.salaryDeductionAmount);
                    return (
                      <TableRow key={row.employeeId} className={cn(row.billableLateCount > 0 && "bg-red-50/30")}>
                        <TableCell>
                          <p className="text-sm font-semibold text-gray-900">{row.employeeName}</p>
                          <p className="font-mono text-[11px] text-gray-400">{row.employeeCode}</p>
                        </TableCell>
                        <TableCell className="text-sm text-gray-600">{row.department ?? "—"}</TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              "text-sm font-bold",
                              row.totalLateCount > 0 ? "text-amber-700" : "text-gray-400",
                            )}
                          >
                            {row.totalLateCount}
                          </span>
                        </TableCell>
                        {pooled && (
                          <>
                            <TableCell>
                              <span
                                className={cn("text-sm font-bold", overage > 0 ? "text-orange-700" : "text-gray-400")}
                              >
                                {overage}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm font-bold text-gray-800">
                              {row.totalLateCount + overage}
                            </TableCell>
                          </>
                        )}
                        <TableCell className="text-sm text-gray-600">
                          {row.permissionsUsed}/{freeAllowance}
                        </TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              "text-sm font-bold",
                              row.billableLateCount > 0 ? "text-red-700" : "text-green-600",
                            )}
                          >
                            {row.billableLateCount}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm font-bold text-gray-800">{row.shiftDeductions}</TableCell>
                        <TableCell>
                          <span className={cn("text-sm font-bold", deduction > 0 ? "text-red-700" : "text-green-600")}>
                            {inr(row.salaryDeductionAmount)}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

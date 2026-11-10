import { useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import {
  ArrowRight,
  BadgeCheck,
  CircleSlash,
  Download,
  FileSpreadsheet,
  FileText,
  Lock,
  PauseCircle,
  PlayCircle,
  UserPlus,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExportMenu, type ExportItem } from "@/components/payroll/kit/ExportMenu";
import { dateShort, inr, plural } from "@/components/payroll/kit/format";
import { BusyIcon, Chip, SkeletonRows } from "@/components/payroll/kit/parts";
import { openPayrollDetails } from "@/components/payroll/kit/url-state";
import { SkippedPanel, type SkippedItem } from "@/components/payroll/panels/skipped";
import { useToast } from "@/hooks/use-toast";
import {
  usePayrollMonthActions,
  type PayrollMonthSkipped,
  type PayrollMonthStatus,
  type PayrollRunItem,
} from "@/lib/api-client/custom-hooks";
import { MONTH_NAMES } from "@/components/payroll/BreakdownDrawer";
import { bankFileRows, exportPayrollToExcel } from "@/lib/payrollExcelExport";
import { downloadReportFile } from "@/lib/report-download";
import { cn } from "@/lib/utils";
import { STATEMENT_REPORT_ID } from "../logic";
import {
  SKIPPED_GROUP_LABEL,
  rowsOf,
  skippedStatementQuery,
  staffSkippedRows,
  type SkippedGroupKey,
  type StaffSkippedRow,
} from "./logic";

const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^HTTP \d+[^:]*:\s*/, "") : undefined);

/** The columns of a group's rows from md up: employee, department, why, NET, actions. */
const GRID = "md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,2fr)_7rem_minmax(0,1.4fr)]";

const GROUP_TONE: Record<SkippedGroupKey, string> = {
  not_generated: "border-red-200 bg-red-50 text-red-800",
  on_hold: "border-amber-200 bg-amber-50 text-amber-800",
  new_joiner: "border-sky-200 bg-sky-50 text-sky-800",
  paid_separately: "border-emerald-200 bg-emerald-50 text-emerald-800",
};

/** The one-person bank file of an employee paid on their own: the month's bank file format, with just them in it. */
export function downloadOnePersonBankFile(run: PayrollRunItem, monthLabel: string) {
  const name = (run.employeeName ?? run.employeeCode ?? "Employee").replace(/\s+/g, "_");
  return exportPayrollToExcel([run], `Staff ${name}`, monthLabel);
}

/**
 * Skipped Employees of a staff month (owner 2026-11-10), every employee who is NOT in the month's payroll, one group each:
 *   Not generated  payroll could not be worked out (no salary, no working days ...): the engine's own skip check
 *   On hold        HR held the salary: Unhold (before Payroll Done) or Release & pay (after)
 *   New joiners    joined inside the month: calculated, kept aside until "Add to payroll" (or Release & pay after the lock)
 *   Paid separately  released and paid on their own after the lock, each with a bank file of just them
 * Its own two exports are the main payroll's two (owner 2026-11-10): "Export" with the Salary Payroll Statement (Excel /
 * PDF: the same Report Center files, rows = only the skipped employees that have a payroll) and "Export bank file" (the
 * same bank format, only the held and new employees not paid yet). Nobody from the month's payroll is in either.
 */
export function StaffSkippedView({
  month,
  year,
  periodLabel,
  status,
  lists,
  listsLoading,
  notGenerated,
  totalChecked,
  checkLoading,
  checkError,
  onRecheck,
  rechecking,
}: {
  month: number;
  year: number;
  periodLabel: string;
  status: PayrollMonthStatus | undefined;
  lists: PayrollMonthSkipped | undefined;
  listsLoading?: boolean;
  notGenerated: SkippedItem[] | undefined;
  totalChecked?: number;
  checkLoading?: boolean;
  checkError?: unknown;
  onRecheck?: () => void;
  rechecking?: boolean;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const actions = usePayrollMonthActions();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [releasing, setReleasing] = useState<StaffSkippedRow | null>(null);
  const [released, setReleased] = useState<PayrollRunItem | null>(null);

  const rows = useMemo(
    () =>
      staffSkippedRows(
        notGenerated?.map((s) => ({
          employeeId: s.employeeId,
          employeeCode: s.employeeCode,
          name: s.name,
          reason: s.reason,
        })),
        lists,
      ),
    [notGenerated, lists],
  );
  const locked = !!status?.locked;
  const can = status?.can;
  // the skipped employees who have figures (the statement), and of those the ones not paid yet (the bank file)
  const withPayroll = rows.filter((r) => r.run).length;
  const toPay = useMemo(
    () => bankFileRows([...(lists?.onHold ?? []), ...(lists?.newJoiners ?? [])], "skipped"),
    [lists],
  );
  const notGeneratedCount = rowsOf(rows, "not_generated").length;
  const groups: { key: SkippedGroupKey; count: number }[] = (
    ["not_generated", "on_hold", "new_joiner", "paid_separately"] as SkippedGroupKey[]
  ).map((key) => ({ key, count: rowsOf(rows, key).length }));

  const run = async (row: StaffSkippedRow, what: "unhold" | "add") => {
    if (!row.payrollId) return;
    setBusyId(row.payrollId);
    try {
      if (what === "unhold") {
        await actions.hold.mutateAsync({ id: row.payrollId, hold: false });
        toast({
          title: `${row.name}'s salary is no longer on hold`,
          description: "Back in the payroll and the bank file.",
        });
      } else {
        await actions.addToPayroll.mutateAsync(row.payrollId);
        toast({ title: `${row.name} added to the ${periodLabel} payroll` });
      }
    } catch (err) {
      toast({ title: "That did not work", description: errorText(err), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const release = async () => {
    if (!releasing?.payrollId) return;
    try {
      const row = await actions.releaseAndPay.mutateAsync(releasing.payrollId);
      setReleased(row);
      toast({ title: `${releasing.name} released and paid`, description: "Download their bank file below." });
    } catch (err) {
      toast({ title: "Could not release and pay", description: errorText(err), variant: "destructive" });
      setReleasing(null);
    }
  };

  // the same two files as the main payroll's, for the skipped employees only (owner 2026-11-10)
  const statementItem = (format: "xlsx" | "pdf"): ExportItem => ({
    key: `statement-${format}`,
    label: `Salary Payroll Statement (${format === "pdf" ? "PDF" : "Excel"})`,
    hint: `The printed statement for ${periodLabel}, the skipped employees only (${plural(withPayroll, "employee")}): on hold, new joiners and those paid separately`,
    icon: format === "pdf" ? FileText : FileSpreadsheet,
    disabled: withPayroll === 0,
    run: async () => {
      await downloadReportFile({
        reportId: STATEMENT_REPORT_ID,
        title: `Salary Statement Skipped Employees ${periodLabel}`,
        format,
        query: skippedStatementQuery({ month, year }),
      });
    },
  });
  const exportItems: ExportItem[] = [statementItem("xlsx"), statementItem("pdf")];

  const actionCell = (row: StaffSkippedRow): ReactNode => {
    const busy = busyId === row.payrollId;
    const details = row.payrollId ? (
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-700 hover:underline"
        onClick={() => openPayrollDetails(navigate, "staff", row.payrollId!)}
        data-testid={`skipped-details-${row.payrollId}`}
      >
        Details <ArrowRight size={12} />
      </button>
    ) : null;
    const canRelease = locked && !!can?.releaseAndPay;
    return (
      <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
        {row.group === "on_hold" && !locked && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 border-amber-200 px-2 text-xs text-amber-800 hover:bg-amber-50"
            disabled={busy || !can?.hold}
            title={
              can?.hold ? "Take the hold off: back in the payroll and the bank file" : "Your login cannot change holds"
            }
            onClick={() => void run(row, "unhold")}
            data-testid={`skipped-unhold-${row.payrollId}`}
          >
            <BusyIcon busy={busy} icon={PlayCircle} size={12} /> Unhold
          </Button>
        )}
        {row.group === "new_joiner" && !locked && (
          <Button
            size="sm"
            className="h-7 gap-1 border-0 bg-none bg-sky-600 px-2 text-xs text-white hover:bg-sky-700"
            disabled={busy || !can?.addToPayroll}
            title="Put this new joiner in the month's payroll (they stay in it when the month is generated again)"
            onClick={() => void run(row, "add")}
            data-testid={`skipped-add-${row.payrollId}`}
          >
            <BusyIcon busy={busy} icon={UserPlus} size={12} /> Add to payroll
          </Button>
        )}
        {(row.group === "on_hold" || row.group === "new_joiner") && locked && (
          <Button
            size="sm"
            className="h-7 gap-1 border-0 bg-none bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-700"
            disabled={!canRelease}
            title={
              canRelease
                ? "Release this employee and mark them Paid on their own, with a bank file of just them"
                : "Only a whole-company login with payroll edit rights can release and pay"
            }
            onClick={() => {
              setReleased(null);
              setReleasing(row);
            }}
            data-testid={`skipped-release-${row.payrollId}`}
          >
            <Wallet size={12} /> Release &amp; pay
          </Button>
        )}
        {row.group === "paid_separately" && row.run && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 border-emerald-200 px-2 text-xs text-emerald-700 hover:bg-emerald-50"
            title={`Export a bank file of just ${row.name}`}
            onClick={() => void downloadOnePersonBankFile(row.run!, periodLabel)}
            data-testid={`skipped-bankfile-${row.payrollId}`}
          >
            <Download size={12} /> Bank file
          </Button>
        )}
        {details}
      </div>
    );
  };

  const groupTable = (key: Exclude<SkippedGroupKey, "not_generated">, icon: ReactNode, hint: string) => {
    const members = rowsOf(rows, key);
    if (members.length === 0 && key === "paid_separately") return null;
    return (
      <section
        className="clay-card rounded-2xl border border-slate-100"
        aria-label={SKIPPED_GROUP_LABEL[key]}
        data-testid={`skipped-group-${key}`}
      >
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("rounded-xl border p-1.5", GROUP_TONE[key])}>{icon}</span>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-gray-900">
                {SKIPPED_GROUP_LABEL[key]}{" "}
                <span className="text-muted-foreground" data-testid={`skipped-group-${key}-count`}>
                  ({members.length})
                </span>
              </h3>
              <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
          </div>
        </header>
        {listsLoading ? (
          <div className="p-3">
            <SkeletonRows rows={2} />
          </div>
        ) : members.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground" data-testid={`skipped-group-${key}-empty`}>
            Nobody.
          </p>
        ) : (
          // one list for every screen: a row of columns from md up, a small card (name and NET, the reason, then the
          // actions) on a phone, so the buttons are never off to the side of a table that has to be scrolled
          <div className="text-sm">
            <div
              className={cn(
                "hidden bg-gray-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500 md:grid",
                GRID,
              )}
              aria-hidden="true"
            >
              <span>Employee</span>
              <span>Department</span>
              <span>Why</span>
              <span className="text-right">NET</span>
              <span className="text-right">Action</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {members.map((row) => (
                <li
                  key={row.payrollId ?? row.employeeId}
                  className={cn(
                    "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 px-3 py-2.5 md:items-center",
                    GRID,
                  )}
                  data-testid={`skipped-${key}-row-${row.employeeCode}`}
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900">{row.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {row.employeeCode || "—"}
                      <span className="font-sans md:hidden">{row.department ? ` · ${row.department}` : ""}</span>
                    </p>
                  </div>
                  <span className="hidden text-gray-700 md:block">{row.department || "—"}</span>
                  <p className="col-span-2 text-xs text-gray-700 md:col-span-1">
                    {row.reason}
                    {row.run?.status === "paid" && key !== "paid_separately" && (
                      <span className="ml-1.5">
                        <Chip tone="success">Cleared</Chip>
                      </span>
                    )}
                  </p>
                  <span className="col-start-2 row-start-1 text-right font-semibold tabular-nums md:col-start-auto md:row-start-auto">
                    {inr(row.net)}
                  </span>
                  <div className="col-span-2 md:col-span-1">{actionCell(row)}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="space-y-4" data-testid="staff-skipped-view">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-100 bg-white/80 p-3">
        <div className="flex flex-wrap items-center gap-1.5" data-testid="skipped-group-chips">
          {groups.map((g) => (
            <span
              key={g.key}
              className={cn("rounded-full border px-2.5 py-1 text-xs font-semibold", GROUP_TONE[g.key])}
              data-testid={`skipped-chip-${g.key}`}
            >
              {SKIPPED_GROUP_LABEL[g.key]}: {g.count}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu
            items={exportItems}
            label="Export"
            heading={`Export ${periodLabel}: Skipped Employees only`}
            testId="skipped-section-export"
          />
          <Button
            variant="outline"
            className="h-9 gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
            disabled={toPay.length === 0}
            title={
              toPay.length === 0
                ? "Nobody on hold or new joiner is waiting to be paid"
                : `The bank-transfer file of the ${plural(toPay.length, "held or new employee")} not paid yet. Paying from it does not mark them Paid: use Release & pay after Payroll Done for that.`
            }
            onClick={() =>
              void exportPayrollToExcel(toPay, "Staff Skipped", `${MONTH_NAMES[month - 1]}_${year}`, "skipped")
            }
            data-testid="skipped-section-bank"
          >
            <Download size={14} /> Export bank file
          </Button>
        </div>
        {notGeneratedCount > 0 && (
          <p className="w-full text-xs text-muted-foreground" data-testid="skipped-section-export-note">
            {notGeneratedCount === 1
              ? "1 employee with no payroll yet (Not generated) is not in these files: there are no figures for them."
              : `${notGeneratedCount} employees with no payroll yet (Not generated) are not in these files: there are no figures for them.`}
          </p>
        )}
      </div>

      {locked && (
        <p
          className="flex items-start gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900"
          data-testid="skipped-locked-note"
        >
          <Lock size={13} className="mt-0.5 shrink-0" />
          {periodLabel} is finalized: nothing can be generated, held or added any more. An employee on hold or a new
          joiner can still be paid on their own with Release &amp; pay (they get a bank file of just them).
        </p>
      )}

      {groupTable(
        "on_hold",
        <PauseCircle size={15} />,
        "On the Salary Statement with HOLD in Remarks; never in the bank file until released.",
      )}
      {groupTable(
        "new_joiner",
        <UserPlus size={15} />,
        "Joined during the month: their payroll is worked out but kept out of the records, totals, bank file and statement until added.",
      )}
      {groupTable(
        "paid_separately",
        <BadgeCheck size={15} />,
        "Released and paid on their own after the month was finalized.",
      )}

      <section aria-label="Not generated" data-testid="skipped-group-not_generated" className="space-y-2">
        <h3 className="flex items-center gap-2 px-1 text-sm font-bold text-gray-900">
          <span className={cn("rounded-xl border p-1.5", GROUP_TONE.not_generated)}>
            <CircleSlash size={15} />
          </span>
          Not generated{" "}
          <span className="text-muted-foreground" data-testid="skipped-group-not_generated-count">
            ({rowsOf(rows, "not_generated").length})
          </span>
        </h3>
        <SkippedPanel
          skipped={notGenerated}
          totalChecked={totalChecked}
          loading={checkLoading}
          error={checkError}
          onRecheck={onRecheck}
          rechecking={rechecking}
          periodLabel={periodLabel}
          kind="staff"
          accent="indigo"
          hideExport
        />
      </section>

      <Dialog
        open={!!releasing}
        onOpenChange={(next) => {
          if (!next) {
            setReleasing(null);
            setReleased(null);
          }
        }}
      >
        <DialogContent className="max-w-md" data-testid="skipped-release-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wallet size={16} className="text-emerald-600" /> Release &amp; pay {releasing?.name}
            </DialogTitle>
            <DialogDescription>
              {released
                ? `${releasing?.name} is marked Paid (${dateShort(released.paymentPaidAt?.slice(0, 10))}) and was told on their phone.`
                : `${releasing?.name} leaves ${releasing?.group === "on_hold" ? "On hold" : "New joiners"}, is marked Paid today for ${periodLabel} (NET ${inr(releasing?.net)}) and gets a phone notification. Nothing else in the finalized month changes.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            {released ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    setReleasing(null);
                    setReleased(null);
                  }}
                >
                  Close
                </Button>
                <Button
                  className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
                  title={`Export a bank file of just ${released.employeeName ?? "this employee"}`}
                  onClick={() => void downloadOnePersonBankFile(released, periodLabel)}
                  data-testid="skipped-release-bankfile"
                >
                  <Download size={14} /> Bank file
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setReleasing(null)} data-testid="skipped-release-cancel">
                  Cancel
                </Button>
                <Button
                  className="bg-emerald-600 font-bold text-white hover:bg-emerald-700"
                  disabled={actions.releaseAndPay.isPending}
                  onClick={() => void release()}
                  data-testid="skipped-release-yes"
                >
                  <BusyIcon busy={actions.releaseAndPay.isPending} icon={Wallet} /> Yes, release and pay
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

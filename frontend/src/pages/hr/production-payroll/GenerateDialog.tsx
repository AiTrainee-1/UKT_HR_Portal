import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Cog,
  Loader2,
  Lock,
  Play,
  ScanSearch,
  UsersRound,
  Wallet,
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { dateShort, plural } from "@/components/payroll/kit/format";
import { Chip } from "@/components/payroll/kit/parts";
import { StatutoryRulesChip, StatutoryWhoNote } from "@/components/payroll/kit/StatutoryNote";
import { usePfEsiRulesSlice } from "@/components/payroll/kit/statutory-rules";
import { usePayrollGeneration } from "@/contexts/PayrollGenerationContext";
import { useToast } from "@/hooks/use-toast";
import {
  PAY_CYCLE_INFO,
  usePayrollSettings,
  useProductionSkipCheck,
  type CyclePeriod,
  type PayCycle,
  type ProductionPeriodStatus,
} from "@/lib/api-client/custom-hooks";
import { normalizeWeekStart, weekRunsText } from "../settings/production-payroll/cycles";
import { dayAfter } from "./CycleNotices";
import { coverageText, partialReady } from "./coverage";
import { formatPeriod, skippedFromRoster } from "./logic";
import { draftGroups, moveRoute } from "./period-workflow";

/**
 * "Generate payroll" for the whole roster of one cycle and one period: says what the run will do and which rules it will
 * use, who it will compute and who it leaves alone, and can check beforehand who would be skipped. It can always be
 * pressed again (owner 2026-11-16): the payslips already made for the period are worked out again with the latest
 * attendance, pay cycle and rates (ticked by default; untick to generate only those without one), a salary already
 * marked Paid is never changed, one marked Cleared stays Cleared (as on Staff Payroll), and a finalized period refuses.
 * ("Generate again" on the Employees tab still recomputes one person.) An employee who moved from another pay cycle is paid only the days no other payroll paid, and the dialog
 * lists them with exactly which days. Workers who moved here from another cycle (previous -> new cycle, the days they
 * are paid for) and workers who joined during the period are named too: they are calculated, then wait in New Joiners
 * until HR adds them (owner 2026-11-16). A period can be generated only once it has ended, and never once it is
 * finalized (Payroll Done). The run itself is the same fire-and-forget request as before (PayrollGenerationContext owns
 * it, so it keeps going after this dialog closes).
 */
export function GenerateDialog({
  cycle,
  period,
  status,
  onClose,
  onStarted,
}: {
  cycle: PayCycle;
  period: CyclePeriod;
  status: ProductionPeriodStatus;
  onClose: () => void;
  /** Called as the run starts, so the page keeps showing this period while it is generated. */
  onStarted: (period: CyclePeriod) => void;
}) {
  const { toast } = useToast();
  const { triggerGenerateProduction, isGenerating } = usePayrollGeneration();
  const settings = usePayrollSettings();
  const statutoryRules = usePfEsiRulesSlice();
  const [checkSkips, setCheckSkips] = useState(false);
  // The real engine, run on every employee inside a transaction that is always rolled back: slow, so only on request.
  const skip = useProductionSkipCheck(checkSkips ? { cycle, ...period } : null);
  const info = PAY_CYCLE_INFO[cycle];
  const ps = settings.data;
  const own = ps?.prodCycles?.[cycle];
  const ready = status.counts.ready;
  const blocked = status.counts.blocked;
  // Payslips already made for the period can be worked out again with the latest attendance, pay cycle and rates
  // (owner 2026-11-16: "I should be able to click Generate Payroll again", also just to check the figures). Only the
  // workers on this cycle now; never a salary already marked Paid; one marked Cleared stays Cleared.
  const withPayslip = useMemo(() => status.employees.filter((e) => e.payroll), [status.employees]);
  const regenerable = useMemo(() => withPayslip.filter((e) => e.payroll?.paymentStatus !== "paid"), [withPayslip]);
  const paidNotAgain = withPayslip.length - regenerable.length;
  // regenerating replaces what HR typed in with Adjust (a bonus, extra deductions) with the computed figures; a bonus
  // is the sign of it the list carries (the engine writes a note on every payslip, so a note is not one)
  const handAdjusted = regenerable.filter((e) => (e.payroll?.bonus ?? 0) > 0).length;
  const [again, setAgain] = useState(true);
  // Workers whose days of this period are in DRAFT payslips of other periods (owner 2026-11-16: a Generated payslip is a
  // draft): the old week-start grid, or their old cycle after a move. Never a block: with "Replace the overlapping draft
  // payslips" (ticked by default) those drafts are deleted first and the days are paid once, here.
  const [replace, setReplace] = useState(true);
  const withDrafts = useMemo(
    () => status.employees.filter((e) => (e.drafts?.length ?? 0) > 0 && !e.blockedReason),
    [status.employees],
  );
  const groups = useMemo(() => draftGroups(withDrafts), [withDrafts]);
  const draftsNew = withDrafts.filter((e) => !e.payroll).length;
  const draftsAgain = withDrafts.filter((e) => e.payroll && e.payroll.paymentStatus !== "paid").length;
  // without "replace" nobody with drafts in the way is worked out (the server refuses them, naming the drafts)
  const fresh = replace ? ready : ready - draftsNew;
  const regenerate = again && regenerable.length > 0;
  const againCount = regenerate ? regenerable.length - (replace ? 0 : draftsAgain) : 0;
  const replacing = replace ? draftsNew + (regenerate ? draftsAgain : 0) : 0;
  const total = fresh + againCount;
  const blockedPeople = useMemo(() => skippedFromRoster(status.employees), [status.employees]);
  const partPeople = useMemo(() => partialReady(status.employees), [status.employees]);
  const clearedCount = status.counts.paid;
  const slabs = (own?.lateSlabs ?? ps?.prodLateDeductionSlabs ?? []).length;
  const locked = !!status.locked;
  // who arrives through New Joiners: moved here from another cycle, or joined during the period (not yet generated)
  const movedIn = useMemo(
    () => status.employees.filter((e) => e.movedIn && !e.payroll && !e.blockedReason),
    [status.employees],
  );
  const joiners = useMemo(
    () => status.employees.filter((e) => e.joinedOn && !e.movedIn && !e.payroll && !e.blockedReason),
    [status.employees],
  );

  const handleGenerate = () => {
    if (isGenerating) {
      toast({
        title: "A payroll run is already in progress",
        description: "Wait for it to finish before starting another.",
      });
      return;
    }
    // Fire-and-forget: the PayrollGenerationContext owns the request and the progress polling from here, so generation
    // keeps running and stays visible through the pipeline banner even after this dialog (or the page) unmounts.
    onStarted(period);
    void triggerGenerateProduction({
      cycle,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      // the whole roster: new payslips for whoever has none, and (when ticked) the existing ones worked out again
      ...(regenerate ? { regenerate: true } : {}),
      // and the draft payslips of other periods that share these days are replaced (when ticked)
      ...(replace && withDrafts.length > 0 ? { replaceDrafts: true } : {}),
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      {/* Never taller than the window (owner 2026-11-20): title and buttons stay in view, the middle scrolls. */}
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-1.5rem)] max-w-lg flex-col gap-4 sm:w-full"
        data-testid="pcp-generate-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play size={16} className="text-amber-600" /> Generate {info.label} Payroll
          </DialogTitle>
          <DialogDescription>
            Production payroll of the {info.label} cycle for the period below, worked out from attendance. Payslips
            already made can be worked out again with the latest changes; a salary already paid is never changed, and no
            day is ever paid twice.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-6 min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-1" data-testid="pcp-generate-body">
          <div className="rounded-xl border border-amber-100 bg-amber-50/60 p-3">
            <p className="text-xs font-medium text-amber-700">{info.calculation}</p>
            <p className="text-lg font-black text-amber-900" data-testid="pcp-generate-period">
              {formatPeriod(period)}
            </p>
            <p className="mt-1 text-xs font-semibold text-amber-800" data-testid="pcp-generate-when">
              {locked
                ? "This period is finalized (Payroll Done): it can no longer be generated."
                : status.periodEnded
                  ? "This period has ended - ready to generate."
                  : `This period has not ended yet - it can be generated from ${dayAfter(period.periodEnd)}, once every shift of its last day is complete.`}
            </p>
          </div>

          <div
            className="space-y-1.5 rounded-xl border bg-white p-3 text-xs text-gray-700"
            data-testid="pcp-generate-who"
          >
            <p>
              <strong data-testid="pcp-generate-ready">{plural(fresh, "employee", "employees")}</strong> on the{" "}
              {info.label} cycle {fresh === 1 ? "has" : "have"} no payslip for this period yet and will be computed.
            </p>
            {withDrafts.length > 0 && (
              <div
                className="space-y-1.5 rounded-lg border border-violet-200 bg-violet-50/60 p-2.5"
                data-testid="pcp-generate-drafts"
              >
                <label className="flex cursor-pointer items-start gap-2 font-semibold text-violet-950">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-violet-600"
                    checked={replace}
                    onChange={(e) => setReplace(e.target.checked)}
                    data-testid="pcp-generate-replace"
                  />
                  <span>
                    Replace the overlapping draft payslips:{" "}
                    <span data-testid="pcp-generate-drafts-count">
                      {plural(withDrafts.length, "worker", "workers")}
                    </span>{" "}
                    will be worked out for this period, replacing their draft payslips for
                  </span>
                </label>
                <ul className="ml-6 list-disc space-y-0.5 text-[11.5px] text-violet-900/90">
                  {groups.map((g) => (
                    <li key={g.key} data-testid={`pcp-generate-draft-group-${g.periodStart}`}>
                      {g.periodLabel} ({g.label}): {plural(g.workers, "worker")}
                      {g.cleared > 0 ? `, ${g.cleared} marked Cleared` : ""}
                    </li>
                  ))}
                </ul>
                <p className="ml-6 text-[11px] text-violet-900/80">
                  {replace
                    ? "Draft payslips are only Generated (not finalized, not paid): they are deleted first and these days are paid once, here. Days of a replaced draft outside this period wait until their own period is generated. A Cleared mark goes with the draft. Finalized or paid payslips are never replaced."
                    : "Not ticked: these workers are left out of this run and keep their draft payslips."}
                </p>
              </div>
            )}
            {withPayslip.length > 0 && (
              <div
                className="space-y-1.5 rounded-lg border border-indigo-100 bg-indigo-50/50 p-2.5"
                data-testid="pcp-generate-existing"
              >
                {regenerable.length > 0 ? (
                  <label className="flex cursor-pointer items-start gap-2 font-semibold text-indigo-950">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
                      checked={again}
                      onChange={(e) => setAgain(e.target.checked)}
                      data-testid="pcp-generate-again"
                    />
                    <span>
                      Also work out again the{" "}
                      <span data-testid="pcp-generate-again-count">
                        {plural(regenerable.length, "payslip", "payslips")}
                      </span>{" "}
                      already made for this period, with the latest attendance, pay cycle and rates
                    </span>
                  </label>
                ) : (
                  <p className="font-semibold text-indigo-950">Every payslip of this period is already paid.</p>
                )}
                <ul className="ml-6 list-disc space-y-0.5 text-[11.5px] text-indigo-900/80">
                  {clearedCount > 0 && (
                    <li>
                      {plural(clearedCount, "payslip is", "payslips are")} marked Cleared: only the figures are worked
                      out again, {clearedCount === 1 ? "it stays" : "they stay"} Cleared.
                    </li>
                  )}
                  {paidNotAgain > 0 && (
                    <li data-testid="pcp-generate-paid-left">
                      {plural(paidNotAgain, "salary is", "salaries are")} already marked Paid and{" "}
                      {paidNotAgain === 1 ? "is" : "are"} never changed.
                    </li>
                  )}
                  {regenerate && handAdjusted > 0 && (
                    <li className="font-semibold text-amber-800" data-testid="pcp-generate-adjusted">
                      {plural(handAdjusted, "payslip has", "payslips have")} a bonus added with Adjust: working{" "}
                      {handAdjusted === 1 ? "it" : "them"} out again replaces the bonus and any deductions typed in by
                      hand with the computed figures.
                    </li>
                  )}
                  <li>
                    Workers who moved to another pay cycle after this period was generated keep their payslip here;
                    their days are not paid again on the new cycle.
                  </li>
                </ul>
              </div>
            )}
            {partPeople.length > 0 && (
              <div className="text-sky-900" data-testid="pcp-generate-partial">
                <p className="flex items-start gap-1.5">
                  <CalendarClock size={13} className="mt-0.5 shrink-0 text-sky-600" />
                  <span>
                    {plural(partPeople.length, "employee changed", "employees changed")} pay cycle: only the days no
                    other payroll paid are computed (catch-up days are added where no cycle paid them).
                  </span>
                </p>
                <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto pl-5 text-[11px] text-gray-600">
                  {partPeople.map((p) => (
                    <li key={p.employeeId} data-testid={`pcp-generate-partial-${p.employeeCode}`}>
                      <span className="font-semibold text-gray-800">{p.name}</span>{" "}
                      <span className="font-mono text-gray-400">{p.employeeCode}</span> - {coverageText(p.coverage)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {movedIn.length > 0 && (
              <div className="text-violet-900" data-testid="pcp-generate-moved">
                <p className="flex items-start gap-1.5">
                  <UsersRound size={13} className="mt-0.5 shrink-0 text-violet-600" />
                  <span>
                    {plural(movedIn.length, "worker moved", "workers moved")} here from another pay cycle: only the
                    eligible days are paid (days already paid on the previous cycle are left out), and they wait in New
                    Joiners until you add them.
                  </span>
                </p>
                <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto pl-5 text-[11px] text-gray-600">
                  {movedIn.map((p) => (
                    <li key={p.employeeId} data-testid={`pcp-generate-moved-${p.employeeCode}`}>
                      <span className="font-semibold text-gray-800">{p.name}</span>{" "}
                      <span className="font-mono text-gray-400">{p.employeeCode}</span> - {moveRoute(p.movedIn!)} on{" "}
                      {dateShort(p.movedIn!.changedOn)}:{" "}
                      {p.coverage
                        ? `${plural(p.coverage.paidDays, "eligible day")}${p.coverage.alreadyPaid.length ? ` (${coverageText(p.coverage)})` : ""}`
                        : "the days no payroll paid"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {joiners.length > 0 && (
              <p className="flex items-start gap-1.5 text-sky-900" data-testid="pcp-generate-joiners">
                <UsersRound size={13} className="mt-0.5 shrink-0 text-sky-600" />
                <span>
                  {plural(joiners.length, "worker", "workers")} joined during this period (
                  {joiners
                    .slice(0, 4)
                    .map((p) => p.name)
                    .join(", ")}
                  {joiners.length > 4 ? ` and ${joiners.length - 4} more` : ""}): calculated as usual, then kept in New
                  Joiners until you add them.
                </span>
              </p>
            )}
            {blocked > 0 && (
              <div className="text-amber-800">
                <p className="flex items-start gap-1.5">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" />
                  <span>
                    {plural(blocked, "employee", "employees")} cannot be generated (no salary per shift, or every day of
                    the period is already paid on another payslip): see Skipped Employees.
                  </span>
                </p>
                <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto pl-5 text-[11px] text-gray-600">
                  {blockedPeople.map((p) => (
                    <li key={p.employeeId}>
                      <span className="font-semibold text-gray-800">{p.name}</span>{" "}
                      <span className="font-mono text-gray-400">{p.employeeCode}</span> - {p.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <ul className="space-y-1.5 text-xs text-gray-600">
            <li className="flex items-start gap-2">
              <ClipboardList size={13} className="mt-0.5 shrink-0 text-amber-500" />
              Pay = total shifts earned × salary per shift, worked out from each employee's punches in the period.
            </li>
            <li className="flex items-start gap-2">
              <Cog size={13} className="mt-0.5 shrink-0 text-amber-500" />
              Prices late days with the late rules of the {info.label} cycle.
            </li>
            <li className="flex items-start gap-2">
              <Wallet size={13} className="mt-0.5 shrink-0 text-amber-500" />
              Recovers the advance repayments that fall due in the month the period ends.
            </li>
          </ul>

          <div className="rounded-xl border bg-white p-3" data-testid="pcp-generate-rules">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-gray-700">Rules this run will use</p>
              <Link
                href="/hr/settings?tab=production_payroll"
                className="text-xs font-semibold text-amber-700 hover:underline"
              >
                Review in Settings
              </Link>
            </div>
            {settings.isLoading || !ps ? (
              <div className="mt-2 flex gap-2" data-testid="pcp-generate-rules-loading">
                <Skeleton className="h-5 w-32 rounded-full" />
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-5 w-28 rounded-full" />
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Chip tone="info">
                  {info.days} days, weeks run {weekRunsText(normalizeWeekStart(own?.weekStart))}
                </Chip>
                <Chip tone="info">
                  {ps.prodAttendanceMode === "strict" ? "Strict attendance" : "Simple attendance"}
                </Chip>
                {ps.prodLateDetectionEnabled ? (
                  <Chip tone="warning">
                    Late: {own?.lateFreeAllowance ?? ps.prodLateFreeAllowance ?? 0} free, {plural(slabs, "slab")}
                  </Chip>
                ) : (
                  <Chip tone="neutral">Late detection off</Chip>
                )}
                <StatutoryRulesChip kind="production" rules={statutoryRules} testId="pcp-generate-statutory" />
              </div>
            )}
            <StatutoryWhoNote
              kind="production"
              rules={statutoryRules}
              linkClassName="text-amber-700"
              className="mt-3 border-t pt-3"
              testId="pcp-generate-statutory-note"
            />
          </div>

          <div className="rounded-xl border border-dashed border-gray-200 p-3">
            {!checkSkips ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-gray-600">
                  Run the real calculation on everyone, without saving anything, to see who would be skipped.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 gap-1.5"
                  onClick={() => setCheckSkips(true)}
                  data-testid="pcp-generate-check"
                >
                  <ScanSearch size={13} /> Check who would be skipped
                </Button>
              </div>
            ) : skip.isLoading || skip.isFetching ? (
              <div className="flex items-center gap-2 text-xs text-gray-600" role="status">
                <Loader2 size={14} className="animate-spin text-amber-600" />
                Checking every employee on the {info.label} cycle for {formatPeriod(period)}…
              </div>
            ) : skip.isError || !skip.data ? (
              <p className="text-xs text-red-700">The check could not be completed. Try again.</p>
            ) : skip.data.skippedCount === 0 ? (
              <p
                className="flex items-center gap-2 text-xs font-semibold text-green-700"
                data-testid="pcp-generate-skips-none"
              >
                <CheckCircle2 size={14} /> Nobody would be skipped: all {skip.data.totalChecked} employees can be paid
                {skip.data.alreadyGenerated > 0 ? ` (${skip.data.alreadyGenerated} already have payroll)` : ""}.
              </p>
            ) : (
              <div className="space-y-1.5" data-testid="pcp-generate-skips">
                <p className="text-xs font-semibold text-amber-800">
                  {skip.data.skippedCount} of {skip.data.totalChecked} would be skipped
                  {skip.data.alreadyGenerated > 0
                    ? `; ${skip.data.alreadyGenerated} already have payroll and are left alone`
                    : ""}
                  :
                </p>
                <ul className="max-h-28 space-y-1 overflow-y-auto text-xs text-gray-600">
                  {skip.data.skipped.map((p) => (
                    <li key={p.employeeId}>
                      <span className="font-semibold text-gray-800">{p.name}</span>{" "}
                      <span className="font-mono text-gray-400">{p.employeeCode}</span> - {p.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {locked && (
            <p className="mr-auto flex items-center gap-1.5 text-xs font-semibold text-violet-700">
              <Lock size={12} /> Finalized: locked
            </p>
          )}
          <Button
            onClick={handleGenerate}
            disabled={isGenerating || locked || !status.periodEnded || total === 0}
            title={
              replacing > 0 ? `${plural(replacing, "worker")}: draft payslips of other periods are replaced` : undefined
            }
            className="bg-amber-600 font-bold text-white hover:bg-amber-700"
            data-testid="pcp-generate-confirm"
          >
            {isGenerating ? (
              "A run is already in progress…"
            ) : (
              <>
                <Play size={13} className="mr-1.5" />
                {confirmLabel(fresh, againCount, replacing)}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The confirm button: what the run will do, in a few words (`replacing`: workers whose drafts are replaced). */
export function confirmLabel(fresh: number, again: number, replacing = 0): string {
  const tail = replacing > 0 ? ` · ${replacing} replace drafts` : "";
  if (fresh > 0 && again > 0) return `Generate ${fresh} · work out ${again} again${tail}`;
  if (again > 0) return `Work out ${plural(again, "payslip", "payslips")} again${tail}`;
  return `Generate for ${plural(fresh, "employee", "employees")}${tail}`;
}

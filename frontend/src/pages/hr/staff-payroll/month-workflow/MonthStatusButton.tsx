import { useEffect, useState } from "react";
import { AlertTriangle, BadgeCheck, CheckCheck, Hourglass, Loader2, Lock, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { dateTime, inr, plural } from "@/components/payroll/kit/format";
import { useToast } from "@/hooks/use-toast";
import { usePayrollMonthActions, type PayrollMonthStatus } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import {
  FINALIZE_QUESTION,
  MARK_PAID_QUESTION,
  WHOLE_COMPANY_ONLY,
  daysAfterFinalizing,
  elapsedLabel,
  finalizeWarnings,
  monthButton,
} from "./logic";
import { MonthTimeline } from "./MonthTimeline";

/** The current time, ticking every `everyMs` while `on` (the Payment Pending timer). */
export function useNow(on: boolean, everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!on) return;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), everyMs);
    return () => window.clearInterval(timer);
  }, [on, everyMs]);
  return now;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^HTTP \d+[^:]*:\s*/, "") : undefined);

/**
 * The Staff Payroll month's own button, where "Legacy Session Config" used to be:
 *   Payroll Done     -> asks the owner's question (Yes / Cancel) and locks the month for good;
 *   Payment Pending  -> amber, with a live timer since finalizing; opens the timeline and Mark as Paid;
 *   Paid             -> green, with the paid date and how many days after finalizing; opens the timeline.
 * A unit login or a role without payroll edit rights sees the same states but cannot press Payroll Done / Mark as Paid.
 */
export function MonthStatusButton({ status, loading }: { status: PayrollMonthStatus | undefined; loading?: boolean }) {
  const { toast } = useToast();
  const { finalize, markPaid } = usePayrollMonthActions();
  const [open, setOpen] = useState<"finalize" | "payment" | null>(null);
  const [confirmPaid, setConfirmPaid] = useState(false);
  const now = useNow(status?.state === "finalized");
  const button = monthButton(status, now);

  if (!status || !button) {
    return (
      <Button variant="outline" className="h-9 gap-2" disabled data-testid="month-status-loading">
        {loading ? <Loader2 size={14} className="animate-spin" /> : <CheckCheck size={14} />} Payroll Done
      </Button>
    );
  }

  const doFinalize = async () => {
    try {
      await finalize.mutateAsync({ month: status.month, year: status.year });
      toast({
        title: `${status.label} payroll is finalized`,
        description: "It is locked for good. The button now shows how long payment has been pending.",
      });
      setOpen(null);
    } catch (err) {
      toast({ title: "Could not finalize the payroll", description: errorText(err), variant: "destructive" });
    }
  };

  const doMarkPaid = async () => {
    try {
      const result = await markPaid.mutateAsync({ month: status.month, year: status.year });
      toast({
        title: `${status.label} salaries marked as Paid`,
        description: `${plural(result.employeesPaid ?? 0, "employee")} marked Paid and told on their phone.`,
      });
      setConfirmPaid(false);
      setOpen(null);
    } catch (err) {
      toast({ title: "Could not mark the month as paid", description: errorText(err), variant: "destructive" });
    }
  };

  const close = () => {
    setOpen(null);
    setConfirmPaid(false);
  };

  return (
    <>
      {button.kind === "done" ? (
        <span title={button.blockedReason || "Finalize this month's payroll: it is then locked for good"}>
          <Button
            variant="outline"
            className="h-9 gap-2 border-violet-200 font-semibold text-violet-700 hover:bg-violet-50"
            disabled={!!button.blockedReason}
            onClick={() => setOpen("finalize")}
            data-testid="month-status-button"
            data-state="open"
          >
            <CheckCheck size={14} /> Payroll Done
          </Button>
        </span>
      ) : (
        <span {...{ [VIEW_SAFE_ATTR]: "" }}>
          <Button
            variant="outline"
            className={cn(
              "h-auto min-h-9 gap-2 py-1 text-left font-semibold",
              button.kind === "pending"
                ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                : "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100",
            )}
            onClick={() => setOpen("payment")}
            title={button.kind === "pending" ? "Payment pending since the month was finalized" : "This month is paid"}
            data-testid="month-status-button"
            data-state={button.kind === "pending" ? "finalized" : "paid"}
          >
            {button.kind === "pending" ? <Hourglass size={14} /> : <BadgeCheck size={15} />}
            <span className="flex flex-col leading-tight">
              <span>{button.label}</span>
              <span className="text-[11px] font-medium tabular-nums opacity-90" data-testid="month-status-detail">
                {button.detail}
              </span>
            </span>
          </Button>
        </span>
      )}

      {/* Payroll Done: the owner's question, what is still open, Yes / Cancel */}
      <Dialog open={open === "finalize"} onOpenChange={(next) => !next && close()}>
        <DialogContent className="max-w-lg" data-testid="month-finalize-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock size={16} className="text-violet-600" /> Payroll Done: {status.label}
            </DialogTitle>
            <DialogDescription className="text-sm font-medium text-gray-800" data-testid="month-finalize-question">
              {FINALIZE_QUESTION}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-gray-600" data-testid="month-finalize-summary">
              {plural(status.counts.inPayroll, "employee")} in the payroll
              {status.counts.onHold ? `, ${status.counts.onHold} on hold` : ""}
              {status.counts.newJoiners ? `, ${plural(status.counts.newJoiners, "new joiner")} not added` : ""}. After
              this nothing in {status.label} can be generated, recomputed, adjusted, cleared or held again; only a held
              or new employee can still be released and paid one by one.
            </p>
            {finalizeWarnings(status).length > 0 && (
              <div
                className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
                data-testid="month-finalize-warnings"
              >
                <p className="flex items-center gap-1.5 font-semibold">
                  <AlertTriangle size={13} className="text-amber-600" /> Before you confirm
                </p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {finalizeWarnings(status).map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={close} data-testid="month-finalize-cancel">
              Cancel
            </Button>
            <Button
              className="bg-violet-600 font-bold text-white hover:bg-violet-700"
              disabled={finalize.isPending}
              onClick={() => void doFinalize()}
              data-testid="month-finalize-yes"
            >
              {finalize.isPending ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null}
              Yes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payment Pending / Paid: the timer, the timeline and (pending) Mark as Paid */}
      <Dialog open={open === "payment"} onOpenChange={(next) => !next && close()}>
        <DialogContent className="max-w-lg" data-testid="month-payment-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {status.state === "paid" ? (
                <BadgeCheck size={17} className="text-emerald-600" />
              ) : (
                <Hourglass size={16} className="text-amber-600" />
              )}
              {status.label}: {status.state === "paid" ? "paid" : "payment pending"}
            </DialogTitle>
            <DialogDescription data-testid="month-payment-summary">
              {status.state === "paid"
                ? `Paid on ${dateTime(status.paidAt)} by ${status.paidBy || "HR"}, ${daysAfterFinalizing(status.daysToPay)}.`
                : `Finalized ${dateTime(status.finalizedAt)} by ${status.finalizedBy || "HR"}. Waiting for payment for ${elapsedLabel(status.finalizedAt, now)}.`}
            </DialogDescription>
          </DialogHeader>

          {status.state === "finalized" && !confirmPaid && (
            <div
              className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-3"
              data-testid="month-payment-timer"
            >
              <Hourglass size={22} className="shrink-0 text-amber-600" />
              <div>
                <p className="text-lg font-black tabular-nums text-amber-900">
                  {elapsedLabel(status.finalizedAt, now)}
                </p>
                <p className="text-xs text-amber-800">since Payroll Done, until payment is confirmed</p>
              </div>
            </div>
          )}

          {confirmPaid ? (
            <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
              <p className="font-semibold" data-testid="month-paid-question">
                {MARK_PAID_QUESTION}
              </p>
              <p className="text-xs" data-testid="month-paid-count">
                {plural(status.counts.notPaid, "employee")} will be marked Paid
                {status.counts.onHold + status.counts.newJoiners > 0
                  ? `; ${status.counts.onHold + status.counts.newJoiners} held or new employee(s) are not (pay them later with Release & pay on Skipped Employees)`
                  : ""}
                .
              </p>
            </div>
          ) : (
            <MonthTimeline status={status} now={now} />
          )}

          <DialogFooter className="gap-2">
            {confirmPaid ? (
              <>
                <Button variant="outline" onClick={() => setConfirmPaid(false)} data-testid="month-paid-cancel">
                  Cancel
                </Button>
                <Button
                  className="bg-emerald-600 font-bold text-white hover:bg-emerald-700"
                  disabled={markPaid.isPending}
                  onClick={() => void doMarkPaid()}
                  data-testid="month-paid-yes"
                >
                  {markPaid.isPending ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null}
                  Yes, mark as Paid
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={close}>
                  Close
                </Button>
                {status.state === "finalized" && (
                  <span
                    title={status.can.markPaid ? "Confirm that this month's salaries were paid" : WHOLE_COMPANY_ONLY}
                  >
                    <Button
                      className="gap-2 bg-emerald-600 font-bold text-white hover:bg-emerald-700"
                      disabled={!status.can.markPaid}
                      onClick={() => setConfirmPaid(true)}
                      data-testid="month-mark-paid"
                    >
                      <Wallet size={14} /> Mark as Paid
                    </Button>
                  </span>
                )}
              </>
            )}
          </DialogFooter>
          {status.state === "finalized" && !status.can.markPaid && !confirmPaid && (
            <p className="text-xs text-muted-foreground" data-testid="month-paid-blocked">
              {WHOLE_COMPANY_ONLY}
            </p>
          )}
          {status.snapshot && (
            <p className="text-[11px] text-muted-foreground" data-testid="month-snapshot">
              When finalized: {plural(status.snapshot.inPayroll, "employee")} in the payroll, total NET{" "}
              {inr(status.snapshot.mainNet)}
              {status.snapshot.onHold ? `, ${status.snapshot.onHold} on hold` : ""}
              {status.snapshot.newJoiners ? `, ${status.snapshot.newJoiners} new joiner(s) not added` : ""}.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

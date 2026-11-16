import { useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCheck,
  CheckCircle2,
  Circle,
  Hourglass,
  Loader2,
  Lock,
  Wallet,
  Wand2,
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
import { Input } from "@/components/ui/input";
import { dateShort, dateTime, inr, plural } from "@/components/payroll/kit/format";
import { Chip } from "@/components/payroll/kit/parts";
import { UnlockPanel } from "@/components/payroll/kit/UnlockPanel";
import { useToast } from "@/hooks/use-toast";
import {
  useProductionPeriodActions,
  type CyclePeriod,
  type PayCycle,
  type PeriodState,
  type ProductionPeriodWorkflow,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { useNow } from "../staff-payroll/month-workflow/MonthStatusButton";
import { daysAfterFinalizing, elapsedLabel } from "../staff-payroll/month-workflow/logic";
import {
  FINALIZE_QUESTION,
  MARK_PAID_QUESTION,
  PERIOD_STATE_META,
  WHOLE_COMPANY_ONLY,
  finalizeSummary,
  paidOnProblem,
  periodButton,
  periodTimeline,
  todayIso,
  type TimelineStep,
} from "./period-workflow";

const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^HTTP \d+[^:]*:\s*/, "") : undefined);

/** The period's state as a chip (page header, period picker). */
export function PeriodStateChip({ state, testId }: { state: PeriodState; testId?: string }) {
  const meta = PERIOD_STATE_META[state];
  return (
    <span data-testid={testId} data-state={state}>
      <Chip tone={meta.tone} title={meta.hint}>
        {meta.label}
      </Chip>
    </span>
  );
}

const STEP_ICON: Record<TimelineStep["key"], typeof Wand2> = { generated: Wand2, finalized: Lock, paid: Wallet };

/** Generated -> Payroll Done -> Paid, as a one-line strip (compact) or the list in the popups. */
export function PeriodTimeline({
  status,
  now,
  compact = false,
}: {
  status: ProductionPeriodWorkflow | undefined;
  now?: Date;
  compact?: boolean;
}) {
  const steps = periodTimeline(status, now);
  return (
    <ol
      className={cn(
        "grid gap-2",
        compact ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1",
        compact && "rounded-2xl border border-slate-100 bg-white/70 p-2.5",
      )}
      aria-label="The pay period's timeline"
      data-testid={compact ? "pcp-timeline-strip" : "pcp-timeline"}
    >
      {steps.map((step) => {
        const Icon = STEP_ICON[step.key];
        return (
          <li
            key={step.key}
            className={cn(
              "flex min-w-0 items-start gap-2.5 rounded-xl px-2.5 py-2",
              step.done ? "bg-emerald-50/70" : "bg-slate-50",
            )}
            data-testid={`pcp-step-${step.key}`}
            data-done={step.done ? "true" : "false"}
          >
            <span
              className={cn(
                "mt-0.5 shrink-0 rounded-lg p-1.5",
                step.done ? "bg-emerald-100 text-emerald-700" : "bg-white text-slate-400",
              )}
            >
              <Icon size={14} />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-xs font-bold text-gray-900">
                {step.title}
                {step.done ? (
                  <CheckCircle2 size={12} className="text-emerald-600" aria-label="done" />
                ) : (
                  <Circle size={11} className="text-slate-300" aria-label="not yet" />
                )}
              </span>
              {step.when && (
                <span className="block text-xs font-semibold tabular-nums text-slate-700">{step.when}</span>
              )}
              <span className="block break-words text-[11px] leading-snug text-muted-foreground">{step.detail}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The pay period's own button on a cycle page, as on Staff Payroll (owner 2026-11-16):
 *   Payroll Done     -> the owner's question (Yes / Cancel); the period is then locked for good. Refused, with the
 *                       reason, while the period has not ended or anyone is still waiting in New Joiners;
 *   Payment Pending  -> amber, a live timer since Payroll Done; opens the timeline and Mark as Paid (HR enters the day
 *                       the wages were paid);
 *   Paid             -> green, the paid day and how many days after Payroll Done.
 * A unit login or a role without the right sees the same states but cannot press them.
 */
export function PeriodStatusButton({
  cycle,
  period,
  status,
  loading,
}: {
  cycle: PayCycle;
  period: CyclePeriod;
  status: ProductionPeriodWorkflow | undefined;
  loading?: boolean;
}) {
  const { toast } = useToast();
  const { finalize, markPaid, unlock } = useProductionPeriodActions();
  const [open, setOpen] = useState<"finalize" | "payment" | null>(null);
  const [confirmPaid, setConfirmPaid] = useState(false);
  const [paidOn, setPaidOn] = useState(todayIso());
  const now = useNow(status?.state === "finalized");
  const button = periodButton(status, now);

  if (!status || !button) {
    return (
      <Button variant="outline" className="h-9 gap-2" disabled data-testid="pcp-period-status-loading">
        {loading ? <Loader2 size={14} className="animate-spin" /> : <CheckCheck size={14} />} Payroll Done
      </Button>
    );
  }

  const paidProblem = paidOnProblem(paidOn, status.periodEnd);

  const doFinalize = async () => {
    try {
      await finalize.mutateAsync({ cycle, period });
      toast({
        title: `${status.label} ${status.periodLabel} is finalized`,
        description: "It is locked for good. The button now shows how long payment has been pending.",
      });
      setOpen(null);
    } catch (err) {
      toast({ title: "Could not finalize the pay period", description: errorText(err), variant: "destructive" });
    }
  };

  const doMarkPaid = async () => {
    try {
      const result = await markPaid.mutateAsync({ cycle, period, paidOn });
      toast({
        title: `${status.label} ${status.periodLabel} marked as Paid`,
        description: `${plural(result.workersPaid ?? 0, "worker")} marked Paid on ${dateShort(paidOn)}.`,
      });
      setConfirmPaid(false);
      setOpen(null);
    } catch (err) {
      toast({ title: "Could not mark the period as paid", description: errorText(err), variant: "destructive" });
    }
  };

  // a finalized, unpaid period back to Generated (owner 2026-11-16), with a reason; a paid one is locked for good
  const doUnlock = async (reason: string) => {
    try {
      await unlock.mutateAsync({ cycle, period, reason });
      toast({
        title: `${status.label} ${status.periodLabel} is unlocked`,
        description: "It is Generated again: generate or work it out again, then press Payroll Done.",
      });
      setOpen(null);
      return true;
    } catch (err) {
      toast({ title: "Could not unlock the pay period", description: errorText(err), variant: "destructive" });
      return false;
    }
  };

  const close = () => {
    setOpen(null);
    setConfirmPaid(false);
  };

  return (
    <>
      {button.kind === "done" ? (
        <span title={button.blockedReason || "Finalize this pay period's payroll: it is then locked for good"}>
          <Button
            variant="outline"
            className="h-9 gap-2 border-violet-200 font-semibold text-violet-700 hover:bg-violet-50"
            disabled={!!button.blockedReason}
            onClick={() => setOpen("finalize")}
            data-testid="pcp-period-status"
            data-state={status.state}
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
            title={button.kind === "pending" ? "Payment pending since Payroll Done" : "This pay period is paid"}
            data-testid="pcp-period-status"
            data-state={status.state}
          >
            {button.kind === "pending" ? <Hourglass size={14} /> : <BadgeCheck size={15} />}
            <span className="flex flex-col leading-tight">
              <span>{button.label}</span>
              <span className="text-[11px] font-medium tabular-nums opacity-90" data-testid="pcp-period-status-detail">
                {button.detail}
              </span>
            </span>
          </Button>
        </span>
      )}

      {/* Payroll Done: the owner's question, what is still open, Yes / Cancel */}
      <Dialog open={open === "finalize"} onOpenChange={(next) => !next && close()}>
        <DialogContent className="max-w-lg" data-testid="pcp-finalize-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock size={16} className="text-violet-600" /> Payroll Done: {status.label} {status.periodLabel}
            </DialogTitle>
            <DialogDescription className="text-sm font-medium text-gray-800" data-testid="pcp-finalize-question">
              {FINALIZE_QUESTION}
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-gray-600" data-testid="pcp-finalize-summary">
            {finalizeSummary(status)}
          </p>
          {status.counts.notCleared > 0 && (
            <p className="flex items-start gap-1.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" />
              {plural(status.counts.notCleared, "worker")} in the payroll{" "}
              {status.counts.notCleared === 1 ? "is" : "are"} not marked Cleared (verified) yet. You can still go ahead.
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={close} data-testid="pcp-finalize-cancel">
              Cancel
            </Button>
            <Button
              className="bg-violet-600 font-bold text-white hover:bg-violet-700"
              disabled={finalize.isPending}
              onClick={() => void doFinalize()}
              data-testid="pcp-finalize-yes"
            >
              {finalize.isPending ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null}
              Yes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payment Pending / Paid: the timer, the timeline and (pending) Mark as Paid */}
      <Dialog open={open === "payment"} onOpenChange={(next) => !next && close()}>
        <DialogContent className="max-w-lg" data-testid="pcp-payment-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {status.state === "paid" ? (
                <BadgeCheck size={17} className="text-emerald-600" />
              ) : (
                <Hourglass size={16} className="text-amber-600" />
              )}
              {status.label} {status.periodLabel}: {status.state === "paid" ? "paid" : "payment pending"}
            </DialogTitle>
            <DialogDescription data-testid="pcp-payment-summary">
              {status.state === "paid"
                ? `Paid on ${dateShort(status.paidOn ?? status.paidAt?.slice(0, 10))}${status.paidBy ? `, recorded by ${status.paidBy}` : ""}${status.daysToPay !== null ? `, ${daysAfterFinalizing(status.daysToPay)}` : ""}.`
                : `Finalized ${dateTime(status.finalizedAt)} by ${status.finalizedBy || "HR"}. Waiting for payment for ${elapsedLabel(status.finalizedAt, now)}.`}
            </DialogDescription>
          </DialogHeader>

          {confirmPaid ? (
            <div className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
              <p className="font-semibold" data-testid="pcp-paid-question">
                {MARK_PAID_QUESTION}
              </p>
              <label className="flex flex-wrap items-center gap-2 text-xs font-semibold text-gray-700">
                Paid on
                <Input
                  type="date"
                  value={paidOn}
                  max={todayIso()}
                  min={status.periodEnd}
                  onChange={(e) => setPaidOn(e.target.value)}
                  className="h-9 w-44 bg-white text-sm"
                  aria-label="The date the wages were paid"
                  data-testid="pcp-paid-on"
                />
              </label>
              {paidProblem && (
                <p className="text-xs font-semibold text-red-700" data-testid="pcp-paid-on-problem">
                  {paidProblem}
                </p>
              )}
              <p className="text-xs" data-testid="pcp-paid-count">
                {plural(status.counts.notPaid, "worker")} will be marked Paid.
              </p>
            </div>
          ) : (
            <>
              {status.state === "finalized" && (
                <div
                  className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-3"
                  data-testid="pcp-payment-timer"
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
              <PeriodTimeline status={status} now={now} />
              <UnlockPanel
                what="this pay period"
                blocked={
                  status.state === "paid" ? (status.unlockBlocked ?? "Paid: locked for good.") : status.unlockBlocked
                }
                allowed={!!status.can.unlock}
                busy={unlock.isPending}
                onUnlock={doUnlock}
              />
            </>
          )}

          <DialogFooter className="gap-2">
            {confirmPaid ? (
              <>
                <Button variant="outline" onClick={() => setConfirmPaid(false)} data-testid="pcp-paid-cancel">
                  Cancel
                </Button>
                <Button
                  className="bg-emerald-600 font-bold text-white hover:bg-emerald-700"
                  disabled={markPaid.isPending || !!paidProblem}
                  onClick={() => void doMarkPaid()}
                  data-testid="pcp-paid-yes"
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
                  <span title={status.can.markPaid ? "Confirm that this period's wages were paid" : WHOLE_COMPANY_ONLY}>
                    <Button
                      className="gap-2 bg-emerald-600 font-bold text-white hover:bg-emerald-700"
                      disabled={!status.can.markPaid}
                      onClick={() => {
                        setPaidOn(todayIso());
                        setConfirmPaid(true);
                      }}
                      data-testid="pcp-mark-paid"
                    >
                      <Wallet size={14} /> Mark as Paid
                    </Button>
                  </span>
                )}
              </>
            )}
          </DialogFooter>
          {status.state === "finalized" && !status.can.markPaid && !confirmPaid && (
            <p className="text-xs text-muted-foreground" data-testid="pcp-paid-blocked">
              {status.wholeCompany
                ? "Your role cannot mark production payroll as paid (Production Payroll -> Mark as Paid needs Edit)."
                : WHOLE_COMPANY_ONLY}
            </p>
          )}
          {status.snapshot && !status.snapshot.backfill && (
            <p className="text-[11px] text-muted-foreground" data-testid="pcp-snapshot">
              When finalized: {plural(status.snapshot.inPayroll, "worker")} in the payroll, total NET{" "}
              {inr(status.snapshot.mainNet)}.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

import {
  AlertTriangle,
  CheckCircle2,
  CheckCheck,
  Clock,
  History,
  ListChecks,
  MessageSquareText,
  Printer,
  RotateCcw,
  Trash2,
  Wallet,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdvanceDetail, type AdvanceDecisionItem, type AdvanceRepaymentItem } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  HISTORY_ACTION_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  TYPE_LABEL,
  appliedByEmployee,
  approvedOf,
  canDelete,
  decidedAtOf,
  decidedByOf,
  earnedPeriodLabel,
  workingDaysText,
  hasLeft,
  historyText,
  progressPct,
  requestedOf,
  type SettlementRow,
} from "./logic";
import { Chip, InitialsAvatar, ProgressBar } from "./parts";
import { MONTH_FULL, formatDate, formatDateTime, formatMoney, monthLabel } from "./shared";
import { buildStatementHtml, printStatement } from "./statement";

type Props = {
  advanceId: number | null;
  onClose: () => void;
  onApprove: (row: SettlementRow) => void;
  onReject: (row: SettlementRow) => void;
  onDelete: (row: SettlementRow) => void;
  /** false: this account may not approve this type of advance (Salary Advance / Term Loan are separate switches), so no
   *  Approve / Reject. */
  canDecide?: (row: SettlementRow) => boolean;
};

function Figure({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-xl border bg-white p-3 text-center">
      <p className="mb-0.5 text-[11px] text-gray-400">{label}</p>
      <p className={cn("text-sm font-black", tone)}>{value}</p>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-4 text-xs">
      <dt className="text-gray-400">{label}</dt>
      <dd className="text-right font-medium text-gray-700">{value}</dd>
    </div>
  );
}

const HISTORY_ICON: Record<AdvanceDecisionItem["action"], { icon: typeof CheckCircle2; tone: string }> = {
  approved: { icon: CheckCircle2, tone: "bg-green-100 text-green-700" },
  rejected: { icon: XCircle, tone: "bg-red-100 text-red-600" },
  reopened: { icon: RotateCcw, tone: "bg-slate-100 text-slate-600" },
};

/** Every approval, rejection and reopening, newest first, with the amounts, the deduction month and the remark. */
function DecisionHistory({ items, type }: { items: AdvanceDecisionItem[]; type: SettlementRow["advanceType"] }) {
  return (
    <section className="space-y-3" aria-label="Decision history" data-testid="advance-history">
      <div className="flex items-center gap-2">
        <ListChecks size={14} className="text-gray-400" />
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">History ({items.length})</p>
      </div>
      {items.length === 0 ? (
        <p className="py-3 text-center text-xs text-muted-foreground">Not approved or rejected yet.</p>
      ) : (
        <ol className="space-y-2">
          {items.map((item) => {
            const { title, detail } = historyText(item, type);
            const { icon: Icon, tone } = HISTORY_ICON[item.action];
            return (
              <li
                key={item.id}
                className="flex gap-3 rounded-xl border border-gray-100 bg-white p-3"
                data-testid={`advance-history-${item.id}`}
              >
                <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", tone)}>
                  <Icon size={14} aria-label={HISTORY_ACTION_LABEL[item.action]} />
                </div>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-sm font-semibold text-gray-900">{title}</p>
                  {detail && <p className="text-xs text-gray-600">{detail}</p>}
                  {item.remark && (
                    <p className="break-words text-xs italic text-gray-700">&ldquo;{item.remark}&rdquo;</p>
                  )}
                  <p className="text-[11px] text-gray-400">
                    {[item.by && `by ${item.by}`, item.at && formatDateTime(item.at)].filter(Boolean).join(" · ")}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** One advance in full: what was asked for and approved, what is recovered, what is still scheduled, every deduction and
 *  every decision. */
export default function DetailSheet({
  advanceId,
  onClose,
  onApprove,
  onReject,
  onDelete,
  canDecide = () => true,
}: Props) {
  const { data, isLoading, isError, refetch } = useAdvanceDetail(advanceId);
  const adv = data as SettlementRow | undefined;
  const repayments: AdvanceRepaymentItem[] = adv?.repayments ?? [];
  const scheduled = repayments.reduce((s, r) => s + (r.isProcessed ? 0 : r.amount), 0);
  const deducted = repayments.filter((r) => r.isProcessed).length;
  // the part of what is owed that no deduction is lined up for
  const unscheduled = adv && adv.status === "approved" ? Math.max(0, adv.outstanding - scheduled) : 0;
  const approved = adv ? approvedOf(adv) : null;

  return (
    <Sheet open={advanceId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg" data-testid="advance-detail">
        {isError ? (
          <div className="space-y-3 pt-8 text-center">
            <SheetTitle className="text-base">Advance</SheetTitle>
            <SheetDescription>This advance could not be loaded.</SheetDescription>
            <Button variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : isLoading || !adv ? (
          <div className="space-y-4 pt-6">
            <SheetTitle className="sr-only">Loading advance</SheetTitle>
            <SheetDescription className="sr-only">Loading the advance details</SheetDescription>
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="space-y-5 pb-8 pt-2">
            <SheetHeader className="space-y-3 pb-0 text-left">
              <div className="flex items-center gap-3 pr-6">
                <InitialsAvatar name={adv.employeeName} size="lg" />
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-base">{adv.employeeName}</SheetTitle>
                  <SheetDescription className="truncate text-xs">
                    <span className="font-mono">{adv.employeeCode}</span>
                    {[adv.employeeDesignation, adv.employeeDepartment, adv.employeeBranch]
                      .filter(Boolean)
                      .map((t) => ` · ${t}`)
                      .join("")}
                  </SheetDescription>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Chip tone={STATUS_TONE[adv.status]}>{STATUS_LABEL[adv.status]}</Chip>
                <Chip tone={adv.advanceType === "term" ? "accent" : "info"}>{TYPE_LABEL[adv.advanceType]}</Chip>
                {hasLeft(adv) && <Chip tone="caution">Has left</Chip>}
                {appliedByEmployee(adv) && <Chip tone="neutral">Applied by employee</Chip>}
              </div>
            </SheetHeader>

            {adv.status !== "pending" && (adv.decisionRemark ?? "").trim() && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-xl border p-3 text-xs",
                  adv.status === "rejected"
                    ? "border-red-200 bg-red-50 text-red-900"
                    : "border-slate-200 bg-slate-50 text-slate-800",
                )}
                data-testid="advance-decision-remark"
              >
                <MessageSquareText size={14} className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="font-semibold">
                    {adv.status === "rejected" ? "Reason for rejecting" : "HR's remark"}
                    {decidedByOf(adv) ? ` (${decidedByOf(adv)})` : ""}
                  </p>
                  <p className="break-words">{adv.decisionRemark}</p>
                </div>
              </div>
            )}

            {hasLeft(adv) && adv.outstanding > 0 && adv.status === "approved" && (
              <div
                className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
                data-testid="advance-left-note"
              >
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <p>
                  This employee has left. <b>{formatMoney(adv.outstanding)}</b> is still outstanding and is to be
                  recovered in their full and final settlement.
                </p>
              </div>
            )}

            <section className="space-y-2" aria-label="Settlement breakdown">
              <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Breakdown</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="advance-figures">
                <Figure label="Requested" value={formatMoney(requestedOf(adv))} tone="text-gray-800" />
                <Figure
                  label="Approved"
                  value={approved != null ? formatMoney(approved) : adv.status === "rejected" ? "Rejected" : "Waiting"}
                  tone={approved != null && approved < requestedOf(adv) ? "text-amber-700" : "text-blue-700"}
                />
                <Figure label="Recovered" value={formatMoney(adv.totalRepaid)} tone="text-green-600" />
                <Figure
                  label="Outstanding"
                  value={approved != null ? formatMoney(adv.outstanding) : "-"}
                  tone="text-red-500"
                />
              </div>
              {approved != null && approved < requestedOf(adv) && (
                <p className="text-xs font-medium text-amber-700" data-testid="advance-approved-less">
                  {formatMoney(approved)} approved of the {formatMoney(requestedOf(adv))} asked for. Only the approved
                  amount is deducted.
                </p>
              )}
              {(adv.status === "approved" || adv.status === "closed") && (
                <>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-gray-400">
                      <span>Recovery progress</span>
                      <span>{progressPct(adv)}%</span>
                    </div>
                    <ProgressBar pct={progressPct(adv)} className="h-2" />
                  </div>
                  {adv.status === "approved" && (
                    <p className="text-xs text-gray-500" data-testid="advance-scheduled">
                      Still scheduled through payroll: <b>{formatMoney(scheduled)}</b>
                      {unscheduled > 0.005 && (
                        <span className="text-amber-700">
                          {" "}
                          ({formatMoney(unscheduled)} of what is outstanding has no deduction scheduled)
                        </span>
                      )}
                    </p>
                  )}
                </>
              )}
            </section>

            {adv.earnings && (
              <section className="space-y-2" aria-label="Salary earned" data-testid="advance-earned">
                <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-gray-400">
                  <Wallet size={13} /> Earned in {earnedPeriodLabel(adv.earnings)}
                </p>
                <dl className="space-y-1.5 rounded-xl border border-gray-100 bg-white p-3">
                  <Detail label="Fixed salary" value={formatMoney(adv.earnings.fixedSalary)} />
                  <Detail label="Working days" value={workingDaysText(adv.earnings)} />
                  <Detail label="Earned salary" value={formatMoney(adv.earnings.earnedAmount)} />
                  {adv.earnings.limit != null && (
                    <Detail
                      label={`Limit (${adv.earnings.percent}% of earned salary)`}
                      value={formatMoney(adv.earnings.limit)}
                    />
                  )}
                </dl>
              </section>
            )}

            {(adv.limitRemark ?? "").trim() && (
              <div
                className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
                data-testid="advance-limit-remark"
              >
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="font-semibold">Recorded above the {adv.earnings?.percent ?? 50}% limit</p>
                  <p className="break-words">{adv.limitRemark}</p>
                </div>
              </div>
            )}

            <dl className="space-y-1.5 rounded-xl bg-gray-50 p-3" aria-label="Advance details">
              <Detail label="Purpose" value={adv.purpose} />
              <Detail
                label="Applied by"
                value={appliedByEmployee(adv) ? "The employee, from the mobile app" : "HR (recorded here)"}
              />
              {adv.salaryAtRequest != null && !adv.earnings && (
                <Detail label="Monthly fixed salary" value={formatMoney(adv.salaryAtRequest)} />
              )}
              {adv.advanceType === "term" && adv.emiAmount > 0 && (
                <Detail
                  label="Monthly EMI"
                  value={`${formatMoney(adv.emiAmount)}${adv.repaymentMonths ? ` for ${adv.repaymentMonths} months` : ""}`}
                />
              )}
              <Detail
                label={adv.advanceType === "term" ? "Deduction starts" : "Deducted in"}
                value={
                  adv.repaymentStartMonth && adv.repaymentStartYear
                    ? monthLabel(adv.repaymentStartMonth, adv.repaymentStartYear)
                    : null
                }
              />
              <Detail label="Applied on" value={adv.createdAt ? formatDateTime(adv.createdAt) : null} />
              <Detail label="Decided by" value={decidedByOf(adv)} />
              <Detail label="Decided on" value={decidedAtOf(adv) ? formatDateTime(decidedAtOf(adv)) : null} />
              <Detail label="Disbursed" value={adv.disbursedAt ? formatDate(adv.disbursedAt) : null} />
              <Detail label="Notes" value={adv.notes} />
              <Detail label="Phone" value={adv.employeePhone} />
              <Detail label="Email" value={adv.employeeEmail} />
            </dl>

            {adv.status === "pending" && canDecide(adv) && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="h-9 flex-1 gap-1.5 bg-green-600 hover:bg-green-700"
                  onClick={() => onApprove(adv)}
                  data-testid="detail-approve"
                >
                  <CheckCircle2 size={13} /> Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 flex-1 gap-1.5 border-red-200 text-red-500"
                  onClick={() => onReject(adv)}
                  data-testid="detail-reject"
                >
                  <XCircle size={13} /> Reject
                </Button>
              </div>
            )}
            {adv.status === "closed" && (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-green-200 bg-green-50 py-2">
                <CheckCheck size={15} className="text-green-600" />
                <p className="text-sm font-semibold text-green-700">Fully repaid: completed</p>
              </div>
            )}
            {adv.status === "approved" && (
              <div className="flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                <CheckCircle2 size={13} className="shrink-0" />
                Deductions are processed automatically during monthly payroll.
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => printStatement(buildStatementHtml(adv, repayments))}
                data-testid="detail-print"
              >
                <Printer size={13} /> Print statement
              </Button>
              {canDelete(adv) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto gap-1.5 text-red-500 hover:text-red-600"
                  onClick={() => onDelete(adv)}
                  data-testid="detail-delete"
                >
                  <Trash2 size={13} /> Delete {TYPE_LABEL[adv.advanceType]}
                </Button>
              )}
            </div>

            <Separator />

            <section className="space-y-3" aria-label="Deduction schedule">
              <div className="flex items-center gap-2">
                <History size={14} className="text-gray-400" />
                <p className="text-xs font-bold uppercase tracking-wider text-gray-400">
                  Deduction schedule ({repayments.length})
                </p>
                {repayments.length > 0 && (
                  <span className="ml-auto text-[11px] text-gray-400">
                    {deducted} of {repayments.length} deducted
                  </span>
                )}
              </div>
              {repayments.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  {adv.status === "pending"
                    ? "The schedule is created when the advance is approved."
                    : "No deduction schedule found."}
                </p>
              ) : (
                <ul className="space-y-2">
                  {repayments.map((r) => (
                    <li
                      key={r.id}
                      className={cn(
                        "flex items-center justify-between rounded-xl border p-3",
                        r.isProcessed ? "border-green-100 bg-green-50" : "border-gray-100 bg-white",
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={cn(
                            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                            r.isProcessed ? "bg-green-100" : "bg-gray-100",
                          )}
                        >
                          {r.isProcessed ? (
                            <CheckCircle2 size={14} className="text-green-600" />
                          ) : (
                            <Clock size={14} className="text-gray-400" />
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-semibold">
                            {MONTH_FULL[r.month - 1]} {r.year}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {r.isProcessed ? "Deducted via payroll" : "Scheduled payroll deduction"}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={cn("text-sm font-bold", r.isProcessed ? "text-green-600" : "text-gray-500")}>
                          {formatMoney(r.amount)}
                        </p>
                        <p
                          className={cn(
                            "mt-0.5 text-xs font-medium",
                            r.isProcessed ? "text-green-500" : "text-amber-500",
                          )}
                        >
                          {r.isProcessed ? "Done" : "Pending"}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {adv.history && (
              <>
                <Separator />
                <DecisionHistory items={adv.history} type={adv.advanceType} />
              </>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

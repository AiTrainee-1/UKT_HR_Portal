import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ClipboardCheck, IndianRupee, ListChecks, XCircle } from "lucide-react";
import StatCard from "@/components/md/kit/StatCard";
import { num } from "@/lib/md/format";
import { batchTitle, finalized, istDateTime, money, periodLabel, sentBackToHr, type ReviewSummary } from "./logic";
import { Quote } from "./parts";
import Tracker from "./Tracker";
import type { SettlementBatch } from "./types";

/**
 * The Overview tab: the batch's eight stages, the six headline numbers, HR's note to the MD and, once the MD has confirmed,
 * "Sent back to HR" with the MD's instructions (and HR's final note once HR has finalized). Read-only.
 */
export default function OverviewView({
  batch,
  summary,
  stageChip,
}: {
  batch: SettlementBatch;
  summary: ReviewSummary;
  stageChip: ReactNode;
}) {
  const period = periodLabel(batch.month, batch.year);
  const canDecide = batch.stage === "md_review" && batch.actions.canDecideMd;
  const showFinal = finalized(batch.stage);
  const approvedAmount = showFinal ? batch.amounts.finalApproved : batch.amounts.mdApproved;
  const alerts = batch.counts.warning + batch.counts.critical;
  const left = batch.counts.total - batch.counts.mdDecided;

  return (
    <section
      className="md-card space-y-5 p-4 @2xl:p-6"
      aria-label={`${batchTitle(batch)} of ${period}`}
      data-testid="md-settlement-view-overview"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-black tracking-tight text-md-ink" data-testid="md-settlement-batch-title">
            {batchTitle(batch)} · {period}
          </h3>
          {batch.forwardedAt && (
            <p className="mt-0.5 text-xs text-md-ink-soft">
              Forwarded{batch.forwardedBy ? ` by ${batch.forwardedBy}` : ""} on {istDateTime(batch.forwardedAt)}
            </p>
          )}
        </div>
        {stageChip}
      </div>

      <Tracker steps={batch.tracker} />

      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3 @5xl:grid-cols-6" data-testid="md-settlement-stats">
        <StatCard
          label="Requests"
          value={num(batch.counts.total)}
          sub={`${money(batch.amounts.requested)} asked`}
          icon={ClipboardCheck}
          tone="blue"
          testId="md-settlement-kpi-requests"
        />
        <StatCard
          label="Decided"
          value={`${num(batch.counts.mdDecided)}/${num(batch.counts.total)}`}
          sub={left > 0 ? `${num(left)} left to decide` : "All decided"}
          icon={ListChecks}
          tone={canDecide && left > 0 ? "amber" : "slate"}
          testId="md-settlement-kpi-decided"
        />
        <StatCard
          label="Approved"
          value={num(batch.counts.approved)}
          sub={summary.reduced ? `${num(summary.reduced)} for a smaller amount` : "All at the amount asked"}
          icon={CheckCircle2}
          tone="green"
          testId="md-settlement-kpi-approved"
        />
        <StatCard
          label="Rejected"
          value={num(batch.counts.rejected)}
          sub={batch.counts.rejected ? `${money(summary.rejectedTotal)} not paid` : "None rejected"}
          icon={XCircle}
          tone={batch.counts.rejected ? "red" : "slate"}
          testId="md-settlement-kpi-rejected"
        />
        <StatCard
          label="Leave alerts"
          value={num(alerts)}
          sub={`${num(batch.counts.warning)} warning (3 days) · ${num(batch.counts.critical)} frequent (over 3)`}
          icon={AlertTriangle}
          tone={batch.counts.critical ? "red" : batch.counts.warning ? "amber" : "slate"}
          testId="md-settlement-kpi-leave"
        />
        <StatCard
          label={showFinal ? "Final approved" : "Approved amount"}
          value={money(approvedAmount)}
          sub={`of ${money(batch.amounts.requested)} requested`}
          icon={IndianRupee}
          tone="indigo"
          testId="md-settlement-kpi-amount"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
        <div className="md-panel-sand p-3.5" data-testid="md-settlement-hr-message">
          <p className="text-[11px] font-extrabold uppercase tracking-wide text-md-warning-800">HR's note to you</p>
          <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-md-ink">
            {batch.hrNote?.trim() || "HR added no note to this batch."}
          </p>
          {(batch.forwardedBy || batch.forwardedAt) && (
            <p className="mt-1.5 text-[11px] text-md-ink-soft">
              {[batch.forwardedBy, istDateTime(batch.forwardedAt)].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
        {sentBackToHr(batch.stage) && batch.finalizedVia !== "md" && (
          <div className="md-panel space-y-1.5 p-3.5" data-testid="md-settlement-sent-back">
            <p className="flex items-center gap-1.5 text-[13px] font-extrabold text-md-success-700">
              <CheckCircle2 size={15} aria-hidden="true" /> Sent back to HR
            </p>
            <p className="text-xs leading-relaxed text-md-ink-soft">
              {batch.mdConfirmedAt
                ? `Confirmed on ${istDateTime(batch.mdConfirmedAt)}${batch.mdConfirmedBy ? ` by ${batch.mdConfirmedBy}` : ""}. `
                : ""}
              {batch.stage === "hr_final"
                ? "HR is doing the final settlement within your decisions."
                : batch.finalizedAt
                  ? `HR finalized it on ${istDateTime(batch.finalizedAt)}${batch.finalizedBy ? ` (${batch.finalizedBy})` : ""}.`
                  : ""}
            </p>
            {batch.mdNote && <Quote label="Your instructions">{batch.mdNote}</Quote>}
            {showFinal && batch.finalNote && <Quote label="HR's note on the final settlement">{batch.finalNote}</Quote>}
          </div>
        )}
      </div>
    </section>
  );
}

import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { cn } from "@/lib/utils";
import { STATE_STYLE, stripLines, tickMonth } from "./logic";
import { CardError, failed } from "./parts";
import type { PayrollQueries } from "./queries";

/**
 * Where each of the last twelve months stands, newest on the right: generated (still open), payment pending (HR pressed
 * Payroll Done, not paid yet), paid (Mark as Paid; production: cleared), part paid, provisional. Click a month to look
 * at it.
 */
export default function StatusStrip({
  query,
  selected,
  onSelect,
}: {
  query: PayrollQueries["status"];
  /** The month on screen ("YYYY-MM"). */
  selected: string | null | undefined;
  onSelect: (month: string) => void;
}) {
  const data = query.data;
  return (
    <SectionCard
      testId="md-payroll-status-strip"
      title="Payroll status by month"
      subtitle={
        data ? `Salary day is the ${data.payDay}th · click a month to open it` : "Which months are paid or pending"
      }
      loading={query.isPending}
      provenance={data?.provenance}
      provenanceIds={["payroll-status", "provisional"]}
      actions={<AskAiButton question="Which payroll months are paid, and which are still pending or provisional?" />}
    >
      {failed(query) ? (
        <CardError query={query} />
      ) : (
        <>
          {/* a phone shows all twelve months at once, three across; wider screens keep the one sideways row */}
          <ol
            className="grid grid-cols-3 gap-2 pb-1 pt-1 @lg:-mx-1 @lg:flex @lg:gap-2.5 @lg:overflow-x-auto @lg:px-1 @lg:pb-3"
            data-testid="md-payroll-status-chips"
          >
            {(data?.months ?? []).map((m) => {
              const style = STATE_STYLE[m.state] ?? STATE_STYLE.generated;
              const clickable = m.slips > 0 || m.state === "not_generated";
              return (
                <li key={m.month} className="min-w-0 @lg:shrink-0">
                  <button
                    type="button"
                    disabled={!clickable}
                    onClick={() => onSelect(m.month)}
                    aria-current={selected === m.month ? "date" : undefined}
                    data-testid={`md-payroll-status-${m.month}`}
                    data-state={m.state}
                    className="md-money-month"
                  >
                    <span className="text-[13px] font-black tracking-tight text-md-ink">{tickMonth(m.month)}</span>
                    <span className="flex items-center gap-1.5 text-[11px] font-bold text-md-ink-soft">
                      <i className={cn("md-money-dot", style.dot)} />
                      {style.label}
                    </span>
                    {stripLines(m).map((line) => (
                      <span
                        key={line.text}
                        className={cn(
                          "text-[11px] font-semibold",
                          line.tone === "warn" ? "text-md-warning-800" : "text-md-ink-soft",
                        )}
                      >
                        {line.text}
                      </span>
                    ))}
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-1 text-[11.5px] leading-snug text-md-ink-soft">
            Staff: Generated = still open, HR can change it; Payment pending = Payroll Done pressed, locked, not paid
            yet; Paid = HR pressed Mark as Paid. Cleared alone is a check, not a payment. Production is paid once
            cleared. Provisional = staff slips generated before the month ended, which understate pay until payroll is
            regenerated.
          </p>
        </>
      )}
    </SectionCard>
  );
}

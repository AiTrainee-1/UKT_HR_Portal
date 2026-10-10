import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { inrCompact } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { STATE_STYLE, tickMonth } from "./logic";
import { CardError, failed } from "./parts";
import type { PayrollQueries } from "./queries";

/**
 * Which months have been generated and paid: twelve chips, newest on the right. A month is "Paid" when every slip's payroll
 * row is marked paid; there is no finalised switch in the system, so this is the nearest honest answer. Click a month to
 * look at it.
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
          <ol className="-mx-1 flex gap-2.5 overflow-x-auto px-1 pb-3 pt-1" data-testid="md-payroll-status-chips">
            {(data?.months ?? []).map((m) => {
              const style = STATE_STYLE[m.state];
              const clickable = m.slips > 0 || m.state === "not_generated";
              return (
                <li key={m.month} className="shrink-0">
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
                    {m.unpaidNet > 0 && m.slips > 0 && (
                      <span className="text-[10.5px] font-semibold text-md-warning-800">
                        {inrCompact(m.unpaidNet)} unpaid
                      </span>
                    )}
                    {m.provisionalSlips > 0 && (
                      <span className="text-[10.5px] font-semibold text-md-ink-soft">
                        {m.provisionalSlips} provisional
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-1 text-[11.5px] leading-snug text-md-ink-soft">
            Paid = every slip is marked paid. Provisional = staff slips generated before the month ended, which
            understate pay until payroll is regenerated.
          </p>
        </>
      )}
    </SectionCard>
  );
}

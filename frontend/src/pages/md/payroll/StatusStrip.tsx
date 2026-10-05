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
          <ol className="flex gap-2 overflow-x-auto pb-1" data-testid="md-payroll-status-chips">
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
                    className={cn(
                      "flex min-w-[5.5rem] flex-col items-start gap-0.5 rounded-xl border px-2.5 py-2 text-left transition-colors",
                      clickable ? "bg-white hover:border-[#006496]/40" : "cursor-default bg-slate-50/60 opacity-70",
                      selected === m.month && "border-[#006496] ring-1 ring-[#006496]/40",
                    )}
                  >
                    <span className="text-[13px] font-bold text-[#1a3a4a]">{tickMonth(m.month)}</span>
                    <span className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-600">
                      <i className={cn("h-2 w-2 rounded-full", style.dot)} />
                      {style.label}
                    </span>
                    {m.unpaidNet > 0 && m.slips > 0 && (
                      <span className="text-[10.5px] text-amber-700">{inrCompact(m.unpaidNet)} unpaid</span>
                    )}
                    {m.provisionalSlips > 0 && (
                      <span className="text-[10.5px] text-slate-500">{m.provisionalSlips} provisional</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-2 text-[11px] text-[#006496]/60">
            Paid = every slip is marked paid. Provisional = staff slips generated before the month ended, which
            understate pay until payroll is regenerated.
          </p>
        </>
      )}
    </SectionCard>
  );
}

import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { cn } from "@/lib/utils";
import { ruleLegend, ruleUpdatedText, type LegendItem } from "./logic";
import { QueryError } from "./parts";
import type { TeaRule } from "./types";

const DOT: Record<LegendItem["tone"], string> = {
  good: "bg-green-500",
  bad: "bg-red-500",
  muted: "bg-slate-300",
};

/** What counts as an overrun, in plain words: the allowance HR has set, how a break is classified from shortest to
 *  longest, and the rules that keep a missed scan from inflating the figures. */
export default function RuleCard({ query, ask }: { query: UseQueryResult<TeaRule>; ask: string }) {
  const rule = query.data;
  return (
    <SectionCard
      title="What counts as an overrun"
      subtitle="The tea-break rule HR has set, and how this page reads it"
      loading={query.isPending}
      provenance={rule?.provenance}
      actions={<AskAiButton question={ask} />}
      testId="md-tea-break-rule"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : rule ? (
        <div className="grid grid-cols-1 gap-5 @3xl:grid-cols-[11rem_1fr]">
          <div className="flex flex-col items-center justify-center rounded-2xl bg-blue-50 px-4 py-5 text-center">
            <p className="text-4xl font-black leading-none text-[#006496]" data-testid="md-tea-break-allowed">
              {rule.allowedMinutes}
            </p>
            <p className="mt-1 text-xs font-medium text-[#006496]/70">minutes allowed</p>
            <p className="mt-2 text-[11px] text-[#006496]/55">{ruleUpdatedText(rule)}</p>
          </div>
          <div className="min-w-0 space-y-4">
            <ul className="grid grid-cols-1 gap-2 @xl:grid-cols-2" data-testid="md-tea-break-legend">
              {ruleLegend(rule).map((item) => (
                <li key={item.id} className="flex items-start gap-2 rounded-xl border bg-white p-2.5">
                  <span className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-full", DOT[item.tone])} aria-hidden="true" />
                  <div>
                    <p className="text-[13px] font-bold text-[#1a3a4a]">{item.title}</p>
                    <p className="text-xs text-gray-600">{item.text}</p>
                  </div>
                </li>
              ))}
            </ul>
            <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-gray-700" data-testid="md-tea-break-statements">
              {rule.statements.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}

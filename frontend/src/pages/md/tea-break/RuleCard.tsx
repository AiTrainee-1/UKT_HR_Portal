import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { cn } from "@/lib/utils";
import { ruleLegend, ruleUpdatedText, type LegendItem } from "./logic";
import { QueryError } from "./parts";
import type { TeaRule } from "./types";

/** The dot in front of each class of break: sage is on time, crimson an overrun, grey the breaks the page leaves out. */
const DOT: Record<LegendItem["tone"], string> = {
  good: "md-analytics-tone-good",
  bad: "md-analytics-tone-bad",
  muted: "md-analytics-tone-neutral",
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
          <div className="md-panel-sand flex flex-col items-center justify-center px-4 py-6 text-center">
            <p
              className="text-5xl font-black leading-none tabular-nums text-md-wine"
              data-testid="md-tea-break-allowed"
            >
              {rule.allowedMinutes}
            </p>
            <p className="mt-2 text-xs font-semibold text-md-ink">minutes allowed</p>
            <p className="mt-2 text-[11px] text-md-ink-soft">{ruleUpdatedText(rule)}</p>
          </div>
          <div className="min-w-0 space-y-4">
            <ul className="grid grid-cols-1 gap-2.5 @xl:grid-cols-2" data-testid="md-tea-break-legend">
              {ruleLegend(rule).map((item) => (
                <li key={item.id} className="md-panel flex items-start gap-3 p-3 text-[13px] leading-5">
                  <span className={cn("md-analytics-dot", DOT[item.tone])} aria-hidden="true" />
                  <div>
                    <p className="text-[13px] font-bold text-md-ink">{item.title}</p>
                    <p className="text-xs text-md-ink-soft">{item.text}</p>
                  </div>
                </li>
              ))}
            </ul>
            <ul
              className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-md-ink marker:text-md-wine-400"
              data-testid="md-tea-break-statements"
            >
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

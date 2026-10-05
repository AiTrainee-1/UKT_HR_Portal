import AskAiButton from "@/components/md/kit/AskAiButton";
import { sortInsights, toInsight } from "@/components/md/kit/dto";
import InsightList from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import { Unavailable } from "./parts";
import type { EmployeesInsights } from "./types";

/** "Needs your attention": hot-spots, early leavers, a shrinking workforce, staffing gaps, and the good news. */
export default function AttentionCard({
  insights,
  question,
  failed,
}: {
  insights: EmployeesInsights | undefined;
  question: string;
  failed?: boolean;
}) {
  const items = insights ? sortInsights(insights.items.map(toInsight)) : [];
  const more = insights ? insights.total - insights.items.length : 0;
  return (
    <SectionCard
      title="Needs your attention"
      subtitle="Found automatically from the same figures as the cards below"
      provenance={insights?.provenance}
      loading={!insights && !failed}
      actions={<AskAiButton question={question} />}
      testId="md-employees-attention"
    >
      {insights ? (
        <InsightList items={items} emptyText="Nothing in the workforce needs your attention for this period." />
      ) : (
        <Unavailable />
      )}
      {more > 0 && (
        <p className="mt-2 text-center text-xs text-muted-foreground">And {more} more, lower on the list.</p>
      )}
    </SectionCard>
  );
}

import AskAiButton from "@/components/md/kit/AskAiButton";
import { sortInsights, toInsight } from "@/components/md/kit/dto";
import InsightList from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import { moreText } from "./logic";
import { Unavailable } from "./parts";
import type { DashboardOverview } from "./types";

/** "Needs your attention": the most serious items from every page, merged and ranked, each with a way to its page. */
export default function AttentionCard({
  overview,
  failed,
}: {
  overview: DashboardOverview | undefined;
  failed?: boolean;
}) {
  const items = overview ? sortInsights(overview.insights.map(toInsight)) : [];
  const more = overview ? moreText(overview.insightsTotal, overview.insights.length) : null;
  return (
    <SectionCard
      title="Needs your attention"
      subtitle="From every page, most serious first"
      provenance={overview?.provenance}
      provenanceIds={["dashboard-attention"]}
      loading={!overview && !failed}
      actions={<AskAiButton question="What needs my attention first today, and why?" />}
      testId="md-dashboard-attention"
    >
      {overview ? (
        <InsightList items={items} emptyText="Nothing across the company needs your attention right now." />
      ) : (
        <Unavailable />
      )}
      {more && (
        <p className="mt-2 text-center text-xs text-muted-foreground" data-testid="md-dashboard-attention-more">
          {more}
        </p>
      )}
    </SectionCard>
  );
}

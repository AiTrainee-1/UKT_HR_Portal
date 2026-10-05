import AskAiButton from "@/components/md/kit/AskAiButton";
import { sortInsights, toInsight } from "@/components/md/kit/dto";
import InsightList from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import { QueryError } from "./parts";
import type { QueryLike, RecruitmentAttention } from "./types";

/** "Needs your attention": the exceptions the server found for the chosen period and part of the company, most severe
 *  first, each with a link to the detail and an Explain button. */
export default function AttentionCard({ query }: { query: QueryLike<RecruitmentAttention> }) {
  // the page link is for the Dashboard: here every item is already on the page it points to, so only "Explain" is offered
  const items = sortInsights((query.data?.items ?? []).map((item) => toInsight({ ...item, page: null })));
  return (
    <SectionCard
      testId="md-recruitment-attention"
      title="Needs your attention"
      subtitle="Positions open too long, resignations waiting, departments losing people, and where candidates drop out"
      loading={query.isPending}
      provenance={query.data?.provenance}
      actions={<AskAiButton question="What should I look at first in recruitment, and why?" />}
    >
      <QueryError query={query} />
      {query.data && <InsightList items={items} emptyText="Nothing in recruitment needs your attention right now." />}
    </SectionCard>
  );
}

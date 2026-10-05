import type { UseQueryResult } from "@tanstack/react-query";
import InsightList from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import { sortInsights, toInsight } from "@/components/md/kit/dto";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { QueryError, refreshingClass } from "./parts";
import type { TeaAttention } from "./types";

/** "Needs your attention": what stands out in the chosen period and selection, worst first, each with an Explain
 *  button. The links point at this very page, so they are left out. */
export default function AttentionCard({ query, ask }: { query: UseQueryResult<TeaAttention>; ask: string }) {
  const items = sortInsights(query.data?.items ?? []).map((dto) => toInsight({ ...dto, page: null }));
  return (
    <SectionCard
      title="Needs your attention"
      subtitle="What stands out in this period, worst first"
      loading={query.isPending}
      provenance={query.data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-tea-break-attention"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : (
        <InsightList items={items} emptyText="Nothing needs your attention in this period." />
      )}
    </SectionCard>
  );
}

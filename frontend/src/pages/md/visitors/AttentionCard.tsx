import type { UseQueryResult } from "@tanstack/react-query";
import { ErrorBanner } from "@/components/md/kit/states";
import InsightList from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import { sortInsights, toInsight } from "@/components/md/kit/dto";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import type { ExceptionsResponse } from "./types";

/** "Needs your attention": what the gate data flags in the chosen period, most serious first, each with the number, the
 *  reason and a question to ask. (The page is already open, so the findings do not link back to it.) */
export default function AttentionCard({ query }: { query: UseQueryResult<ExceptionsResponse> }) {
  const data = query.isError ? undefined : query.data;
  const items = sortInsights(data?.attention ?? []).map((dto) => ({ ...toInsight(dto), page: undefined }));
  return (
    <SectionCard
      title="Needs your attention"
      subtitle="Found in the chosen period. Requests waiting for approval are live and cover all dates."
      loading={query.isPending}
      provenance={data?.provenance}
      provenanceIds={["exceptions"]}
      testId="md-visitors-attention"
    >
      {query.isError ? (
        <ErrorBanner message={describeMdError(query.error)} onRetry={() => query.refetch()} />
      ) : (
        <InsightList items={items} emptyText="Nothing needs your attention at the gate in this period." />
      )}
    </SectionCard>
  );
}

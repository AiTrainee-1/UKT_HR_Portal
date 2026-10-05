import AskAiButton from "@/components/md/kit/AskAiButton";
import { sortInsights, toInsight } from "@/components/md/kit/dto";
import InsightList from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import { ErrorBanner } from "@/components/md/kit/states";
import { describeMdError, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { ask } from "./logic";
import type { ActivityAttention } from "./types";

/** Exceptions first: what stands out in the last 7 days. The same checks the dashboard shows; they do not follow the
 *  period chosen on the page, which is why the card says so. */
export default function AttentionCard() {
  const q = useMdQuery<ActivityAttention>("activity/attention");
  // every item points at this very page, so the "go to the page" link is left off
  const items = sortInsights(q.data?.insights ?? []).map((i) => ({ ...toInsight(i), page: undefined }));
  return (
    <SectionCard
      title="Needs your attention"
      subtitle="What stands out in the last 7 days, whichever period is chosen below"
      provenance={q.data?.provenance}
      loading={q.isPending}
      actions={<AskAiButton question={ask.attention()} />}
      testId="md-activity-attention"
    >
      {q.isError ? (
        <ErrorBanner message={describeMdError(q.error)} onRetry={() => q.refetch()} />
      ) : (
        <InsightList items={items} />
      )}
    </SectionCard>
  );
}

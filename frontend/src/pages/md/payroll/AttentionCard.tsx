import AskAiButton from "@/components/md/kit/AskAiButton";
import InsightList, { type Insight } from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import { CardError, failed } from "./parts";
import type { PayrollQueries } from "./queries";
import type { AttentionItem } from "./types";

/** The server's finding as the list shows it. No "go to the page" link: this IS the page. */
const toInsight = (item: AttentionItem): Insight => ({
  id: item.id,
  severity: item.severity,
  title: item.title,
  detail: item.detail,
  metric: item.metric ?? undefined,
  ask: item.ask,
});

/** Exceptions first: the status of the month, a cost jump or fall and its main driver, overtime, exceptions, advances. */
export default function AttentionCard({ query, label }: { query: PayrollQueries["attention"]; label: string }) {
  return (
    <SectionCard
      testId="md-payroll-attention"
      title="Needs your attention"
      subtitle={`What stands out in ${label}, most serious first`}
      loading={query.isPending}
      provenance={query.data?.provenance}
      actions={<AskAiButton question={`What needs my attention in payroll for ${label}?`} />}
    >
      {failed(query) ? (
        <CardError query={query} />
      ) : (
        <InsightList
          items={(query.data?.items ?? []).map(toInsight)}
          emptyText="Nothing needs your attention in payroll."
        />
      )}
    </SectionCard>
  );
}

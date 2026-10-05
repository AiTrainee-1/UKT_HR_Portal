import { toInsight } from "@/components/md/kit/dto";
import AskAiButton from "@/components/md/kit/AskAiButton";
import InsightList from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import type { UseQueryResult } from "@tanstack/react-query";
import CardBody from "./CardBody";
import { ask, type AskContext } from "./logic";
import type { AttendanceExceptions } from "./types";

/** "Needs your attention": the findings of the period, most severe first, each with a question for the assistant. */
export default function AttentionCard({
  query,
  context,
}: {
  query: UseQueryResult<AttendanceExceptions>;
  context: AskContext;
}) {
  return (
    <SectionCard
      testId="md-attendance-attention"
      title="Needs your attention"
      subtitle="Exceptions found in this period, most serious first"
      loading={query.isPending}
      provenance={query.data?.provenance}
      actions={<AskAiButton question={ask.page(context)} label="Brief me" />}
    >
      <CardBody query={query}>
        {(data) => (
          <InsightList items={data.attention.map(toInsight)} emptyText="Nothing needs your attention in this period." />
        )}
      </CardBody>
    </SectionCard>
  );
}

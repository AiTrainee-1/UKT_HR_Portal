import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import BriefingList from "../shared/BriefingList";
import { QueryError, refreshingClass } from "./parts";
import type { GeoBriefing } from "./types";

/** The page in a few plain sentences, written by the server from the very figures on this page (no AI, no quota). The
 *  "Explain with AI" button hands the question to the assistant, which explains on demand. */
export default function BriefingCard({ query, ask }: { query: UseQueryResult<GeoBriefing>; ask: string }) {
  const data = query.data;
  return (
    <SectionCard
      title="In plain words"
      subtitle="Written from the figures below by fixed rules: no AI is asked until you press Explain"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={data?.ask || ask} label="Explain with AI" />}
      bodyClassName={refreshingClass(query)}
      testId="md-geo-briefing"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data && data.sentences.length > 0 ? (
        <BriefingList sentences={data.sentences} testIdPrefix="md-geo-sentence" />
      ) : data ? (
        <EmptyBlock title="Nothing to say yet">There are no on-duty records for this selection.</EmptyBlock>
      ) : null}
    </SectionCard>
  );
}

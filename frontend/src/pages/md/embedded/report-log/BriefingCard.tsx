import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { cn } from "@/lib/utils";
import { QueryError, refreshingClass } from "./parts";
import type { RlBriefing } from "./types";

const DOT: Record<string, string> = { good: "bg-green-500", bad: "bg-red-500", neutral: "bg-[#006496]" };

/** The page in a few plain sentences, written by the server from the very figures on this page (no AI, no quota). The
 *  "Explain with AI" button hands the question to the assistant, which explains on demand. */
export default function BriefingCard({ query, ask }: { query: UseQueryResult<RlBriefing>; ask: string }) {
  const data = query.data;
  return (
    <SectionCard
      title="In plain words"
      subtitle="Written from the figures below by fixed rules: no AI is asked until you press Explain"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={data?.ask || ask} label="Explain with AI" />}
      bodyClassName={refreshingClass(query)}
      testId="md-reportlog-briefing"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data && data.sentences.length > 0 ? (
        <ul className="space-y-2.5">
          {data.sentences.map((s) => (
            <li key={s.id} className="flex gap-2.5 text-sm text-gray-800" data-testid={`md-reportlog-sentence-${s.id}`}>
              <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT[s.tone] ?? DOT.neutral)} />
              <span>{s.text}</span>
            </li>
          ))}
        </ul>
      ) : data ? (
        <EmptyBlock title="Nothing to say yet">There are no attendance records for this selection.</EmptyBlock>
      ) : null}
    </SectionCard>
  );
}

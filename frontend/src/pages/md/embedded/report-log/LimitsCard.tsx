import type { UseQueryResult } from "@tanstack/react-query";
import { Info } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import type { RlSummary } from "./types";

/** What this page cannot tell the MD. The Report Log is HR's absence report and attendance register, not a list of reports
 *  produced or sent: stating the gaps plainly is better than letting a missing number read as "nothing happened". */
export default function LimitsCard({ query, ask }: { query: UseQueryResult<RlSummary>; ask: string }) {
  const unknowns = query.data?.unknowns ?? [];
  if (!query.data || unknowns.length === 0) return null;
  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-1.5">
          <Info size={14} className="text-md-wine" /> What this page cannot tell you
        </span>
      }
      subtitle="The data behind the Report Log does not record these, so no figure is shown for them"
      actions={<AskAiButton question={ask} />}
      testId="md-reportlog-limits"
    >
      <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-md-ink marker:text-md-wine-400">
        {unknowns.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </SectionCard>
  );
}

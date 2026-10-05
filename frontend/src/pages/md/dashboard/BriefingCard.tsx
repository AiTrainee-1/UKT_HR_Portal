import { ArrowUpRight, Sparkles } from "lucide-react";
import { Link } from "wouter";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { MD_NAV_BY_ID } from "@/components/md/md-nav";
import { MD_GOLD_GRADIENT } from "@/components/md/MdSidebar";
import { cn } from "@/lib/utils";
import { BRIEFING_QUESTION } from "./logic";
import { Unavailable } from "./parts";
import type { BriefingTone, DashboardOverview } from "./types";

const DOT: Record<BriefingTone, string> = {
  good: "bg-green-500",
  watch: "bg-amber-500",
  neutral: "bg-[#006496]/35",
};

/**
 * Today's briefing: a few plain sentences with the numbers, written by fixed rules on the server (no AI), each ending
 * with a link to the page it came from, and a button that asks the assistant for the full version.
 */
export default function BriefingCard({
  overview,
  failed,
}: {
  overview: DashboardOverview | undefined;
  failed?: boolean;
}) {
  const briefing = overview?.briefing;
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <Sparkles size={15} className="text-[#e0a83a]" aria-hidden />
          Today's briefing
        </span>
      }
      subtitle="What to know first, in plain words. Every number is on the cards below."
      provenance={overview?.provenance}
      provenanceIds={["dashboard-briefing"]}
      loading={!overview && !failed}
      testId="md-dashboard-briefing"
    >
      <span
        aria-hidden
        className="absolute bottom-5 left-0 top-5 w-1 rounded-r-full"
        style={{ background: MD_GOLD_GRADIENT }}
      />
      {!briefing ? (
        <Unavailable />
      ) : (
        <div className="space-y-4">
          <ol className="space-y-3">
            {briefing.sentences.map((s) => {
              const page = s.page ? MD_NAV_BY_ID[s.page] : undefined;
              return (
                <li key={s.id} className="flex gap-3" data-testid={`md-briefing-${s.id}`} data-tone={s.tone}>
                  <span aria-hidden className={cn("mt-2 h-2 w-2 shrink-0 rounded-full", DOT[s.tone])} />
                  <p className="min-w-0 flex-1 text-[15px] leading-relaxed text-[#1a3a4a]">
                    {s.text}
                    {page && (
                      <>
                        {" "}
                        <Link
                          href={page.path}
                          className="inline-flex items-center gap-0.5 whitespace-nowrap rounded-full bg-[#006496]/[0.07] px-2 py-0.5 align-baseline text-[11px] font-semibold text-[#006496] hover:bg-[#006496]/[0.12]"
                        >
                          {page.navLabel ?? page.title} <ArrowUpRight size={11} />
                        </Link>
                      </>
                    )}
                  </p>
                </li>
              );
            })}
          </ol>
          <AskAiButton size="md" label="Ask AI for the full briefing" question={briefing.ask || BRIEFING_QUESTION} />
        </div>
      )}
    </SectionCard>
  );
}

import { ArrowUpRight, Sparkles } from "lucide-react";
import { Link } from "wouter";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { MD_NAV_BY_ID } from "@/components/md/md-nav";
import { cn } from "@/lib/utils";
import { BRIEFING_QUESTION } from "./logic";
import { Unavailable } from "./parts";
import type { BriefingTone, DashboardOverview } from "./types";

/** The dot before each sentence: sage for good news, ochre for something to watch, wine-tinted for the rest. */
const DOT: Record<BriefingTone, string> = {
  good: "bg-md-success-500 ring-md-success-500/20",
  watch: "bg-md-warning-400 ring-md-warning-400/25",
  neutral: "bg-md-wine/60 ring-md-wine/15",
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
        <span className="flex items-center gap-2.5">
          <span className="md-dashboard-icon md-dashboard-icon-sm md-dashboard-icon-wine">
            <Sparkles size={15} aria-hidden />
          </span>
          Today's briefing
        </span>
      }
      subtitle="What to know first, in plain words. Every number is on the cards below."
      provenance={overview?.provenance}
      provenanceIds={["dashboard-briefing"]}
      loading={!overview && !failed}
      className="md-dashboard-card md-dashboard-briefing"
      testId="md-dashboard-briefing"
    >
      <span aria-hidden className="md-dashboard-accent-bar" />
      {!briefing ? (
        <Unavailable />
      ) : (
        <div className="space-y-5">
          <ol className="space-y-3.5">
            {briefing.sentences.map((s) => {
              const page = s.page ? MD_NAV_BY_ID[s.page] : undefined;
              return (
                <li key={s.id} className="flex gap-3.5" data-testid={`md-briefing-${s.id}`} data-tone={s.tone}>
                  <span aria-hidden className={cn("mt-[0.6rem] h-2 w-2 shrink-0 rounded-full ring-4", DOT[s.tone])} />
                  <p className="min-w-0 flex-1 text-[15px] leading-relaxed text-md-ink">
                    {s.text}
                    {page && (
                      <>
                        {" "}
                        <Link
                          href={page.path}
                          className="md-chip md-chip-wine md-dashboard-linkchip whitespace-nowrap align-baseline"
                        >
                          {page.navLabel ?? page.title} <ArrowUpRight size={11} aria-hidden />
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

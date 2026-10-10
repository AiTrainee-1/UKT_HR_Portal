import { useState } from "react";
import MdLayout from "@/components/md/MdLayout";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { describeMdError, useMdMe, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import AttentionCard from "../dashboard/AttentionCard";
import BriefingCard from "../dashboard/BriefingCard";
import ExploreSection from "../dashboard/ExploreSection";
import { assistantContext, failedSources, failureMessage, pageNotes } from "../dashboard/logic";
import TrendsSection from "../dashboard/TrendsSection";
import type { DashboardOverview, DashboardTrends } from "../dashboard/types";
import CommandHeader from "./CommandHeader";
import RequestsWaiting from "./RequestsWaiting";
import Pulse from "./Pulse";
import TodayUnits from "./TodayUnits";
import Tools from "./Tools";

/** The numbers are live (people punching in), so the overview refreshes itself once a minute while the tab is open. */
const REFRESH_MS = 60_000;

/**
 * The Managing Director's dashboard: a command centre, not a copy of the HR dashboard.
 *
 *   hero         the date and the greeting (the page's heading: this page has no title strip of its own, by the owner's
 *                choice), what wants the MD today, and the Ask bar that opens the AI assistant; "Give me a briefing"
 *                is its first suggestion
 *   pulse        the company's headline figures, each with its change and a way into its page
 *   main column  the briefing, today at the factory (every unit), what needs attention, the trends
 *   right rail   the requests waiting (to look at: HR and the Department Heads decide them), quick actions, and what only
 *                the Admin can open
 *   explore      a tile for every other page
 *
 * Every figure comes from the same analytics the pages use (nothing is recalculated here); a part that cannot be read
 * says so in place and the rest stays usable. Links go only to pages the MD can open; what only the Admin may open is
 * shown locked and says so when pressed (see Tools.tsx).
 */
export default function MdDashboardHome() {
  const me = useMdMe();
  const overview = useMdQuery<DashboardOverview>("dashboard/overview", undefined, {
    refetchInterval: REFRESH_MS,
    staleTime: 20_000,
  });
  const trends = useMdQuery<DashboardTrends>("dashboard/trends", undefined, { staleTime: 2 * 60_000 });
  const data = overview.data;
  const [waiting, setWaiting] = useState(0);
  usePublishAssistantContext(assistantContext(data));

  const unreadable = failedSources(data);
  const notes = pageNotes(data?.notes);
  const retryOverview = () => void overview.refetch();

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1600px] space-y-6" data-testid="md-dashboard-page">
        <CommandHeader
          name={me.data?.name}
          serverTime={me.data?.serverTime}
          attention={data?.insightsTotal ?? 0}
          waiting={waiting}
        />

        {overview.isError && (
          <ErrorBanner message={`The overview: ${describeMdError(overview.error)}`} onRetry={retryOverview} />
        )}
        {!overview.isError && unreadable.length > 0 && (
          <ErrorBanner message={failureMessage(unreadable)} onRetry={retryOverview} />
        )}
        {notes.length > 0 && (
          <NoteBanner>
            {notes.map((n) => (
              <span key={n} className="block">
                {n}
              </span>
            ))}
          </NoteBanner>
        )}

        <Pulse overview={data} failed={overview.isError} />

        <div className="grid grid-cols-1 items-start gap-6 @5xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 space-y-6">
            <BriefingCard overview={data} failed={overview.isError} />
            <TodayUnits overview={data} failed={overview.isError} />
            <AttentionCard overview={data} failed={overview.isError} />
            <TrendsSection query={trends} />
          </div>
          <aside className="min-w-0 space-y-6 @5xl:sticky @5xl:top-2" data-testid="md-home-rail">
            <RequestsWaiting onTotal={setWaiting} />
            <Tools />
          </aside>
        </div>

        <ExploreSection pages={me.data?.pages} />
      </div>
    </MdLayout>
  );
}

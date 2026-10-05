import MdLayout from "@/components/md/MdLayout";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { describeMdError, useMdMe, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import AttentionCard from "./dashboard/AttentionCard";
import BriefingCard from "./dashboard/BriefingCard";
import ExploreSection from "./dashboard/ExploreSection";
import Hero from "./dashboard/Hero";
import KpiStrip from "./dashboard/KpiStrip";
import { assistantContext, failedSources, failureMessage, pageNotes } from "./dashboard/logic";
import TrendsSection from "./dashboard/TrendsSection";
import type { DashboardOverview, DashboardTrends } from "./dashboard/types";
import UnitsCard from "./dashboard/UnitsCard";

/** The numbers are live (people punching in), so the overview refreshes itself once a minute while the tab is open. */
const REFRESH_MS = 60_000;

/**
 * Dashboard: "how is the company today, what changed, and what needs me?" in under a minute. The overview (briefing,
 * cards, exceptions, today by unit) and the trends are two requests, so the first paints without waiting for the
 * charts; a part that cannot be read says so inline and the rest stays usable.
 */
export default function MdDashboard() {
  const me = useMdMe();
  const overview = useMdQuery<DashboardOverview>("dashboard/overview", undefined, {
    refetchInterval: REFRESH_MS,
    staleTime: 20_000,
  });
  const trends = useMdQuery<DashboardTrends>("dashboard/trends", undefined, { staleTime: 2 * 60_000 });
  const data = overview.data;
  usePublishAssistantContext(assistantContext(data));

  const unreadable = failedSources(data);
  const notes = pageNotes(data?.notes);
  const retryOverview = () => void overview.refetch();
  const refreshAll = () => {
    void overview.refetch();
    void trends.refetch();
  };

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-5" data-testid="md-dashboard-page">
        <Hero
          name={me.data?.name}
          serverTime={me.data?.serverTime}
          today={data?.today}
          generatedAt={data?.generatedAt}
          refreshing={overview.isFetching || trends.isFetching}
          onRefresh={refreshAll}
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
              <p key={n}>{n}</p>
            ))}
          </NoteBanner>
        )}

        <BriefingCard overview={data} failed={overview.isError} />
        <KpiStrip overview={data} failed={overview.isError} />

        <div className="@container">
          <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
            <div className="min-w-0 @4xl:col-span-7">
              <AttentionCard overview={data} failed={overview.isError} />
            </div>
            <div className="min-w-0 @4xl:col-span-5">
              <UnitsCard overview={data} failed={overview.isError} onRetry={retryOverview} />
            </div>
          </div>
        </div>

        <TrendsSection query={trends} />
        <ExploreSection pages={me.data?.pages} />
      </div>
    </MdLayout>
  );
}

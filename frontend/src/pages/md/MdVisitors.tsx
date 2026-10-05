import { useMemo, useState } from "react";
import { DoorOpen } from "lucide-react";
import MdLayout from "@/components/md/MdLayout";
import { FilterBar, PeriodBar, ScopeBar } from "@/components/md/kit/FilterBar";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { describeMdError, useMdOrg, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { EVERYONE, periodParams, scopeParams, type PeriodChoice, type ScopeChoice } from "@/lib/md/period";
import ActivityCard from "./visitors/ActivityCard";
import AttentionCard from "./visitors/AttentionCard";
import ExceptionsCard from "./visitors/ExceptionsCard";
import KpiStrip from "./visitors/KpiStrip";
import { assistantContext, bannerNotes } from "./visitors/logic";
import OutpassSection from "./visitors/OutpassSection";
import TrendCard from "./visitors/TrendCard";
import UnitsCard from "./visitors/UnitsCard";
import type {
  ExceptionsResponse,
  OutpassResponse,
  SummaryResponse,
  TrendResponse,
  UnitsResponse,
  VisitorsResponse,
} from "./visitors/types";
import VisitorsSection from "./visitors/VisitorsSection";

/**
 * Outpass & Visitors: who is coming into the premises, who is leaving during the shift, and is it under control?
 * Exceptions first (what needs attention), then the trend, then visitors, outpasses, the people behind the findings and
 * the newest activity. Every figure carries its "how is this calculated?" and a question for the assistant.
 */
export default function MdVisitors() {
  const [period, setPeriod] = useState<PeriodChoice>({ preset: "last_30_days" });
  const [scope, setScope] = useState<ScopeChoice>(EVERYONE);
  const params = useMemo(() => ({ ...periodParams(period), ...scopeParams(scope) }), [period, scope]);

  const org = useMdOrg();
  const summary = useMdQuery<SummaryResponse>("visitors/summary", params);
  const trend = useMdQuery<TrendResponse>("visitors/trend", params);
  const units = useMdQuery<UnitsResponse>("visitors/units", params);
  const visitors = useMdQuery<VisitorsResponse>("visitors/visitors", { ...params, limit: 10 });
  const outpass = useMdQuery<OutpassResponse>("visitors/outpass", { ...params, limit: 25 });
  const exceptions = useMdQuery<ExceptionsResponse>("visitors/exceptions", { ...params, limit: 25 });

  // a failed load shows an error, not the figures of the previous filter
  const headline = summary.isError ? undefined : summary.data;

  usePublishAssistantContext(
    assistantContext({
      periodLabel: headline?.period?.label ?? "",
      scopeText: headline?.scope?.description ?? "All units · all departments · staff and production",
      summary: headline,
    }),
  );

  const notes = bannerNotes(headline?.notes, headline?.period?.days);

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-5" data-testid="md-visitors-page">
        <MdPageHeader
          icon={DoorOpen}
          title="Outpass & Visitors"
          subtitle="Who is coming in, who is leaving during the shift, and whether it is under control."
          updatedAt={headline?.generatedAt}
        />

        <FilterBar>
          <PeriodBar value={period} onChange={setPeriod} />
          <ScopeBar value={scope} onChange={setScope} org={org.data} />
          <span className="hidden max-w-sm text-[11px] leading-snug text-[#006496]/55 xl:inline">
            Unit narrows everything. Department and staff or production apply to the employee who leaves and to the
            person visited.
          </span>
        </FilterBar>

        {summary.isError && <ErrorBanner message={describeMdError(summary.error)} onRetry={() => summary.refetch()} />}
        {notes.map((note) => (
          <NoteBanner key={note}>{note}</NoteBanner>
        ))}

        <KpiStrip summary={headline} loading={summary.isPending} />
        <AttentionCard query={exceptions} />
        <TrendCard query={trend} />
        <UnitsCard query={units} />
        <VisitorsSection query={visitors} />
        <OutpassSection query={outpass} />
        <ExceptionsCard query={exceptions} />
        <ActivityCard params={params} />
      </div>
    </MdLayout>
  );
}

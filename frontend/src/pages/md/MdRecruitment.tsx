import { useState } from "react";
import { UserPlus } from "lucide-react";
import MdLayout from "@/components/md/MdLayout";
import { FilterBar, PeriodBar, ScopeBar } from "@/components/md/kit/FilterBar";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { describeMdError, useMdOrg, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { EVERYONE, periodParams, scopeParams, type PeriodChoice, type ScopeChoice } from "@/lib/md/period";
import AttentionCard from "./recruitment/AttentionCard";
import FunnelSection from "./recruitment/FunnelSection";
import JoinersSection from "./recruitment/JoinersSection";
import KpiStrip from "./recruitment/KpiStrip";
import {
  DEFAULT_PERIOD,
  PERIOD_PRESETS,
  assistantSummary,
  collectNotes,
  periodText,
  scopeText,
} from "./recruitment/logic";
import PositionsSection from "./recruitment/PositionsSection";
import ResignationsSection from "./recruitment/ResignationsSection";
import type {
  RecruitmentAttention,
  RecruitmentFunnel,
  RecruitmentJoiners,
  RecruitmentPositions,
  RecruitmentResignations,
  RecruitmentSources,
  RecruitmentSummary,
  RecruitmentTrend,
} from "./recruitment/types";

const PATH = "recruitment";

/**
 * Recruitment: "are we hiring enough, fast enough, and keeping the people we hire?" Exceptions first, then the
 * funnel, open positions and the staffing gap, resignations, and joiners against leavers. Every card compares with
 * something, explains how it is calculated, and offers to ask the assistant.
 */
export default function MdRecruitment() {
  const [period, setPeriod] = useState<PeriodChoice>(DEFAULT_PERIOD);
  const [scope, setScope] = useState<ScopeChoice>(EVERYONE);
  const org = useMdOrg();

  const scopeQuery = scopeParams(scope);
  const params = { ...periodParams(period), ...scopeQuery };

  const summary = useMdQuery<RecruitmentSummary>(`${PATH}/summary`, params);
  const attention = useMdQuery<RecruitmentAttention>(`${PATH}/attention`, params);
  const funnel = useMdQuery<RecruitmentFunnel>(`${PATH}/funnel`, params);
  const sources = useMdQuery<RecruitmentSources>(`${PATH}/sources`, params);
  const positions = useMdQuery<RecruitmentPositions>(`${PATH}/positions`, scopeQuery);
  const resignations = useMdQuery<RecruitmentResignations>(`${PATH}/resignations`, { ...params, limit: 25 });
  const joiners = useMdQuery<RecruitmentJoiners>(`${PATH}/joiners`, { ...params, limit: 25 });
  const trend = useMdQuery<RecruitmentTrend>(`${PATH}/trend`, scopeQuery);

  usePublishAssistantContext({
    page: "recruitment",
    title: "Recruitment",
    filters: { Period: periodText(period, summary.data?.period?.label), Scope: scopeText(scope, org.data) },
    summary: summary.data ? assistantSummary(summary.data.current) : undefined,
  });

  const notes = collectNotes(summary.data, positions.data, trend.data, funnel.data);

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-5" data-testid="md-recruitment">
        <MdPageHeader
          icon={UserPlus}
          title="Recruitment"
          subtitle="Are we hiring enough, fast enough, and keeping the people we hire?"
          updatedAt={summary.data?.generatedAt}
        />
        <FilterBar>
          <div className="min-w-0 max-w-full overflow-x-auto">
            <PeriodBar value={period} onChange={setPeriod} presets={PERIOD_PRESETS} />
          </div>
          <ScopeBar value={scope} onChange={setScope} org={org.data} />
        </FilterBar>

        {summary.isError && !summary.data && (
          <ErrorBanner message={describeMdError(summary.error)} onRetry={() => void summary.refetch()} />
        )}
        {notes.map((note) => (
          <NoteBanner key={note}>{note}</NoteBanner>
        ))}

        <KpiStrip query={summary} />
        <AttentionCard query={attention} />
        <FunnelSection funnel={funnel} sources={sources} />
        <PositionsSection query={positions} />
        <ResignationsSection query={resignations} />
        <JoinersSection trend={trend} joiners={joiners} />
      </div>
    </MdLayout>
  );
}

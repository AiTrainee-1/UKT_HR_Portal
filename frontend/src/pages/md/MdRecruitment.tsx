import { useLocation } from "wouter";
import { UserPlus } from "lucide-react";
import { FilterBar, PeriodBar, ScopeBar } from "@/components/md/kit/FilterBar";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import { MonthPicker, monthLabel, monthRange, thisMonthKey } from "@/components/md/kit/MonthPicker";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import MdLayout from "@/components/md/MdLayout";
import { describeMdError, useMdOrg, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { scopeParams } from "@/lib/md/period";
import {
  monthFromParams,
  monthPatch,
  oneOf,
  periodFromParams,
  periodKey,
  periodPatch,
  periodQuery,
  scopeFromParams,
  scopePatch,
  useUrlParams,
} from "@/lib/md/url-filters";
import { Pills } from "./approvals/parts";
import AttentionCard from "./recruitment/AttentionCard";
import { employeeHref, PositionSheet, ResignationSheet } from "./recruitment/DetailSheets";
import FunnelSection from "./recruitment/FunnelSection";
import JoinersSection from "./recruitment/JoinersSection";
import KpiStrip from "./recruitment/KpiStrip";
import {
  DEFAULT_PERIOD,
  PERIOD_PRESETS,
  VIEWS,
  assistantSummary,
  collectNotes,
  overviewText,
  periodText,
  scopeText,
  shows,
  type RecruitmentView,
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
const VIEW_IDS = VIEWS.map((v) => v.value);

/**
 * Recruitment: "are we hiring enough, fast enough, and keeping the people we hire?" Exceptions first, then the
 * funnel, open positions and the staffing gap, resignations (with what was decided and why), and joiners against leavers.
 * Every card compares with something, explains how it is calculated, and offers to ask the assistant.
 *
 * 2026-11-21: the period (presets, a custom range or a month), the unit / department / staff-production scope and the
 * part of recruitment shown (`view`) live in the address; a two-sentence overview leads; a resignation, a position or an
 * employee opens its detail on click (the resignation and the position in a side sheet, also kept in the address).
 */
export default function MdRecruitment() {
  const [params, update] = useUrlParams();
  const [, navigate] = useLocation();
  const month = monthFromParams(params);
  const period = periodFromParams(params, DEFAULT_PERIOD);
  const scope = scopeFromParams(params);
  const view = oneOf<RecruitmentView>(params, "view", VIEW_IDS, "all");
  const resignationId = Number(params.get("resignation")) || null;
  const positionId = Number(params.get("position")) || null;
  const org = useMdOrg();

  const scopeQuery = scopeParams(scope);
  const query = { ...periodQuery(period, month), ...scopeQuery };

  const summary = useMdQuery<RecruitmentSummary>(`${PATH}/summary`, query);
  const attention = useMdQuery<RecruitmentAttention>(`${PATH}/attention`, query);
  const funnel = useMdQuery<RecruitmentFunnel>(`${PATH}/funnel`, query, { enabled: shows(view, "hiring") });
  const sources = useMdQuery<RecruitmentSources>(`${PATH}/sources`, query, { enabled: shows(view, "hiring") });
  const positions = useMdQuery<RecruitmentPositions>(`${PATH}/positions`, scopeQuery, {
    enabled: shows(view, "hiring") || positionId != null,
  });
  const resignations = useMdQuery<RecruitmentResignations>(
    `${PATH}/resignations`,
    { ...query, limit: 25 },
    { enabled: shows(view, "resignations") },
  );
  const joiners = useMdQuery<RecruitmentJoiners>(
    `${PATH}/joiners`,
    { ...query, limit: 25 },
    { enabled: shows(view, "joiners") },
  );
  const trend = useMdQuery<RecruitmentTrend>(`${PATH}/trend`, scopeQuery, { enabled: shows(view, "joiners") });

  const label = periodText(period, summary.data?.period?.label ?? (month ? monthLabel(month) : undefined));
  usePublishAssistantContext({
    page: "recruitment",
    title: "Recruitment",
    filters: {
      Period: label,
      Scope: scopeText(scope, org.data),
      ...(view !== "all" ? { Showing: VIEWS.find((v) => v.value === view)?.label ?? view } : {}),
    },
    summary: summary.data ? assistantSummary(summary.data.current) : undefined,
  });

  const notes = collectNotes(summary.data, positions.data, trend.data, funnel.data);
  const openPosition = positionId ? positions.data?.positions.find((p) => p.id === positionId) : undefined;
  const gapRow = openPosition
    ? positions.data?.headcountGap.departments.find((d) => d.departmentId === openPosition.departmentId)
    : undefined;

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-4 @lg:space-y-5" data-testid="md-recruitment">
        <MdPageHeader
          icon={UserPlus}
          title="Recruitment"
          subtitle="Are we hiring enough, fast enough, and keeping the people we hire?"
          updatedAt={summary.data?.generatedAt}
        />
        <FilterBar>
          <div className="min-w-0 max-w-full overflow-x-auto">
            <PeriodBar
              key={periodKey(period, month)}
              value={month ? { preset: "custom", ...monthRange(month) } : period}
              onChange={(next) => update(periodPatch(next))}
              presets={PERIOD_PRESETS}
            />
          </div>
          <MonthPicker value={month ?? thisMonthKey()} onChange={(m) => update(monthPatch(m))} label="Month" />
          <ScopeBar value={scope} onChange={(next) => update(scopePatch(next))} org={org.data} />
        </FilterBar>
        <div className="max-w-full overflow-x-auto">
          <Pills
            label="Part of recruitment"
            value={view}
            options={VIEWS}
            onChange={(next) => update({ view: next === "all" ? null : next })}
            testId="md-recruitment-view"
          />
        </div>

        {summary.isError && !summary.data && (
          <ErrorBanner message={describeMdError(summary.error)} onRetry={() => void summary.refetch()} />
        )}
        {notes.map((note) => (
          <NoteBanner key={note}>{note}</NoteBanner>
        ))}

        {summary.data && (
          <p
            className="md-card px-4 py-3 text-[13px] leading-relaxed text-md-ink sm:px-5"
            data-testid="md-recruitment-overview"
          >
            {overviewText(summary.data.current, label)}
          </p>
        )}
        <KpiStrip query={summary} />
        <AttentionCard query={attention} />
        {shows(view, "hiring") && <FunnelSection funnel={funnel} sources={sources} />}
        {shows(view, "hiring") && (
          <PositionsSection query={positions} onOpen={(p) => update({ position: p.id }, { push: true })} />
        )}
        {shows(view, "resignations") && (
          <ResignationsSection query={resignations} onOpen={(id) => update({ resignation: id }, { push: true })} />
        )}
        {shows(view, "joiners") && (
          <JoinersSection trend={trend} joiners={joiners} onOpenEmployee={(id) => navigate(employeeHref(id))} />
        )}

        <ResignationSheet id={resignationId} onClose={() => update({ resignation: null })} />
        <PositionSheet
          position={openPosition ?? null}
          gap={gapRow}
          staleAfter={positions.data?.summary.staleAfterDays ?? 45}
          onClose={() => update({ position: null })}
        />
      </div>
    </MdLayout>
  );
}

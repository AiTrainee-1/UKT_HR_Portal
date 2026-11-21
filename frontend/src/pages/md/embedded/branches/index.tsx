import { useState, type ComponentType } from "react";
import { Building2, CalendarCheck2, Clock3, IndianRupee, LogIn, Timer, TrendingDown, UserX } from "lucide-react";
import { pageQuestion, useBrief } from "@/components/md/embedded/brief";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { CHART } from "@/components/md/kit/chartTheme";
import { kpiValueText, sortInsights, toInsight } from "@/components/md/kit/dto";
import InsightList from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import StatCard, { type StatTone } from "@/components/md/kit/StatCard";
import { EmptyBlock, NoteBanner } from "@/components/md/kit/states";
import TrendChart from "@/components/md/kit/TrendChart";
import { useMdOrg, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import BriefingList from "../shared/BriefingList";
import type { InsightsDefaults } from "../shared/filters";
import InsightsFilterBar from "../shared/InsightsFilterBar";
import SegTabs from "../shared/SegTabs";
import { StripFigure, StripInsights, StripShell } from "../shared/InsightStrip";
import { useInsightsFilters } from "../shared/useInsightsFilters";
import { QueryError, refreshing } from "../employees/kit";
import {
  CARD_METRICS,
  TREND_CHOICES,
  againstCompany,
  assistantSummary,
  companyTiles,
  metricText,
  trendRows,
  verdictTone,
  type CompanyTile,
} from "./logic";
import type { MetricDef, MetricId, UnitsAttention, UnitsSummary, UnitsTrend } from "./types";
import UnitSheet from "./UnitSheet";

const PAGE = "branches";
const DEFAULTS: InsightsDefaults = { extra: { metric: "attendancePct" } };

const TILE: Partial<Record<CompanyTile["id"], { icon: ComponentType<{ size?: number }>; tone: StatTone }>> = {
  units: { icon: Building2, tone: "blue" },
  attendancePct: { icon: CalendarCheck2, tone: "green" },
  absenteeismPct: { icon: UserX, tone: "red" },
  latePct: { icon: Clock3, tone: "amber" },
  overtimeHours: { icon: Timer, tone: "indigo" },
  attritionPct: { icon: TrendingDown, tone: "purple" },
  joiners: { icon: LogIn, tone: "teal" },
  payrollCost: { icon: IndianRupee, tone: "slate" },
};

const CHIP = { good: "md-chip-success", bad: "md-chip-danger", neutral: "" } as const;

/**
 * Branches, Insights & AI: the units side by side for a month (or a range) on the current attendance rules, people,
 * overtime, attrition and pay: the company's figures, each unit against them, the trend by unit and what needs attention.
 * A unit opens its profile (departments against the unit), a department its people.
 */
export default function BranchesInsights() {
  const { filters, params, label, setWhen, setScope, setExtra } = useInsightsFilters(DEFAULTS);
  const metric = (filters.extra.metric || "attendancePct") as MetricId;
  const query = { ...params };
  delete query.metric;
  const org = useMdOrg();
  const summary = useMdQuery<UnitsSummary>("units/summary", query);
  const attention = useMdQuery<UnitsAttention>("units/attention", query);
  const trend = useMdQuery<UnitsTrend>("units/trend", { ...query, metric });
  const [unitId, setUnitId] = useState<number | null>(null);

  const s = summary.data;
  const periodLabel = s?.period?.label ?? label;
  usePublishAssistantContext({
    page: PAGE,
    title: "Branches",
    filters: { Period: periodLabel, Scope: s?.scope?.description ?? "Everyone" },
    summary: assistantSummary(s),
  });
  const defs = Object.fromEntries((s?.metrics ?? []).map((m) => [m.id, m])) as Record<MetricId, MetricDef>;

  return (
    <div className="space-y-5" data-testid="md-units-insights">
      <InsightsFilterBar filters={filters} onWhen={setWhen} onScope={setScope} org={org.data} />

      {summary.isError && <QueryError query={summary} />}

      <SectionCard
        title="In short"
        subtitle={`How the units compare in ${periodLabel}`}
        loading={summary.isPending}
        provenance={s?.provenance}
        actions={s && <AskAiButton question={s.briefing.ask} />}
        testId="md-units-briefing"
      >
        {s && s.briefing.sentences.length > 0 ? (
          <BriefingList sentences={s.briefing.sentences} testIdPrefix="md-units-sentence" />
        ) : (
          !summary.isPending && <p className="text-[13px] text-md-ink-soft">No unit has people in this selection.</p>
        )}
      </SectionCard>

      <div className={`grid grid-cols-2 gap-3 @3xl:grid-cols-4 ${refreshing(summary)}`} data-testid="md-units-kpis">
        {(s ? companyTiles(s) : []).map((tile) => {
          const look = TILE[tile.id] ?? { icon: Building2, tone: "slate" as StatTone };
          return (
            <StatCard
              key={tile.id}
              testId={`md-units-kpi-${tile.id}`}
              label={tile.label}
              value={tile.value}
              sub={tile.sub}
              icon={look.icon}
              tone={look.tone}
              delta={tile.delta}
              provenance={s?.provenance}
              provenanceIds={tile.provenanceIds}
            />
          );
        })}
      </div>
      {s?.measured && s.previous && (
        <p className="md-analytics-note px-1" data-testid="md-units-compare">
          Attendance is for complete days ({s.measured.start} to {s.measured.end}); changes compare with the{" "}
          {s.previous.days} days before. Attrition is always the last 12 months; payroll the latest closed month.
        </p>
      )}

      <SectionCard
        title="The units side by side"
        subtitle="Each unit against the company; click one for its departments and people"
        loading={summary.isPending}
        provenance={s?.provenance}
        actions={<AskAiButton question={`Which unit needs my attention first in ${periodLabel}, and why?`} />}
        className={refreshing(summary)}
        testId="md-units-rows"
      >
        {s && s.rows.length === 0 ? (
          <EmptyBlock title="No units" testId="md-units-rows-empty">
            Nobody works in this selection.
          </EmptyBlock>
        ) : (
          <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
            {(s?.rows ?? []).map((row) => (
              <button
                key={String(row.id)}
                type="button"
                onClick={() => row.id != null && setUnitId(row.id)}
                disabled={row.id == null}
                className="md-panel p-3 text-left transition-shadow hover:shadow-md disabled:cursor-default"
                data-testid={`md-units-row-${row.id ?? "none"}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-black text-md-ink">{row.name}</span>
                  {row.isHeadOffice && <span className="md-chip md-analytics-chip-sm">Head office</span>}
                  {row.isActive === false && (
                    <span className="md-chip md-chip-danger md-analytics-chip-sm">Inactive</span>
                  )}
                  <span className="ml-auto text-xs font-semibold text-md-ink-soft">
                    {num(row.headcount)} active
                    {row.factory ? ` · ${num(row.factory)} factory` : ""}
                  </span>
                </div>
                <div className="mt-2.5 grid grid-cols-2 gap-2 @lg:grid-cols-4">
                  {CARD_METRICS.map((id) => {
                    const entry = row.metrics[id];
                    const tone = verdictTone(entry);
                    return (
                      <div key={id} className="min-w-0" data-testid={`md-units-row-${row.id ?? "none"}-${id}`}>
                        <p className="truncate text-[11px] font-semibold text-md-ink-soft">{defs[id]?.label ?? id}</p>
                        <p className="text-sm font-black tabular-nums text-md-ink">
                          {metricText(defs[id]?.format, entry?.value)}
                        </p>
                        {tone && (
                          <span className={cn("md-chip md-analytics-chip-sm mt-0.5", CHIP[tone])}>
                            {againstCompany(defs[id], entry)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </button>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Over time, unit by unit"
        subtitle={
          trend.data
            ? `${trend.data.metric.label} by ${trend.data.granularity}; the dashed line is the company`
            : "One figure for every unit over the period"
        }
        loading={trend.isPending}
        provenance={trend.data?.provenance}
        actions={
          <SegTabs
            label="Figure"
            items={TREND_CHOICES}
            value={metric}
            onChange={(v) => setExtra("metric", v)}
            testId="md-units-trend-metric"
          />
        }
        className={refreshing(trend)}
        testId="md-units-trend"
      >
        {trend.isError ? (
          <QueryError query={trend} />
        ) : trend.data && trend.data.buckets.length > 0 ? (
          <div className="md-shell-chart">
            <TrendChart
              data={trendRows(trend.data)}
              xKey="label"
              series={[
                ...trend.data.units.map((u, i) => ({
                  key: `u${u.id ?? "none"}`,
                  label: u.name,
                  kind: "line" as const,
                  color: CHART.series[i % CHART.series.length],
                })),
                { key: "company", label: "Company", kind: "line" as const, color: CHART.deep, dashed: true },
              ]}
              height={230}
              yFormat={(v) => metricText(trend.data?.metric.format === "pct" ? "pct" : "number", v)}
            />
          </div>
        ) : (
          <EmptyBlock title="Nothing to draw" testId="md-units-trend-empty">
            There are no complete days with records in this period yet.
          </EmptyBlock>
        )}
      </SectionCard>

      <SectionCard
        title="Needs your attention"
        subtitle={`What stands out between the units in ${periodLabel}`}
        loading={attention.isPending}
        provenance={attention.data?.provenance}
        actions={<AskAiButton question={pageQuestion("Branches")} />}
        testId="md-units-attention"
      >
        {attention.isError ? (
          <QueryError query={attention} />
        ) : (
          <InsightList
            items={sortInsights(attention.data?.items ?? []).map(toInsight)}
            emptyText="Nothing stands out between the units."
          />
        )}
      </SectionCard>

      {s && s.notes.length > 0 && (
        <NoteBanner>
          <ul className="list-disc space-y-1 pl-4" data-testid="md-units-notes">
            {s.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </NoteBanner>
      )}

      <UnitSheet unitId={unitId} params={query} metrics={s?.metrics ?? []} onClose={() => setUnitId(null)} />
    </div>
  );
}

/** The strip above the Branches page: the unit count, the weakest unit's attendance and the top exceptions. */
export function Strip() {
  const brief = useBrief(PAGE);
  const kpis = (brief.data?.kpis ?? []).slice(0, 3);
  const insights = sortInsights(brief.data?.insights ?? []).slice(0, 2);
  if (brief.isError || (!brief.isLoading && kpis.length === 0 && insights.length === 0)) return null;
  return (
    <StripShell
      testId="md-units-strip"
      question={pageQuestion("Branches")}
      loading={brief.isLoading}
      below={<StripInsights items={insights} testId="md-units-strip-insights" />}
    >
      {kpis.map((kpi) => (
        <StripFigure key={kpi.id} testId={`strip-kpi-${kpi.id}`} label={kpi.label} value={kpiValueText(kpi)} />
      ))}
    </StripShell>
  );
}

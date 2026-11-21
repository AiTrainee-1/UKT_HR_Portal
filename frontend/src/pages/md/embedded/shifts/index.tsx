import { useState, type ComponentType } from "react";
import { AlarmClockOff, Factory, Layers, Repeat2, Timer, UserCheck, UserX, Users } from "lucide-react";
import { pageQuestion, useBrief } from "@/components/md/embedded/brief";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import { kpiValueText, sortInsights, toInsight } from "@/components/md/kit/dto";
import InsightList from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import StatCard, { type StatTone } from "@/components/md/kit/StatCard";
import { EmptyBlock, NoteBanner } from "@/components/md/kit/states";
import TrendChart from "@/components/md/kit/TrendChart";
import { useMdOrg, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { dayLong, num, pct } from "@/lib/md/format";
import { scopeParams } from "@/lib/md/period";
import BriefingList from "../shared/BriefingList";
import { DetailList, DetailRow } from "../shared/DetailSheet";
import type { InsightsDefaults } from "../shared/filters";
import InsightsFilterBar from "../shared/InsightsFilterBar";
import { StripFigure, StripInsights, StripShell } from "../shared/InsightStrip";
import { useInsightsFilters } from "../shared/useInsightsFilters";
import { QueryError, refreshing } from "../employees/kit";
import { assistantSummary, changeRows, lateBars, shiftBars, shiftTiles, type ShiftTileId } from "./logic";
import ShiftPeopleSheet from "./ShiftPeopleSheet";
import type {
  ShiftsAttendance,
  ShiftsAttention,
  ShiftsBriefing,
  ShiftsChanges,
  ShiftsCoverage,
  ShiftsSummary,
} from "./types";
import { drillClick } from "../shared/drill";

const PAGE = "shifts";
const DEFAULTS: InsightsDefaults = {};

const TILE: Record<ShiftTileId, { icon: ComponentType<{ size?: number }>; tone: StatTone }> = {
  active: { icon: Users, tone: "blue" },
  covered: { icon: UserCheck, tone: "green" },
  none: { icon: UserX, tone: "red" },
  changes: { icon: Repeat2, tone: "indigo" },
  ending: { icon: AlarmClockOff, tone: "amber" },
  overlap: { icon: Layers, tone: "purple" },
  production: { icon: Factory, tone: "teal" },
  inUse: { icon: Timer, tone: "slate" },
};

/**
 * Manage Shift, Insights & AI: who is on which shift today (staff on shift templates; production on the production shifts
 * of Settings or a special shift), what changed in the month (or range), lateness by shift and what needs a decision. A
 * shift (or "without a shift") opens its people; a person opens their record.
 */
export default function ShiftsInsights() {
  const { filters, params, label, setWhen, setScope } = useInsightsFilters(DEFAULTS);
  const today = scopeParams(filters.scope);
  const org = useMdOrg();
  const summary = useMdQuery<ShiftsSummary>("shifts/summary", params);
  const briefing = useMdQuery<ShiftsBriefing>("shifts/briefing", params);
  const coverage = useMdQuery<ShiftsCoverage>("shifts/coverage", today);
  const changes = useMdQuery<ShiftsChanges>("shifts/changes", params);
  const late = useMdQuery<ShiftsAttendance>("shifts/attendance", params);
  const attention = useMdQuery<ShiftsAttention>("shifts/attention", params);
  const [shift, setShift] = useState<string | null>(null);

  const s = summary.data;
  const periodLabel = s?.period?.label ?? label;
  usePublishAssistantContext({
    page: PAGE,
    title: "Manage Shift",
    filters: { Period: periodLabel, Scope: s?.scope?.description ?? "Everyone" },
    summary: assistantSummary(s),
  });
  const prod = coverage.data?.production;

  return (
    <div className="space-y-5" data-testid="md-shifts-insights">
      <InsightsFilterBar filters={filters} onWhen={setWhen} onScope={setScope} org={org.data} />

      {summary.isError && <QueryError query={summary} />}

      <SectionCard
        title="In short"
        subtitle={`Staffing today and the changes in ${periodLabel}`}
        loading={briefing.isPending}
        provenance={briefing.data?.provenance}
        actions={briefing.data && <AskAiButton question={briefing.data.briefing.ask} />}
        testId="md-shifts-briefing"
      >
        {briefing.isError ? (
          <QueryError query={briefing} />
        ) : briefing.data && briefing.data.briefing.sentences.length > 0 ? (
          <BriefingList sentences={briefing.data.briefing.sentences} testIdPrefix="md-shifts-sentence" />
        ) : (
          <p className="text-[13px] text-md-ink-soft">Nothing to summarise for this selection.</p>
        )}
      </SectionCard>

      <div className={`grid grid-cols-2 gap-3 @3xl:grid-cols-4 ${refreshing(summary)}`} data-testid="md-shifts-kpis">
        {s
          ? shiftTiles(s).map((tile) => (
              <StatCard
                key={tile.id}
                testId={`md-shifts-kpi-${tile.id}`}
                label={tile.label}
                value={tile.value}
                sub={tile.sub}
                icon={TILE[tile.id].icon}
                tone={TILE[tile.id].tone}
                delta={tile.delta}
                provenance={s.provenance}
                provenanceIds={tile.provenanceIds}
                onClick={tile.people ? drillClick(() => setShift(tile.people!)) : undefined}
              />
            ))
          : (Object.keys(TILE) as ShiftTileId[]).map((id) => (
              <StatCard
                key={id}
                testId={`md-shifts-kpi-${id}`}
                label=" "
                value="—"
                icon={TILE[id].icon}
                tone={TILE[id].tone}
                loading={summary.isPending}
              />
            ))}
      </div>

      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-2">
        <SectionCard
          title="People on each shift today"
          subtitle="Click a shift for its people"
          loading={coverage.isPending}
          provenance={coverage.data?.provenance}
          actions={<AskAiButton question="How are the shifts staffed today, and is any shift short of people?" />}
          className={refreshing(coverage)}
          testId="md-shifts-coverage"
        >
          {coverage.isError ? (
            <QueryError query={coverage} />
          ) : (
            <BarList
              items={coverage.data ? shiftBars(coverage.data) : []}
              format={(n) => num(n)}
              onSelect={(item) => setShift(item.key)}
              emptyText="Nobody in this selection is active."
              testId="md-shifts-coverage-list"
            />
          )}
        </SectionCard>

        <SectionCard
          title="Production shifts"
          subtitle={
            prod?.inForce
              ? `Settings -> Production Shifts, in force since ${dayLong(prod.effectiveFrom)}: picked by the first punch`
              : "How production days are judged"
          }
          loading={coverage.isPending}
          provenance={coverage.data?.provenance}
          provenanceIds={["shift-production"]}
          testId="md-shifts-production"
        >
          {prod && prod.inForce ? (
            <div className="space-y-3">
              <DetailList testId="md-shifts-production-defaults">
                {prod.defaults.map((g) => (
                  <DetailRow
                    key={g.id}
                    primary={g.label}
                    secondary={`${g.appliesOnText} · first punch ${g.firstPunchFrom ?? "?"}-${g.firstPunchTo ?? "?"}`}
                    value={
                      g.start
                        ? `${g.start}${g.mainOut ? `-${g.mainOut}${g.mainOutNextDay ? " (+1)" : ""}` : ""}`
                        : undefined
                    }
                  />
                ))}
                <DetailRow
                  primary="On the default shifts today"
                  value={num(prod.onDefaults)}
                  onClick={() => setShift("production")}
                  testId="md-shifts-production-on-defaults"
                />
              </DetailList>
              {prod.specials.length > 0 && (
                <div>
                  <h4 className="md-analytics-subhead">Special shifts (own times and wages)</h4>
                  <DetailList testId="md-shifts-production-specials">
                    {prod.specials.map((g) => (
                      <DetailRow
                        key={g.id}
                        testId={`md-shifts-special-${g.id}`}
                        primary={g.label}
                        secondary={`${g.appliesOnText}${g.start ? ` · from ${g.start}` : ""}`}
                        value={`${num(g.people)} today`}
                        onClick={() => setShift(g.key)}
                      />
                    ))}
                  </DetailList>
                </div>
              )}
            </div>
          ) : (
            <p className="text-[13px] text-md-ink-soft" data-testid="md-shifts-production-off">
              The production rules are not in force for today, so production workers are judged by their shift
              templates, which are counted with the other shifts.
            </p>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Shift changes"
        subtitle="Moves between shifts, first shifts and renewals, by the day each one starts"
        loading={changes.isPending}
        provenance={changes.data?.provenance}
        actions={<AskAiButton question={`Why did people change shift in ${periodLabel}, and between which shifts?`} />}
        className={refreshing(changes)}
        testId="md-shifts-changes"
      >
        {changes.isError ? (
          <QueryError query={changes} />
        ) : changes.data && changes.data.points.some((p) => p.started > 0) ? (
          <div className="md-shell-chart">
            <TrendChart
              data={changeRows(changes.data)}
              xKey="label"
              series={[
                { key: "moved", label: "Moves", kind: "bar", stackId: "c", color: CHART.brand },
                { key: "first", label: "First shifts", kind: "bar", stackId: "c", color: CHART.info },
                { key: "renewed", label: "Renewals", kind: "bar", stackId: "c", color: CHART.slate },
              ]}
              height={220}
              yFormat={(v) => num(v)}
            />
          </div>
        ) : (
          <EmptyBlock title="No changes" testId="md-shifts-changes-empty">
            No shift was assigned or changed in this period.
          </EmptyBlock>
        )}
        {s?.changes.specialStarts ? (
          <p className="md-analytics-note mt-2" data-testid="md-shifts-special-starts">
            {num(s.changes.specialStarts)} production {s.changes.specialStarts === 1 ? "worker was" : "workers were"}{" "}
            put on a special shift in this period.
          </p>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Late arrivals by shift"
        subtitle={
          late.data?.overall?.latePct != null
            ? `${pct(late.data.overall.latePct)} across all shifts; each day filed under the shift it was worked on`
            : "Each worked day filed under the shift it was worked on"
        }
        loading={late.isPending}
        provenance={late.data?.provenance}
        className={refreshing(late)}
        testId="md-shifts-late"
      >
        {late.isError ? (
          <QueryError query={late} />
        ) : (
          <BarList
            items={late.data ? lateBars(late.data) : []}
            format={(n) => pct(n)}
            color={CHART.warn}
            max={100}
            onSelect={(item) => setShift(item.key)}
            emptyText="No complete day with records in this period yet."
            testId="md-shifts-late-list"
          />
        )}
      </SectionCard>

      <SectionCard
        title="Needs your attention"
        subtitle={`What needs a decision, and what stands out in ${periodLabel}`}
        loading={attention.isPending}
        provenance={attention.data?.provenance}
        actions={<AskAiButton question={pageQuestion("Manage Shift")} />}
        testId="md-shifts-attention"
      >
        {attention.isError ? (
          <QueryError query={attention} />
        ) : (
          <InsightList
            items={sortInsights(attention.data?.items ?? []).map(toInsight)}
            emptyText="Nothing needs attention for this selection."
          />
        )}
      </SectionCard>

      {coverage.data && coverage.data.notes.length > 0 && (
        <NoteBanner>
          <ul className="list-disc space-y-1 pl-4" data-testid="md-shifts-notes">
            {coverage.data.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </NoteBanner>
      )}

      <ShiftPeopleSheet shift={shift} scope={today} onClose={() => setShift(null)} />
    </div>
  );
}

/** The strip above the Manage Shift page: employees without a shift, shift changes and the top exceptions. */
export function Strip() {
  const brief = useBrief(PAGE);
  const kpis = (brief.data?.kpis ?? []).slice(0, 3);
  const insights = sortInsights(brief.data?.insights ?? []).slice(0, 2);
  if (brief.isError || (!brief.isLoading && kpis.length === 0 && insights.length === 0)) return null;
  return (
    <StripShell
      testId="md-shifts-strip"
      question={pageQuestion("Manage Shift")}
      loading={brief.isLoading}
      below={<StripInsights items={insights} testId="md-shifts-strip-insights" />}
    >
      {kpis.map((kpi) => (
        <StripFigure key={kpi.id} testId={`strip-kpi-${kpi.id}`} label={kpi.label} value={kpiValueText(kpi)} />
      ))}
    </StripShell>
  );
}

import { useState, type ComponentType } from "react";
import { CalendarClock, Factory, LogIn, LogOut, TrendingDown, TrendingUp, UserMinus, Users } from "lucide-react";
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
import { num } from "@/lib/md/format";
import { scopeParams } from "@/lib/md/period";
import BriefingList from "../shared/BriefingList";
import type { InsightsDefaults } from "../shared/filters";
import InsightsFilterBar from "../shared/InsightsFilterBar";
import { StripFigure, StripInsights, StripShell } from "../shared/InsightStrip";
import { useInsightsFilters } from "../shared/useInsightsFilters";
import { PeopleSheet, QueryError, refreshing } from "./kit";
import { assistantSummary, kpiTiles, movementRows, workforceAsks, type TileId } from "./logic";
import type {
  Briefing,
  EmpComposition,
  EmpExceptions,
  EmpMovement,
  EmpSummary,
  EmpWorkforce,
  PeopleAsk,
} from "./types";
import { drillClick } from "../shared/drill";

const PAGE = "employees";
/** Month by default: the month drives joiners, leavers and attrition; headcount is read on its last day. */
const DEFAULTS: InsightsDefaults = {};

const TILE: Record<TileId, { icon: ComponentType<{ size?: number }>; tone: StatTone }> = {
  headcount: { icon: Users, tone: "blue" },
  joiners: { icon: LogIn, tone: "green" },
  leavers: { icon: LogOut, tone: "red" },
  net: { icon: TrendingUp, tone: "indigo" },
  attrition: { icon: TrendingDown, tone: "amber" },
  early: { icon: UserMinus, tone: "purple" },
  factory: { icon: Factory, tone: "teal" },
  tenure: { icon: CalendarClock, tone: "slate" },
};

/**
 * Employees, Insights & AI: the shape of the workforce and how it moves, for a month (or a range): headcount, joiners,
 * leavers and attrition, the groups the HRMS keeps today (Factory Employees by label, production pay cycles, PF / ESI /
 * TDS), departments, and what needs attention. Every figure opens the people behind it; a person opens their record.
 */
export default function EmployeesInsights() {
  const { filters, params, label, setWhen, setScope } = useInsightsFilters(DEFAULTS);
  const today = scopeParams(filters.scope);
  const org = useMdOrg();
  const summary = useMdQuery<EmpSummary>("employees/summary", params);
  const briefing = useMdQuery<Briefing>("employees/briefing", params);
  const movement = useMdQuery<EmpMovement>("employees/movement", params);
  const attention = useMdQuery<EmpExceptions>("employees/insights", params);
  const workforce = useMdQuery<EmpWorkforce>("employees/workforce", today);
  const composition = useMdQuery<EmpComposition>("employees/composition", { ...today, limit: 10 });
  const [ask, setAsk] = useState<PeopleAsk | null>(null);

  const s = summary.data;
  const periodLabel = s?.period?.label ?? label;
  usePublishAssistantContext({
    page: PAGE,
    title: "Employees",
    filters: { Period: periodLabel, Scope: s?.scope?.description ?? "Everyone" },
    summary: assistantSummary(s, workforce.data),
  });
  const asks = workforce.data ? workforceAsks(workforce.data) : null;

  return (
    <div className="space-y-5" data-testid="md-emp-insights">
      <InsightsFilterBar filters={filters} onWhen={setWhen} onScope={setScope} org={org.data} />

      {summary.isError && <QueryError query={summary} />}

      <SectionCard
        title="In short"
        subtitle={`The workforce in ${periodLabel}, in plain words`}
        loading={briefing.isPending}
        provenance={briefing.data?.provenance}
        actions={briefing.data && <AskAiButton question={briefing.data.briefing.ask} />}
        testId="md-emp-briefing"
      >
        {briefing.isError ? (
          <QueryError query={briefing} />
        ) : briefing.data && briefing.data.briefing.sentences.length > 0 ? (
          <BriefingList sentences={briefing.data.briefing.sentences} testIdPrefix="md-emp-sentence" />
        ) : (
          <p className="text-[13px] text-md-ink-soft">Nothing to summarise for this selection.</p>
        )}
      </SectionCard>

      <div
        className={`grid grid-cols-2 gap-3 @3xl:grid-cols-4 [&>*:last-child:nth-child(odd)]:col-span-2 @3xl:[&>*:last-child:nth-child(odd)]:col-span-1 ${refreshing(summary)}`}
        data-testid="md-emp-kpis"
      >
        {s
          ? kpiTiles(s, periodLabel).map((tile) => (
              <StatCard
                key={tile.id}
                testId={`md-emp-kpi-${tile.id}`}
                label={tile.label}
                value={tile.value}
                sub={tile.sub}
                icon={TILE[tile.id].icon}
                tone={TILE[tile.id].tone}
                delta={tile.delta}
                provenance={s.provenance}
                provenanceIds={tile.provenanceIds}
                onClick={tile.ask ? drillClick(() => setAsk(tile.ask!)) : undefined}
              />
            ))
          : (Object.keys(TILE) as TileId[]).map((id) => (
              <StatCard
                key={id}
                testId={`md-emp-kpi-${id}`}
                label=" "
                value="—"
                icon={TILE[id].icon}
                tone={TILE[id].tone}
                loading={summary.isPending}
              />
            ))}
      </div>
      {s && (
        <p className="md-analytics-note px-1" data-testid="md-emp-compare">
          Changes compare with the {s.previousPeriod.days} days before ({s.previousPeriod.label.toLowerCase()}). Click a
          figure to see the people behind it.
        </p>
      )}

      <SectionCard
        title="Joiners and leavers"
        subtitle="Who came and went in each step of the period, and the headcount at its end (right axis)"
        loading={movement.isPending}
        provenance={movement.data?.provenance}
        actions={<AskAiButton question={`How did the workforce move in ${periodLabel}, and why?`} />}
        className={refreshing(movement)}
        testId="md-emp-movement"
      >
        {movement.isError ? (
          <QueryError query={movement} />
        ) : movement.data && movement.data.points.length > 0 ? (
          <div className="md-shell-chart">
            <TrendChart
              data={movementRows(movement.data.points)}
              xKey="label"
              series={[
                { key: "joiners", label: "Joiners", kind: "bar", color: CHART.good },
                { key: "leavers", label: "Leavers", kind: "bar", color: CHART.bad },
                { key: "headcount", label: "Headcount", kind: "line", color: CHART.deep, rightAxis: true },
              ]}
              height={230}
              yFormat={(v) => num(v)}
            />
          </div>
        ) : (
          <EmptyBlock title="No movement" testId="md-emp-movement-empty">
            Nobody joined or left in this period.
          </EmptyBlock>
        )}
      </SectionCard>

      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-3" data-testid="md-emp-groups">
        <SectionCard
          title="Factory Employees"
          subtitle="By label (the label is their department and designation)"
          loading={workforce.isPending}
          provenance={workforce.data?.provenance}
          testId="md-emp-factory"
        >
          {workforce.isError ? (
            <QueryError query={workforce} />
          ) : (
            <BarList
              items={asks?.labels ?? []}
              format={(n) => num(n)}
              onSelect={(item) => {
                const row = asks?.labels.find((l) => l.key === item.key);
                if (row) setAsk(row.ask);
              }}
              emptyText="No Factory Employees in this selection."
              testId="md-emp-factory-list"
            />
          )}
        </SectionCard>
        <SectionCard
          title="Production pay cycles"
          subtitle={
            workforce.data && workforce.data.cycles.unassigned > 0
              ? `${num(workforce.data.cycles.unassigned)} without a cycle are in no production payroll`
              : "Which production payroll each worker is paid on"
          }
          loading={workforce.isPending}
          provenance={workforce.data?.provenance}
          testId="md-emp-cycles"
        >
          {workforce.data && (
            <BarList
              items={asks?.cycles ?? []}
              format={(n) => num(n)}
              color={CHART.info}
              onSelect={(item) => {
                const row = asks?.cycles.find((c) => c.key === item.key);
                if (row) setAsk(row.ask);
              }}
              emptyText="No production workers in this selection."
              testId="md-emp-cycles-list"
            />
          )}
        </SectionCard>
        <SectionCard
          title="PF, ESI and TDS"
          subtitle="Co Emp employees get PF and ESI; TDS employees have tax deducted instead"
          loading={workforce.isPending}
          provenance={workforce.data?.provenance}
          testId="md-emp-statutory"
        >
          {workforce.data && (
            <BarList
              items={asks?.statutory ?? []}
              format={(n) => num(n)}
              color={CHART.gold}
              onSelect={(item) => {
                const row = asks?.statutory.find((c) => c.key === item.key);
                if (row) setAsk(row.ask);
              }}
              testId="md-emp-statutory-list"
            />
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Departments"
        subtitle={
          composition.data
            ? `The biggest ${Math.min(composition.data.byDepartment.length, 10)} of ${num(composition.data.departmentsTotal)} by people here today; click one for its people`
            : "People here today by department"
        }
        loading={composition.isPending}
        provenance={composition.data?.provenance}
        className={refreshing(composition)}
        testId="md-emp-departments"
      >
        {composition.isError ? (
          <QueryError query={composition} />
        ) : (
          <BarList
            items={(composition.data?.byDepartment ?? []).map((d) => ({
              key: String(d.id ?? "none"),
              label: d.label,
              value: d.count,
              sub: d.staff != null ? `${num(d.staff)} staff · ${num(d.production ?? 0)} production` : undefined,
            }))}
            format={(n) => num(n)}
            onSelect={(item) =>
              item.key !== "none" &&
              setAsk({
                group: "active",
                title: String(item.label),
                subtitle: "People here today",
                extra: { department: item.key },
                open: { path: "/md/employees", label: "Open in Employees" },
              })
            }
            emptyText="Nobody works in this selection."
            testId="md-emp-departments-list"
          />
        )}
      </SectionCard>

      <SectionCard
        title="Needs your attention"
        subtitle={`What stands out in ${periodLabel}, most important first`}
        loading={attention.isPending}
        provenance={attention.data?.provenance}
        actions={<AskAiButton question={pageQuestion("Employees")} />}
        testId="md-emp-attention"
      >
        {attention.isError ? (
          <QueryError query={attention} />
        ) : (
          <InsightList
            items={sortInsights(attention.data?.items ?? []).map(toInsight)}
            emptyText="Nothing stands out for this selection."
          />
        )}
      </SectionCard>

      {s && s.notes.length > 0 && (
        <NoteBanner>
          <ul className="list-disc space-y-1 pl-4" data-testid="md-emp-notes">
            {s.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </NoteBanner>
      )}

      <PeopleSheet ask={ask} params={params} onClose={() => setAsk(null)} testId="md-emp-people" />
    </div>
  );
}

/** The strip above the Employees page: the headline figures and the top exceptions, each with Explain. */
export function Strip() {
  const brief = useBrief(PAGE);
  const kpis = (brief.data?.kpis ?? []).slice(0, 3);
  const insights = sortInsights(brief.data?.insights ?? []).slice(0, 2);
  if (brief.isError || (!brief.isLoading && kpis.length === 0 && insights.length === 0)) return null;
  return (
    <StripShell
      testId="md-emp-strip"
      question={pageQuestion("Employees")}
      loading={brief.isLoading}
      below={<StripInsights items={insights} testId="md-emp-strip-insights" />}
    >
      {kpis.map((kpi) => (
        <StripFigure key={kpi.id} testId={`strip-kpi-${kpi.id}`} label={kpi.label} value={kpiValueText(kpi)} />
      ))}
    </StripShell>
  );
}

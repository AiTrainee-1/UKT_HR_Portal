import { useState, type ComponentType } from "react";
import { Building2, CheckCircle2, Fingerprint, Hand, Hourglass, MapPinned } from "lucide-react";
import { pageQuestion, useBrief } from "@/components/md/embedded/brief";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DonutChart from "@/components/md/kit/DonutChart";
import InsightList from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import StatCard from "@/components/md/kit/StatCard";
import TrendChart from "@/components/md/kit/TrendChart";
import { sortInsights, toInsight } from "@/components/md/kit/dto";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { describeMdError, useMdOrg, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { num, pct } from "@/lib/md/format";
import BriefingList from "../shared/BriefingList";
import { drillClick } from "../shared/drill";
import type { InsightsDefaults } from "../shared/filters";
import { StripFigure, StripInsights, StripNote, StripShell } from "../shared/InsightStrip";
import InsightsFilterBar from "../shared/InsightsFilterBar";
import { thisMonth, whenParams } from "../shared/filters";
import { useOpenInPage } from "../shared/jump";
import { useInsightsFilters } from "../shared/useInsightsFilters";
import PunchDrillSheet from "./PunchDrill";
import { assistantContext, chartRows, chartSeries, familySlices, PAGE, TILES, tileDelta, TITLE } from "./logic";
import type { PunchAttention, PunchDrill, PunchMissing, PunchSources, PunchSummary } from "./types";

const ICONS: Record<string, ComponentType<{ size?: number }>> = {
  punches: Fingerprint,
  hand: Hand,
  missing: Hourglass,
  devices: Building2,
  held: MapPinned,
  coverage: CheckCircle2,
};

/** The Insights tab opens on this month, everyone (staff and production). A module constant (useInsightsFilters). */
const DEFAULTS: InsightsDefaults = {};

/**
 * Attendance Search, Insights & AI: how punches arrive (devices, phones, hand entries, the MD auto attendance), whether
 * every device is sending, who keeps missing a punch, which On-Duty punches still wait for HR, and how much of it has
 * become attendance. A click on a figure lists who or what is behind it; a person opens their punches day by day. The HR
 * page itself (one employee's punches and month) is the Operations tab next to this one.
 */
export default function PunchInsights() {
  const { filters, params, label, setWhen, setScope } = useInsightsFilters(DEFAULTS);
  const [drill, setDrill] = useState<PunchDrill | null>(null);
  const open = useOpenInPage();
  const org = useMdOrg();
  const summary = useMdQuery<PunchSummary>("punches/summary", params);
  const sources = useMdQuery<PunchSources>("punches/sources", params);
  const missing = useMdQuery<PunchMissing>("punches/missing", { ...params, limit: 10 });
  const attention = useMdQuery<PunchAttention>("punches/attention", params);

  const data = summary.data;
  const scopeText = data?.scope?.description ?? "the whole company";
  const where = `${label}, ${scopeText}`;
  usePublishAssistantContext(assistantContext(data, label, scopeText));

  return (
    <div className="space-y-5" data-testid="md-punch-insights">
      <InsightsFilterBar
        filters={filters}
        onWhen={setWhen}
        onScope={setScope}
        org={org.data}
        testId="md-punch-filters"
      />

      {summary.isError && (
        <ErrorBanner message={describeMdError(summary.error)} onRetry={() => void summary.refetch()} />
      )}

      <SectionCard
        testId="md-punch-briefing"
        title="How punches arrived"
        subtitle="Written from the figures below"
        loading={summary.isPending}
        provenance={data?.provenance}
        actions={<AskAiButton question={data?.briefing.ask ?? pageQuestion(TITLE)} label="Explain with AI" />}
      >
        {data && (
          <BriefingList
            sentences={data.briefing.sentences.map((text, i) => ({ id: String(i), tone: "neutral", text }))}
            testIdPrefix="md-punch-sentence"
          />
        )}
      </SectionCard>

      <div
        className="grid grid-cols-2 gap-3 @3xl:grid-cols-3 @5xl:grid-cols-6 [&>*:last-child:nth-child(odd)]:col-span-2 @3xl:[&>*:last-child:nth-child(odd)]:col-span-1"
        data-testid="md-punch-kpis"
      >
        {TILES.map((tile) => {
          const action = tile.drill
            ? () => setDrill({ kind: tile.drill } as PunchDrill)
            : tile.open
              ? () => open(tile.open as string)
              : undefined;
          return (
            <StatCard
              key={tile.id}
              testId={`md-punch-kpi-${tile.id}`}
              label={tile.label}
              value={data ? tile.value(data) : "—"}
              sub={data ? tile.sub(data) : undefined}
              icon={ICONS[tile.id]}
              tone={tile.tone}
              delta={data ? tileDelta(tile, data) : null}
              loading={summary.isPending}
              provenance={data?.provenance}
              provenanceIds={tile.provenanceIds}
              onClick={data && action ? drillClick(action) : undefined}
            />
          );
        })}
      </div>

      <SectionCard
        testId="md-punch-attention"
        title="Needs your attention"
        subtitle="What stands out in this period, most serious first"
        loading={attention.isPending}
        provenance={attention.data?.provenance}
      >
        {attention.isError ? (
          <ErrorBanner message={describeMdError(attention.error)} onRetry={() => void attention.refetch()} />
        ) : (
          <InsightList
            items={sortInsights(attention.data?.items ?? []).map(toInsight)}
            emptyText="Nothing about punches needs your attention in this period."
          />
        )}
      </SectionCard>

      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
        <SectionCard
          testId="md-punch-sources"
          className="@4xl:col-span-8"
          title="Punches by how they arrived"
          subtitle={sources.data?.granularity === "week" ? "One bar per week" : "One bar per day"}
          loading={sources.isPending}
          provenance={sources.data?.provenance}
          actions={
            <AskAiButton question={`How have punches arrived over ${where}? Is the hand-entered share rising?`} />
          }
        >
          {sources.isError ? (
            <ErrorBanner message={describeMdError(sources.error)} onRetry={() => void sources.refetch()} />
          ) : sources.data && sources.data.points.length > 0 ? (
            <TrendChart
              data={chartRows(sources.data.points)}
              xKey="label"
              series={chartSeries(sources.data.families)}
              height={240}
              yFormat={(v) => num(v)}
              legend
            />
          ) : (
            <p className="md-analytics-note">No punches in this period.</p>
          )}
        </SectionCard>
        <SectionCard
          testId="md-punch-families"
          className="@4xl:col-span-4"
          title="Where they came from"
          subtitle="Share of all punches"
          loading={summary.isPending}
          provenance={data?.provenance}
          provenanceIds={["punches-sources"]}
        >
          {data && (
            <DonutChart data={familySlices(data)} center={num(data.metrics.punches.value)} format={(n) => num(n)} />
          )}
        </SectionCard>
      </div>

      <SectionCard
        testId="md-punch-missing"
        title="Who keeps missing a punch"
        subtitle={`On several days in ${label} · click a person for their punches`}
        loading={missing.isPending}
        provenance={missing.data?.provenance}
        actions={<AskAiButton question={`Who keeps missing a punch (${where}), and do they ask for a correction?`} />}
      >
        {missing.isError ? (
          <ErrorBanner message={describeMdError(missing.error)} onRetry={() => void missing.refetch()} />
        ) : missing.data && missing.data.rows.length > 0 ? (
          <ul className="md-panel divide-y divide-md-line" data-testid="md-punch-missing-list">
            {missing.data.rows.map((r) => (
              <li key={r.employeeId}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-md-wine/5"
                  onClick={() => setDrill({ kind: "employee", employeeId: r.employeeId, name: r.employeeName })}
                  data-testid={`md-punch-missing-${r.employeeId}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-md-ink">{r.employeeName}</span>
                    <span className="block truncate text-xs text-md-ink-soft">
                      {[r.employeeCode, r.department, r.unit].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-[13px] font-bold tabular-nums text-md-ink">
                    {num(r.missingDays)} days
                    <span className="block text-[11px] font-medium text-md-ink-soft">
                      {r.missingPct != null ? `${pct(r.missingPct)} of their days` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="md-analytics-note">Nobody missed a punch on several days in this period.</p>
        )}
      </SectionCard>

      {data && data.notes.length > 0 && (
        <NoteBanner>
          <ul className="list-disc space-y-1 pl-4" data-testid="md-punch-notes">
            {data.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </NoteBanner>
      )}

      <PunchDrillSheet drill={drill} params={params} where={where} onDrill={setDrill} onClose={() => setDrill(null)} />
    </div>
  );
}

/** The strip above the Attendance Search page: this month's punches, the hand-entered share, silent devices and On-Duty
 *  punches still waiting for HR, with the top exceptions. The same month the Insights tab opens on (one shared answer). */
export function Strip() {
  const brief = useBrief(PAGE);
  const summary = useMdQuery<PunchSummary>("punches/summary", whenParams(thisMonth()));
  const data = summary.data;
  const insights = sortInsights(brief.data?.insights ?? []).slice(0, 2);
  if (
    (summary.isError && brief.isError) ||
    (!summary.isLoading && !brief.isLoading && !data && insights.length === 0)
  ) {
    return null;
  }
  return (
    <StripShell
      testId="md-punch-strip"
      question={pageQuestion(TITLE)}
      loading={summary.isLoading}
      below={<StripInsights items={insights} testId="md-punch-strip-insights" />}
    >
      {data && (
        <>
          <StripFigure
            testId="md-punch-strip-punches"
            label="Punches this month"
            value={num(data.metrics.punches.value)}
          >
            {data.metrics.handEnteredPct.value != null && (
              <StripNote tone={data.metrics.handEnteredPct.value >= 10 ? "watch" : "neutral"}>
                {pct(data.metrics.handEnteredPct.value)} by hand
              </StripNote>
            )}
          </StripFigure>
          <StripFigure
            testId="md-punch-strip-devices"
            label="Devices sending"
            value={`${num(data.devices.reporting)} of ${num(data.devices.listed)}`}
          >
            {data.devices.silent > 0 && <StripNote tone="bad">{num(data.devices.silent)} silent</StripNote>}
          </StripFigure>
          {(data.heldOnDuty?.pending ?? 0) > 0 && (
            <StripFigure
              testId="md-punch-strip-held"
              label="On-Duty waiting for HR"
              value={num(data.heldOnDuty?.pending ?? 0)}
            />
          )}
        </>
      )}
    </StripShell>
  );
}

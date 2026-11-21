import { useState } from "react";
import { pageQuestion, useBrief } from "@/components/md/embedded/brief";
import { kpiValueText, sortInsights } from "@/components/md/kit/dto";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { describeMdError, useMdOrg, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { describeScope, scopeIsEveryone } from "@/lib/md/period";
import InsightsFilterBar from "../shared/InsightsFilterBar";
import { StripFigure, StripInsights, StripNote, StripShell } from "../shared/InsightStrip";
import { useInsightsFilters } from "../shared/useInsightsFilters";
import BottlenecksCard from "./BottlenecksCard";
import { AttentionCard, BriefingCard, KpiStrip, TrendCard } from "./cards";
import DrillSheet from "./DrillSheet";
import GroupsCard from "./GroupsCard";
import RejectionsCard from "./RejectionsCard";
import WaitingCard from "./WaitingCard";
import { DEFAULTS, KIND_OPTIONS, PAGE, TITLE, askQuestions, assistantSummary, kindLabel } from "./logic";
import type {
  BreakdownBy,
  Drill,
  RqAttention,
  RqBottlenecks,
  RqBreakdown,
  RqRejections,
  RqSummary,
  RqTrend,
  RqWaiting,
} from "./types";

/**
 * Requests, Insights & AI: what is waiting for a decision and with whom, how many came in and were decided, how fast, why
 * they are rejected, and where they get stuck, for every kind of request on the HR Requests page. The MD only looks: HR and
 * the Department Heads decide (the Operations tab is the HR page, view only). Every figure opens the requests behind it.
 */
export default function RequestsInsights() {
  const { filters, params, label, setWhen, setScope, setExtra } = useInsightsFilters(DEFAULTS);
  const [by, setBy] = useState<BreakdownBy>("kind");
  const [drill, setDrill] = useState<Drill | null>(null);
  const org = useMdOrg();
  const kind = filters.extra.kind || "all";
  const scopeOnly = { ...params };
  delete scopeOnly.period;
  delete scopeOnly.month;
  delete scopeOnly.from;
  delete scopeOnly.to;

  const summary = useMdQuery<RqSummary>("requests/summary", params);
  const attention = useMdQuery<RqAttention>("requests/attention", params);
  const trend = useMdQuery<RqTrend>("requests/trend", params);
  const waiting = useMdQuery<RqWaiting>("requests/waiting", { ...scopeOnly, limit: 10 });
  const groups = useMdQuery<RqBreakdown>("requests/breakdown", { ...params, by, limit: 25 });
  const bottlenecks = useMdQuery<RqBottlenecks>("requests/bottlenecks", { ...params, limit: 10 });
  const rejections = useMdQuery<RqRejections>("requests/rejections", { ...params, limit: 8 });

  const periodLabel = summary.data?.period?.label ?? label;
  const selection = summary.data?.scope?.description ?? describeScope(filters.scope);
  const ask = askQuestions(periodLabel, kind, scopeIsEveryone(filters.scope) ? null : selection);

  usePublishAssistantContext({
    page: PAGE,
    title: TITLE,
    filters: { Period: periodLabel, Scope: selection, Kind: kindLabel(kind) },
    summary: assistantSummary(summary.data),
  });

  const open = (d: Drill) =>
    setDrill({ ...d, ask: d.ask ?? `Tell me about these requests: ${d.title} (${periodLabel}).` });

  return (
    <div className="space-y-5" data-testid="md-requests-insights">
      <InsightsFilterBar filters={filters} onWhen={setWhen} onScope={setScope} org={org.data}>
        <Select value={kind} onValueChange={(v) => setExtra("kind", v)}>
          <SelectTrigger
            className="md-field h-9 w-full text-xs font-semibold sm:w-[13rem]"
            aria-label="Kind of request"
            data-testid="md-requests-kind"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_OPTIONS.map((k) => (
              <SelectItem key={k.value} value={k.value}>
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </InsightsFilterBar>

      {summary.isError && (
        <ErrorBanner message={describeMdError(summary.error)} onRetry={() => void summary.refetch()} />
      )}

      <BriefingCard query={summary} ask={ask.briefing} />
      <KpiStrip query={summary} onDrill={open} />
      <AttentionCard query={attention} ask={ask.attention} />
      <TrendCard query={trend} ask={ask.trend} />

      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-2">
        <WaitingCard query={waiting} ask={ask.waiting} onDrill={open} />
        <GroupsCard query={groups} by={by} onBy={setBy} ask={ask.groups} onDrill={open} />
      </div>
      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-2">
        <BottlenecksCard query={bottlenecks} ask={ask.bottlenecks} onDrill={open} />
        <RejectionsCard query={rejections} ask={ask.rejections} onDrill={open} />
      </div>

      {summary.data && summary.data.notes.length > 0 && (
        <NoteBanner>
          <div data-testid="md-requests-notes">
            <p className="font-semibold">About these figures</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {summary.data.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        </NoteBanner>
      )}

      <DrillSheet drill={drill} params={params} onClose={() => setDrill(null)} />
    </div>
  );
}

/**
 * The strip above the Requests page: what is waiting now and with whom, the typical time to decide, and the top
 * exceptions, each with Explain. Starts folded into "Show insights" (the frame's InsightsReveal).
 */
export function Strip() {
  const brief = useBrief(PAGE);
  const summary = useMdQuery<RqSummary>("requests/summary", { period: "last_30_days" });
  const speed = (brief.data?.kpis ?? []).find((k) => k.id === "requests.median-decision");
  const insights = sortInsights(brief.data?.insights ?? []).slice(0, 2);
  const w = summary.data?.waiting;

  if (
    (brief.isError && summary.isError) ||
    (!brief.isLoading && !summary.isLoading && !w && !speed && !insights.length)
  ) {
    return null;
  }
  return (
    <StripShell
      testId="md-requests-strip"
      question={pageQuestion(TITLE)}
      loading={brief.isLoading || summary.isLoading}
      below={<StripInsights items={insights} testId="md-requests-strip-insights" />}
    >
      {w && (
        <StripFigure testId="md-requests-strip-waiting" label="Waiting now" value={w.total}>
          {w.withDepartmentHead > 0 && <StripNote tone="watch">{w.withDepartmentHead} with Department Heads</StripNote>}
          {w.threeDaysPlus > 0 && <StripNote tone="bad">{w.threeDaysPlus} waited 3+ days</StripNote>}
        </StripFigure>
      )}
      {speed && <StripFigure testId="md-requests-strip-speed" label={speed.label} value={kpiValueText(speed)} />}
    </StripShell>
  );
}

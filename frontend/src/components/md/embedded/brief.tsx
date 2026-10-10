import { Activity, AlertOctagon, AlertTriangle, CheckCircle2, Info, Sparkles } from "lucide-react";
import { Link } from "wouter";
import { useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import type { MdInsightDto, MdKpiDto, Provenance } from "@/lib/md/types";
import { cn } from "@/lib/utils";
import { kpiDelta, kpiValueText, sortInsights, toInsight } from "../kit/dto";
import AskAiButton from "../kit/AskAiButton";
import InsightList from "../kit/InsightList";
import KpiCard from "../kit/KpiCard";
import SectionCard from "../kit/SectionCard";
import { DeltaChip } from "../kit/StatCard";
import { EmptyBlock, ErrorBanner } from "../kit/states";
import { MD_NAV_BY_ID } from "../md-nav";

/** What /api/md/brief/<page> returns: the headline figures and the exceptions of the analytics module behind a page. */
export type Brief = {
  page: string;
  title: string;
  domain: string | null;
  kpis: MdKpiDto[];
  insights: MdInsightDto[];
  provenance?: Provenance[];
  notes?: string[];
  generatedAt?: string;
};

export const useBrief = (page: string) => useMdQuery<Brief>(`brief/${page}`, undefined, { staleTime: 60_000 });

/** One icon per severity (the shape says it, the colour backs it up): crimson bad, ochre watch, periwinkle information, sage good. */
const SEVERITY: Record<MdInsightDto["severity"], { icon: typeof Info; tone: string; label: string }> = {
  critical: { icon: AlertOctagon, tone: "text-md-danger-600", label: "Critical" },
  warning: { icon: AlertTriangle, tone: "text-md-warning-600", label: "Needs attention" },
  info: { icon: Info, tone: "text-md-info", label: "For your information" },
  good: { icon: CheckCircle2, tone: "text-md-success", label: "Good news" },
};

/** The question "Ask AI" opens with for a page as a whole. */
export const pageQuestion = (title: string) =>
  `Give me a briefing on ${title}: what stands out, and why? Compare with the previous period.`;

/**
 * The strip above every MD copy of an HR page: its headline figures and top exceptions, with "Ask AI". It is a fallback:
 * a page with an Insights module of its own (pages/md/embedded/<page id>/index.tsx exporting `Strip`) shows that instead.
 */
export function BriefStrip({ page }: { page: string }) {
  const meta = MD_NAV_BY_ID[page];
  const brief = useBrief(page);
  const data = brief.data;
  const kpis = (data?.kpis ?? []).slice(0, 4);
  const insights = sortInsights(data?.insights ?? []).slice(0, 3);

  if (brief.isError || (!brief.isLoading && kpis.length === 0 && insights.length === 0)) {
    // nothing to say is a state, not an error banner on top of a working page
    return null;
  }

  return (
    <div className="md-shell-strip mb-4 p-4" data-testid="md-brief-strip">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        <span className="mr-1 flex items-center gap-2">
          <span className="md-shell-strip-mark">
            <Sparkles size={13} strokeWidth={2.2} />
          </span>
          <span className="md-shell-overline text-md-wine">MD insights</span>
        </span>
        {brief.isLoading && <span className="text-xs font-medium text-md-ink-soft">Working out the figures…</span>}
        {kpis.map((kpi) => {
          const delta = kpiDelta(kpi);
          return (
            <span key={kpi.id} className="md-shell-strip-kpi" data-testid={`strip-kpi-${kpi.id}`}>
              <span className="text-[11px] font-semibold leading-tight text-md-ink-soft">{kpi.label}</span>
              <span className="flex items-center gap-2">
                <b className="text-base font-black leading-tight tabular-nums text-md-ink">{kpiValueText(kpi)}</b>
                {delta && <DeltaChip {...delta} />}
              </span>
            </span>
          );
        })}
        <span className="ml-auto">
          <AskAiButton
            question={pageQuestion(meta?.title ?? data?.title ?? "this page")}
            label="Ask AI about this page"
            size="md"
          />
        </span>
      </div>
      {insights.length > 0 && (
        <ul className="mt-3 space-y-0.5 border-t border-md-warning-600/15 pt-2.5" data-testid="strip-insights">
          {insights.map((item) => {
            const s = SEVERITY[item.severity];
            return (
              <li key={item.id} className="md-shell-strip-row">
                <s.icon size={15} strokeWidth={2.2} className={cn("mt-0.5 shrink-0", s.tone)} aria-label={s.label} />
                <span className="min-w-0 flex-1 text-[13px] leading-snug text-md-ink">
                  <b className="font-bold">{item.title}</b>
                  {item.detail && <span className="text-md-ink-soft"> — {item.detail}</span>}
                </span>
                {item.ask && <AskAiButton question={item.ask} label="Explain" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The Insights tab of a page with no analytics of its own yet: the same brief, in full. */
export function BriefBody({ page }: { page: string }) {
  const meta = MD_NAV_BY_ID[page];
  const brief = useBrief(page);
  const data = brief.data;

  if (brief.isError) {
    return <ErrorBanner message={describeMdError(brief.error)} onRetry={() => brief.refetch()} />;
  }
  const kpis = data?.kpis ?? [];
  const insights = sortInsights(data?.insights ?? []).map(toInsight);

  return (
    <div className="space-y-5" data-testid="md-brief-body">
      {kpis.length > 0 && (
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
          {kpis.map((kpi) => (
            <KpiCard key={kpi.id} kpi={kpi} icon={Activity} loading={brief.isLoading} provenance={data?.provenance} />
          ))}
        </div>
      )}
      <SectionCard
        title="Needs your attention"
        subtitle={`What stands out on ${meta?.title ?? "this page"}, most important first`}
        loading={brief.isLoading}
        provenance={data?.provenance}
        actions={<AskAiButton question={pageQuestion(meta?.title ?? "this page")} />}
        testId="md-brief-attention"
      >
        <InsightList items={insights} />
      </SectionCard>
      {!brief.isLoading && kpis.length === 0 && insights.length === 0 && (
        <EmptyBlock title="Nothing to compare yet">
          There are no figures behind this page yet. Ask the assistant about it, or open{" "}
          <Link href="/md/dashboard" className="font-semibold text-md-wine underline">
            the dashboard
          </Link>
          .
        </EmptyBlock>
      )}
    </div>
  );
}

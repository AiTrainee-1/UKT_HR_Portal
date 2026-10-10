import { Activity, Sparkles } from "lucide-react";
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

const TONE: Record<string, string> = {
  good: "text-green-700",
  bad: "text-red-700",
  neutral: "text-[#006496]/70",
};

const SEVERITY_DOT: Record<MdInsightDto["severity"], string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-blue-500",
  good: "bg-green-500",
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
    <div
      className="mb-4 rounded-2xl border border-[#e0a83a]/30 bg-gradient-to-r from-[#fffaf0] to-white p-3.5 shadow-sm"
      data-testid="md-brief-strip"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-widest text-[#b8801c]">
          <Sparkles size={13} /> MD insights
        </span>
        {brief.isLoading && <span className="text-xs text-muted-foreground">Working out the figures…</span>}
        {kpis.map((kpi) => {
          const delta = kpiDelta(kpi);
          return (
            <span key={kpi.id} className="flex items-baseline gap-1.5 text-sm" data-testid={`strip-kpi-${kpi.id}`}>
              <span className="text-xs text-muted-foreground">{kpi.label}</span>
              <b className="font-black text-gray-900">{kpiValueText(kpi)}</b>
              {delta && (
                <span className={cn("text-[11px] font-semibold", TONE[delta.tone] ?? TONE.neutral)}>{delta.text}</span>
              )}
            </span>
          );
        })}
        <span className="ml-auto">
          <AskAiButton
            question={pageQuestion(meta?.title ?? data?.title ?? "this page")}
            label="Ask AI about this page"
          />
        </span>
      </div>
      {insights.length > 0 && (
        <ul className="mt-2.5 space-y-1" data-testid="strip-insights">
          {insights.map((item) => (
            <li key={item.id} className="flex items-start gap-2 text-[13px] text-gray-800">
              <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", SEVERITY_DOT[item.severity])} />
              <span className="min-w-0 flex-1">
                <b className="font-semibold">{item.title}</b>
                {item.detail && <span className="text-muted-foreground"> — {item.detail}</span>}
              </span>
              {item.ask && <AskAiButton question={item.ask} label="Explain" />}
            </li>
          ))}
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
          <Link href="/md/dashboard" className="font-semibold text-[#006496] underline">
            the dashboard
          </Link>
          .
        </EmptyBlock>
      )}
    </div>
  );
}

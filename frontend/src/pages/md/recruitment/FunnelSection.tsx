import { useState } from "react";
import { Layers } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { PillTabs } from "@/components/ui/pill-tabs";
import { num, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { funnelBars, stepColor, type FunnelBar } from "./logic";
import { QueryError } from "./parts";
import type { FunnelDepartmentRow, FunnelView, QueryLike, RecruitmentFunnel, RecruitmentSources } from "./types";

const VIEWS = [
  { value: "all", label: "All candidates" },
  { value: "jobBoard", label: "Job board" },
  { value: "screening", label: "Resume screening" },
];

/** One bar of the funnel: centred in its track so the column narrows as candidates drop out. */
function FunnelShape({ bar, index, total }: { bar: FunnelBar; index: number; total: number }) {
  if (!bar.tracked) {
    return (
      <div className="flex h-9 items-center justify-center rounded-lg border border-dashed border-slate-300 text-xs text-slate-500">
        Not recorded for this view
      </div>
    );
  }
  return (
    <div className="h-9 rounded-lg bg-[#006496]/[0.05]" role="img" aria-label={`${bar.label}: ${bar.count} candidates`}>
      <div
        className={cn(
          "mx-auto h-full rounded-lg transition-[width] duration-500 ease-out",
          bar.standalone && "border-2 border-dashed border-green-500",
        )}
        style={{
          width: `${bar.widthPct}%`,
          background: bar.standalone ? "rgba(34,197,94,.14)" : stepColor(index, total),
        }}
      />
    </div>
  );
}

function FunnelSteps({ bars }: { bars: FunnelBar[] }) {
  const pipeline = bars.filter((b) => !b.standalone).length;
  return (
    <ol className="space-y-4" data-testid="md-recruitment-funnel-steps">
      {bars.map((b, i) => (
        <li
          key={b.id}
          data-testid={`funnel-step-${b.id}`}
          className="grid grid-cols-1 items-start gap-x-4 gap-y-1.5 @md:grid-cols-[6.5rem_minmax(0,1fr)]"
        >
          <div className="flex items-baseline justify-between gap-2 @md:block">
            <p className="text-[13px] font-semibold text-[#1a3a4a]">{b.label}</p>
            <p
              className="text-xl font-black leading-none tabular-nums text-[#1a3a4a] @md:mt-1"
              data-testid={`funnel-count-${b.id}`}
            >
              {b.count == null ? "—" : num(b.count)}
            </p>
          </div>
          <div className="min-w-0">
            <FunnelShape bar={b} index={i} total={pipeline} />
            <p className="mt-1 flex flex-wrap gap-x-3 text-xs leading-snug">
              {b.conversion && <b className="text-[#006496]">{b.conversion}</b>}
              {b.dropOff && <span className="text-[#006496]/60">{b.dropOff}</span>}
              {i === 0 && b.tracked && <span className="text-[#006496]/60">Everyone who entered</span>}
            </p>
            {b.note && <p className="mt-0.5 text-[11px] italic leading-snug text-[#006496]/60">{b.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

const DEPARTMENT_COLUMNS: Column<FunnelDepartmentRow>[] = [
  {
    key: "department",
    header: "Department",
    cell: (r) => <span className="font-medium text-[#1a3a4a]">{r.department}</span>,
    sortValue: (r) => r.department,
  },
  { key: "applied", header: "Applied", align: "right", cell: (r) => num(r.applied), sortValue: (r) => r.applied },
  { key: "screened", header: "Screened", align: "right", cell: (r) => num(r.screened), sortValue: (r) => r.screened },
  {
    key: "shortlisted",
    header: "Shortlisted",
    align: "right",
    cell: (r) => num(r.shortlisted),
    sortValue: (r) => r.shortlisted,
  },
  {
    key: "interviewed",
    header: "Interviewed",
    align: "right",
    cell: (r) => num(r.interviewed),
    sortValue: (r) => r.interviewed,
  },
  { key: "offered", header: "Offered", align: "right", cell: (r) => num(r.offered), sortValue: (r) => r.offered },
  { key: "joined", header: "Joined", align: "right", cell: (r) => num(r.joined), sortValue: (r) => r.joined },
];

export default function FunnelSection({
  funnel,
  sources,
}: {
  funnel: QueryLike<RecruitmentFunnel>;
  sources: QueryLike<RecruitmentSources>;
}) {
  const [view, setView] = useState<FunnelView>("all");
  const data = funnel.data;
  const stages = data ? (view === "all" ? data.stages : data.views[view]) : [];
  const bars = funnelBars(stages);
  const entered = bars[0]?.count ?? 0;

  return (
    <div className="@container" data-testid="md-recruitment-funnel-section">
      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
        <SectionCard
          className="min-w-0 @container @4xl:col-span-8"
          testId="md-recruitment-funnel"
          title="Hiring funnel"
          subtitle="Candidates who entered in the period, counted at each step by where they are today"
          loading={funnel.isPending}
          provenance={data?.provenance}
          provenanceIds={["funnel"]}
          actions={
            <AskAiButton question="Where are we losing candidates in the hiring funnel, and what would improve it?" />
          }
        >
          <QueryError query={funnel} />
          <div className="mb-4 max-w-full overflow-x-auto" data-testid="md-recruitment-funnel-view">
            <PillTabs
              size="sm"
              items={VIEWS}
              value={view}
              onChange={(v) => setView(v as FunnelView)}
              baseColor="#006496"
            />
          </div>
          {data &&
            (entered === 0 && view !== "all" ? (
              <EmptyBlock icon={Layers} title="No candidates in this view">
                Nobody entered through this route in the period.
              </EmptyBlock>
            ) : data.stages[0]?.count === 0 ? (
              <EmptyBlock icon={Layers} title="No candidates in this period">
                Candidates appear here when someone applies on the job board or HR uploads a resume in Resume Screening.
              </EmptyBlock>
            ) : (
              <FunnelSteps bars={bars} />
            ))}
        </SectionCard>

        <SectionCard
          className="min-w-0 @4xl:col-span-4"
          testId="md-recruitment-sources"
          title="Where candidates come from"
          subtitle="The route each candidate came in through"
          loading={sources.isPending}
          provenance={sources.data?.provenance}
          actions={<AskAiButton question="Which candidate source is working best for us?" />}
        >
          <QueryError query={sources} />
          {sources.data &&
            (sources.data.total === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No candidates in this period.</p>
            ) : (
              <>
                <BarList
                  testId="md-recruitment-sources-list"
                  items={sources.data.channels.map((c) => ({
                    key: c.id,
                    label: c.label,
                    value: c.candidates,
                    sub: `${num(c.progressed)} ${c.progressedLabel}${c.progressedPct != null ? ` (${pct(c.progressedPct, 0)})` : ""}${c.detail ? ` · ${c.detail}` : ""}`,
                  }))}
                />
                <p className="mt-4 text-[11px] text-[#006496]/60">
                  The system records which route a candidate came through, not how they heard of the job (referral,
                  agency, walk-in).
                </p>
              </>
            ))}
        </SectionCard>

        <SectionCard
          className="min-w-0 @4xl:col-span-12"
          testId="md-recruitment-funnel-departments"
          title="Funnel by department"
          subtitle={
            data && data.departmentsTotal > data.departmentsShown
              ? `The ${data.departmentsShown} departments with the most candidates, of ${data.departmentsTotal}`
              : "Candidates by the department they applied to; Joined is every new employee of the department, hired through any route"
          }
          loading={funnel.isPending}
          actions={<AskAiButton question="Which departments convert candidates into hires best, and which worst?" />}
        >
          <QueryError query={funnel} />
          {data && (
            <DataTable
              testId="md-recruitment-funnel-department-table"
              columns={DEPARTMENT_COLUMNS}
              rows={data.byDepartment}
              rowKey={(r) => r.departmentId ?? "none"}
              initialSort={{ key: "applied", dir: "desc" }}
              pageSize={8}
              empty="No candidates in this period."
            />
          )}
        </SectionCard>
      </div>
    </div>
  );
}

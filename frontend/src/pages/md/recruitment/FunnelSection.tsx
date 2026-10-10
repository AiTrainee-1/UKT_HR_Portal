import { useState } from "react";
import { CheckCheck, Layers } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { num, pct } from "@/lib/md/format";
import { funnelBars, stepColor, type FunnelBar } from "./logic";
import { QueryError, SegTabs } from "./parts";
import type { FunnelDepartmentRow, FunnelView, QueryLike, RecruitmentFunnel, RecruitmentSources } from "./types";

const VIEWS = [
  { value: "all", label: "All candidates" },
  { value: "jobBoard", label: "Job board" },
  { value: "screening", label: "Resume screening" },
];

/** One bar of the funnel: centred in its sand groove so the column narrows as candidates drop out. The colour runs down the
 *  wine ramp, light at the top to dark at the bottom; "Joined" is counted from the employee records, so it is indigo and
 *  dashed rather than the next step of the same colour. */
function FunnelShape({ bar, index, total }: { bar: FunnelBar; index: number; total: number }) {
  if (!bar.tracked) {
    return <div className="md-people-funnel-empty">Not recorded for this view</div>;
  }
  return (
    <div className="md-people-funnel-track" role="img" aria-label={`${bar.label}: ${bar.count} candidates`}>
      {bar.widthPct > 0 && (
        <div
          className="md-people-funnel-bar"
          data-standalone={bar.standalone}
          style={{ width: `${bar.widthPct}%`, background: bar.standalone ? undefined : stepColor(index, total) }}
        />
      )}
    </div>
  );
}

function FunnelSteps({ bars }: { bars: FunnelBar[] }) {
  const pipeline = bars.filter((b) => !b.standalone).length;
  return (
    <ol className="md-people-funnel space-y-3.5" data-testid="md-recruitment-funnel-steps">
      {bars.map((b, i) => (
        <li
          key={b.id}
          data-testid={`funnel-step-${b.id}`}
          className="grid grid-cols-1 items-start gap-x-5 gap-y-2 @md:grid-cols-[8rem_minmax(0,1fr)]"
        >
          <div className="flex items-center justify-between gap-2 @md:block">
            <p className="flex items-center gap-2 text-[13px] font-bold text-md-ink">
              <span className="md-people-step-no" data-kind={b.standalone ? "records" : "pipeline"} aria-hidden="true">
                {b.standalone && <CheckCheck size={12} />}
              </span>
              {b.label}
            </p>
            <p
              className="md-people-figure text-[1.65rem] font-black leading-none tracking-tight text-md-ink @md:mt-1.5 @md:pl-[1.875rem]"
              data-testid={`funnel-count-${b.id}`}
            >
              {b.count == null ? "—" : num(b.count)}
            </p>
          </div>
          <div className="min-w-0">
            <FunnelShape bar={b} index={i} total={pipeline} />
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-snug">
              {b.conversion && <b className="md-chip md-chip-wine">{b.conversion}</b>}
              {b.dropOff && <span className="font-medium text-md-ink-soft">{b.dropOff}</span>}
              {i === 0 && b.tracked && <span className="font-medium text-md-ink-soft">Everyone who entered</span>}
            </p>
            {b.note && <p className="mt-1 text-[11px] italic leading-snug text-md-ink-soft">{b.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** A column of counts: right-aligned, tabular, the last step of the funnel (Joined) in wine. */
type CountKey = "applied" | "screened" | "shortlisted" | "interviewed" | "offered" | "joined";

const countColumn = (key: CountKey, header: string, emphasis = false): Column<FunnelDepartmentRow> => ({
  key,
  header,
  align: "right",
  className: "tabular-nums",
  cell: (r) => (emphasis ? <b className="text-md-wine">{num(r[key])}</b> : num(r[key])),
  sortValue: (r) => r[key],
});

const DEPARTMENT_COLUMNS: Column<FunnelDepartmentRow>[] = [
  {
    key: "department",
    header: "Department",
    cell: (r) => <span className="font-semibold text-md-ink">{r.department}</span>,
    sortValue: (r) => r.department,
  },
  countColumn("applied", "Applied"),
  countColumn("screened", "Screened"),
  countColumn("shortlisted", "Shortlisted"),
  countColumn("interviewed", "Interviewed"),
  countColumn("offered", "Offered"),
  countColumn("joined", "Joined", true),
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
          <div className="mb-5 max-w-full overflow-x-auto pb-1" data-testid="md-recruitment-funnel-view">
            <SegTabs
              label="Which candidates the funnel counts"
              items={VIEWS}
              value={view}
              onChange={(v) => setView(v as FunnelView)}
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
              <p className="py-6 text-center text-sm text-md-ink-soft">No candidates in this period.</p>
            ) : (
              <>
                <BarList
                  testId="md-recruitment-sources-list"
                  items={sources.data.channels.map((c, i) => ({
                    key: c.id,
                    label: c.label,
                    value: c.candidates,
                    color: CHART.series[i % CHART.series.length], // a route keeps its own colour: wine, then indigo
                    sub: `${num(c.progressed)} ${c.progressedLabel}${c.progressedPct != null ? ` (${pct(c.progressedPct, 0)})` : ""}${c.detail ? ` · ${c.detail}` : ""}`,
                  }))}
                />
                <p className="mt-4 text-[11px] leading-snug text-md-ink-soft">
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

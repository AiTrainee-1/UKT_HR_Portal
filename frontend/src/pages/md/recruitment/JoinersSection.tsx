import { ArrowLeftRight, UserPlus, UserX } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { dayShort, monthText, num } from "@/lib/md/format";
import { daysText, docsChip, earlyHeadline, hasVacancyLine, plural, trendRows, trendVerdict } from "./logic";
import { Avatar, Chip, Expandable, QueryError } from "./parts";
import type { EarlyLeaverRow, JoinerRow, QueryLike, RecruitmentJoiners, RecruitmentTrend } from "./types";

const JOINER_COLUMNS: Column<JoinerRow>[] = [
  {
    key: "name",
    header: "Employee",
    cell: (r) => (
      <div className="flex min-w-[9rem] items-center gap-2.5">
        <Avatar name={r.employeeName} className="md-people-avatar-sm" />
        <div className="min-w-0">
          <p className="font-semibold text-md-ink">{r.employeeName}</p>
          <p className="text-xs text-md-ink-soft">
            {[r.department, r.designation ?? (r.type ? r.type[0].toUpperCase() + r.type.slice(1) : null)]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </div>
    ),
    sortValue: (r) => r.employeeName,
  },
  {
    key: "joined",
    header: "Joined",
    cell: (r) => <span className="whitespace-nowrap tabular-nums">{dayShort(r.joinDate)}</span>,
    sortValue: (r) => r.joinDate,
  },
  {
    key: "docs",
    header: "Onboarding documents",
    cell: (r) => {
      const chip = docsChip(r.docsMissing);
      return <Chip tone={chip.tone}>{chip.text}</Chip>;
    },
    sortValue: (r) => r.docsMissing,
  },
];

const EARLY_COLUMNS: Column<EarlyLeaverRow>[] = [
  {
    key: "name",
    header: "Employee",
    cell: (r) => (
      <div className="flex min-w-[9rem] items-center gap-2.5">
        <Avatar name={r.employeeName} className="md-people-avatar-sm md-people-avatar-ink" />
        <div className="min-w-0">
          <p className="font-semibold text-md-ink">{r.employeeName}</p>
          <p className="text-xs text-md-ink-soft">{r.department}</p>
        </div>
      </div>
    ),
    sortValue: (r) => r.employeeName,
  },
  {
    key: "served",
    header: "Stayed",
    cell: (r) => (
      <span
        className="whitespace-nowrap font-bold tabular-nums text-md-ink"
        title={r.approximate ? "Exit date is approximate" : undefined}
      >
        {r.approximate ? "about " : ""}
        {daysText(r.daysServed)}
      </span>
    ),
    sortValue: (r) => r.daysServed,
  },
  {
    key: "dates",
    header: "Joined → left",
    cell: (r) => (
      <span className="whitespace-nowrap text-xs text-md-ink-soft">
        {dayShort(r.joinDate)} → {dayShort(r.exitDate)}
      </span>
    ),
    sortValue: (r) => r.exitDate,
  },
];

// Joined is the series that matters (wine), Left the comparison (indigo), the staffing gap an ochre dashed line on its own
// scale. Colour is not the only cue: the legend names each, and the bars sit side by side.
const TREND_SERIES = (withVacancies: boolean): TrendSeries[] => [
  { key: "joiners", label: "Joined", kind: "bar", color: CHART.brand },
  { key: "leavers", label: "Left", kind: "bar", color: CHART.deep },
  ...(withVacancies
    ? [
        {
          key: "vacancies",
          label: "Vacancies against plan",
          kind: "line" as const,
          color: CHART.gold,
          dashed: true,
          rightAxis: true,
        },
      ]
    : []),
];

/** Joiners against leavers over twelve months with the running staffing gap, then who joined (and whether their
 *  documents are in) and who left within 90 days. */
export default function JoinersSection({
  trend,
  joiners,
}: {
  trend: QueryLike<RecruitmentTrend>;
  joiners: QueryLike<RecruitmentJoiners>;
}) {
  const t = trend.data;
  const j = joiners.data;
  const rows = t ? trendRows(t.months) : [];
  const withVacancies = t ? hasVacancyLine(t.months) : false;

  return (
    <div className="@container" data-testid="md-recruitment-joiners-section">
      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
        <SectionCard
          className="min-w-0 @4xl:col-span-12"
          testId="md-recruitment-trend"
          title="Joiners against leavers"
          subtitle={t ? `Last 12 months. ${trendVerdict(t.totals)}` : "Last 12 months"}
          loading={trend.isPending}
          provenance={t?.provenance}
          provenanceIds={["joiners", "leavers", "headcount-gap"]}
          actions={<AskAiButton question="Are we hiring faster than people leave, and is the staffing gap closing?" />}
        >
          <QueryError query={trend} />
          {t &&
            (t.totals.joiners === 0 && t.totals.leavers === 0 ? (
              <EmptyBlock icon={ArrowLeftRight} title="No joiners or leavers in the last 12 months">
                Joiners come from employee join dates; leavers from approved resignations and deactivations.
              </EmptyBlock>
            ) : (
              <TrendChart
                data={rows}
                xKey="month"
                xFormat={(v) => monthText(v, true)}
                series={TREND_SERIES(withVacancies)}
                height={280}
                rightFormat={(v) => String(v)}
              />
            ))}
          {t && withVacancies && (
            <p className="mt-2 text-[11px] leading-snug text-md-ink-soft">
              The line is vacancies against today's staffing plan at each month end (right-hand scale); the plan has no
              history. The latest month is the month so far.
            </p>
          )}
        </SectionCard>

        <SectionCard
          className="min-w-0 @4xl:col-span-7"
          testId="md-recruitment-joiners"
          title="Who joined"
          subtitle={
            j
              ? `${plural(j.summary.joiners, "joiner")} in the period${j.summary.docsPending ? ` · ${plural(j.summary.docsPending, "person", "people")} still owe documents` : ""}`
              : undefined
          }
          loading={joiners.isPending}
          provenance={j?.provenance}
          provenanceIds={["joiners", "onboarding-docs"]}
          actions={<AskAiButton question="Who joined recently, and is onboarding keeping up with the documents?" />}
        >
          <QueryError query={joiners} />
          {j &&
            (j.list.length === 0 ? (
              <EmptyBlock icon={UserPlus} title="Nobody joined in this period">
                Joiners come from the join date on each employee record.
              </EmptyBlock>
            ) : (
              <>
                <Expandable
                  initial={5}
                  items={j.byDepartment.map((d) => ({ key: d.department, label: d.department, value: d.joiners }))}
                >
                  {(shown) => <BarList testId="md-recruitment-joiners-departments" items={shown} />}
                </Expandable>
                <div className="mt-5 border-t border-md-line pt-3">
                  <DataTable
                    testId="md-recruitment-joiners-table"
                    columns={JOINER_COLUMNS}
                    rows={j.list}
                    rowKey={(r) => `${r.employeeName}-${r.joinDate}`}
                    pageSize={5}
                    dense
                  />
                  {j.listShown < j.summary.joiners && (
                    <p className="mt-2 text-[11px] leading-snug text-md-ink-soft">
                      The {j.listShown} most recent of {num(j.summary.joiners)} joiners are listed.
                    </p>
                  )}
                </div>
              </>
            ))}
        </SectionCard>

        <SectionCard
          className="min-w-0 @4xl:col-span-5"
          testId="md-recruitment-early"
          title="Early attrition"
          subtitle={j ? `People who left within ${j.earlyAttrition.windowDays} days of joining` : undefined}
          loading={joiners.isPending}
          provenance={j?.provenance}
          provenanceIds={["early-attrition", "leavers"]}
          actions={<AskAiButton question="Are new hires leaving early, and in which departments?" />}
        >
          <QueryError query={joiners} />
          {j &&
            (j.earlyAttrition.totalLeavers === 0 ? (
              <EmptyBlock icon={UserX} title="Nobody left in this period">
                Early attrition is the share of leavers who had been here 90 days or less.
              </EmptyBlock>
            ) : (
              <>
                <p
                  className="md-panel-wine mb-4 px-4 py-3 text-sm font-semibold leading-snug text-md-ink"
                  data-testid="md-recruitment-early-headline"
                >
                  {earlyHeadline(j.earlyAttrition)}
                </p>
                {j.earlyAttrition.list.length === 0 ? (
                  <p className="py-4 text-center text-sm text-md-ink-soft">No one left within 90 days of joining.</p>
                ) : (
                  <DataTable
                    testId="md-recruitment-early-table"
                    columns={EARLY_COLUMNS}
                    rows={j.earlyAttrition.list}
                    rowKey={(r) => `${r.employeeName}-${r.exitDate}`}
                    pageSize={5}
                    dense
                  />
                )}
                {j.earlyAttrition.byDepartment.length > 0 && (
                  <p className="mt-3 text-[11px] leading-snug text-md-ink-soft">
                    Most early exits:{" "}
                    {j.earlyAttrition.byDepartment.map((d) => `${d.department} (${d.leavers})`).join(", ")}.
                  </p>
                )}
              </>
            ))}
        </SectionCard>
      </div>
    </div>
  );
}

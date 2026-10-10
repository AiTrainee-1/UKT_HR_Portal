import { FileClock, PieChart } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import DonutChart from "@/components/md/kit/DonutChart";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayLong, dayShort, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { daysLeftText, daysText, outlookLine, plural, reasonSlices, waitTone } from "./logic";
import { Avatar, Chip, Expandable, QueryError } from "./parts";
import type { OnNoticeRow, OutlookWindow, PendingResignation, QueryLike, RecruitmentResignations } from "./types";

function pendingColumns(warnAfter: number): Column<PendingResignation>[] {
  return [
    {
      key: "employee",
      header: "Employee",
      cell: (r) => (
        <div className="flex min-w-[10rem] items-center gap-2.5">
          <Avatar name={r.employeeName} />
          <div className="min-w-0">
            <p className="font-semibold text-md-ink">{r.employeeName}</p>
            <p className="text-xs text-md-ink-soft">{[r.department, r.designation].filter(Boolean).join(" · ")}</p>
          </div>
        </div>
      ),
      sortValue: (r) => r.employeeName,
    },
    {
      key: "raised",
      header: "Raised",
      cell: (r) => (
        <div className="whitespace-nowrap">
          <p className="tabular-nums text-md-ink">{dayShort(r.requestedOn)}</p>
          <Chip tone={waitTone(r.daysWaiting, warnAfter)} className="mt-0.5">
            waiting {daysText(r.daysWaiting)}
          </Chip>
        </div>
      ),
      sortValue: (r) => r.daysWaiting,
    },
    {
      key: "lastDay",
      header: "Last working day",
      cell: (r) =>
        r.lastWorkingDate ? (
          <div className="whitespace-nowrap">
            <p className="tabular-nums text-md-ink">{dayShort(r.lastWorkingDate)}</p>
            {r.daysToLastDay != null && (
              <p className="text-[11px] text-md-ink-soft">
                {r.daysToLastDay >= 0 ? daysLeftText(r.daysToLastDay) : "date has passed"}
              </p>
            )}
          </div>
        ) : (
          <span className="text-xs text-md-ink-soft">Not given</span>
        ),
      sortValue: (r) => r.lastWorkingDate,
    },
    {
      key: "waitingFor",
      header: "Waiting for",
      cell: (r) => <Chip tone="blue">{r.waitingForText}</Chip>,
      sortValue: (r) => r.waitingForText,
    },
  ];
}

function NoticeList({ rows, total }: { rows: OnNoticeRow[]; total: number }) {
  if (rows.length === 0) return null;
  return (
    <div className="md-panel mt-5 p-4" data-testid="md-recruitment-on-notice">
      <p className="md-people-overline mb-1.5">Serving notice ({total})</p>
      <ul>
        {rows.map((r) => (
          <li key={r.id} className="md-people-row">
            <span className="flex min-w-0 items-center gap-2.5">
              <Avatar name={r.employeeName} className="md-people-avatar-sm" />
              <span className="min-w-0 text-sm">
                <b className="font-semibold text-md-ink">{r.employeeName}</b>{" "}
                <span className="text-xs text-md-ink-soft">{r.department}</span>
              </span>
            </span>
            <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-md-ink-soft">
              last day {dayLong(r.lastWorkingDate)}
              <Chip>{daysLeftText(r.daysLeft)}</Chip>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A "next N days" figure on a quiet tinted panel: wine for the nearer window, sand for the longer one. */
function OutlookTile({ window, testId, tone }: { window: OutlookWindow; testId: string; tone: "wine" | "sand" }) {
  return (
    <div className={cn("md-people-outlook", tone === "wine" ? "md-panel-wine" : "md-panel-sand")} data-testid={testId}>
      <p className="text-xs font-bold text-md-ink-soft">Next {window.days} days</p>
      <p className="md-people-outlook-figure">{num(window.total)}</p>
      <p className="text-xs leading-snug text-md-ink-soft">{outlookLine(window)}</p>
    </div>
  );
}

/** Resignations: what waits for a decision (and for whom), who is serving notice, who is due to leave soon, why people
 *  resign, and where. Names appear only in the two short lists; reasons are counted by group, never quoted. */
export default function ResignationsSection({ query }: { query: QueryLike<RecruitmentResignations> }) {
  const data = query.data;
  const warnAfter = data?.summary.warnAfterDays ?? 7;
  const total = data?.reasons.reduce((sum, r) => sum + r.count, 0) ?? 0;

  return (
    <div className="@container" data-testid="md-recruitment-resignations-section">
      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
        <SectionCard
          className="min-w-0 @4xl:col-span-8"
          testId="md-recruitment-pending"
          title="Resignations waiting for a decision"
          subtitle={
            data
              ? data.summary.pending === 0
                ? "Nothing is waiting"
                : `${plural(data.summary.pending, "request")} · ${data.summary.waitingOn.map((w) => `${w.count} with ${w.label}`).join(", ")}`
              : undefined
          }
          loading={query.isPending}
          provenance={data?.provenance}
          provenanceIds={["resignations-pending", "notice"]}
          actions={
            <AskAiButton question="Which resignations are waiting for a decision, and who needs to act on them?" />
          }
        >
          <QueryError query={query} />
          {data &&
            (data.pending.length === 0 && data.onNotice.length === 0 ? (
              <EmptyBlock icon={FileClock} title="No resignations waiting">
                Requests raised by employees appear here until the department head and HR have decided them.
              </EmptyBlock>
            ) : (
              <>
                {data.pending.length > 0 && (
                  <DataTable
                    testId="md-recruitment-pending-table"
                    columns={pendingColumns(warnAfter)}
                    rows={data.pending}
                    rowKey={(r) => r.id}
                    initialSort={{ key: "raised", dir: "desc" }}
                    pageSize={6}
                  />
                )}
                <NoticeList rows={data.onNotice} total={data.summary.onNotice} />
              </>
            ))}
        </SectionCard>

        <SectionCard
          className="min-w-0 @4xl:col-span-4"
          testId="md-recruitment-outlook"
          title="Who is about to leave"
          subtitle="Last working days that fall within the window"
          loading={query.isPending}
          provenance={data?.provenance}
          provenanceIds={["outlook"]}
          actions={
            <AskAiButton question="Who is due to leave in the next 60 days, and which departments will it hurt?" />
          }
        >
          <QueryError query={query} />
          {data && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <OutlookTile window={data.outlook.next30} testId="md-recruitment-outlook-30" tone="wine" />
                <OutlookTile window={data.outlook.next60} testId="md-recruitment-outlook-60" tone="sand" />
              </div>
              {data.outlook.byDepartment.length > 0 && (
                <div className="mt-5">
                  <p className="md-people-overline mb-3">By department, next 60 days</p>
                  <BarList
                    testId="md-recruitment-outlook-departments"
                    color={CHART.deep}
                    items={data.outlook.byDepartment.slice(0, 6).map((d) => ({
                      key: d.departmentId == null ? "none" : String(d.departmentId),
                      label: d.department,
                      value: d.count,
                    }))}
                  />
                </div>
              )}
              {data.outlook.withoutDate > 0 && (
                <p className="mt-3 text-[11px] leading-snug text-md-ink-soft">
                  {plural(data.outlook.withoutDate, "waiting request")}{" "}
                  {data.outlook.withoutDate === 1 ? "has" : "have"} no last working day, so{" "}
                  {data.outlook.withoutDate === 1 ? "it is" : "they are"} not counted.
                </p>
              )}
            </>
          )}
        </SectionCard>

        <SectionCard
          className="min-w-0 @4xl:col-span-5"
          testId="md-recruitment-reasons"
          title="Why people resign"
          subtitle="Resignations raised in the period, grouped by what employees wrote"
          loading={query.isPending}
          provenance={data?.provenance}
          provenanceIds={["reasons", "resignations-raised"]}
          actions={<AskAiButton question="Why are people resigning, and what could we change?" />}
        >
          <QueryError query={query} />
          {data &&
            (data.reasons.length === 0 ? (
              <EmptyBlock icon={PieChart} title="No resignations raised in this period">
                Reasons are grouped here once employees raise resignation requests.
              </EmptyBlock>
            ) : (
              <DonutChart
                testId="md-recruitment-reasons-donut"
                data={reasonSlices(data.reasons)}
                center={
                  <>
                    <p className="md-people-figure text-2xl font-black text-md-ink">{num(total)}</p>
                    <p className="text-[11px] font-semibold text-md-ink-soft">raised</p>
                  </>
                }
              />
            ))}
          {data && data.reasons.length > 0 && (
            <p className="mt-3 text-[11px] leading-snug text-md-ink-soft">
              Grouped by keyword from each employee's own words, so it is a guide, not an exact count. Average time to
              decide:{" "}
              {data.summary.avgDaysToDecision == null
                ? "not enough decided requests"
                : daysText(data.summary.avgDaysToDecision)}
              .
            </p>
          )}
        </SectionCard>

        <SectionCard
          className="min-w-0 @4xl:col-span-7"
          testId="md-recruitment-resignations-by-department"
          title="Resignations by department"
          subtitle="Raised in the period, with what happened to them"
          loading={query.isPending}
          provenance={data?.provenance}
          provenanceIds={["resignations-raised"]}
          actions={<AskAiButton question="Which departments have the most resignations, and is it getting worse?" />}
        >
          <QueryError query={query} />
          {data && (
            <Expandable
              items={data.byDepartment.map((d) => ({
                key: d.departmentId == null ? "none" : String(d.departmentId),
                label: d.department,
                value: d.raised,
                sub: `${d.approved} approved · ${d.pending} waiting · ${d.rejected} rejected`,
              }))}
            >
              {(shown) => (
                <BarList
                  testId="md-recruitment-resignations-departments"
                  emptyText="No resignations raised in this period."
                  items={shown}
                />
              )}
            </Expandable>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

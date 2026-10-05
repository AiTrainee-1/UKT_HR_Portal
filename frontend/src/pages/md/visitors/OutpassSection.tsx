import { useMemo, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { DoorOpen } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
import { Button } from "@/components/ui/button";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { minutesText, num, pct } from "@/lib/md/format";
import {
  agingItems,
  departmentItems,
  dropOffs,
  durationItems,
  funnelItems,
  periodPhrase,
  plural,
  reasonItems,
  refusalItems,
  waitText,
} from "./logic";
import { CardNote, Chip, MiniStat, SectionHeading, type ChipTone } from "./parts";
import type { OutpassResponse } from "./types";

const DEPARTMENTS_SHOWN = 6;

const DROP_TONE: Record<string, ChipTone> = { bad: "red", warn: "amber", neutral: "slate" };

type GateRow = OutpassResponse["gateScans"]["byGate"][number];
const gateColumns: Column<GateRow>[] = [
  { key: "gate", header: "Gate", cell: (g) => <span className="font-semibold text-[#1a3a4a]">{g.gate}</span> },
  { key: "exits", header: "Exits", align: "right", cell: (g) => num(g.exits) },
  { key: "returns", header: "Returns", align: "right", cell: (g) => num(g.returns) },
  {
    key: "refused",
    header: "Refused",
    align: "right",
    cell: (g) => <span className={g.refused > 0 ? "font-semibold text-red-700" : undefined}>{num(g.refused)}</span>,
  },
];

/** Who leaves during the shift: the request-to-return funnel, hours out by department, why, for how long, the approvals
 *  queue and what the gate refused. */
export default function OutpassSection({ query }: { query: UseQueryResult<OutpassResponse> }) {
  const d = query.isError ? undefined : query.data;
  const [showAll, setShowAll] = useState(false);
  const when = periodPhrase(d?.period);
  const shown = showAll ? 25 : DEPARTMENTS_SHOWN;
  const departments = useMemo(() => (d ? departmentItems(d.byDepartment, shown) : []), [d, shown]);
  const empty = !!d && d.requests === 0 && d.gateScans.attempts === 0;
  const aging = d?.approvals.aging;
  const scans = d?.gateScans;

  return (
    <section className="space-y-4" data-testid="md-outpass-section">
      <SectionHeading
        icon={DoorOpen}
        title="Outpasses"
        subtitle="Employees who asked to leave during the shift. On-Duty trips are official work and are not counted."
        testId="md-outpass-section-heading"
      />
      {query.isError && <ErrorBanner message={describeMdError(query.error)} onRetry={() => query.refetch()} />}

      {query.isError ? null : empty ? (
        <SectionCard title="No outpasses in this period" testId="md-outpass-none">
          <EmptyBlock icon={DoorOpen} title="Nobody asked to leave">
            No outpass was requested {when} for this unit, department and staff or production choice, and the gate
            scanned nothing. Try a longer period.
          </EmptyBlock>
        </SectionCard>
      ) : (
        <div className="grid grid-cols-1 items-start gap-5 @2xl:grid-cols-2 @5xl:grid-cols-12">
          <SectionCard
            className="@5xl:col-span-5"
            title="From request to return"
            subtitle="What happened to the passes requested in the period"
            loading={query.isPending}
            provenance={d?.provenance}
            provenanceIds={["funnel", "return-rate"]}
            actions={
              <AskAiButton
                question={`How many outpass requests were approved, used and returned ${when}? Where do the rest go?`}
              />
            }
            testId="md-outpass-funnel"
          >
            {d && (
              <>
                <BarList items={funnelItems(d.funnel)} testId="md-outpass-funnel-bars" />
                {dropOffs(d.funnel).length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-1.5" data-testid="md-outpass-dropoffs">
                    {dropOffs(d.funnel).map((x) => (
                      <Chip key={x.key} tone={DROP_TONE[x.tone]}>
                        {x.label}: {num(x.count)}
                      </Chip>
                    ))}
                  </div>
                )}
                {d.funnel.onDutyTrips > 0 && (
                  <CardNote>
                    Not counted: {num(d.funnel.onDutyTrips)} On-Duty {plural(d.funnel.onDutyTrips, "trip")} (official
                    work).
                  </CardNote>
                )}
              </>
            )}
          </SectionCard>

          <SectionCard
            className="@5xl:col-span-7"
            title="Time out by department"
            subtitle="Hours employees spent outside the gate on a pass (exit scan to return scan)"
            loading={query.isPending}
            provenance={d?.provenance}
            provenanceIds={["departments", "hours-out"]}
            actions={<AskAiButton question={`Which departments lost the most time to outpasses ${when}?`} />}
            testId="md-outpass-departments"
          >
            <BarList
              items={departments}
              color={CHART.warn}
              emptyText="No pass was scanned back in during this period."
              testId="md-outpass-department-bars"
            />
            {d && d.byDepartment.length > DEPARTMENTS_SHOWN && (
              <div className="mt-3 flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAll((v) => !v)}
                  data-testid="md-outpass-show-all"
                >
                  {showAll ? "Show fewer" : `Show all ${num(d.departmentsTotal)}`}
                </Button>
              </div>
            )}
          </SectionCard>

          <SectionCard
            className="@5xl:col-span-4"
            title="Why people leave"
            subtitle="The pass type chosen on the request"
            loading={query.isPending}
            provenance={d?.provenance}
            provenanceIds={["reasons"]}
            actions={
              <AskAiButton question={`Why are employees taking outpasses ${when}? Split official from personal.`} />
            }
            testId="md-outpass-reasons"
          >
            <BarList items={reasonItems(d?.byReason ?? [])} emptyText="No requests in this period." />
          </SectionCard>

          <SectionCard
            className="@5xl:col-span-4"
            title="How long they stay out"
            subtitle="Passes scanned back in, by door-to-door time"
            loading={query.isPending}
            provenance={d?.provenance}
            provenanceIds={["durations"]}
            actions={
              <AskAiButton
                question={`How long do employees stay out on outpasses ${when}? Were any far longer than usual?`}
              />
            }
            testId="md-outpass-durations"
          >
            {d && (
              <>
                <BarList
                  items={durationItems(d.durations.buckets)}
                  color={CHART.sky}
                  emptyText="No pass was scanned back in."
                />
                {d.durations.measured > 0 && (
                  <CardNote>
                    Typical (median) {minutesText(d.durations.medianMinutes)} · longest{" "}
                    {minutesText(d.durations.longestMinutes)} · {num(d.durations.measured)} passes measured
                  </CardNote>
                )}
              </>
            )}
          </SectionCard>

          <SectionCard
            className="@2xl:col-span-2 @5xl:col-span-4"
            title="Approvals waiting"
            subtitle="Requests nobody has decided yet, right now"
            loading={query.isPending}
            provenance={d?.provenance}
            provenanceIds={["waiting", "turnaround"]}
            actions={
              <AskAiButton question="Which outpass requests are still waiting for a decision, and how long have they waited?" />
            }
            testId="md-outpass-approvals"
          >
            {d && aging && (
              <>
                <div className="mb-3 grid grid-cols-2 gap-2">
                  <MiniStat
                    label="waiting now"
                    value={num(aging.waiting)}
                    tone={aging.overOneDay > 0 ? "bad" : undefined}
                  />
                  <MiniStat label="oldest" value={aging.waiting > 0 ? waitText(aging.oldestMinutes) : "—"} />
                </div>
                <BarList items={agingItems(aging.buckets)} emptyText="Nothing is waiting." />
                <CardNote>
                  {d.approvals.turnaround.avgMinutes == null
                    ? "No request was approved in this period."
                    : `Approved requests were decided in ${minutesText(d.approvals.turnaround.avgMinutes)} on average (half within ${minutesText(d.approvals.turnaround.medianMinutes)}).`}
                </CardNote>
              </>
            )}
          </SectionCard>

          <SectionCard
            className="@2xl:col-span-2 @5xl:col-span-12"
            title="At the gate"
            subtitle="Exit and return scans, and the ones the gate refused"
            loading={query.isPending}
            provenance={d?.provenance}
            provenanceIds={["gate-scans"]}
            actions={<AskAiButton question={`How often did the gate refuse an outpass scan ${when}, and why?`} />}
            testId="md-outpass-gate"
          >
            {scans && (
              <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
                <div className="space-y-3 @4xl:col-span-5">
                  <div className="grid grid-cols-3 gap-2">
                    <MiniStat label="scans" value={num(scans.attempts)} />
                    <MiniStat label="refused" value={num(scans.refused)} tone={scans.refused > 0 ? "bad" : undefined} />
                    <MiniStat label="refused share" value={pct(scans.refusedPct)} />
                  </div>
                  <BarList items={refusalItems(scans)} emptyText="The gate refused nothing in this period." />
                </div>
                <div className="@4xl:col-span-7">
                  <DataTable
                    columns={gateColumns}
                    rows={scans.byGate}
                    rowKey={(g) => g.gate}
                    pageSize={8}
                    dense
                    empty="No scans at any gate in this period."
                  />
                </div>
              </div>
            )}
          </SectionCard>
        </div>
      )}
    </section>
  );
}

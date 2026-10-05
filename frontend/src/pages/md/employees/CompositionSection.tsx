import { Users } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import DonutChart from "@/components/md/kit/DonutChart";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import TrendChart from "@/components/md/kit/TrendChart";
import { num } from "@/lib/md/format";
import {
  bandRows,
  bandTick,
  departmentsFootnote,
  genderSlices,
  groupBars,
  staffingBars,
  typeSlices,
  typeSplitText,
  type Asks,
} from "./logic";
import { Unavailable } from "./parts";
import type { EmployeesComposition } from "./types";

const heading = "mb-2 text-[11px] font-bold uppercase tracking-wider text-[#006496]/60";

function Total({ n }: { n: number }) {
  return (
    <>
      <p className="text-2xl font-black text-[#1a3a4a]">{num(n)}</p>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[#006496]/55">people</p>
    </>
  );
}

/** A column chart of one band (age, length of service): the shape of the workforce at a glance. */
function Columns({ rows }: { rows: { label: string; count: number }[] }) {
  return (
    <TrendChart
      data={rows}
      xKey="label"
      series={[{ key: "count", label: "People", kind: "bar", color: CHART.brand }]}
      xFormat={bandTick}
      yFormat={(v) => num(v)}
      height={210}
      allTicks
    />
  );
}

/** Who works here today: mix, units, departments, length of service, age, designations and planned staffing. */
export default function CompositionSection({
  composition: c,
  asks,
  showingAll,
  onShowAll,
  failed,
}: {
  composition: EmployeesComposition | undefined;
  failed?: boolean;
  asks: Asks;
  /** True once every department has been asked for, not just the biggest. */
  showingAll: boolean;
  onShowAll: () => void;
}) {
  if (!c) {
    return (
      <div
        className="grid grid-cols-1 items-start gap-5 @2xl:grid-cols-2 @5xl:grid-cols-12"
        data-testid="md-employees-composition"
      >
        <SectionCard className="@2xl:col-span-2 @5xl:col-span-12" title="Who works here" loading={!failed}>
          <Unavailable />
        </SectionCard>
      </div>
    );
  }
  if (c.total === 0) {
    return (
      <SectionCard title="Who works here" provenance={c.provenance} testId="md-employees-composition">
        <EmptyBlock icon={Users} title="Nobody is on the rolls for these filters">
          There are no active employees in this unit, department and type. Choose a wider part of the company.
        </EmptyBlock>
      </SectionCard>
    );
  }
  const ask = (question: string) => <AskAiButton question={question} />;
  const rows = c.staffing.rows;
  const half = Math.ceil(rows.length / 2);
  const staffingColumns = rows.length > 4 ? [rows.slice(0, half), rows.slice(half)] : [rows];
  return (
    <div
      className="grid grid-cols-1 items-start gap-5 @2xl:grid-cols-2 @5xl:grid-cols-12"
      data-testid="md-employees-composition"
    >
      <SectionCard
        className="@5xl:col-span-4"
        title="Staff and production"
        subtitle="Everyone on the rolls today"
        provenance={c.provenance}
        provenanceIds={["composition"]}
        actions={ask(asks.mix)}
        testId="md-employees-mix"
      >
        <DonutChart
          data={typeSlices(c.byType)}
          center={<Total n={c.total} />}
          height={170}
          testId="md-employees-mix-donut"
        />
        {c.byGender.length > 0 && (
          <div className="mt-4 border-t pt-3" data-testid="md-employees-gender">
            <p className={heading}>Gender</p>
            <DonutChart data={genderSlices(c.byGender)} height={120} />
          </div>
        )}
      </SectionCard>

      <SectionCard
        className="@5xl:col-span-3"
        title="By unit"
        subtitle="People in each unit"
        provenance={c.provenance}
        provenanceIds={["composition"]}
        actions={ask(asks.units)}
        testId="md-employees-units"
      >
        <BarList items={groupBars(c.byUnit, typeSplitText)} />
      </SectionCard>

      <SectionCard
        className="@2xl:col-span-2 @5xl:col-span-5"
        title="By department"
        subtitle={departmentsFootnote(c) ?? "People in each department"}
        provenance={c.provenance}
        provenanceIds={["composition"]}
        actions={ask(asks.departments)}
        testId="md-employees-departments"
      >
        <BarList items={groupBars(c.byDepartment, typeSplitText)} />
        {c.departmentsTotal > c.byDepartment.filter((d) => !d.other).length && !showingAll && (
          <button
            type="button"
            onClick={onShowAll}
            className="mt-3 w-full rounded-lg border border-dashed border-[#006496]/25 py-1.5 text-xs font-semibold text-[#006496] hover:bg-[#006496]/[0.05]"
            data-testid="md-employees-departments-more"
          >
            Show all {num(c.departmentsTotal)} departments
          </button>
        )}
      </SectionCard>

      <SectionCard
        className="@5xl:col-span-4"
        title="Length of service"
        subtitle="How long today's people have been here"
        provenance={c.provenance}
        provenanceIds={["age-tenure-bands"]}
        actions={ask(asks.service)}
        testId="md-employees-tenure-bands"
      >
        <Columns rows={bandRows(c.byTenureBand)} />
      </SectionCard>

      <SectionCard
        className="@5xl:col-span-4"
        title="Age"
        subtitle="Completed years, where a date of birth is on file"
        provenance={c.provenance}
        provenanceIds={["age-tenure-bands"]}
        actions={ask(asks.age)}
        testId="md-employees-age-bands"
      >
        <Columns rows={bandRows(c.byAgeBand)} />
      </SectionCard>

      <SectionCard
        className="@2xl:col-span-2 @5xl:col-span-4"
        title="By designation"
        subtitle={c.designationsTotal > 0 ? `${num(c.designationsTotal)} designations` : undefined}
        provenance={c.provenance}
        provenanceIds={["composition"]}
        actions={ask(asks.designations)}
        testId="md-employees-designations"
      >
        <BarList items={groupBars(c.byDesignation)} />
      </SectionCard>

      <SectionCard
        className="@2xl:col-span-2 @5xl:col-span-12"
        title="Planned vs actual staff"
        subtitle={
          c.staffing.planned
            ? `${num(c.staffing.vacancies)} vacancies across ${num(c.staffing.departmentsBelow)} ${
                c.staffing.departmentsBelow === 1 ? "department" : "departments"
              } · the plan counts staff, not production`
            : "The plan counts staff, not production"
        }
        provenance={c.provenance}
        provenanceIds={["staffing-plan"]}
        actions={ask(asks.staffing)}
        testId="md-employees-staffing"
      >
        {c.staffing.planned ? (
          <div className="grid grid-cols-1 gap-x-10 gap-y-3 @3xl:grid-cols-2">
            {staffingColumns.map((part, i) => (
              <BarList key={i} items={staffingBars(part)} max={100} />
            ))}
          </div>
        ) : (
          <EmptyBlock title="No planned staff is set">
            {c.notes.find((n) => n.startsWith("No required headcount")) ??
              "Set a required headcount for each department (Recruitment, Required Roles) to see the gaps here."}
          </EmptyBlock>
        )}
      </SectionCard>
    </div>
  );
}

import { Briefcase, Scale } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayShort, num } from "@/lib/md/format";
import { GAP_KEY, daysText, gapBarItems, plural } from "./logic";
import { AgeBarView, Chip, Expandable, MixBar, MixKey, QueryError } from "./parts";
import type { OpenPosition, QueryLike, RecruitmentPositions } from "./types";

function columnsFor(staleAfter: number, maxDays: number): Column<OpenPosition>[] {
  return [
    {
      key: "position",
      header: "Position",
      cell: (p) => (
        <div className="min-w-[9rem]">
          <p className="font-semibold text-md-ink">{p.title}</p>
          <p className="text-xs text-md-ink-soft">
            {[p.department, p.unit].filter(Boolean).join(" · ") || "No department"}
          </p>
        </div>
      ),
      sortValue: (p) => p.title,
    },
    {
      key: "open",
      header: "Open for",
      cell: (p) => (
        <div className="min-w-[9rem]" data-testid={`position-age-${p.id}`}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-bold tabular-nums text-md-ink">{daysText(p.daysOpen)}</span>
            {p.stale && <Chip tone="red">Stale</Chip>}
          </div>
          <AgeBarView days={p.daysOpen} staleAfter={staleAfter} maxDays={maxDays} />
          <p className="mt-1 text-[11px] text-md-ink-soft">Posted {dayShort(p.postedOn)}</p>
        </div>
      ),
      sortValue: (p) => p.daysOpen,
    },
    {
      key: "applicants",
      header: "Applicants",
      cell: (p) => (
        <div className="min-w-[6rem]">
          <p className="mb-1.5 font-bold tabular-nums text-md-ink">{num(p.applicants)}</p>
          <MixBar mix={p.stageMix} />
        </div>
      ),
      sortValue: (p) => p.applicants,
    },
  ];
}

/** Open positions with how long each has waited (the stale ones flagged), and the staffing gap by department. The
 *  system does not record when a position is filled, so age is the honest measure of "how long positions stay open". */
export default function PositionsSection({ query }: { query: QueryLike<RecruitmentPositions> }) {
  const data = query.data;
  const staleAfter = data?.summary.staleAfterDays ?? 45;
  const maxDays = Math.max(0, ...(data?.positions ?? []).map((p) => p.daysOpen));
  const gap = data?.headcountGap;
  const gapItems = gap ? gapBarItems(gap.departments) : [];

  return (
    <div className="@container" data-testid="md-recruitment-positions-section">
      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
        <SectionCard
          className="min-w-0 @4xl:col-span-7"
          testId="md-recruitment-positions"
          title="Open positions"
          subtitle={
            data
              ? `${plural(data.summary.open, "position")} open · ${data.summary.stale} open more than ${staleAfter} days`
              : undefined
          }
          loading={query.isPending}
          provenance={data?.provenance}
          provenanceIds={["open-positions", "position-age", "time-to-fill"]}
          actions={<AskAiButton question="Which open positions are stuck, and what is holding them up?" />}
        >
          <QueryError query={query} />
          {data &&
            (data.positions.length === 0 ? (
              <EmptyBlock icon={Briefcase} title="No open positions">
                Positions appear here when HR opens a job posting on the Interviews page.
              </EmptyBlock>
            ) : (
              <>
                <DataTable
                  testId="md-recruitment-positions-table"
                  columns={columnsFor(staleAfter, maxDays)}
                  rows={data.positions}
                  rowKey={(p) => p.id}
                  initialSort={{ key: "open", dir: "desc" }}
                  pageSize={6}
                />
                {data.positionsShown < data.summary.open && (
                  <p className="mt-2 text-[11px] text-md-ink-soft">
                    The {data.positionsShown} oldest of {data.summary.open} positions are listed.
                  </p>
                )}
                <div className="mt-4 space-y-2 border-t border-md-line pt-3">
                  <MixKey />
                  <p
                    className="text-[11px] leading-snug text-md-ink-soft"
                    data-testid="md-recruitment-time-to-fill-note"
                  >
                    The system does not record when a position is filled, so the age of positions still open is shown
                    instead of time to fill.
                  </p>
                </div>
              </>
            ))}
        </SectionCard>

        <SectionCard
          className="min-w-0 @4xl:col-span-5"
          testId="md-recruitment-gap"
          title="Staffing gap by department"
          subtitle={
            gap?.vacancies != null && gap.required != null
              ? `${plural(gap.vacancies, "vacancy", "vacancies")} against a plan of ${num(gap.required)} staff`
              : "Required staff against active staff"
          }
          loading={query.isPending}
          provenance={data?.provenance}
          provenanceIds={["vacancies"]}
          actions={<AskAiButton question="Which departments are short of staff against the plan, and by how much?" />}
        >
          <QueryError query={query} />
          {gap &&
            (!gap.applicable ? (
              <EmptyBlock icon={Scale} title="No staffing plan for production">
                The required-staff plan covers staff only. Choose staff and production together, or staff, to see it.
              </EmptyBlock>
            ) : gap.vacancies == null ? (
              <EmptyBlock icon={Scale} title="No staffing plan set">
                Set the required number for each department on the Required Roles page to see where you are short.
              </EmptyBlock>
            ) : gapItems.length === 0 ? (
              <EmptyBlock icon={Scale} title="Every planned department is fully staffed">
                No department is below its required number of staff.
              </EmptyBlock>
            ) : (
              <>
                <Expandable items={gapItems}>
                  {(shown) => <BarList testId="md-recruitment-gap-list" items={shown} />}
                </Expandable>
                <ul className="md-people-key mt-4" aria-label="Bar colours">
                  {GAP_KEY.map((k) => (
                    <li key={k.label}>
                      <i style={{ background: k.color }} aria-hidden="true" />
                      {k.label}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] leading-snug text-md-ink-soft">
                  {gap.departmentsTotal - (gap.departmentsWithGap ?? 0)} of {gap.departmentsTotal} planned departments
                  are at or above their plan. Shortfalls are not offset by another department's surplus.
                </p>
              </>
            ))}
        </SectionCard>
      </div>
    </div>
  );
}

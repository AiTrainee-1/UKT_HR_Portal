import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronRight, SearchX, Users } from "lucide-react";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, NoteBanner } from "@/components/md/kit/states";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useElementWidth } from "@/components/payroll/statement/use-element-width";
import { inr, inrCompact, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { PAY_STACK, PeopleChart } from "./charts";
import {
  PEOPLE_SORTS,
  PEOPLE_SORT_LABEL,
  daysText,
  defaultDir,
  nextSort,
  paymentChip,
  peopleBars,
  typeLabel,
  type DashState,
  type PeopleSort,
} from "./logic";
import { CardError, ChartLegend, Explain, Figure, Pager, ToneChip, failed } from "./parts";
import type { DashQueries, DashUpdate } from "./queries";
import SortTable, { type Col } from "./SortTable";
import type { PayPeopleResponse, PayPersonRow } from "./types";

const CHART_LIMIT = { narrow: 8, wide: 12 };

function Totals({ data }: { data: PayPeopleResponse }) {
  const t = data.totals;
  return (
    <div className="grid grid-cols-2 gap-2.5 @2xl:grid-cols-3 @5xl:grid-cols-6" data-testid="md-pay-people-totals">
      <Figure
        label="Employees"
        value={num(data.total)}
        sub="matching the filters"
        emphasis
        testId="md-pay-people-count"
      />
      <Figure
        label="Earned salary"
        value={inrCompact(t.earnedSalary)}
        sub={t.actualSalary == null ? "paid per shift" : `staff full salary ${inrCompact(t.actualSalary)}`}
      />
      <Figure
        label="Deductions"
        value={inrCompact(t.deductions.total)}
        sub={`attendance ${inrCompact(t.attendanceDeduction)}`}
        testId="md-pay-people-deductions"
      />
      <Figure label="Net paid" value={inrCompact(t.netPaid)} sub="received by them" testId="md-pay-people-net" />
      <Figure label="Company cost" value={inrCompact(t.companyCost)} sub="with employer PF / ESI" />
      <Figure label="Casual leave" value={`${daysText(t.clDays)} days`} sub={`${inrCompact(t.clAmount)} paid for it`} />
    </div>
  );
}

/** Sort on a phone, where the table's headers are not shown: the column and the direction. */
function SortControl({ state, update }: { state: DashState; update: DashUpdate }) {
  const text = state.sort === "name" || state.sort === "code" || state.sort === "department";
  const Icon = state.dir === "asc" ? ArrowUpNarrowWide : ArrowDownWideNarrow;
  return (
    <div className="flex items-center gap-1.5" data-testid="md-pay-sort">
      <Select
        value={state.sort}
        onValueChange={(v) => update({ sort: v as PeopleSort, dir: defaultDir(v as PeopleSort) })}
      >
        <SelectTrigger
          className="md-field h-8 w-[10.5rem] text-xs font-semibold"
          aria-label="Sort by"
          data-testid="md-pay-sort-by"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PEOPLE_SORTS.map((s) => (
            <SelectItem key={s} value={s}>
              {PEOPLE_SORT_LABEL[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <button
        type="button"
        onClick={() => update({ dir: state.dir === "asc" ? "desc" : "asc" })}
        className="md-btn md-btn-soft md-btn-sm h-8 px-2.5"
        aria-label={`Sorted ${state.dir === "asc" ? "ascending" : "descending"}; reverse`}
        data-testid="md-pay-sort-dir"
      >
        <Icon size={14} aria-hidden />
        <span className="text-[11.5px]">
          {text ? (state.dir === "asc" ? "A–Z" : "Z–A") : state.dir === "asc" ? "Lowest" : "Highest"}
        </span>
      </button>
    </div>
  );
}

/** One employee on a phone. Only a salary on hold is flagged: "Not paid" on every card of an unpaid month says nothing
 *  the month's status does not (the table on a wide screen keeps its Payment column). */
function PersonCard({ row, onOpen }: { row: PayPersonRow; onOpen: (id: number) => void }) {
  const payment = row.onHold ? paymentChip(row.paymentStatus, true) : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(row.employeeId)}
        className="md-panel flex w-full flex-col gap-2.5 p-3 text-left transition-colors hover:bg-md-wine/[0.04]"
        data-testid={`md-pay-person-card-${row.employeeId}`}
      >
        <span className="flex w-full items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-extrabold text-md-ink">{row.name}</span>
            <span className="block truncate text-[11.5px] font-medium text-md-ink-soft">
              {row.code} · {row.department ?? "—"}
              {row.unit ? ` · ${row.unit}` : ""}
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span className="block text-[15px] font-black tabular-nums text-md-ink">{inr(row.netPaid)}</span>
            <span className="block text-[11px] font-medium text-md-ink-soft">net paid</span>
          </span>
        </span>
        <span className="grid w-full grid-cols-3 gap-2 text-[11px]">
          <span>
            <span className="block text-md-ink-soft">Earned</span>
            <span className="block font-bold tabular-nums text-md-ink">{inrCompact(row.earnedSalary)}</span>
          </span>
          <span>
            <span className="block text-md-ink-soft">Attendance</span>
            <span className="block font-bold tabular-nums text-md-ink">{inrCompact(row.attendanceDeduction)}</span>
          </span>
          <span>
            <span className="block text-md-ink-soft">Deductions</span>
            <span className="block font-bold tabular-nums text-md-ink">{inrCompact(row.deductions.total)}</span>
          </span>
        </span>
        <span className="flex w-full flex-wrap items-center gap-1.5">
          <span className="md-chip text-[11px]">{typeLabel(row.type)}</span>
          {row.clDays > 0 && (
            <span className="md-chip text-[11px]">
              CL {daysText(row.clDays)} d · {inrCompact(row.clAmount)}
            </span>
          )}
          {payment && (
            <ToneChip tone={payment.tone} className="text-[11px]">
              {payment.text}
            </ToneChip>
          )}
          <ChevronRight size={15} className="ml-auto text-md-ink-soft" aria-hidden />
        </span>
      </button>
    </li>
  );
}

function PeopleTable({
  data,
  state,
  update,
  onOpen,
}: {
  data: PayPeopleResponse;
  state: DashState;
  update: DashUpdate;
  onOpen: (id: number) => void;
}) {
  const t = data.totals;
  const money = (key: PeopleSort, header: string, get: (r: PayPersonRow) => number | null, total: number | null) =>
    ({
      key,
      header,
      sortKey: key,
      align: "right",
      cell: (r: PayPersonRow) => inr(get(r)),
      total: inr(total),
    }) satisfies Col<PayPersonRow>;
  const columns: Col<PayPersonRow>[] = [
    {
      key: "name",
      header: "Employee",
      sortKey: "name",
      // a salary on hold is flagged by the name; the payment itself is in the employee's history (a "Not paid" column
      // repeated on every row of an unpaid month would only cost the table its width)
      cell: (r) => (
        <span className="flex max-w-[13.5rem] flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-bold text-md-ink">{r.name}</span>
            {r.onHold && (
              <ToneChip tone="warning" className="shrink-0 text-[11px]">
                On hold
              </ToneChip>
            )}
          </span>
          <span className="truncate text-[11px] font-medium text-md-ink-soft">
            {r.code}
            {r.designation ? ` · ${r.designation}` : ""}
          </span>
        </span>
      ),
      total: <span className="font-extrabold">All {num(data.total)} matching</span>,
    },
    {
      key: "department",
      header: "Department",
      sortKey: "department",
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-semibold">{r.department ?? "—"}</span>
          <span className="text-[11px] text-md-ink-soft">
            {[r.unit, typeLabel(r.type)].filter(Boolean).join(" · ")}
          </span>
        </span>
      ),
    },
    {
      key: "days",
      header: "Days paid",
      align: "right",
      title: "Paid days of the working days; production: days worked in its pay periods",
      cell: (r) => (
        <span className="flex flex-col items-end">
          <span>
            {daysText(r.paidDays)} / {daysText(r.workingDays)}
          </span>
          {r.type === "production" && r.periods > 0 && (
            <span className="text-[11px] text-md-ink-soft">
              {r.periods} {r.periods === 1 ? "period" : "periods"}
            </span>
          )}
        </span>
      ),
    },
    money("actualSalary", "Actual", (r) => r.actualSalary, t.actualSalary),
    money("earnedSalary", "Earned", (r) => r.earnedSalary, t.earnedSalary),
    money("attendanceDeduction", "Attendance ded.", (r) => r.attendanceDeduction, t.attendanceDeduction),
    money("deductions", "Deductions", (r) => r.deductions.total, t.deductions.total),
    money("netPaid", "Net paid", (r) => r.netPaid, t.netPaid),
    money("companyCost", "Company cost", (r) => r.companyCost, t.companyCost),
    {
      key: "cl",
      header: "CL",
      sortKey: "clAmount",
      align: "right",
      title: "Casual leave paid: the amount, and the days under it",
      cell: (r) =>
        r.clDays > 0 ? (
          <span className="flex flex-col items-end">
            <span>{inr(r.clAmount)}</span>
            <span className="text-[11px] text-md-ink-soft">{daysText(r.clDays)} d</span>
          </span>
        ) : (
          <span className="text-md-ink-soft">—</span>
        ),
      total: (
        <span className="flex flex-col items-end">
          <span>{inr(t.clAmount)}</span>
          <span className="text-[11px] text-md-ink-soft">{daysText(t.clDays)} d</span>
        </span>
      ),
    },
  ];
  return (
    <SortTable
      caption="Employees and their pay for the month"
      columns={columns}
      rows={data.rows}
      rowKey={(r) => r.employeeId}
      sort={{ key: state.sort, dir: state.dir }}
      onSort={(key) => update(nextSort(state, key as PeopleSort))}
      onRowClick={(r) => onOpen(r.employeeId)}
      rowLabel={(r) => `Open ${r.name}'s salary history`}
      totals
      minWidth="50rem"
      testId="md-pay-people-table"
    />
  );
}

/**
 * Employees: everyone paid in the month (filtered and searched on the server), each with the figures that matter, the
 * whole selection added up above, and the people on the page compared side by side. A table on a wide screen, cards on
 * a phone; an employee opens their salary history.
 */
export default function EmployeesView({
  query,
  state,
  update,
  onOpen,
}: {
  query: DashQueries["people"];
  state: DashState;
  update: DashUpdate;
  onOpen: (id: number) => void;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const narrow = width > 0 && width < 480;
  const data = query.data;

  if (failed(query)) return <CardError query={query} />;
  if (query.isPending || !data) {
    return (
      <div className="space-y-4" data-testid="md-pay-employees" aria-busy="true">
        <SectionCard title="Employees" loading />
      </div>
    );
  }

  if (data.total === 0) {
    return (
      <SectionCard title="Employees" testId="md-pay-people-empty">
        {state.q ? (
          <EmptyBlock
            icon={SearchX}
            title={`No employee matches “${state.q}”`}
            action={
              <button
                type="button"
                className="md-btn md-btn-soft md-btn-sm"
                onClick={() => update({ q: "" })}
                data-testid="md-pay-clear-search"
              >
                Clear the search
              </button>
            }
          >
            Search by part of a name or an employee code. The unit, department and type filters apply too.
          </EmptyBlock>
        ) : (
          <EmptyBlock icon={Users} title={`Nobody was paid in ${data.label ?? "this month"}`}>
            There are no salary slips for this unit, department and type in the month.
          </EmptyBlock>
        )}
      </SectionCard>
    );
  }

  const limit = narrow ? CHART_LIMIT.narrow : CHART_LIMIT.wide;
  const bars = peopleBars(data.rows, limit);
  const sortedByName = state.sort === "name" || state.sort === "code" || state.sort === "department";

  return (
    <div
      className={cn("space-y-4 @lg:space-y-5", query.isPlaceholderData && "opacity-70")}
      data-testid="md-pay-employees"
    >
      {data.notes.map((n) => (
        <NoteBanner key={n}>{n}</NoteBanner>
      ))}
      <Totals data={data} />

      <div className="flex flex-col gap-4 @lg:gap-5">
        <SectionCard
          testId="md-pay-people-list"
          title={`${num(data.total)} ${data.total === 1 ? "employee" : "employees"} paid in ${data.label ?? "the month"}`}
          subtitle="Click an employee for their month-by-month salary history."
          actions={
            <>
              <span className="@3xl:hidden">
                <SortControl state={state} update={update} />
              </span>
              <Explain
                ids={["earned-salary", "attendance-deductions", "deductions", "net-paid", "company-cost", "cl"]}
              />
            </>
          }
        >
          <div className="hidden @3xl:block" data-layout="table">
            <PeopleTable data={data} state={state} update={update} onOpen={onOpen} />
          </div>
          <ul
            className="grid grid-cols-1 gap-2.5 @xl:grid-cols-2 @3xl:hidden"
            data-layout="cards"
            data-testid="md-pay-people-cards"
          >
            {data.rows.map((r) => (
              <PersonCard key={r.employeeId} row={r} onOpen={onOpen} />
            ))}
          </ul>
          <div className="mt-3">
            <Pager total={data.total} page={data.page} pageSize={data.pageSize} onPage={(page) => update({ page })} />
          </div>
        </SectionCard>

        <SectionCard
          testId="md-pay-people-compare"
          title="Side by side"
          subtitle={
            sortedByName
              ? `The first ${bars.length} on this page, in the list's order. Sort by net paid to compare the highest paid.`
              : `The first ${bars.length} on this page, by ${PEOPLE_SORT_LABEL[state.sort].toLowerCase()}. Click one to open them.`
          }
          actions={
            sortedByName ? (
              <button
                type="button"
                className="md-btn md-btn-soft md-btn-sm"
                onClick={() => update({ sort: "netPaid", dir: "desc" })}
                data-testid="md-pay-sort-net"
              >
                Highest paid first
              </button>
            ) : undefined
          }
        >
          <div ref={ref}>
            <PeopleChart bars={bars} onOpen={onOpen} narrow={narrow} />
            <ChartLegend items={PAY_STACK} testId="md-pay-people-legend" />
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

import { CheckCircle2, Eye, Trash2, XCircle } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { allState, SelectBox } from "./bulk";
import { LeaveButton } from "./LeaveCalendarButton";
import {
  STATUS_LABEL,
  STATUS_TONE,
  TYPE_LABEL,
  appliedByEmployee,
  approvedOf,
  canDelete,
  decidedByOf,
  earnedLimitOf,
  hasLeft,
  progressPct,
  requestedOf,
  type Sort,
  type SortKey,
  type SettlementRow,
} from "./logic";
import { Chip, ProgressBar, SortHead } from "./parts";
import { formatDate, formatMoney, monthLabel } from "./shared";
import { CardField, FIRST, FROM, Figure, LAST, PersonCell, Pill, RowAction, RowActions, muted } from "./table-kit";

type Props = {
  rows: SettlementRow[];
  sort: Sort;
  onSort: (key: SortKey) => void;
  onOpen: (row: SettlementRow) => void;
  onApprove: (row: SettlementRow) => void;
  onReject: (row: SettlementRow) => void;
  onDelete: (row: SettlementRow) => void;
  /** The advance whose decision is being saved: its buttons are disabled meanwhile. */
  busyId?: number | null;
  /** false for a row: this account may not approve that type of advance (an HR Manager / HR Assistant without it, Salary
   *  Advance and Term Loan are separate switches), so that row has no Approve / Reject. */
  canDecide?: (row: SettlementRow) => boolean;
  /** The Overview lists both types: a Type column. The typed pages do not need one. */
  showType?: boolean;
  /** Bulk (owner 2026-11-27): the ticked requests, and which rows may be ticked (waiting, and this login may decide). */
  selected?: ReadonlySet<number>;
  selectable?: (row: SettlementRow) => boolean;
  onToggle?: (id: number, on: boolean) => void;
  onToggleAll?: (on: boolean) => void;
  /** Opens a request's leave calendar. */
  onLeave?: (row: SettlementRow) => void;
};

const startOf = (a: SettlementRow) =>
  a.repaymentStartMonth && a.repaymentStartYear ? monthLabel(a.repaymentStartMonth, a.repaymentStartYear) : "";

/** The eligible limit of a request (owner 2026-11-27): a Salary Advance's earned limit (Settings' % of the salary earned
 *  so far, kept on the request), a Term Loan's limit with its months and EMI. */
export function eligibleOf(a: SettlementRow): { limit: number | null; note: string; over: boolean } {
  if (a.advanceType === "term") {
    const limit = a.termLimit ?? null;
    const note = [
      a.repaymentMonths ? `${a.repaymentMonths} ${a.repaymentMonths === 1 ? "month" : "months"}` : "",
      a.emiAmount > 0 ? `${formatMoney(a.emiAmount)}/month` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return { limit, note, over: limit != null && requestedOf(a) > limit };
  }
  const limit = earnedLimitOf(a);
  const e = a.earnings;
  return {
    limit,
    note: e && limit != null ? `${e.percent}% of ${formatMoney(e.earnedAmount)} earned` : "",
    over: limit != null && requestedOf(a) > limit,
  };
}

/** What is recovered so far, as a figure and a bar (only an active or completed advance has anything recovered). */
function Recovery({ a }: { a: SettlementRow }) {
  if (a.status === "pending" || a.status === "rejected") {
    return <span className="text-xs text-muted-foreground">Not started</span>;
  }
  const pct = progressPct(a);
  return (
    <div className="w-32 space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold tabular-nums text-green-700">{formatMoney(a.totalRepaid)}</span>
        <span className="tabular-nums text-muted-foreground">{pct}%</span>
      </div>
      <ProgressBar pct={pct} />
      <p className={cn("text-[11px]", a.outstanding > 0 ? "font-medium text-red-600" : "text-muted-foreground")}>
        {a.outstanding > 0 ? `${formatMoney(a.outstanding)} to recover` : "Nothing outstanding"}
      </p>
    </div>
  );
}

function Requested({ a }: { a: SettlementRow }) {
  return (
    <span
      className={cn(
        "text-sm font-semibold tabular-nums text-slate-900",
        a.status === "rejected" && "font-normal text-muted-foreground line-through",
      )}
    >
      {formatMoney(requestedOf(a))}
    </span>
  );
}

/** The limit, with how it was worked out under it (on a laptop that line is the figure's hover text, so the table fits). */
function Eligible({ a, card }: { a: SettlementRow; card?: boolean }) {
  const e = eligibleOf(a);
  if (e.limit == null) return muted;
  const hover = [e.note, e.over ? "Asked for more than the eligible limit" : ""].filter(Boolean).join(". ");
  return (
    <div className="whitespace-nowrap leading-tight">
      <p
        className={cn("text-sm tabular-nums", e.over ? "font-semibold text-amber-700" : "text-slate-700")}
        title={hover || undefined}
        data-over-limit={e.over ? "true" : undefined}
      >
        {formatMoney(e.limit)}
      </p>
      {e.note && (
        <p className={cn("mt-0.5 text-[11px] text-muted-foreground", !card && "hidden min-[1880px]:block")}>{e.note}</p>
      )}
    </div>
  );
}

/** What was approved once decided; "of ₹X asked" when HR approved less. */
function Approved({ a }: { a: SettlementRow }) {
  const asked = requestedOf(a);
  const approved = approvedOf(a);
  if (approved == null) {
    return a.status === "rejected" ? <span className="text-xs font-semibold text-red-600">Rejected</span> : muted;
  }
  return (
    <Figure
      value={formatMoney(approved)}
      strong
      sub={
        approved !== asked ? (
          <span className="font-medium text-amber-700" data-testid={`advance-asked-${a.id}`}>
            of {formatMoney(asked)} asked
          </span>
        ) : undefined
      }
    />
  );
}

/** The purpose, HR's remark (the reason for a rejection, the why of a smaller approval), the over-limit reason and who
 *  decided; one line each in the table (the whole text on hover). */
function Remarks({ a, wrap }: { a: SettlementRow; wrap?: boolean }) {
  const by = decidedByOf(a);
  const remark = a.status === "pending" ? "" : (a.decisionRemark ?? "").trim();
  const purpose = (a.purpose ?? "").trim();
  const over = (a.limitRemark ?? "").trim();
  if (!by && !remark && !purpose && !over) return muted;
  const line = wrap ? "line-clamp-2" : "truncate";
  return (
    <div className={cn("space-y-0.5 text-xs leading-snug", !wrap && "max-w-[15rem]")}>
      {purpose && (
        <p className={cn(line, "text-slate-600")} title={purpose}>
          <span className="text-muted-foreground">Purpose: </span>
          {purpose}
        </p>
      )}
      {remark && (
        <p className={cn(line, "text-slate-700")} title={remark} data-testid={`advance-remark-${a.id}`}>
          &ldquo;{remark}&rdquo;
        </p>
      )}
      {over && (
        <p className={cn(line, "text-amber-800")} title={over}>
          <span className="font-medium">Above the limit: </span>
          {over}
        </p>
      )}
      {by && <p className="text-muted-foreground">by {by}</p>}
    </div>
  );
}

function TypeCell({ a }: { a: SettlementRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Chip tone={a.advanceType === "term" ? "accent" : "info"}>{TYPE_LABEL[a.advanceType]}</Chip>
      {appliedByEmployee(a) && (
        <Chip tone="neutral" className="text-[10px]">
          <span data-testid={`advance-by-employee-${a.id}`}>Applied by employee</span>
        </Chip>
      )}
    </div>
  );
}

function StatusCell({ a }: { a: SettlementRow }) {
  return <Pill tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Pill>;
}

/** Approve / Reject (a waiting request this login may decide), Delete (a waiting one) and View: icon buttons with their
 *  hover labels, as on All Employees. */
function Actions({
  a,
  busy,
  decide,
  onApprove,
  onReject,
  onDelete,
  onOpen,
  prefix = "advance",
}: {
  a: SettlementRow;
  busy: boolean;
  decide: boolean;
  onApprove: () => void;
  onReject: () => void;
  onDelete: () => void;
  onOpen: () => void;
  /** The table and the phone cards both draw these buttons, so each gets its own test ids. */
  prefix?: string;
}) {
  const waiting = a.status === "pending";
  return (
    <RowActions>
      {waiting && decide && (
        <>
          <RowAction
            label="Approve"
            icon={<CheckCircle2 size={15} />}
            color="emerald"
            onClick={onApprove}
            disabled={busy}
            aria={`Approve advance for ${a.employeeName}`}
            testId={`${prefix}-approve-${a.id}`}
          />
          <RowAction
            label="Reject"
            icon={<XCircle size={15} />}
            color="red"
            onClick={onReject}
            disabled={busy}
            aria={`Reject advance for ${a.employeeName}`}
            testId={`${prefix}-reject-${a.id}`}
          />
        </>
      )}
      {canDelete(a) && (
        <RowAction
          label="Delete request"
          icon={<Trash2 size={15} />}
          color="red"
          onClick={onDelete}
          aria={`Delete advance for ${a.employeeName}`}
          testId={`${prefix}-delete-${a.id}`}
        />
      )}
      <RowAction
        label="View details"
        icon={<Eye size={15} />}
        color="blue"
        onClick={onOpen}
        aria={`View details of the advance for ${a.employeeName}`}
        testId={`${prefix}-view-${a.id}`}
      />
    </RowActions>
  );
}

/**
 * The Normal Method's list (owner 2026-11-27), in the HRMS table style (All Employees): the employee with initials, code
 * and department; the type (Overview); what was asked for, the eligible limit (a Salary Advance's earned limit; a Term
 * Loan's limit with its months and EMI) and what was approved, right-aligned; what payroll recovered; the first
 * deduction; the leave check (opens the leave calendar); the status pill; the remarks; when it was raised; and the
 * actions as icon buttons. The less needed columns show from a wider screen on, so the table fits its card on a laptop;
 * a phone or tablet gets a card per request with every value. A checkbox per waiting request for the bulk steps.
 */
export default function AdvanceList({
  rows,
  sort,
  onSort,
  onOpen,
  onApprove,
  onReject,
  onDelete,
  busyId,
  canDecide = () => true,
  showType = true,
  selected,
  selectable,
  onToggle,
  onToggleAll,
  onLeave,
}: Props) {
  const tickable = selectable && onToggle ? rows.filter(selectable) : [];
  const withSelect = tickable.length > 0;
  const ticked = selected ? tickable.filter((r) => selected.has(r.id)).length : 0;
  const leave = (a: SettlementRow, prefix: string) => (
    <LeaveButton
      check={a.leaveCheck}
      name={a.employeeName}
      onOpen={() => onLeave?.(a)}
      testId={`${prefix}-leave-${a.id}`}
    />
  );
  const box = (a: SettlementRow, prefix: string) =>
    selectable?.(a) && onToggle ? (
      <SelectBox
        checked={!!selected?.has(a.id)}
        onChange={(v) => onToggle(a.id, v)}
        label={`Select ${a.employeeName}'s request`}
        testId={`${prefix}-select-${a.id}`}
      />
    ) : null;
  const person = (a: SettlementRow, size?: number) => (
    <PersonCell
      name={a.employeeName}
      code={a.employeeCode}
      department={a.employeeDepartment}
      badge={hasLeft(a) ? <Chip tone="caution">Has left</Chip> : undefined}
      size={size}
    />
  );
  const actions = (a: SettlementRow, prefix?: string) => (
    <Actions
      a={a}
      prefix={prefix}
      busy={busyId === a.id}
      decide={canDecide(a)}
      onApprove={() => onApprove(a)}
      onReject={() => onReject(a)}
      onDelete={() => onDelete(a)}
      onOpen={() => onOpen(a)}
    />
  );

  return (
    <>
      {/* laptops and up: the table */}
      <div className="hidden border-t border-slate-100 xl:block">
        <Table data-testid="advances-table">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {withSelect && (
                <TableHead className={cn(FIRST, "w-10")}>
                  <SelectBox
                    checked={allState(ticked, tickable.length)}
                    onChange={(v) => onToggleAll?.(v)}
                    label="Select all the waiting requests shown"
                    testId="advance-select-all"
                  />
                </TableHead>
              )}
              <SortHead
                label="Employee"
                column="employee"
                sort={sort}
                onSort={onSort}
                className={withSelect ? undefined : FIRST}
              />
              {showType && <TableHead className="whitespace-nowrap">Type</TableHead>}
              <SortHead label="Requested" column="amount" sort={sort} onSort={onSort} className="text-right" />
              <TableHead className="whitespace-nowrap text-right">Eligible limit</TableHead>
              <TableHead className="whitespace-nowrap text-right">Approved</TableHead>
              <SortHead label="Recovered" column="recovery" sort={sort} onSort={onSort} className={FROM["3xl"]} />
              <SortHead label="Deduction from" column="start" sort={sort} onSort={onSort} className={FROM["2xl"]} />
              <TableHead className="whitespace-nowrap text-center">Leave</TableHead>
              <SortHead label="Status" column="status" sort={sort} onSort={onSort} />
              <TableHead className={cn("whitespace-nowrap", FROM.full)}>Remarks</TableHead>
              <SortHead label="Raised" column="created" sort={sort} onSort={onSort} className={FROM["2xl"]} />
              <TableHead className={cn("whitespace-nowrap text-right", LAST)}>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => {
              const on = !!selected?.has(a.id);
              return (
                <TableRow
                  key={a.id}
                  className={cn("cursor-pointer", on && "bg-sky-50/80 hover:bg-sky-50")}
                  data-state={on ? "selected" : undefined}
                  onClick={() => onOpen(a)}
                  data-testid={`advance-row-${a.id}`}
                >
                  {withSelect && <TableCell className={cn(FIRST, "w-10")}>{box(a, "advance")}</TableCell>}
                  <TableCell className={cn("max-w-[15rem] py-3", !withSelect && FIRST)}>{person(a)}</TableCell>
                  {showType && (
                    <TableCell>
                      <TypeCell a={a} />
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    <Requested a={a} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Eligible a={a} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Approved a={a} />
                  </TableCell>
                  <TableCell className={FROM["3xl"]}>
                    <Recovery a={a} />
                  </TableCell>
                  <TableCell className={cn("whitespace-nowrap text-sm text-slate-700", FROM["2xl"])}>
                    {startOf(a) || muted}
                  </TableCell>
                  <TableCell className="text-center">{leave(a, "advance")}</TableCell>
                  <TableCell>
                    <StatusCell a={a} />
                  </TableCell>
                  <TableCell className={FROM.full}>
                    <Remarks a={a} />
                  </TableCell>
                  <TableCell className={cn("whitespace-nowrap text-sm text-muted-foreground", FROM["2xl"])}>
                    {formatDate(a.createdAt)}
                  </TableCell>
                  <TableCell className={cn("text-right", LAST)} onClick={(e) => e.stopPropagation()}>
                    {actions(a)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* phones and tablets: a card for each advance */}
      <ul className="divide-y divide-slate-100 border-t border-slate-100 xl:hidden" data-testid="advances-cards">
        {rows.map((a) => (
          <li
            key={a.id}
            onClick={() => onOpen(a)}
            className={cn("cursor-pointer space-y-3 px-4 py-3.5", selected?.has(a.id) && "bg-sky-50/80")}
            data-testid={`advance-card-${a.id}`}
          >
            <div className="flex items-center gap-3">
              {withSelect && box(a, "advance-card")}
              {/* min-w-0 lets the code / department line truncate, so the status pill is never pushed off the card */}
              <div className="min-w-0 flex-1">{person(a, 38)}</div>
              <span className="shrink-0">
                <StatusCell a={a} />
              </span>
            </div>
            {showType && <TypeCell a={a} />}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-xl border border-slate-100 bg-slate-50/60 p-3 sm:grid-cols-3">
              <CardField label="Requested">
                <Requested a={a} />
              </CardField>
              <CardField label="Eligible limit">
                <Eligible a={a} card />
              </CardField>
              <CardField label="Approved">
                <Approved a={a} />
              </CardField>
              <CardField label="Leave">{leave(a, "advance-card")}</CardField>
              <CardField label="Recovered">
                <Recovery a={a} />
              </CardField>
              <CardField label="Deduction from">{startOf(a) || muted}</CardField>
            </dl>
            <Remarks a={a} wrap />
            <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
              <span className="text-xs text-muted-foreground">Raised {formatDate(a.createdAt)}</span>
              {actions(a, "advance-card")}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

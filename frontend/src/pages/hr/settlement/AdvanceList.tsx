import { CheckCircle2, ChevronRight, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  STATUS_LABEL,
  STATUS_TONE,
  TYPE_LABEL,
  hasLeft,
  progressPct,
  type Sort,
  type SortKey,
  type SettlementRow,
} from "./logic";
import { Chip, InitialsAvatar, ProgressBar, SortHead } from "./parts";
import { formatDate, formatMoney, monthLabel } from "./shared";

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
};

const startOf = (a: SettlementRow) =>
  a.repaymentStartMonth && a.repaymentStartYear ? monthLabel(a.repaymentStartMonth, a.repaymentStartYear) : "-";

/** What is recovered so far, as a figure and a bar (only an active or completed advance has anything recovered). */
function Recovery({ a }: { a: SettlementRow }) {
  if (a.status === "pending" || a.status === "rejected") {
    return <span className="text-xs text-gray-400">Not started</span>;
  }
  const pct = progressPct(a);
  return (
    <div className="min-w-[8.5rem] space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold text-green-700">{formatMoney(a.totalRepaid)}</span>
        <span className="text-gray-400">{pct}%</span>
      </div>
      <ProgressBar pct={pct} />
      <p className={cn("text-[11px]", a.outstanding > 0 ? "font-semibold text-red-600" : "text-gray-400")}>
        {a.outstanding > 0 ? `${formatMoney(a.outstanding)} to recover` : "Nothing outstanding"}
      </p>
    </div>
  );
}

function TypeCell({ a }: { a: SettlementRow }) {
  return (
    <div className="space-y-0.5">
      <Chip tone={a.advanceType === "term" ? "accent" : "info"}>{TYPE_LABEL[a.advanceType]}</Chip>
      {a.advanceType === "term" && a.emiAmount > 0 && (
        <p className="text-[11px] text-gray-500">
          {formatMoney(a.emiAmount)}/month{a.repaymentMonths ? ` · ${a.repaymentMonths} months` : ""}
        </p>
      )}
    </div>
  );
}

function EmployeeCell({ a, large }: { a: SettlementRow; large?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <InitialsAvatar name={a.employeeName} size={large ? "lg" : "md"} />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-gray-900">
          {a.employeeName}
          {hasLeft(a) && <Chip tone="caution">Has left</Chip>}
        </p>
        <p className="truncate text-xs text-gray-500">
          <span className="font-mono">{a.employeeCode}</span>
          {[a.employeeDepartment, a.employeeBranch].filter(Boolean).map((t) => ` · ${t}`)}
        </p>
      </div>
    </div>
  );
}

function Decide({
  a,
  busy,
  onApprove,
  onReject,
  prefix = "advance",
}: {
  a: SettlementRow;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  /** The table and the phone cards both draw these buttons, so each gets its own test ids. */
  prefix?: string;
}) {
  if (a.status !== "pending") return null;
  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm"
        className="h-8 gap-1 bg-green-600 text-xs hover:bg-green-700"
        disabled={busy}
        onClick={onApprove}
        aria-label={`Approve advance for ${a.employeeName}`}
        data-testid={`${prefix}-approve-${a.id}`}
      >
        <CheckCircle2 size={12} /> Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1 border-red-200 text-xs text-red-600"
        disabled={busy}
        onClick={onReject}
        aria-label={`Reject advance for ${a.employeeName}`}
        data-testid={`${prefix}-reject-${a.id}`}
      >
        <XCircle size={12} /> Reject
      </Button>
    </div>
  );
}

function DeleteButton({
  a,
  onDelete,
  prefix = "advance",
}: {
  a: SettlementRow;
  onDelete: () => void;
  prefix?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onDelete}
      title="Delete advance"
      aria-label={`Delete advance for ${a.employeeName}`}
      data-testid={`${prefix}-delete-${a.id}`}
    >
      <Trash2 size={15} className="text-red-500" />
    </Button>
  );
}

export default function AdvanceList({ rows, sort, onSort, onOpen, onApprove, onReject, onDelete, busyId }: Props) {
  return (
    <>
      {/* wide screens: a table */}
      <div className="hidden md:block">
        <Table data-testid="advances-table">
          <TableHeader>
            <TableRow>
              <SortHead label="Employee" column="employee" sort={sort} onSort={onSort} />
              <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">Type</TableHead>
              <SortHead label="Amount" column="amount" sort={sort} onSort={onSort} />
              <SortHead label="Recovered" column="recovery" sort={sort} onSort={onSort} />
              <SortHead label="Deduction from" column="start" sort={sort} onSort={onSort} />
              <SortHead label="Status" column="status" sort={sort} onSort={onSort} />
              <SortHead label="Raised" column="created" sort={sort} onSort={onSort} />
              <TableHead className="text-right text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => (
              <TableRow
                key={a.id}
                className="cursor-pointer"
                onClick={() => onOpen(a)}
                data-testid={`advance-row-${a.id}`}
              >
                <TableCell>
                  <EmployeeCell a={a} />
                </TableCell>
                <TableCell>
                  <TypeCell a={a} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm font-bold">{formatMoney(a.amount)}</TableCell>
                <TableCell>
                  <Recovery a={a} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-gray-600">{startOf(a)}</TableCell>
                <TableCell>
                  <Chip tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Chip>
                  {a.approvedBy && a.status !== "pending" && (
                    <p className="mt-0.5 text-[11px] text-gray-400">by {a.approvedBy}</p>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-gray-500">{formatDate(a.createdAt)}</TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1">
                    <Decide a={a} busy={busyId === a.id} onApprove={() => onApprove(a)} onReject={() => onReject(a)} />
                    <DeleteButton a={a} onDelete={() => onDelete(a)} />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onOpen(a)}
                      title="View details"
                      aria-label={`View details of the advance for ${a.employeeName}`}
                      data-testid={`advance-view-${a.id}`}
                    >
                      <ChevronRight size={16} className="text-gray-400" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* phones: a card for each advance */}
      <div className="divide-y md:hidden" data-testid="advances-cards">
        {rows.map((a) => (
          <div key={a.id} onClick={() => onOpen(a)} className="space-y-3 p-4" data-testid={`advance-card-${a.id}`}>
            <div className="flex items-start justify-between gap-2">
              <EmployeeCell a={a} large />
              <Chip tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Chip>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="text-gray-400">Amount</p>
                <p className="text-sm font-bold">{formatMoney(a.amount)}</p>
                <div className="mt-1">
                  <TypeCell a={a} />
                </div>
              </div>
              <div>
                <p className="mb-0.5 text-gray-400">Recovered</p>
                <Recovery a={a} />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 text-[11px] text-gray-500">
              <span>
                Raised {formatDate(a.createdAt)} · from {startOf(a)}
              </span>
              <span className="flex items-center" onClick={(e) => e.stopPropagation()}>
                <DeleteButton prefix="advance-card" a={a} onDelete={() => onDelete(a)} />
                <Button variant="ghost" size="sm" className="h-8 gap-0.5 text-xs" onClick={() => onOpen(a)}>
                  Details <ChevronRight size={14} />
                </Button>
              </span>
            </div>
            {a.status === "pending" && (
              <div onClick={(e) => e.stopPropagation()}>
                <Decide
                  prefix="advance-card"
                  a={a}
                  busy={busyId === a.id}
                  onApprove={() => onApprove(a)}
                  onReject={() => onReject(a)}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

import { CheckCircle, Plus, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { hrCanAct, hrCanReject, trailLine, waitingText } from "@/lib/approval-workflow";
import { TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { longDate, shortDate } from "../leave/logic";
import { Chip, PersonCell, StatusChip } from "../leave/parts";
import {
  balanceDetail,
  balanceLevel,
  balanceText,
  isHalf,
  portionText,
  serviceText,
  whyNot,
  type BoardRow,
  type ClRequest,
  type Why,
} from "./logic";

const HEAD = "text-[11px] font-bold uppercase tracking-wider text-[#006496]/60";

const WHY_CHIP: Record<Why["tone"], string> = {
  info: TONE.info,
  warning: TONE.warning,
  neutral: TONE.neutral,
  danger: TONE.danger,
};

const where = (r: { department?: string | null; branch?: string | null }) =>
  [r.department, r.branch].filter(Boolean).join(" · ") || null;

/** "Half day (first half)" under the date of a half-day request; nothing for a full day (the usual case). */
function PortionChip({ portion }: { portion?: string | null }) {
  if (!isHalf(portion)) return null;
  return (
    <div className="my-0.5" data-testid="cl-portion">
      <Chip className={TONE.info}>{portionText(portion)}</Chip>
    </div>
  );
}

const LEVEL_TEXT: Record<NonNullable<ReturnType<typeof balanceLevel>>, string> = {
  full: "text-emerald-700",
  some: "text-sky-800",
  low: "text-amber-700",
  none: "text-rose-700",
};

/** "11 of 12 left" (with what is used and waiting under it); a click opens the employee's Casual Leave history. Without a
 *  balance (an older server) it shows the approved days of the year, as before. */
function BalanceCell({
  r,
  onHistory,
  testId = `cl-balance-${r.employeeId}`,
}: {
  r: BoardRow;
  onHistory?: (r: BoardRow) => void;
  testId?: string;
}) {
  const text = balanceText(r.balance);
  if (!text) return <span className="text-xs text-gray-600">{r.approvedThisYear ?? 0}</span>;
  const detail = balanceDetail(r.balance);
  const level = balanceLevel(r.balance);
  const body = (
    <>
      <span className={cn("text-xs font-bold tabular-nums", level && LEVEL_TEXT[level])}>{text}</span>
      {detail && <span className="text-[11px] text-gray-500">{detail}</span>}
    </>
  );
  if (!onHistory) {
    return (
      <span className="inline-flex flex-col" data-testid={testId}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onHistory(r)}
      className="-mx-2 -my-1 inline-flex flex-col items-start rounded-lg px-2 py-1 text-left hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
      aria-label={`Casual Leave history of ${r.employeeName ?? r.employeeCode}: ${text}`}
      title="See the Casual Leave history of the year"
      data-testid={testId}
      data-view-safe
    >
      {body}
    </button>
  );
}

/** One half-day of the month is used: the employee can still take the other half. Under the yearly rule: only half a day
 *  of the year's balance is left. */
function HalfLeftNote({ r }: { r: BoardRow }) {
  if (r.left !== "one_half") return null;
  if (r.balance?.tracked) {
    return (
      <p className="text-[11px] font-semibold text-amber-700" data-testid={`half-left-${r.employeeId}`}>
        Only half a day of Casual Leave left this year
      </p>
    );
  }
  const used = r.usedParts?.[0];
  return (
    <p className="text-[11px] font-semibold text-amber-700" data-testid={`half-left-${r.employeeId}`}>
      One half-day left
      {used ? ` (${used.portion === "second_half" ? "second" : "first"} half of ${shortDate(used.date)} used)` : ""}
    </p>
  );
}

/** "Approved by Suresh (Dept Head)" under a decided request. */
function decidedBy(r: ClRequest): string | null {
  if (!r.reviewedBy || r.status === "pending") return null;
  const role = r.reviewerRole === "dept_head" ? "Dept Head" : "HR";
  const on = r.reviewedAt ? ` · ${shortDate(r.reviewedAt)}` : "";
  return `${r.status === "approved" ? "Approved" : "Rejected"} by ${r.reviewedBy} (${role})${on}`;
}

// ─── Requests: Taken this month and Requests ───

type RequestActions = {
  busy: boolean;
  onDecide: (r: ClRequest, status: "approved" | "rejected") => void;
  onDelete: (r: ClRequest) => void;
};

function RequestButtons({ r, busy, onDecide, onDelete }: { r: ClRequest } & RequestActions) {
  const pending = r.status === "pending";
  return (
    <div className="flex items-center justify-end gap-1.5">
      {pending && hrCanAct(r.approval, true) && (
        <Button
          size="sm"
          className="h-8 gap-1 bg-green-600 text-xs hover:bg-green-700"
          onClick={() => onDecide(r, "approved")}
          disabled={busy}
        >
          <CheckCircle size={12} /> Approve
        </Button>
      )}
      {pending && hrCanReject(r.approval, true) && (
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 border-red-200 text-xs text-red-500"
          onClick={() => onDecide(r, "rejected")}
          disabled={busy}
        >
          <XCircle size={12} /> Reject
        </Button>
      )}
      {!pending && (
        <button
          type="button"
          onClick={() => onDelete(r)}
          className="rounded-lg p-1.5 text-gray-300 hover:bg-red-50 hover:text-red-500"
          title="Delete record"
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

export function RequestList({ rows, ...actions }: { rows: ClRequest[] } & RequestActions) {
  return (
    <>
      <div className="hidden md:block">
        <Table data-testid="cl-table">
          <TableHeader>
            <TableRow>
              <TableHead className={HEAD}>Employee</TableHead>
              <TableHead className={HEAD}>CL date</TableHead>
              <TableHead className={HEAD}>Status</TableHead>
              <TableHead className={HEAD}>Decided by</TableHead>
              <TableHead className={HEAD}>Approval pipeline</TableHead>
              <TableHead className={cn(HEAD, "text-right")}>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} data-testid={`cl-${r.id}`} data-status={r.status}>
                <TableCell>
                  <PersonCell id={r.employeeId} name={r.employeeName} code={r.employeeCode} sub={where(r)} />
                </TableCell>
                <TableCell>
                  <p className="whitespace-nowrap text-sm font-semibold text-gray-900">{longDate(r.date)}</p>
                  <PortionChip portion={r.portion} />
                  {r.reason && <p className="max-w-[14rem] truncate text-xs text-gray-400">{r.reason}</p>}
                </TableCell>
                <TableCell>
                  <StatusChip status={r.status} approval={r.approval} />
                </TableCell>
                <TableCell className="text-xs text-gray-600">
                  {decidedBy(r) ?? <span className="text-gray-300">-</span>}
                  {r.reviewComment && <p className="max-w-[14rem] truncate text-gray-400">{r.reviewComment}</p>}
                </TableCell>
                <TableCell className="text-xs">
                  <Pipeline r={r} />
                </TableCell>
                <TableCell>
                  <RequestButtons r={r} {...actions} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="divide-y md:hidden" data-testid="cl-cards">
        {rows.map((r) => (
          <div key={r.id} className="space-y-2 p-4" data-testid={`cl-card-${r.id}`}>
            <div className="flex items-start justify-between gap-2">
              <PersonCell id={r.employeeId} name={r.employeeName} code={r.employeeCode} sub={where(r)} />
              <StatusChip status={r.status} approval={r.approval} />
            </div>
            <p className="text-sm font-semibold text-gray-900">{longDate(r.date)}</p>
            <PortionChip portion={r.portion} />
            {r.reason && <p className="text-xs text-gray-500">{r.reason}</p>}
            {decidedBy(r) && <p className="text-xs text-gray-500">{decidedBy(r)}</p>}
            <Pipeline r={r} />
            <RequestButtons r={r} {...actions} />
          </div>
        ))}
      </div>
    </>
  );
}

/** Where the request is in its approval pipeline: who has decided so far and who it waits for. */
function Pipeline({ r }: { r: ClRequest }) {
  if (!r.approval) return <span className="text-gray-300">-</span>;
  const text = trailLine(r.approval) ?? (r.status === "pending" ? waitingText(r.approval) : null);
  return text ? <p className="text-xs text-gray-500">{text}</p> : <span className="text-gray-300">-</span>;
}

// ─── Eligible ───

export function EligibleList({
  rows,
  onApply,
  onHistory,
  monthLabel,
}: {
  rows: BoardRow[];
  onApply: (r: BoardRow) => void;
  /** Opens the employee's Casual Leave history (the balance cell is the button). */
  onHistory?: (r: BoardRow) => void;
  monthLabel: string;
}) {
  return (
    <>
      <div className="hidden md:block">
        <Table data-testid="eligible-table">
          <TableHeader>
            <TableRow>
              <TableHead className={HEAD}>Employee</TableHead>
              <TableHead className={HEAD}>Joined</TableHead>
              <TableHead className={HEAD}>Service</TableHead>
              <TableHead className={HEAD}>Last CL</TableHead>
              <TableHead className={HEAD}>CL balance</TableHead>
              <TableHead className={cn(HEAD, "text-right")}>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.employeeId} data-testid={`eligible-${r.employeeId}`}>
                <TableCell>
                  <PersonCell id={r.employeeId} name={r.employeeName} code={r.employeeCode} sub={where(r)} />
                  <HalfLeftNote r={r} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-gray-600">{shortDate(r.joinDate)}</TableCell>
                <TableCell className="whitespace-nowrap text-xs font-semibold text-gray-700">
                  {serviceText(r.serviceMonths)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-gray-600">
                  {r.lastClDate ? shortDate(r.lastClDate) : <span className="text-gray-400">Never</span>}
                </TableCell>
                <TableCell>
                  <BalanceCell r={r} onHistory={onHistory} />
                </TableCell>
                <TableCell className="text-right">
                  <ApplyButton r={r} onApply={onApply} monthLabel={monthLabel} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="divide-y md:hidden" data-testid="eligible-cards">
        {rows.map((r) => (
          <div key={r.employeeId} className="space-y-2 p-4" data-testid={`eligible-card-${r.employeeId}`}>
            <PersonCell id={r.employeeId} name={r.employeeName} code={r.employeeCode} sub={where(r)} />
            <p className="text-xs text-gray-500">
              {serviceText(r.serviceMonths)} of service · last CL {r.lastClDate ? shortDate(r.lastClDate) : "never"}
            </p>
            {balanceText(r.balance) && (
              <div>
                <BalanceCell r={r} onHistory={onHistory} testId={`cl-balance-card-${r.employeeId}`} />
              </div>
            )}
            <HalfLeftNote r={r} />
            <ApplyButton r={r} onApply={onApply} monthLabel={monthLabel} />
          </div>
        ))}
      </div>
    </>
  );
}

function ApplyButton({ r, onApply, monthLabel }: { r: BoardRow; onApply: (r: BoardRow) => void; monthLabel: string }) {
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8 gap-1 text-xs"
      onClick={() => onApply(r)}
      aria-label={`Apply CL for ${r.employeeName ?? r.employeeCode} in ${monthLabel}`}
      data-testid={`apply-cl-${r.employeeId}`}
    >
      <Plus size={12} /> Apply CL
    </Button>
  );
}

// ─── Not eligible ───

export function NotEligibleList({
  rows,
  eligibilityMonths,
  onHistory,
}: {
  rows: BoardRow[];
  eligibilityMonths: number;
  /** Opens the employee's Casual Leave history (the balance cell is the button). */
  onHistory?: (r: BoardRow) => void;
}) {
  return (
    <>
      <div className="hidden md:block">
        <Table data-testid="not-eligible-table">
          <TableHeader>
            <TableRow>
              <TableHead className={HEAD}>Employee</TableHead>
              <TableHead className={HEAD}>Type</TableHead>
              <TableHead className={HEAD}>Service</TableHead>
              <TableHead className={HEAD}>CL balance</TableHead>
              <TableHead className={HEAD}>Why not</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const why = whyNot(r, eligibilityMonths);
              return (
                <TableRow key={r.employeeId} data-testid={`not-eligible-${r.employeeId}`} data-reason={why?.code}>
                  <TableCell>
                    <PersonCell id={r.employeeId} name={r.employeeName} code={r.employeeCode} sub={where(r)} />
                  </TableCell>
                  <TableCell className="text-xs capitalize text-gray-600">{r.employmentType ?? "-"}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-gray-600">
                    {r.employmentType === "production" ? (
                      <span className="text-gray-300">-</span>
                    ) : (
                      serviceText(r.serviceMonths)
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {balanceText(r.balance) ? (
                      <BalanceCell r={r} onHistory={onHistory} />
                    ) : (
                      <span className="text-xs text-gray-300">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {why && (
                      <div className="space-y-0.5">
                        <Chip className={WHY_CHIP[why.tone]}>{why.title}</Chip>
                        <p className="max-w-md text-xs text-gray-500">{why.detail}</p>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="divide-y md:hidden" data-testid="not-eligible-cards">
        {rows.map((r) => {
          const why = whyNot(r, eligibilityMonths);
          return (
            <div key={r.employeeId} className="space-y-2 p-4" data-testid={`not-eligible-card-${r.employeeId}`}>
              <PersonCell id={r.employeeId} name={r.employeeName} code={r.employeeCode} sub={where(r)} />
              {why && (
                <div className="space-y-0.5">
                  <Chip className={WHY_CHIP[why.tone]}>{why.title}</Chip>
                  <p className="text-xs text-gray-500">{why.detail}</p>
                </div>
              )}
              {balanceText(r.balance) && (
                <div>
                  <BalanceCell r={r} onHistory={onHistory} testId={`cl-balance-card-${r.employeeId}`} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

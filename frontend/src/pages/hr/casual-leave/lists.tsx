import { CheckCircle, Plus, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { hrCanAct, hrCanReject, trailLine, waitingText } from "@/lib/approval-workflow";
import { TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { longDate, shortDate } from "../leave/logic";
import { Chip, PersonCell, StatusChip } from "../leave/parts";
import { serviceText, whyNot, type BoardRow, type ClRequest, type Why } from "./logic";

const HEAD = "text-[11px] font-bold uppercase tracking-wider text-[#006496]/60";

const WHY_CHIP: Record<Why["tone"], string> = {
  info: TONE.info,
  warning: TONE.warning,
  neutral: TONE.neutral,
  danger: TONE.danger,
};

const where = (r: { department?: string | null; branch?: string | null }) =>
  [r.department, r.branch].filter(Boolean).join(" · ") || null;

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
  monthLabel,
}: {
  rows: BoardRow[];
  onApply: (r: BoardRow) => void;
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
              <TableHead className={HEAD}>CL this year</TableHead>
              <TableHead className={cn(HEAD, "text-right")}>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.employeeId} data-testid={`eligible-${r.employeeId}`}>
                <TableCell>
                  <PersonCell id={r.employeeId} name={r.employeeName} code={r.employeeCode} sub={where(r)} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-gray-600">{shortDate(r.joinDate)}</TableCell>
                <TableCell className="whitespace-nowrap text-xs font-semibold text-gray-700">
                  {serviceText(r.serviceMonths)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-gray-600">
                  {r.lastClDate ? shortDate(r.lastClDate) : <span className="text-gray-400">Never</span>}
                </TableCell>
                <TableCell className="text-xs text-gray-600">{r.approvedThisYear ?? 0}</TableCell>
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

export function NotEligibleList({ rows, eligibilityMonths }: { rows: BoardRow[]; eligibilityMonths: number }) {
  return (
    <>
      <div className="hidden md:block">
        <Table data-testid="not-eligible-table">
          <TableHeader>
            <TableRow>
              <TableHead className={HEAD}>Employee</TableHead>
              <TableHead className={HEAD}>Type</TableHead>
              <TableHead className={HEAD}>Service</TableHead>
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
            </div>
          );
        })}
      </div>
    </>
  );
}

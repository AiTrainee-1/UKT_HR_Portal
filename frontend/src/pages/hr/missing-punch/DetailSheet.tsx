import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { CheckCircle2, UserRound, XCircle } from "lucide-react";
import { ApprovalTrail } from "@/components/ApprovalTrail";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { waitingText } from "@/lib/approval-workflow";
import { InitialsAvatar } from "../settlement/parts";
import { formatDate, formatDateTime } from "../settlement/shared";
import { StatusChip } from "./RequestCard";
import { decisionLines, formatPunchTime, hrDecides, hrRejects, punchLabel, weekdayOf, type MissingRow } from "./logic";

type Props = {
  row: MissingRow | null;
  busy: boolean;
  onClose: () => void;
  /** The comment is optional and goes to the employee's record of the decision. */
  onDecide: (row: MissingRow, status: "approved" | "rejected", comment: string) => void;
};

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-xs">
      <dt className="text-gray-400">{label}</dt>
      <dd className="text-right font-medium text-gray-700">{children}</dd>
    </div>
  );
}

/** One request in full: the employee, the punch, the pipeline so far, every decision, and HR's decision with a note. */
export default function DetailSheet({ row, busy, onClose, onDecide }: Props) {
  const [comment, setComment] = useState("");
  const close = () => {
    setComment("");
    onClose();
  };
  const canApprove = row ? hrDecides(row) : false;
  const canReject = row ? hrRejects(row) : false;
  const decisions = row ? decisionLines(row) : [];

  return (
    <Sheet open={row !== null} onOpenChange={(o) => !o && close()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg" data-testid="mp-detail">
        {row && (
          <div className="space-y-5 pb-8 pt-2">
            <SheetHeader className="space-y-3 text-left">
              <div className="flex items-center gap-3 pr-6">
                <InitialsAvatar name={row.employeeName} size="lg" />
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-base">{row.employeeName}</SheetTitle>
                  <SheetDescription className="truncate text-xs">
                    <span className="font-mono">{row.employeeCode}</span>
                    {[row.designation, row.department, row.branch]
                      .filter(Boolean)
                      .map((t) => ` · ${t}`)
                      .join("")}
                  </SheetDescription>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip r={row} />
                <Link
                  href={`/hr/employees/${row.employeeId}`}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                >
                  <UserRound size={12} /> View employee
                </Link>
              </div>
            </SheetHeader>

            <dl className="space-y-1.5 rounded-xl bg-gray-50 p-3" aria-label="Request">
              <Line label="Missed date">
                {formatDate(row.date)} ({weekdayOf(row.date)})
              </Line>
              <Line label="Punch">{punchLabel(row)}</Line>
              <Line label="Time">{formatPunchTime(row.punchTime)}</Line>
              <Line label="Requested">{formatDateTime(row.createdAt)}</Line>
            </dl>

            <div className="space-y-1">
              <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Reason</p>
              <p className="rounded-xl border bg-white p-3 text-sm italic text-gray-700">"{row.reason}"</p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Approval</p>
              {row.approval ? (
                <div className="overflow-x-auto">
                  <ApprovalTrail approval={row.approval} submittedBy="Employee" />
                </div>
              ) : null}
              {decisions.length === 0 ? (
                <p className="text-xs text-gray-500">
                  {waitingText(row.approval) ?? "Nobody has decided this request yet."}
                </p>
              ) : (
                <ul className="space-y-2" data-testid="mp-detail-decisions">
                  {decisions.map((d, i) => (
                    <li key={i} className="rounded-xl border bg-white p-3 text-xs">
                      <p className="font-semibold text-gray-800">
                        {d.role}{" "}
                        <span className={d.outcome === "rejected" ? "text-red-600" : "text-green-700"}>
                          {d.outcome}
                        </span>
                        {d.by ? ` by ${d.by}` : ""}
                      </p>
                      {d.at && <p className="text-gray-400">{formatDateTime(d.at)}</p>}
                      {d.comment && <p className="mt-1 italic text-gray-600">"{d.comment}"</p>}
                    </li>
                  ))}
                </ul>
              )}
              {row.status === "approved" && (
                <p className="text-xs text-green-700">Added to attendance as a real punch (source: Missing Punch).</p>
              )}
            </div>

            {(canApprove || canReject) && (
              <div className="space-y-2 rounded-xl border p-3">
                <label htmlFor="mp-comment" className="text-xs font-bold uppercase tracking-wider text-gray-400">
                  Note (optional)
                </label>
                <Textarea
                  id="mp-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  maxLength={300}
                  rows={2}
                  placeholder="Added to the record of your decision"
                  data-testid="mp-comment"
                />
                <div className="flex gap-2">
                  {canApprove && (
                    <Button
                      size="sm"
                      className="h-9 flex-1 gap-1.5 bg-green-600 hover:bg-green-700"
                      disabled={busy}
                      onClick={() => {
                        onDecide(row, "approved", comment.trim());
                        close();
                      }}
                      data-testid="mp-detail-approve"
                    >
                      <CheckCircle2 size={13} /> Approve
                    </Button>
                  )}
                  {canReject && (
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-9 flex-1 gap-1.5"
                      disabled={busy}
                      onClick={() => {
                        onDecide(row, "rejected", comment.trim());
                        close();
                      }}
                      data-testid="mp-detail-reject"
                    >
                      <XCircle size={13} /> Reject
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

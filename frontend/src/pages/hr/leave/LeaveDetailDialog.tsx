import { Building2, Briefcase, CheckCircle, FileText, MapPin, User, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ApprovalTrail } from "@/components/ApprovalTrail";
import { hrCanAct, hrCanReject } from "@/lib/approval-workflow";
import { HALF_DAY_LABEL, decidedByLine, fmtDays, leaveDays, longDate, type LeaveRow } from "./logic";
import { StatusChip } from "./parts";

function Field({ icon, label, children }: { icon?: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      {icon && <span className="mt-0.5 shrink-0 text-gray-400">{icon}</span>}
      <div className="min-w-0">
        <p className="text-xs text-gray-400">{label}</p>
        <div className="text-sm font-semibold text-gray-900">{children}</div>
      </div>
    </div>
  );
}

export default function LeaveDetailDialog({
  leave,
  onClose,
  onDecide,
  busy,
}: {
  leave: LeaveRow | null;
  onClose: () => void;
  onDecide: (leave: LeaveRow, status: "approved" | "rejected") => void;
  busy: boolean;
}) {
  if (!leave) return null;
  const pending = leave.status === "pending";
  const days = leaveDays(leave);
  const single = leave.startDate === leave.endDate;
  const by = decidedByLine(leave, true);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="leave-detail">
        <DialogHeader>
          <DialogTitle>{leave.isHalfDay ? "Half-Day Leave Details" : "Leave Request Details"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-3 rounded-xl border bg-gray-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Employee</p>
            <div className="grid grid-cols-2 gap-3">
              <Field icon={<User size={14} />} label="Name">
                {leave.employeeName ?? "-"}
              </Field>
              <Field icon={<FileText size={14} />} label="Employee ID">
                {leave.employeeCode ?? `#${leave.employeeId}`}
              </Field>
              <Field icon={<Building2 size={14} />} label="Department">
                {leave.department ?? "-"}
              </Field>
              <Field icon={<Briefcase size={14} />} label="Designation">
                {leave.designation ?? "-"}
              </Field>
              {leave.branch && (
                <Field icon={<MapPin size={14} />} label="Branch">
                  {leave.branch}
                </Field>
              )}
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Leave Details</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Leave Type">
                <span className="capitalize">{leave.type}</span>
              </Field>
              <Field label="Status">
                <StatusChip status={leave.status} approval={leave.approval} />
              </Field>
              {leave.isHalfDay ? (
                <div className="col-span-2">
                  <Field label="Date">
                    {longDate(leave.startDate)}
                    <span className="ml-2 text-xs font-normal text-gray-400">
                      ({HALF_DAY_LABEL[leave.halfDaySlot ?? ""] ?? "Half day"})
                    </span>
                  </Field>
                </div>
              ) : single ? (
                <div className="col-span-2">
                  <Field label="Date">
                    {longDate(leave.startDate)}
                    <span className="ml-2 text-xs font-normal text-gray-400">(1 day)</span>
                  </Field>
                </div>
              ) : (
                <>
                  <Field label="From">{longDate(leave.startDate)}</Field>
                  <Field label="To">{longDate(leave.endDate)}</Field>
                </>
              )}
              <Field label="Working Days">
                {fmtDays(days)} day{days === 1 ? "" : "s"}
              </Field>
            </div>
            {leave.reason && (
              <div>
                <p className="mb-1 text-xs text-gray-400">Reason</p>
                <p className="rounded-lg border bg-gray-50 p-3 text-sm text-gray-700">{leave.reason}</p>
              </div>
            )}
            {leave.hrComment && (
              <div>
                <p className="mb-1 text-xs text-gray-400">HR Comment</p>
                <p className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-700">
                  {leave.hrComment}
                </p>
              </div>
            )}
            {by && <p className="text-xs text-gray-500">{by}</p>}
            <p className="text-xs text-gray-300">
              Submitted: {leave.createdAt ? new Date(leave.createdAt).toLocaleString("en-IN") : "-"}
            </p>
          </div>

          {leave.approval && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Approval</p>
              <ApprovalTrail approval={leave.approval} />
            </div>
          )}

          {pending && (hrCanAct(leave.approval, true) || hrCanReject(leave.approval, true)) && (
            <div className="flex gap-2 pt-1">
              {hrCanAct(leave.approval, true) && (
                <Button
                  className="flex-1 gap-1 bg-green-600 hover:bg-green-700"
                  onClick={() => {
                    onDecide(leave, "approved");
                    onClose();
                  }}
                  disabled={busy}
                >
                  <CheckCircle size={14} /> Approve
                </Button>
              )}
              {hrCanReject(leave.approval, true) && (
                <Button
                  variant="outline"
                  className="flex-1 gap-1 border-red-200 text-red-600 hover:bg-red-50"
                  onClick={() => {
                    onDecide(leave, "rejected");
                    onClose();
                  }}
                  disabled={busy}
                >
                  <XCircle size={14} /> Reject
                </Button>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { Building2, Briefcase, CheckCircle, FileText, MapPin, User, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { TimePicker12h } from "@/components/ui/time-picker-12h";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import { ApprovalTrail } from "@/components/ApprovalTrail";
import { hrCanAct, hrCanReject } from "@/lib/approval-workflow";
import type { PermissionItem, PermissionType } from "@/lib/api-client";
import { PERMISSION_MINUTES, PERMISSION_TYPES, permissionOutcome } from "@/lib/late-detection";
import { longDate } from "./logic";

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

export type PermissionForm = {
  employeeId: string;
  date: string;
  type: PermissionType | "";
  permissionTime: string;
  reason: string;
};

export const emptyPermissionForm = (): PermissionForm => ({
  employeeId: "",
  date: new Date().toISOString().slice(0, 10),
  type: "",
  permissionTime: "",
  reason: "",
});

export function AddPermissionDialog({
  open,
  onOpenChange,
  form,
  setForm,
  employees,
  cap,
  saving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: PermissionForm;
  setForm: (updater: (f: PermissionForm) => PermissionForm) => void;
  employees: unknown[] | undefined;
  cap: number;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Permission</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground" data-testid="permission-cap-copy">
            Every permission is exactly {PERMISSION_MINUTES} minutes. Only the first {cap} approved permissions per
            employee each calendar month (earliest date first) are <strong>Allowed</strong>: an Allowed Morning Late-In
            moves that day's shift start {PERMISSION_MINUTES} minutes later, an Allowed Evening Early-Out moves that
            day's shift end {PERMISSION_MINUTES} minutes earlier, and Middle One-Hour never moves either. An approved
            permission beyond that cap is <strong>Overdue / Excess</strong>: it moves nothing and counts as one
            occurrence in the monthly late pool.
          </p>
          <div className="space-y-1.5">
            <Label>Employee</Label>
            <EmployeeSearchSelect
              employees={employees as any[] | undefined}
              value={form.employeeId}
              onChange={(v) => setForm((f) => ({ ...f, employeeId: v }))}
            />
          </div>
          <div className="space-y-1.5" role="radiogroup" aria-label="Permission type">
            <Label>
              Type <span className="text-red-500">*</span>
            </Label>
            {PERMISSION_TYPES.map((t) => {
              const selected = form.type === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`permission-type-${t.key}`}
                  onClick={() => setForm((f) => ({ ...f, type: t.key }))}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected
                      ? "border-cyan-400 bg-cyan-50/60 ring-1 ring-cyan-300"
                      : "border-gray-200 bg-white hover:border-gray-300"
                  }`}
                >
                  <span className="block text-sm font-semibold text-gray-900">{t.label}</span>
                  <span className="block text-[11px] text-gray-500">{t.hint}</span>
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Duration</Label>
              <p className="flex h-9 items-center rounded-md border bg-gray-50 px-3 text-sm font-medium text-gray-700">
                {PERMISSION_MINUTES} minutes
              </p>
            </div>
          </div>
          <TimePicker12h
            label="Requested time (optional)"
            value={form.permissionTime}
            onChange={(v) => setForm((f) => ({ ...f, permissionTime: v }))}
          />
          <div className="space-y-1.5">
            <Label>Reason (optional)</Label>
            <Input
              value={form.reason}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
              placeholder="Brief reason"
            />
          </div>
          <div className="flex gap-3 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={onSave} disabled={saving}>
              {saving ? "Adding…" : "Add Permission"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PermissionDetailDialog({
  permission,
  onClose,
  typeDraft,
  setTypeDraft,
  selectedKey,
  canRevise,
  saving,
  onDecide,
  onSaveType,
}: {
  permission: (PermissionItem & { branch?: string | null }) | null;
  onClose: () => void;
  typeDraft: PermissionType | "";
  setTypeDraft: (type: PermissionType | "") => void;
  /** The request's own type (null when it has none). */
  selectedKey: PermissionType | null;
  /** Re-typing a decided request is only allowed when HR is in the permission pipeline. */
  canRevise: boolean;
  saving: boolean;
  onDecide: (p: PermissionItem, status: "approved" | "rejected", type?: PermissionType) => void;
  onSaveType: (p: PermissionItem, type: PermissionType) => void;
}) {
  const p = permission;
  if (!p) return null;
  const outcome = permissionOutcome(p);
  const pending = p.status === "pending";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="permission-detail">
        <DialogHeader>
          <DialogTitle>Permission Request Details</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-3 rounded-xl border bg-gray-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Employee</p>
            <div className="grid grid-cols-2 gap-3">
              <Field icon={<User size={14} />} label="Name">
                {p.employeeName}
              </Field>
              <Field icon={<FileText size={14} />} label="Employee ID">
                {p.employeeCode ?? `#${p.employeeId}`}
              </Field>
              <Field icon={<Building2 size={14} />} label="Department">
                {p.department ?? "-"}
              </Field>
              <Field icon={<Briefcase size={14} />} label="Designation">
                {p.designation ?? "-"}
              </Field>
              {p.branch && (
                <Field icon={<MapPin size={14} />} label="Branch">
                  {p.branch}
                </Field>
              )}
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Permission Details</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date">{p.date ? longDate(p.date) : "-"}</Field>
              <Field label="Time">{p.permissionTime ?? "Not specified"}</Field>
              <Field label="Outcome">
                <Badge className={`border text-xs ${outcome.className}`}>{outcome.label}</Badge>
              </Field>
              <Field label="Duration">{p.durationMinutes ?? PERMISSION_MINUTES} minutes</Field>
              {p.monthlyUsed != null && (
                <div className="col-span-2">
                  <p className="text-xs text-gray-400">Monthly Usage</p>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="flex gap-0.5">
                      {Array.from({ length: p.monthlyLimit }).map((_, i) => (
                        <div
                          key={i}
                          className={`h-1.5 w-4 rounded-full ${i < (p.monthlyUsed ?? 0) ? "bg-amber-400" : "bg-gray-200"}`}
                        />
                      ))}
                    </div>
                    <span className="text-xs text-gray-500">
                      {p.monthlyUsed}/{p.monthlyLimit}
                    </span>
                  </div>
                </div>
              )}
            </div>
            {p.status !== "rejected" && outcome.explanation && (
              <p
                className={`rounded-lg border p-2 text-xs ${
                  p.capStatus === "excess"
                    ? "border-orange-100 bg-orange-50 text-orange-800"
                    : "bg-gray-50 text-gray-600"
                }`}
              >
                {outcome.explanation}
              </p>
            )}

            {/* Type: HR can classify an untyped request or correct a mis-picked one; it decides whether an
                approval can shift a shift boundary at all. */}
            <div className="space-y-1.5">
              <Label className="text-xs text-gray-400" htmlFor="permission-type-select">
                Type
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  id="permission-type-select"
                  data-testid="permission-type-select"
                  value={typeDraft}
                  onChange={(e) => setTypeDraft(e.target.value as PermissionType | "")}
                  disabled={!pending && !canRevise}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  {!selectedKey && (
                    <option value="" disabled>
                      Not set - choose a type
                    </option>
                  )}
                  {PERMISSION_TYPES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
                {!pending && canRevise && typeDraft && typeDraft !== selectedKey && (
                  <Button size="sm" variant="outline" onClick={() => onSaveType(p, typeDraft)} disabled={saving}>
                    Save type
                  </Button>
                )}
              </div>
              {!selectedKey && (
                <p className="text-[11px] text-amber-700">
                  This request was submitted without a type (older web-app submissions have none), so it cannot move a
                  shift boundary until one is set. Pick the type that matches what the employee asked for; you can also
                  approve without one.
                </p>
              )}
            </div>
            {p.reason && (
              <div>
                <p className="mb-1 text-xs text-gray-400">Reason</p>
                <p className="rounded-lg border bg-gray-50 p-3 text-sm text-gray-700">{p.reason}</p>
              </div>
            )}
            {p.hrComment && (
              <div>
                <p className="mb-1 text-xs text-gray-400">HR Comment</p>
                <p className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-700">{p.hrComment}</p>
              </div>
            )}
            {p.approvedBy && (
              <p className="text-xs text-gray-500">
                {p.status === "rejected" ? "Rejected By" : "Approved By"}: <strong>{p.approvedBy}</strong>
                {p.approverRole === "dept_head" ? " (Department Head)" : " (HR)"}
              </p>
            )}
            <p className="text-xs text-gray-300">
              Submitted: {p.createdAt ? new Date(p.createdAt).toLocaleString("en-IN") : "-"}
            </p>
          </div>

          {p.approval && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Approval</p>
              <ApprovalTrail approval={p.approval} />
            </div>
          )}

          {pending && (hrCanAct(p.approval, true) || hrCanReject(p.approval, true)) && (
            <div className="flex gap-2 pt-1">
              {hrCanAct(p.approval, true) && (
                <Button
                  className="flex-1 gap-1 bg-green-600 hover:bg-green-700"
                  onClick={() => {
                    // Sent only when HR picked or changed it; an untouched, already-typed request is not re-typed.
                    onDecide(p, "approved", typeDraft && typeDraft !== selectedKey ? typeDraft : undefined);
                    onClose();
                  }}
                  disabled={saving}
                >
                  <CheckCircle size={14} /> Approve
                </Button>
              )}
              {hrCanReject(p.approval, true) && (
                <Button
                  variant="outline"
                  className="flex-1 gap-1 border-red-200 text-red-600 hover:bg-red-50"
                  onClick={() => {
                    onDecide(p, "rejected");
                    onClose();
                  }}
                  disabled={saving}
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

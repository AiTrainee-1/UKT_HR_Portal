import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type {
  DepartmentAssignmentConflict,
  DepartmentReassign,
  EmployeeAssignmentConflict,
} from "@/lib/api-client/custom-hooks";

function WarningHeader({ title, children }: { title: string; children: string | undefined }) {
  return (
    <DialogHeader className="items-center text-center sm:items-start sm:text-left">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600">
          <TriangleAlert size={20} />
        </span>
        <DialogTitle className="text-base">{title}</DialogTitle>
      </div>
      <DialogDescription className="pt-1 text-sm text-foreground">{children}</DialogDescription>
    </DialogHeader>
  );
}

/** Assigning a single employee who already reports to another HOD (409 from manager_employee_assignments). */
export function EmployeeConflictDialog({
  conflict,
  onConfirm,
  onClose,
  pending,
}: {
  conflict: { employeeName: string; conflict: EmployeeAssignmentConflict } | null;
  onConfirm: () => void;
  onClose: () => void;
  pending: boolean;
}) {
  return (
    <Dialog open={!!conflict} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm" data-testid="employee-conflict-dialog">
        <WarningHeader title="Already assigned elsewhere">{conflict?.conflict.error}</WarningHeader>
        <div className="flex flex-col gap-2 pt-1">
          <Button className="w-full" onClick={onConfirm} disabled={pending}>
            {pending
              ? "Reassigning…"
              : conflict?.conflict.conflictType === "department"
                ? "Move to this HOD"
                : `Remove from ${conflict?.conflict.existingManager.employeeName} and assign here`}
          </Button>
          <Button variant="outline" className="w-full" onClick={onClose} disabled={pending}>
            Keep existing assignment
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Assigning a whole department when some of its people already report to another HOD (409 from
 *  manager_department_assignments). Ticked people move here; everyone else stays exactly where they are. */
export function DepartmentConflictDialog({
  conflict,
  managerName,
  selected,
  onToggle,
  onSelectAll,
  onSelectNone,
  onConfirm,
  onClose,
  pending,
}: {
  conflict: DepartmentAssignmentConflict | null;
  managerName: string;
  selected: Set<number>;
  onToggle: (employeeId: number) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onConfirm: (reassign: DepartmentReassign) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const people = conflict?.conflicts ?? [];
  return (
    <Dialog open={!!conflict} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto" data-testid="department-conflict-dialog">
        <WarningHeader title="Already assigned to another HOD">{conflict?.error}</WarningHeader>

        {conflict && people.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="font-semibold uppercase tracking-wide text-gray-500">
                Employees who already have an HOD ({people.length})
              </span>
              <span className="space-x-3">
                <button type="button" className="font-medium text-blue-600 hover:underline" onClick={onSelectAll}>
                  Select all
                </button>
                <button type="button" className="font-medium text-blue-600 hover:underline" onClick={onSelectNone}>
                  Select none
                </button>
              </span>
            </div>
            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {people.map((c) => (
                <label
                  key={c.employeeId}
                  className="flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2 transition-colors hover:bg-gray-50"
                >
                  <Checkbox
                    className="mt-1"
                    checked={selected.has(c.employeeId)}
                    onCheckedChange={() => onToggle(c.employeeId)}
                    data-testid={`conflict-pick-${c.employeeCode}`}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-600">
                        {c.employeeCode}
                      </code>
                      <span className="truncate text-sm font-medium">{c.name}</span>
                    </span>
                    <span className="mt-0.5 block text-xs text-gray-500">
                      Already assigned to <strong>{c.manager.employeeName}</strong>
                      {c.via === "direct" ? " individually" : ` through the ${conflict.department.name} department`}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-500">
              Ticked employees move to <strong>{managerName}</strong>. Unticked employees stay with their current HOD:
              nothing changes for them.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2 pt-1">
          <Button
            className="w-full"
            onClick={() =>
              onConfirm(selected.size > 0 && selected.size === people.length ? "all" : Array.from(selected))
            }
            disabled={pending || selected.size === 0}
          >
            {pending ? "Assigning…" : `Reassign ${selected.size} selected & assign department`}
          </Button>
          <Button variant="outline" className="w-full" onClick={() => onConfirm("all")} disabled={pending}>
            Reassign all {conflict?.conflictCount ?? 0} to this HOD
          </Button>
          <Button variant="outline" className="w-full" onClick={() => onConfirm("none")} disabled={pending}>
            {(conflict?.holders.length ?? 0) > 0
              ? "Keep existing assignments: don't assign this department"
              : "Keep existing assignments: assign only the rest of the department"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

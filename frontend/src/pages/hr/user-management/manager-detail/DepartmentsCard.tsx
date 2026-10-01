import { useEffect, useState } from "react";
import { Building2, Info, Plus } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useListDepartments } from "@/lib/api-client";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  useAssignDepartmentToManager,
  useDepartmentRoster,
  useRemoveDepartmentFromManager,
  type DepartmentAssignmentConflict,
  type DepartmentReassign,
  type RosterDepartment,
  type RosterEmployee,
} from "@/lib/api-client/custom-hooks";
import { REMOVE_EXPLANATION, initialOpen } from "../roster";
import { DepartmentConflictDialog } from "./ConflictDialogs";
import DepartmentSection from "./DepartmentSection";

/**
 * The HOD's departments, each with its employees listed automatically. Adding a department lists its people right away
 * (and the new section opens); removing a department asks first, because everyone in it stops reporting to this HOD.
 * Assigning a department whose people already report to another HOD asks what to do with them, as it always did.
 */
export default function DepartmentsCard({
  managerId,
  managerName,
  onClaim,
  claimingId,
}: {
  managerId: number;
  managerName: string;
  onClaim: (e: RosterEmployee) => void;
  claimingId: number | null;
}) {
  const { toast } = useToast();
  const { data: roster, isLoading } = useDepartmentRoster(managerId);
  const { data: allDepartments = [] } = useListDepartments();
  const assign = useAssignDepartmentToManager();
  const removeDepartment = useRemoveDepartmentFromManager();

  const [newDeptId, setNewDeptId] = useState("");
  const [open, setOpen] = useState<Set<number> | null>(null);
  const [justAdded, setJustAdded] = useState<number | null>(null);
  const [conflict, setConflict] = useState<DepartmentAssignmentConflict | null>(null);
  const [reassignIds, setReassignIds] = useState<Set<number>>(new Set());
  const [removing, setRemoving] = useState<RosterDepartment | null>(null);

  const departments = roster?.departments ?? [];
  const openIds = open ?? initialOpen(departments, null);
  const assignedIds = new Set(departments.map((d) => d.id));
  const available = allDepartments.filter((d) => !assignedIds.has(d.id));

  // A department that was just added opens and scrolls into view once its people have arrived.
  useEffect(() => {
    if (justAdded === null || !assignedIds.has(justAdded)) return;
    document
      .querySelector(`[data-testid="dept-section-${justAdded}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setJustAdded(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justAdded, roster]);

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev ?? initialOpen(departments, null));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const added = (departmentId: number) => {
    setNewDeptId("");
    setJustAdded(departmentId);
    setOpen((prev) => new Set([...(prev ?? initialOpen(departments, null)), departmentId]));
  };

  const addDepartment = async () => {
    if (!newDeptId) return;
    const departmentId = Number(newDeptId);
    try {
      const res = await assign.mutateAsync({ managerId, departmentId });
      added(departmentId);
      toast({ title: res.message ?? "Department assigned", description: "Its employees are listed below." });
    } catch (e) {
      const data = e instanceof ApiError ? (e.data as DepartmentAssignmentConflict | null) : null;
      if (e instanceof ApiError && e.status === 409 && data?.conflict && data.conflictType === "department") {
        setReassignIds(new Set());
        setConflict(data);
        return;
      }
      toast({ title: e instanceof Error ? e.message : "Could not assign the department", variant: "destructive" });
    }
  };

  const confirmConflict = async (reassign: DepartmentReassign) => {
    if (!conflict) return;
    const departmentId = conflict.department.id;
    try {
      const res = await assign.mutateAsync({ managerId, departmentId, reassign });
      if (res.assigned === false) {
        toast({ title: "Existing assignments kept: the department was not assigned" });
      } else {
        added(departmentId);
        toast({ title: res.message ?? "Department assigned" });
      }
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Failed to assign department", variant: "destructive" });
    } finally {
      setConflict(null);
    }
  };

  const confirmRemoval = async () => {
    if (!removing) return;
    try {
      await removeDepartment.mutateAsync({ managerId, departmentId: removing.id });
      toast({ title: `${removing.name} removed from ${managerName}` });
    } catch {
      toast({ title: "Failed to remove the department", variant: "destructive" });
    } finally {
      setRemoving(null);
    }
  };

  const toggleReassign = (employeeId: number) =>
    setReassignIds((prev) => {
      const next = new Set(prev);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });

  return (
    <Card className="border-0 shadow-sm" data-testid="departments-card">
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-gray-900">
              Departments &amp; employees{" "}
              <span className="font-semibold text-gray-400" data-testid="departments-count">
                {departments.length}
              </span>
            </h3>
            <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
              Add a department and everyone in it is listed here automatically, including people who join later.
            </p>
          </div>
          {available.length > 0 && (
            <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
              <Select value={newDeptId} onValueChange={setNewDeptId}>
                <SelectTrigger className="h-9 w-full text-sm sm:w-64" data-testid="add-department-select">
                  <SelectValue placeholder="Choose a department…" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                className="h-9 shrink-0 gap-1.5"
                onClick={() => void addDepartment()}
                disabled={!newDeptId || assign.isPending}
                data-testid="add-department"
              >
                <Plus size={14} /> Add Department
              </Button>
            </div>
          )}
        </div>

        {departments.length > 0 && (
          <p className="flex items-start gap-2 rounded-xl bg-blue-50/70 px-3 py-2 text-xs text-blue-900">
            <Info size={14} className="mt-0.5 shrink-0 text-blue-500" />
            <span>{REMOVE_EXPLANATION}</span>
          </p>
        )}

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full rounded-2xl" />
            <Skeleton className="h-16 w-full rounded-2xl" />
          </div>
        ) : departments.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-gray-200 py-10 text-center">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-500">
              <Building2 size={22} />
            </span>
            <p className="text-sm font-semibold text-gray-700">No departments assigned yet</p>
            <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
              {available.length > 0
                ? "Choose a department above. Its employees appear here straight away, and you can remove anyone who should report elsewhere."
                : "There are no departments to assign yet."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {departments.map((d) => (
              <DepartmentSection
                key={d.id}
                managerId={managerId}
                managerName={managerName}
                department={d}
                open={openIds.has(d.id)}
                onToggle={() => toggle(d.id)}
                onRemoveDepartment={() => setRemoving(d)}
                onClaim={onClaim}
                claimingId={claimingId}
              />
            ))}
          </div>
        )}
      </div>

      <DepartmentConflictDialog
        conflict={conflict}
        managerName={managerName}
        selected={reassignIds}
        onToggle={toggleReassign}
        onSelectAll={() => setReassignIds(new Set((conflict?.conflicts ?? []).map((c) => c.employeeId)))}
        onSelectNone={() => setReassignIds(new Set())}
        onConfirm={(r) => void confirmConflict(r)}
        onClose={() => setConflict(null)}
        pending={assign.isPending}
      />

      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent data-testid="remove-department-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removing?.name} from {managerName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The {removing?.counts.reporting ?? 0} employee{removing?.counts.reporting === 1 ? "" : "s"} who report to
              this HOD through {removing?.name} stop reporting to them. They stay in the department, and their requests
              go to the next HOD who holds it, or to HR. Anyone you removed from this department earlier is cleared too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep department</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => void confirmRemoval()}
              data-testid="confirm-remove-department"
            >
              Remove Department
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

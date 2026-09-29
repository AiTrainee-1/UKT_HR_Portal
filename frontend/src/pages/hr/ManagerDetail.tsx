import { useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Shield, Building2, Users, X, Plus, UserRound, CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useListDepartments, useListEmployees } from "@/lib/api-client";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  useGetDepartmentManager,
  useAssignDepartmentToManager,
  useRemoveDepartmentFromManager,
  useAssignEmployeeToManager,
  useRemoveEmployeeFromManager,
  useUpdateDepartmentManager,
  type EmployeeAssignmentConflict,
  type DepartmentAssignmentConflict,
  type DepartmentReassign,
  type ManagerOverlap,
} from "@/lib/api-client/custom-hooks";

/**
 * One department manager (HOD): their permissions, the departments they
 * cover and the employees who report to them.
 *
 * A page rather than the dialog this used to be -a manager can hold several
 * departments and dozens of employees, which is more than a modal should
 * carry, and a page can be linked to and survives a refresh.
 */


export default function ManagerDetail() {
  const [, navigate] = useLocation();
  const params = useParams<{ id: string }>();
  const managerId = Number(params.id) || null;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newDeptId, setNewDeptId] = useState("");
  const [newEmpId, setNewEmpId] = useState("");
  // Set when assigning an employee 409s with a conflict (see
  // manager_employee_assignments) -holds everything the confirm dialog
  // needs to either reassign (force:true) or leave the existing HOD alone.
  const [assignConflict, setAssignConflict] = useState<{
    employeeCode: string;
    employeeName: string;
    conflict: EmployeeAssignmentConflict;
  } | null>(null);
  // Set when assigning a DEPARTMENT 409s (see manager_department_assignments): some of its employees
  // already report to another HOD. `reassignIds` are the ones HR ticks to move here; everyone else
  // stays with their current HOD -unticked is the safe default, nothing moves unless asked.
  const [deptConflict, setDeptConflict] = useState<{
    departmentId: number;
    conflict: DepartmentAssignmentConflict;
  } | null>(null);
  const [reassignIds, setReassignIds] = useState<Set<number>>(new Set());

  const { data: manager, isLoading } = useGetDepartmentManager(managerId);
  const { data: departments = [] } = useListDepartments();
  const { data: employees } = useListEmployees({ status: "active" });

  const assignDeptMutation = useAssignDepartmentToManager();
  const removeDeptMutation = useRemoveDepartmentFromManager();
  const assignEmpMutation = useAssignEmployeeToManager();
  const removeEmpMutation = useRemoveEmployeeFromManager();
  const updateMutation = useUpdateDepartmentManager();


  const handleAddDept = async () => {
    if (!newDeptId || !managerId) return;
    try {
      await assignDeptMutation.mutateAsync({ managerId, departmentId: Number(newDeptId) });
      setNewDeptId("");
      toast({ title: "Department assigned" });
    } catch (e: any) {
      const data = e instanceof ApiError ? (e.data as any) : null;
      if (e instanceof ApiError && e.status === 409 && data?.conflict && data?.conflictType === "department") {
        setReassignIds(new Set());
        setDeptConflict({ departmentId: Number(newDeptId), conflict: data as DepartmentAssignmentConflict });
        return;
      }
      toast({ title: e?.message ?? "Already assigned", variant: "destructive" });
    }
  };

  const confirmDeptAssign = async (reassign: DepartmentReassign) => {
    if (!managerId || !deptConflict) return;
    try {
      const res = await assignDeptMutation.mutateAsync({
        managerId,
        departmentId: deptConflict.departmentId,
        reassign,
      });
      setNewDeptId("");
      toast({
        title:
          res.assigned === false
            ? "Existing assignments kept -the department was not assigned"
            : (res.message ?? "Department assigned"),
      });
    } catch (e: any) {
      toast({ title: e?.message ?? "Failed to assign department", variant: "destructive" });
    } finally {
      setDeptConflict(null);
    }
  };

  const toggleReassign = (employeeId: number) =>
    setReassignIds((prev) => {
      const next = new Set(prev);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });

  // An employee listed under this HOD who reports to another one: move them here.
  const handleReassignOverlap = async (o: ManagerOverlap) => {
    if (!managerId) return;
    try {
      await assignEmpMutation.mutateAsync({ managerId, employeeCode: o.employeeCode, force: true });
      toast({ title: `${o.name} now reports to this HOD` });
    } catch (e: any) {
      toast({ title: e?.message ?? "Failed to reassign", variant: "destructive" });
    }
  };

  const handleRemoveDept = async (deptId: number) => {
    if (!managerId) return;
    try {
      await removeDeptMutation.mutateAsync({ managerId, departmentId: deptId });
      toast({ title: "Department removed" });
    } catch {
      toast({ title: "Failed to remove", variant: "destructive" });
    }
  };

  const handleAddEmp = async () => {
    if (!newEmpId || !managerId) return;
    const emp = employees?.find((e: { id: number }) => String(e.id) === newEmpId);
    if (!emp) return;
    try {
      await assignEmpMutation.mutateAsync({ managerId, employeeCode: emp.employeeCode! });
      setNewEmpId("");
      toast({ title: "Employee assigned" });
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409 && (e.data as any)?.conflict) {
        setAssignConflict({
          employeeCode: emp.employeeCode!,
          employeeName: `${emp.firstName} ${emp.lastName}`,
          conflict: e.data as EmployeeAssignmentConflict,
        });
        return;
      }
      toast({ title: e?.message ?? "Already assigned", variant: "destructive" });
    }
  };

  const confirmReassign = async () => {
    if (!managerId || !assignConflict) return;
    try {
      await assignEmpMutation.mutateAsync({
        managerId, employeeCode: assignConflict.employeeCode, force: true,
      });
      setNewEmpId("");
      toast({ title: `${assignConflict.employeeName} reassigned to this HOD` });
    } catch (e: any) {
      toast({ title: e?.message ?? "Failed to reassign", variant: "destructive" });
    } finally {
      setAssignConflict(null);
    }
  };

  const handleRemoveEmp = async (empId: number) => {
    if (!managerId) return;
    try {
      await removeEmpMutation.mutateAsync({ managerId, employeeId: empId });
      toast({ title: "Employee removed" });
    } catch {
      toast({ title: "Failed to remove", variant: "destructive" });
    }
  };

  const togglePerm = async (field: "canApproveLeaves" | "canApprovePermissions" | "canApproveResignations" | "canApproveAttendance" | "canApproveCasualLeave" | "canApproveOnDuty") => {
    if (!manager || !managerId) return;
    await updateMutation.mutateAsync({
      id: managerId,
      data: { [field]: !manager[field] },
    });
  };

  const assignedDeptIds = new Set((manager?.assignedDepartments ?? []).map((d) => d.id));
  const availableDepts = departments.filter((d) => !assignedDeptIds.has(d.id));

  return (
    <HrLayout>
      <div className="mx-auto max-w-3xl space-y-4">
        {/* Back first, so the way out is the first thing you see. */}
        <button
          onClick={() => navigate("/hr/user-management")}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={15} /> Back to User Management
        </button>

        <div className="flex items-center gap-2">
          <Shield size={18} className="text-blue-600" />
          <h2 className="text-2xl font-black text-gray-900">
            {isLoading ? "Loading…" : manager?.employeeName ?? "User not found"}
          </h2>
        </div>

        {isLoading ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </div>
        ) : manager ? (
          <div className="space-y-5 pt-1">
            {/* Employee info */}
            <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-black text-sm shrink-0">
                {manager.employeeName.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-sm">{manager.employeeName}</span>
                  <code className="text-xs font-mono bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded">
                    {manager.employeeCode}
                  </code>
                  {!manager.isActive && (
                    <Badge className="text-xs bg-red-50 text-red-600 border-red-200">Inactive</Badge>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  {[manager.designation, manager.department].filter(Boolean).join(" · ")}
                </p>
              </div>
            </div>

            {/* Permissions toggles */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Approval Permissions
              </p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { key: "canApproveLeaves" as const, label: "Approve Leaves" },
                  { key: "canApprovePermissions" as const, label: "Approve Permissions & Outpass" },
                  { key: "canApproveResignations" as const, label: "Approve Resignations" },
                  { key: "canApproveAttendance" as const, label: "Approve Attendance Edits" },
                  { key: "canApproveCasualLeave" as const, label: "Approve Casual Leave" },
                  { key: "canApproveOnDuty" as const, label: "Approve On-Duty" },
                ].map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => togglePerm(key)}
                    className={`flex items-center gap-2 p-2.5 rounded-lg border text-sm font-medium transition-colors text-left ${
                      manager[key]
                        ? "bg-green-50 border-green-200 text-green-700"
                        : "bg-gray-50 border-gray-200 text-gray-400"
                    }`}
                  >
                    {manager[key] ? <CheckCircle size={14} /> : <XCircle size={14} />}
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Assigned Departments */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Assigned Departments ({manager.assignedDepartments?.length ?? 0})
              </p>
              <div className="space-y-1.5 mb-2">
                {(manager.assignedDepartments ?? []).length === 0 ? (
                  <p className="text-xs text-gray-400 py-2">No departments assigned yet.</p>
                ) : (
                  (manager.assignedDepartments ?? []).map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center justify-between px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg"
                    >
                      <div className="flex items-center gap-2">
                        <Building2 size={13} className="text-blue-500 shrink-0" />
                        <span className="text-sm font-medium text-blue-800">{d.name}</span>
                      </div>
                      <button
                        onClick={() => handleRemoveDept(d.id)}
                        className="text-red-400 hover:text-red-600 transition-colors"
                        title="Remove"
                      >
                        <XCircle size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
              {availableDepts.length > 0 && (
                <div className="flex gap-2">
                  <select
                    value={newDeptId}
                    onChange={(e) => setNewDeptId(e.target.value)}
                    className="flex-1 h-8 text-xs rounded-md border px-2 bg-background"
                  >
                    <option value="">Add department…</option>
                    {availableDepts.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                  <Button size="sm" className="h-8 text-xs gap-1" onClick={handleAddDept}
                    disabled={!newDeptId || assignDeptMutation.isPending}>
                    <Plus size={12} /> Add
                  </Button>
                </div>
              )}
            </div>

            {/* Assigned Individual Employees */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Individual Employees ({manager.assignedEmployees?.length ?? 0})
                <span className="font-normal text-gray-400 ml-1">-cross-department assignments</span>
              </p>
              <div className="space-y-1.5 mb-2">
                {(manager.assignedEmployees ?? []).length === 0 ? (
                  <p className="text-xs text-gray-400 py-2">No individual employees assigned.</p>
                ) : (
                  (manager.assignedEmployees ?? []).map((e) => (
                    <div
                      key={e.id}
                      className="flex items-center justify-between px-3 py-2 bg-gray-50 border rounded-lg"
                    >
                      <div className="flex items-center gap-2">
                        <code className="text-xs font-mono bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">
                          {e.employeeCode}
                        </code>
                        <span className="text-sm font-medium">{e.name}</span>
                        {e.department && (
                          <span className="text-xs text-gray-400">{e.department}</span>
                        )}
                      </div>
                      <button
                        onClick={() => handleRemoveEmp(e.id)}
                        className="text-red-400 hover:text-red-600 transition-colors"
                        title="Remove"
                      >
                        <XCircle size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <EmployeeSearchSelect
                    employees={(employees ?? []).filter(
                      (e) => !(manager.assignedEmployees ?? []).some((a) => a.id === e.id)
                    )}
                    value={newEmpId}
                    onChange={setNewEmpId}
                    placeholder="Search employee to assign…"
                  />
                </div>
                <Button size="sm" className="h-9 text-xs gap-1 shrink-0" onClick={handleAddEmp}
                  disabled={!newEmpId || assignEmpMutation.isPending}>
                  <Plus size={12} /> Add
                </Button>
              </div>
            </div>

            {/* Listed under this HOD but really reporting to another one. An employee reports to ONE
                HOD (an individual assignment beats department coverage; the earliest wins among
                equals), so these are not in this HOD's approvals or headcount -shown so the
                department's headcount is explained, with a one-click way to move them here. */}
            {(manager.overlaps ?? []).length > 0 && (
              <div>
                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">
                  Reporting to another HOD ({manager.overlaps?.length})
                </p>
                <p className="text-xs text-gray-500 mb-2">
                  Each employee reports to one HOD only. These are in this HOD's departments (or listed here) but
                  already report to someone else, so they are not counted or approved for here.
                </p>
                <div className="space-y-1.5">
                  {(manager.overlaps ?? []).map((o) => (
                    <div
                      key={o.employeeId}
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-amber-50 border border-amber-100 rounded-lg"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <code className="text-xs font-mono bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                            {o.employeeCode}
                          </code>
                          <span className="text-sm font-medium truncate">{o.name}</span>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Reports to <strong>{o.currentManager.employeeName}</strong>
                          {o.via === "direct" ? " (assigned individually)" : ` (through the ${o.department ?? "department"} department)`}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs shrink-0"
                        onClick={() => handleReassignOverlap(o)}
                        disabled={assignEmpMutation.isPending}
                      >
                        Reassign to this HOD
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {manager.notes && (
              <div className="text-xs text-gray-500 bg-amber-50 border border-amber-100 rounded-lg p-2.5">
                <span className="font-semibold">Note:</span> {manager.notes}
              </div>
            )}
          </div>
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground">
            This user no longer exists.
          </p>
        )}
      </div>

      {/* "Already assigned to another HOD" conflict -see manager_employee_
          assignments' 409 response. Reassign moves the employee here
          (deleting the old direct assignment); Keep Existing just closes
          this without touching anything. */}
      <Dialog open={!!assignConflict} onOpenChange={(open) => !open && setAssignConflict(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle size={16} className="text-amber-500" />
              Already assigned elsewhere
            </DialogTitle>
            <DialogDescription className="pt-1 text-sm text-foreground">
              {assignConflict?.conflict.error}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              className="w-full"
              onClick={confirmReassign}
              disabled={assignEmpMutation.isPending}
            >
              {assignEmpMutation.isPending
                ? "Reassigning…"
                : assignConflict?.conflict.conflictType === "department"
                  ? "Move to this HOD"
                  : `Remove from ${assignConflict?.conflict.existingManager.employeeName} and assign here`}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setAssignConflict(null)}
              disabled={assignEmpMutation.isPending}
            >
              Keep existing assignment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* "Already assigned to another HOD" for a whole DEPARTMENT -see
          manager_department_assignments' 409. Lists every employee who already reports to a
          different HOD. Ticked employees are reassigned to this HOD; unticked ones stay exactly
          where they are. Closing the dialog changes nothing. */}
      <Dialog open={!!deptConflict} onOpenChange={(open) => !open && setDeptConflict(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle size={16} className="text-amber-500" />
              Already assigned to another HOD
            </DialogTitle>
            <DialogDescription className="pt-1 text-sm text-foreground">
              {deptConflict?.conflict.error}
            </DialogDescription>
          </DialogHeader>

          {deptConflict && deptConflict.conflict.conflicts.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="font-semibold text-gray-500 uppercase tracking-wide">
                  Employees who already have an HOD ({deptConflict.conflict.conflicts.length})
                </span>
                <span className="space-x-2">
                  <button
                    type="button"
                    className="text-blue-600 hover:underline"
                    onClick={() =>
                      setReassignIds(new Set(deptConflict.conflict.conflicts.map((c) => c.employeeId)))
                    }
                  >
                    Select all
                  </button>
                  <button type="button" className="text-blue-600 hover:underline" onClick={() => setReassignIds(new Set())}>
                    Select none
                  </button>
                </span>
              </div>
              <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                {deptConflict.conflict.conflicts.map((c) => (
                  <label
                    key={c.employeeId}
                    className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 size-4 shrink-0 accent-blue-600"
                      checked={reassignIds.has(c.employeeId)}
                      onChange={() => toggleReassign(c.employeeId)}
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <code className="text-xs font-mono bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">
                          {c.employeeCode}
                        </code>
                        <span className="text-sm font-medium truncate">{c.name}</span>
                      </span>
                      <span className="block text-xs text-gray-500 mt-0.5">
                        Already assigned to <strong>{c.manager.employeeName}</strong>
                        {c.via === "direct"
                          ? " individually"
                          : ` through the ${deptConflict.conflict.department.name} department`}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-gray-500">
                Ticked employees move to <strong>{manager?.employeeName}</strong>. Unticked employees stay with
                their current HOD -nothing changes for them.
              </p>
            </div>
          )}

          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              className="w-full"
              onClick={() =>
                confirmDeptAssign(
                  reassignIds.size > 0 && reassignIds.size === deptConflict?.conflict.conflicts.length
                    ? "all"
                    : Array.from(reassignIds),
                )
              }
              disabled={assignDeptMutation.isPending || reassignIds.size === 0}
            >
              {assignDeptMutation.isPending
                ? "Assigning…"
                : `Reassign ${reassignIds.size} selected & assign department`}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => confirmDeptAssign("all")}
              disabled={assignDeptMutation.isPending}
            >
              Reassign all {deptConflict?.conflict.conflictCount ?? 0} to this HOD
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => confirmDeptAssign("none")}
              disabled={assignDeptMutation.isPending}
            >
              {(deptConflict?.conflict.holders.length ?? 0) > 0
                ? "Keep existing assignments -don't assign this department"
                : "Keep existing assignments -assign only the rest of the department"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}

import { useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Shield, Building2, Users, X, Plus, UserRound, CheckCircle, XCircle } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useListDepartments, useListEmployees } from "@/lib/api-client";
import {
  useGetDepartmentManager,
  useAssignDepartmentToManager,
  useRemoveDepartmentFromManager,
  useAssignEmployeeToManager,
  useRemoveEmployeeFromManager,
  useUpdateDepartmentManager,
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
      toast({ title: e?.message ?? "Already assigned", variant: "destructive" });
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
      toast({ title: e?.message ?? "Already assigned", variant: "destructive" });
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
                  { key: "canApprovePermissions" as const, label: "Approve Permissions" },
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
    </HrLayout>
  );
}

import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import {
  useListDepartmentManagers,
  useGetDepartmentManager,
  useCreateDepartmentManager,
  useUpdateDepartmentManager,
  useDeleteDepartmentManager,
  useAssignDepartmentToManager,
  useRemoveDepartmentFromManager,
  useAssignEmployeeToManager,
  useRemoveEmployeeFromManager,
  getDepartmentManagersQueryKey,
  type DepartmentManagerItem,
} from "@/lib/api-client/custom-hooks";
import { useListDepartments, useListEmployees } from "@/lib/api-client";
import {
  Users, Plus, Trash2, Shield, ChevronRight, Building2,
  UserCheck, CheckCircle, XCircle, Edit2, AlertTriangle,
  Clock, Layers,
} from "lucide-react";

// ─── Create User Dialog ────────────────────────────────────────────────────────

function CreateUserDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [employeeId, setEmployeeId] = useState("");
  const [canApproveLeaves, setCanApproveLeaves] = useState(true);
  const [canApprovePermissions, setCanApprovePermissions] = useState(true);
  const [notes, setNotes] = useState("");

  const { data: employees } = useListEmployees({ status: "active" });
  const createMutation = useCreateDepartmentManager();

  const handleCreate = async () => {
    if (!employeeId) {
      toast({ title: "Please select an employee", variant: "destructive" });
      return;
    }
    const emp = employees?.find((e: { id: number }) => String(e.id) === employeeId);
    if (!emp) {
      toast({ title: "Employee not found", variant: "destructive" });
      return;
    }
    try {
      await createMutation.mutateAsync({
        employeeCode: emp.employeeCode!,
        canApproveLeaves,
        canApprovePermissions,
        notes: notes || undefined,
      });
      toast({ title: `${emp.firstName} ${emp.lastName} added as department user` });
      setEmployeeId("");
      setNotes("");
      setCanApproveLeaves(true);
      setCanApprovePermissions(true);
      onClose();
    } catch (e: any) {
      toast({
        title: "Failed to create user",
        description: e?.message ?? "Unknown error",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck size={16} className="text-blue-600" /> Add Department User
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground -mt-1">
          Assign an employee as a department approver. They can approve leave & permission requests
          from their assigned departments or employees via the mobile app.
        </p>
        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label>Employee <span className="text-red-500">*</span></Label>
            <EmployeeSearchSelect
              employees={employees ?? []}
              value={employeeId}
              onChange={setEmployeeId}
              placeholder="Search by employee code or name…"
            />
          </div>
          <div className="space-y-2">
            <Label>Permissions</Label>
            <div className="space-y-2">
              {[
                { label: "Can approve leave requests", value: canApproveLeaves, set: setCanApproveLeaves },
                { label: "Can approve permission requests", value: canApprovePermissions, set: setCanApprovePermissions },
              ].map(({ label, value, set }) => (
                <label key={label} className="flex items-center gap-2.5 cursor-pointer group">
                  <button
                    onClick={() => set(!value)}
                    className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                      value ? "bg-blue-600 border-blue-600" : "bg-white border-gray-300 hover:border-blue-400"
                    }`}
                  >
                    {value && <CheckCircle size={11} className="text-white" />}
                  </button>
                  <span className="text-sm text-gray-700">{label}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Notes <span className="text-gray-400 font-normal">(optional)</span></Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Covers Cutting section"
            />
          </div>
          <div className="flex gap-3 pt-1">
            <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button className="flex-1" onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Adding…" : "Add User"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Manager Detail Dialog ─────────────────────────────────────────────────────

function ManagerDetailDialog({
  managerId,
  onClose,
}: {
  managerId: number | null;
  onClose: () => void;
}) {
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

  if (!managerId) return null;

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

  const togglePerm = async (field: "canApproveLeaves" | "canApprovePermissions") => {
    if (!manager || !managerId) return;
    await updateMutation.mutateAsync({
      id: managerId,
      data: { [field]: !manager[field] },
    });
  };

  const assignedDeptIds = new Set((manager?.assignedDepartments ?? []).map((d) => d.id));
  const availableDepts = departments.filter((d) => !assignedDeptIds.has(d.id));

  return (
    <Dialog open={!!managerId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield size={16} className="text-blue-600" />
            {isLoading ? "Loading…" : manager?.employeeName}
          </DialogTitle>
        </DialogHeader>

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
                <span className="font-normal text-gray-400 ml-1">— cross-department assignments</span>
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
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ─── Delete Confirm Dialog ─────────────────────────────────────────────────────

function DeleteConfirmDialog({
  manager,
  onClose,
  onConfirm,
  isPending,
}: {
  manager: DepartmentManagerItem | null;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={!!manager} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-600">
            <AlertTriangle size={16} /> Remove Department User
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-gray-600">
          Remove <strong>{manager?.employeeName}</strong> ({manager?.employeeCode}) as a department
          user? They will no longer be able to approve requests from the mobile app.
        </p>
        <div className="flex gap-3 pt-3">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" className="flex-1" onClick={onConfirm} disabled={isPending}>
            {isPending ? "Removing…" : "Remove User"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function UserManagement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [detailManagerId, setDetailManagerId] = useState<number | null>(null);
  const [deleteManager, setDeleteManager] = useState<DepartmentManagerItem | null>(null);

  const { data: managers = [], isLoading } = useListDepartmentManagers();
  const deleteMutation = useDeleteDepartmentManager();
  const updateMutation = useUpdateDepartmentManager();

  const handleDelete = async () => {
    if (!deleteManager) return;
    try {
      await deleteMutation.mutateAsync(deleteManager.id);
      toast({ title: `${deleteManager.employeeName} removed as department user` });
      setDeleteManager(null);
    } catch {
      toast({ title: "Failed to remove user", variant: "destructive" });
    }
  };

  const toggleActive = async (m: DepartmentManagerItem) => {
    await updateMutation.mutateAsync({ id: m.id, data: { isActive: !m.isActive } });
    queryClient.invalidateQueries({ queryKey: getDepartmentManagersQueryKey() });
  };

  const activeCount = managers.filter((m) => m.isActive).length;

  return (
    <HrLayout>
      <div className="space-y-6">
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-gray-900">User Management</h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              Assign employees as department approvers — they receive and action leave & permission
              requests from their team via the mobile app
            </p>
          </div>
          <Button className="gap-2" onClick={() => setShowCreateDialog(true)}>
            <Plus size={15} /> Create User
          </Button>
        </div>

        {/* ── Stats ───────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-3">
          {[
            {
              label: "Total Users",
              value: managers.length,
              icon: <Users size={16} className="text-blue-600" />,
              bg: "bg-blue-50 border-blue-100",
              text: "text-blue-700",
            },
            {
              label: "Active",
              value: activeCount,
              icon: <CheckCircle size={16} className="text-green-600" />,
              bg: "bg-green-50 border-green-100",
              text: "text-green-700",
            },
            {
              label: "Departments Covered",
              value: managers.reduce((s, m) => s + m.departmentCount, 0),
              icon: <Building2 size={16} className="text-indigo-600" />,
              bg: "bg-indigo-50 border-indigo-100",
              text: "text-indigo-700",
            },
          ].map((s) => (
            <Card key={s.label} className={`border ${s.bg}`}>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-1">{s.icon}</div>
                <p className={`text-2xl font-black ${s.text}`}>{s.value}</p>
                <p className="text-xs font-medium text-gray-500 mt-0.5">{s.label}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* ── User Cards ──────────────────────────────────────────────────── */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-1.5">
            <Shield size={13} /> Roles & Permissions
          </p>

          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i} className="border-0 shadow-sm">
                  <CardContent className="p-4"><Skeleton className="h-14 w-full" /></CardContent>
                </Card>
              ))}
            </div>
          ) : managers.length === 0 ? (
            <div className="text-center py-16 border-2 border-dashed border-gray-200 rounded-2xl">
              <UserCheck size={36} className="mx-auto text-gray-200 mb-3" />
              <p className="font-semibold text-gray-500">No department users yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Click <strong>Create User</strong> to assign an employee as a department approver.
              </p>
              <Button className="mt-4 gap-2" variant="outline" onClick={() => setShowCreateDialog(true)}>
                <Plus size={14} /> Create User
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {managers.map((m) => (
                <Card
                  key={m.id}
                  className={`border hover:shadow-md transition-shadow cursor-pointer ${!m.isActive ? "opacity-60" : ""}`}
                  onClick={() => setDetailManagerId(m.id)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center gap-4">
                      {/* Avatar */}
                      <div
                        className={`w-11 h-11 rounded-xl flex items-center justify-center font-black text-white text-sm shrink-0 ${
                          m.isActive
                            ? "bg-gradient-to-br from-blue-500 to-indigo-600"
                            : "bg-gray-300"
                        }`}
                      >
                        {m.employeeName.charAt(0)}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm text-gray-900">{m.employeeName}</span>
                          <code className="text-xs font-mono bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded border">
                            {m.employeeCode}
                          </code>
                          {!m.isActive && (
                            <Badge className="text-xs bg-red-50 text-red-600 border-red-200">
                              Inactive
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1 flex-wrap">
                          {m.department && (
                            <span className="text-xs text-gray-400">{m.department}</span>
                          )}
                          {m.designation && (
                            <span className="text-xs text-gray-400">{m.designation}</span>
                          )}
                          <span className="flex items-center gap-1 text-xs text-gray-400">
                            <Building2 size={11} />
                            {m.departmentCount} dept{m.departmentCount !== 1 ? "s" : ""}
                          </span>
                          <span className="flex items-center gap-1 text-xs text-gray-400">
                            <Users size={11} />
                            {m.employeeCount} individual
                          </span>
                        </div>
                        {/* Permission badges */}
                        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                          <span
                            className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border ${
                              m.canApproveLeaves
                                ? "bg-green-50 text-green-700 border-green-200"
                                : "bg-gray-50 text-gray-400 border-gray-200"
                            }`}
                          >
                            {m.canApproveLeaves ? <CheckCircle size={10} /> : <XCircle size={10} />}
                            Leaves
                          </span>
                          <span
                            className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border ${
                              m.canApprovePermissions
                                ? "bg-green-50 text-green-700 border-green-200"
                                : "bg-gray-50 text-gray-400 border-gray-200"
                            }`}
                          >
                            {m.canApprovePermissions ? <CheckCircle size={10} /> : <XCircle size={10} />}
                            Permissions
                          </span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div
                        className="flex items-center gap-1 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          variant="ghost" size="sm"
                          className="h-8 px-2.5 text-xs gap-1 text-blue-600 hover:bg-blue-50"
                          onClick={() => setDetailManagerId(m.id)}
                        >
                          <Layers size={12} /> Details
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          className="h-8 px-2.5 text-xs gap-1"
                          onClick={() => toggleActive(m)}
                          disabled={updateMutation.isPending}
                        >
                          {m.isActive ? (
                            <span className="text-amber-600">Deactivate</span>
                          ) : (
                            <span className="text-green-600">Activate</span>
                          )}
                        </Button>
                        <Button
                          variant="ghost" size="icon"
                          className="h-8 w-8 text-red-400 hover:text-red-600 hover:bg-red-50"
                          onClick={() => setDeleteManager(m)}
                        >
                          <Trash2 size={13} />
                        </Button>
                        <ChevronRight size={14} className="text-gray-300 ml-1" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* ── How it works ────────────────────────────────────────────────── */}
        <div className="bg-blue-50/60 border border-blue-100 rounded-2xl p-4 space-y-2.5">
          <p className="text-xs font-bold text-blue-700 uppercase tracking-wide">How it works</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {[
              {
                icon: <Plus size={14} className="text-blue-500" />,
                title: "1. Create User",
                desc: "Search an employee by code and assign them as a department approver.",
              },
              {
                icon: <Building2 size={14} className="text-indigo-500" />,
                title: "2. Assign Departments / Employees",
                desc: "Open their details to assign departments or individual cross-department employees.",
              },
              {
                icon: <Clock size={14} className="text-green-500" />,
                title: "3. Mobile Approvals",
                desc: "The assigned user sees a new Approvals tab in the mobile app and can approve/reject requests.",
              },
            ].map((s) => (
              <div key={s.title} className="flex gap-2.5">
                <div className="mt-0.5 shrink-0">{s.icon}</div>
                <div>
                  <p className="text-xs font-semibold text-gray-700">{s.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Dialogs ──────────────────────────────────────────────────────── */}
      <CreateUserDialog open={showCreateDialog} onClose={() => setShowCreateDialog(false)} />
      <ManagerDetailDialog managerId={detailManagerId} onClose={() => setDetailManagerId(null)} />
      <DeleteConfirmDialog
        manager={deleteManager}
        onClose={() => setDeleteManager(null)}
        onConfirm={handleDelete}
        isPending={deleteMutation.isPending}
      />
    </HrLayout>
  );
}

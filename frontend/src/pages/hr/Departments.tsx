import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  useListDepartments, useCreateDepartment, useDeleteDepartment,
  getListDepartmentsQueryKey,
} from "@/lib/api-client";
import {
  useSearchEmployees, useAssignEmployee,
} from "@/lib/api-client";
import { useListEmployees, getListEmployeesQueryKey } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Building2, Plus, Trash2, Users, Search, ChevronDown, ChevronRight,
  UserPlus, X, UserMinus,
} from "lucide-react";
import type { Department, Employee } from "@/lib/api-client";

// ── Employee search dialog used for assigning an employee to a department ──
function AssignEmployeeDialog({
  dept,
  onClose,
}: {
  dept: Department;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const { data: results, isFetching } = useSearchEmployees(query);
  const assignMutation = useAssignEmployee();

  const assign = async (emp: Employee) => {
    if (emp.departmentId === dept.id) {
      toast({ title: `${emp.firstName} is already in this department` });
      return;
    }
    try {
      await assignMutation.mutateAsync({ id: emp.id, departmentId: dept.id });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListDepartmentsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() }),
      ]);
      toast({ title: `${emp.firstName} ${emp.lastName} assigned to ${dept.name}` });
    } catch {
      toast({ title: "Failed to assign employee", variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assign Employee to {dept.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Search by Employee ID or Phone Number</Label>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                autoFocus
                className="pl-9"
                placeholder="e.g. EMP001 or 9876543210"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {query.length < 2 && (
              <p className="text-xs text-muted-foreground">Type at least 2 characters to search</p>
            )}
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto">
            {isFetching && (
              <div className="text-xs text-center text-muted-foreground py-4">Searching…</div>
            )}
            {!isFetching && query.length >= 2 && (!results || results.length === 0) && (
              <div className="text-xs text-center text-muted-foreground py-4">No employees found</div>
            )}
            {(results ?? []).map((emp) => (
              <div
                key={emp.id}
                className="flex items-center justify-between gap-3 p-3 rounded-lg border hover:bg-gray-50"
              >
                <div>
                  <p className="font-semibold text-sm">{emp.firstName} {emp.lastName}</p>
                  <p className="text-xs text-gray-400">
                    {emp.employeeCode} · {emp.phone ?? "—"}
                  </p>
                  {emp.departmentName && (
                    <p className="text-xs text-amber-600 mt-0.5">
                      Currently in: {emp.departmentName}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  className="h-7 text-xs shrink-0"
                  onClick={() => assign(emp)}
                  disabled={assignMutation.isPending || emp.departmentId === dept.id}
                >
                  {emp.departmentId === dept.id ? "Already here" : "Assign"}
                </Button>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Department card with expandable employee list ────────────────────────────
function DeptCard({
  dept,
  onDelete,
}: {
  dept: Department;
  onDelete: (id: number) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const assignMutation = useAssignEmployee();

  const { data: employees, isLoading: empLoading } = useListEmployees(
    { departmentId: dept.id, status: "active" } as any,
    { query: { enabled: expanded } } as any,
  );

  const removeEmployee = async (emp: Employee) => {
    try {
      await assignMutation.mutateAsync({ id: emp.id, departmentId: null });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListDepartmentsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() }),
      ]);
      toast({ title: `${emp.firstName} removed from department` });
    } catch {
      toast({ title: "Failed to remove employee", variant: "destructive" });
    }
  };

  return (
    <>
      <Card className="border-0 shadow-sm hover:shadow-md transition-shadow">
        <CardContent className="p-0">
          {/* Header row */}
          <div
            className="flex items-center gap-4 p-4 cursor-pointer"
            onClick={() => setExpanded((v) => !v)}
          >
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "linear-gradient(135deg, #3b82f6, #06b6d4)" }}
            >
              <Building2 size={18} className="text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-gray-900 truncate">{dept.name}</p>
              {dept.description && (
                <p className="text-sm text-muted-foreground truncate mt-0.5">{dept.description}</p>
              )}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <Badge variant="secondary" className="gap-1.5">
                <Users size={11} />
                {dept.employeeCount ?? 0} employees
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-blue-500 hover:text-blue-700 hover:bg-blue-50"
                onClick={(e) => { e.stopPropagation(); setShowAssign(true); }}
                title="Assign employee"
              >
                <UserPlus size={14} />
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-red-600 hover:bg-red-50"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Trash2 size={15} />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete department?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete <strong>{dept.name}</strong>. Employees
                      assigned to this department will become unassigned.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => onDelete(dept.id)}
                      className="bg-red-600 hover:bg-red-700"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              {expanded ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
            </div>
          </div>

          {/* Expanded employee list */}
          {expanded && (
            <div className="border-t px-4 pb-4 pt-3 space-y-2">
              {empLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <Skeleton className="h-4 w-40" />
                  </div>
                ))
              ) : (employees ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No employees assigned yet.{" "}
                  <button
                    className="text-blue-600 underline"
                    onClick={() => setShowAssign(true)}
                  >
                    Assign one
                  </button>
                </p>
              ) : (
                (employees ?? []).map((emp) => (
                  <div
                    key={emp.id}
                    className="flex items-center justify-between gap-3 py-1.5 px-2 rounded-lg hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                        {emp.firstName.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800 truncate">
                          {emp.firstName} {emp.lastName}
                        </p>
                        <p className="text-xs text-gray-400">
                          {emp.employeeCode}
                          {(emp as any).designationTitle ? ` · ${(emp as any).designationTitle}` : ""}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-gray-300 hover:text-red-500 hover:bg-red-50 shrink-0"
                      title="Remove from department"
                      onClick={() => removeEmployee(emp)}
                      disabled={assignMutation.isPending}
                    >
                      <UserMinus size={13} />
                    </Button>
                  </div>
                ))
              )}
              <Button
                variant="outline"
                size="sm"
                className="w-full gap-2 mt-1 h-8 text-xs border-dashed"
                onClick={() => setShowAssign(true)}
              >
                <UserPlus size={13} /> Assign Employee
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {showAssign && (
        <AssignEmployeeDialog dept={dept} onClose={() => setShowAssign(false)} />
      )}
    </>
  );
}

// ── Main Departments page ─────────────────────────────────────────────────────
export default function Departments() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });

  const { data: departments, isLoading } = useListDepartments();
  const createMutation = useCreateDepartment();
  const deleteMutation = useDeleteDepartment();

  const filtered = (departments ?? []).filter((d) =>
    d.name.toLowerCase().includes(search.toLowerCase()) ||
    (d.description ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  async function handleCreate() {
    if (!form.name.trim()) {
      toast({ title: "Department name is required", variant: "destructive" });
      return;
    }
    try {
      await createMutation.mutateAsync({
        data: { name: form.name.trim(), description: form.description.trim() || undefined },
      });
    } catch {
      toast({ title: "Failed to create department", variant: "destructive" });
      return;
    }
    toast({ title: "Department created" });
    setShowDialog(false);
    setForm({ name: "", description: "" });
    queryClient.invalidateQueries({ queryKey: getListDepartmentsQueryKey() });
  }

  async function handleDelete(id: number) {
    try {
      await deleteMutation.mutateAsync({ id });
    } catch {
      toast({ title: "Failed to delete department", variant: "destructive" });
      return;
    }
    toast({ title: "Department deleted" });
    queryClient.invalidateQueries({ queryKey: getListDepartmentsQueryKey() });
  }

  const totalEmployees = (departments ?? []).reduce((s, d) => s + (d.employeeCount ?? 0), 0);

  return (
    <HrLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Departments</h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              Manage departments and assign employees — click a card to expand
            </p>
          </div>
          <Button onClick={() => setShowDialog(true)} className="gap-2 self-start sm:self-auto">
            <Plus size={16} /> New Department
          </Button>
        </div>

        {/* Search */}
        <div className="relative max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search departments…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Departments</p>
              <p className="text-2xl font-black text-blue-600 mt-0.5">{departments?.length ?? 0}</p>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Total Employees</p>
              <p className="text-2xl font-black text-green-600 mt-0.5">{totalEmployees}</p>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Avg / Dept</p>
              <p className="text-2xl font-black text-purple-600 mt-0.5">
                {departments?.length ? Math.round(totalEmployees / departments.length) : 0}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* List */}
        <div className="grid gap-3">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="border-0 shadow-sm">
                <CardContent className="p-4">
                  <Skeleton className="h-5 w-40 mb-2" />
                  <Skeleton className="h-4 w-64" />
                </CardContent>
              </Card>
            ))
          ) : filtered.length === 0 ? (
            <Card className="border-0 shadow-sm">
              <CardContent className="p-10 flex flex-col items-center text-center">
                <Building2 size={32} className="text-muted-foreground/30 mb-3" />
                <p className="font-semibold text-gray-700">
                  {search ? "No departments match your search" : "No departments yet"}
                </p>
                {!search && (
                  <p className="text-sm text-muted-foreground mt-1">
                    Create your first department to get started.
                  </p>
                )}
              </CardContent>
            </Card>
          ) : (
            filtered.map((dept) => (
              <DeptCard key={dept.id} dept={dept} onDelete={handleDelete} />
            ))
          )}
        </div>
      </div>

      {/* Create Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Department</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="dept-name">Name <span className="text-red-500">*</span></Label>
              <Input
                id="dept-name"
                placeholder="e.g. Production"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dept-desc">Description</Label>
              <Input
                id="dept-desc"
                placeholder="Optional description"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating…" : "Create Department"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}

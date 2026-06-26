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
  useListDesignations, useCreateDesignation, useDeleteDesignation,
  getListDesignationsQueryKey,
} from "@/lib/api-client";
import { useListDepartments, useListEmployees, getListEmployeesQueryKey } from "@/lib/api-client";
import { useSearchEmployees, useAssignEmployee } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Briefcase, Plus, Trash2, Search, ChevronDown, ChevronRight,
  UserPlus, UserMinus, Users,
} from "lucide-react";
import type { Employee } from "@/lib/api-client";
import type { Designation } from "@/lib/api-client/custom-hooks";

// ── Employee search dialog for assigning to a designation ────────────────────
function AssignEmployeeDialog({
  desig,
  onClose,
}: {
  desig: Designation & { employeeCount?: number };
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const { data: results, isFetching } = useSearchEmployees(query);
  const assignMutation = useAssignEmployee();

  const assign = async (emp: Employee) => {
    if ((emp as any).designationId === desig.id) {
      toast({ title: `${emp.firstName} already has this designation` });
      return;
    }
    try {
      await assignMutation.mutateAsync({ id: emp.id, designationId: desig.id });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListDesignationsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() }),
      ]);
      toast({ title: `${emp.firstName} ${emp.lastName} assigned to ${desig.title}` });
    } catch {
      toast({ title: "Failed to assign employee", variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assign Employee to {desig.title}</DialogTitle>
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
                  <p className="text-xs text-gray-400">{emp.employeeCode} · {emp.phone ?? "—"}</p>
                  {(emp as any).designationTitle && (
                    <p className="text-xs text-amber-600 mt-0.5">
                      Current: {(emp as any).designationTitle}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  className="h-7 text-xs shrink-0"
                  onClick={() => assign(emp)}
                  disabled={assignMutation.isPending || (emp as any).designationId === desig.id}
                >
                  {(emp as any).designationId === desig.id ? "Already here" : "Assign"}
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

// ── Designation card with expandable employee list ───────────────────────────
function DesigCard({
  desig,
  onDelete,
}: {
  desig: Designation & { employeeCount?: number };
  onDelete: (id: number) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const assignMutation = useAssignEmployee();

  const { data: employees, isLoading: empLoading } = useListEmployees(
    { designationId: desig.id } as any,
    { query: { enabled: expanded } } as any,
  );

  const removeEmployee = async (emp: Employee) => {
    try {
      await assignMutation.mutateAsync({ id: emp.id, designationId: null });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListDesignationsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() }),
      ]);
      toast({ title: `${emp.firstName} removed from designation` });
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
              style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
            >
              <Briefcase size={18} className="text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-gray-900 truncate">{desig.title}</p>
              <div className="flex items-center gap-2 mt-0.5">
                {desig.departmentName && (
                  <span className="text-xs text-muted-foreground">{desig.departmentName}</span>
                )}
                {desig.level && (
                  <Badge variant="secondary" className="text-xs">{desig.level}</Badge>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge variant="secondary" className="gap-1.5">
                <Users size={11} />
                {desig.employeeCount ?? 0}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50"
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
                    <AlertDialogTitle>Delete designation?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently remove <strong>{desig.title}</strong>.
                      Employees with this designation will become unassigned.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => onDelete(desig.id)}
                      className="bg-red-600 hover:bg-red-700"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              {expanded
                ? <ChevronDown size={16} className="text-gray-400" />
                : <ChevronRight size={16} className="text-gray-400" />}
            </div>
          </div>

          {/* Expanded employee list */}
          {expanded && (
            <div className="border-t px-4 pb-4 pt-3 space-y-2">
              {empLoading ? (
                Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <Skeleton className="h-4 w-40" />
                  </div>
                ))
              ) : (employees ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No employees with this designation.{" "}
                  <button className="text-indigo-600 underline" onClick={() => setShowAssign(true)}>
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
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                        {emp.firstName.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800 truncate">
                          {emp.firstName} {emp.lastName}
                        </p>
                        <p className="text-xs text-gray-400">
                          {emp.employeeCode}
                          {emp.departmentName ? ` · ${emp.departmentName}` : ""}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-gray-300 hover:text-red-500 hover:bg-red-50 shrink-0"
                      title="Remove designation"
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
        <AssignEmployeeDialog desig={desig} onClose={() => setShowAssign(false)} />
      )}
    </>
  );
}

// ── Main Designations page ────────────────────────────────────────────────────
export default function Designations() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const [form, setForm] = useState({ title: "", departmentId: "", level: "" });

  const { data: designations, isLoading } = useListDesignations();
  const { data: departments } = useListDepartments();
  const createMutation = useCreateDesignation();
  const deleteMutation = useDeleteDesignation();

  const filtered = (designations ?? []).filter(
    (d) =>
      d.title.toLowerCase().includes(search.toLowerCase()) ||
      (d.departmentName ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  async function handleCreate() {
    if (!form.title.trim()) {
      toast({ title: "Designation title is required", variant: "destructive" });
      return;
    }
    try {
      await createMutation.mutateAsync({
        title: form.title.trim(),
        departmentId: form.departmentId ? Number(form.departmentId) : null,
        level: form.level.trim() || undefined,
      });
    } catch {
      toast({ title: "Failed to create designation", variant: "destructive" });
      return;
    }
    toast({ title: "Designation created" });
    setShowDialog(false);
    setForm({ title: "", departmentId: "", level: "" });
    queryClient.invalidateQueries({ queryKey: getListDesignationsQueryKey() });
  }

  async function handleDelete(id: number) {
    try {
      await deleteMutation.mutateAsync(id);
    } catch {
      toast({ title: "Failed to delete designation", variant: "destructive" });
      return;
    }
    toast({ title: "Designation deleted" });
    queryClient.invalidateQueries({ queryKey: getListDesignationsQueryKey() });
  }

  return (
    <HrLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Designations</h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              Manage job titles and assign employees — click a card to expand
            </p>
          </div>
          <Button onClick={() => setShowDialog(true)} className="gap-2 self-start sm:self-auto">
            <Plus size={16} /> New Designation
          </Button>
        </div>

        {/* Search */}
        <div className="relative max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search designations…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 gap-3 max-w-xs">
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Total</p>
              <p className="text-2xl font-black text-indigo-600 mt-0.5">{designations?.length ?? 0}</p>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Showing</p>
              <p className="text-2xl font-black text-gray-700 mt-0.5">{filtered.length}</p>
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
                  <Skeleton className="h-4 w-32" />
                </CardContent>
              </Card>
            ))
          ) : filtered.length === 0 ? (
            <Card className="border-0 shadow-sm">
              <CardContent className="p-10 flex flex-col items-center text-center">
                <Briefcase size={32} className="text-muted-foreground/30 mb-3" />
                <p className="font-semibold text-gray-700">
                  {search ? "No designations match your search" : "No designations yet"}
                </p>
                {!search && (
                  <p className="text-sm text-muted-foreground mt-1">
                    Create your first designation to get started.
                  </p>
                )}
              </CardContent>
            </Card>
          ) : (
            filtered.map((d) => (
              <DesigCard key={d.id} desig={d as any} onDelete={handleDelete} />
            ))
          )}
        </div>
      </div>

      {/* Create Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Designation</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="des-title">Title <span className="text-red-500">*</span></Label>
              <Input
                id="des-title"
                placeholder="e.g. Senior Tailor"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="des-dept">Department</Label>
              <select
                id="des-dept"
                value={form.departmentId}
                onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value }))}
                className="w-full h-9 rounded-md border px-3 text-sm bg-background"
              >
                <option value="">— No department —</option>
                {(departments ?? []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="des-level">Level</Label>
              <Input
                id="des-level"
                placeholder="e.g. Manager, Executive, Operator"
                value={form.level}
                onChange={(e) => setForm((f) => ({ ...f, level: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating…" : "Create Designation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}

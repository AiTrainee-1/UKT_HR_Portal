import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  useListShifts, useCreateShift, useUpdateShift, useDeleteShift,
  getListShiftsQueryKey, useListDepartments, useListDesignations,
  type ShiftTemplate,
} from "@/lib/api-client";
import {
  useBulkAssignShift, useSearchEmployees, useListShiftAssignments,
  useDeleteShiftAssignment, getShiftAssignmentsQueryKey,
  useSyncProductionShifts,
  type ShiftAssignment,
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import {
  Clock, Plus, Edit, Trash2, Users, Factory, AlertCircle,
  User, UserPlus, Building2, Briefcase, Search, CheckCircle2, Zap,
  ChevronDown, ChevronRight, UserMinus, Calendar, Timer, RefreshCw,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function genderBadge(rule: string | null | undefined) {
  if (!rule || rule === "all") return null;
  return (
    <Badge variant="secondary" className="text-xs capitalize">{rule} only</Badge>
  );
}

function typeBadge(type: string | null | undefined) {
  if (type === "production")
    return <Badge className="text-xs bg-amber-100 text-amber-700 border-amber-200">Production</Badge>;
  if (type === "staff")
    return <Badge className="text-xs bg-green-100 text-green-700 border-green-200">Staff</Badge>;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shift card (template list)
// ─────────────────────────────────────────────────────────────────────────────
function ShiftCard({ shift, onEdit, onDelete }: {
  shift: ShiftTemplate; onEdit: () => void; onDelete: () => void;
}) {
  return (
    <Card className="border hover:shadow-md transition-shadow">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h4 className="font-bold text-gray-900 text-sm">{shift.name}</h4>
              {shift.isDefault && <Badge className="text-xs bg-blue-50 text-blue-700 border-blue-200">Default</Badge>}
              {genderBadge(shift.genderRule)}
            </div>
            <div className="flex items-center gap-3 text-sm text-gray-600 mt-1 flex-wrap">
              <span className="flex items-center gap-1"><Clock size={13} />{shift.startTime} – {shift.endTime}</span>
              <span className="text-gray-300">|</span>
              <span className="text-xs">Grace: {shift.gracePeriodMinutes}min</span>
              {shift.departmentName && (<><span className="text-gray-300">|</span><span className="text-xs text-muted-foreground">{shift.departmentName}</span></>)}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="icon" onClick={onEdit} className="h-8 w-8 text-gray-400 hover:text-gray-700"><Edit size={14} /></Button>
            <Button variant="ghost" size="icon" onClick={onDelete} className="h-8 w-8 text-red-400 hover:text-red-600"><Trash2 size={14} /></Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Assigned shifts tab — grouped expandable cards
// ─────────────────────────────────────────────────────────────────────────────

type AssignedGroup = {
  shiftId: number;
  shiftName: string;
  shiftType: string;
  startTime: string;
  endTime: string;
  genderRule: string;
  gracePeriodMinutes: number;
  members: ShiftAssignment[];
};

function groupAssignments(assignments: ShiftAssignment[]): AssignedGroup[] {
  const map = new Map<number, AssignedGroup>();
  for (const a of assignments) {
    if (!a.shiftId) continue;
    if (!map.has(a.shiftId)) {
      map.set(a.shiftId, {
        shiftId: a.shiftId,
        shiftName: a.shiftName ?? `Shift #${a.shiftId}`,
        shiftType: a.shiftType ?? "staff",
        startTime: a.startTime ?? "",
        endTime: a.endTime ?? "",
        genderRule: a.genderRule ?? "all",
        gracePeriodMinutes: a.gracePeriodMinutes ?? 0,
        members: [],
      });
    }
    map.get(a.shiftId)!.members.push(a);
  }
  return Array.from(map.values()).sort((a, b) => a.shiftName.localeCompare(b.shiftName));
}

function AssignedGroupCard({ group, onRemove }: {
  group: AssignedGroup;
  onRemove: (assignmentId: number, empName: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [empSearch, setEmpSearch] = useState("");

  const filtered = group.members.filter((m) => {
    const q = empSearch.toLowerCase();
    return (
      m.employeeName.toLowerCase().includes(q) ||
      m.employeeCode.toLowerCase().includes(q) ||
      (m.departmentName ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <Card className="border-0 shadow-sm hover:shadow-md transition-shadow">
      <CardContent className="p-0">
        {/* Header */}
        <div
          className="flex items-center gap-4 p-4 cursor-pointer select-none"
          onClick={() => setExpanded((v) => !v)}
        >
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: group.shiftType === "production"
                ? "linear-gradient(135deg, #f59e0b, #ef4444)"
                : "linear-gradient(135deg, #22c55e, #16a34a)",
            }}
          >
            {group.shiftType === "production" ? (
              <Factory size={18} className="text-white" />
            ) : (
              <Users size={18} className="text-white" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-bold text-gray-900">{group.shiftName}</p>
              {typeBadge(group.shiftType)}
              {genderBadge(group.genderRule)}
            </div>
            <div className="flex items-center gap-4 mt-0.5 text-xs text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1"><Clock size={11} />{group.startTime} – {group.endTime}</span>
              <span className="flex items-center gap-1"><Timer size={11} />Grace: {group.gracePeriodMinutes}min</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <Badge variant="secondary" className="gap-1.5 text-sm font-bold">
              <Users size={12} />{group.members.length}
            </Badge>
            {expanded
              ? <ChevronDown size={16} className="text-gray-400" />
              : <ChevronRight size={16} className="text-gray-400" />}
          </div>
        </div>

        {/* Expanded employee list */}
        {expanded && (
          <div className="border-t px-4 pb-4 pt-3">
            {/* Shift detail strip */}
            <div className="grid grid-cols-3 gap-3 mb-4 p-3 rounded-lg bg-gray-50">
              <div>
                <p className="text-xs text-muted-foreground">Shift Hours</p>
                <p className="text-sm font-bold">{group.startTime} – {group.endTime}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Grace Period</p>
                <p className="text-sm font-bold">{group.gracePeriodMinutes} minutes</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Type</p>
                <p className="text-sm font-bold capitalize">{group.shiftType}</p>
              </div>
            </div>

            {/* Search within group */}
            {group.members.length > 5 && (
              <div className="relative mb-3">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input
                  className="pl-8 h-8 text-xs"
                  placeholder="Filter employees…"
                  value={empSearch}
                  onChange={(e) => setEmpSearch(e.target.value)}
                />
              </div>
            )}

            {/* Employee rows */}
            <div className="space-y-1.5">
              {filtered.length === 0 ? (
                <p className="text-xs text-center text-muted-foreground py-4">No employees match</p>
              ) : (
                filtered.map((emp) => (
                  <div
                    key={emp.id}
                    className="flex items-center justify-between gap-3 py-2 px-2 rounded-lg hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                        {emp.employeeName.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800 truncate">{emp.employeeName}</p>
                        <p className="text-xs text-gray-400 truncate">
                          {emp.employeeCode}
                          {emp.departmentName ? ` · ${emp.departmentName}` : ""}
                          {emp.designationTitle ? ` · ${emp.designationTitle}` : ""}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-right hidden sm:block">
                        <p className="text-xs text-muted-foreground">Since</p>
                        <p className="text-xs font-medium">{emp.effectiveFrom}</p>
                      </div>
                      {emp.employmentType === "production" ? (
                        <Badge className="text-xs bg-amber-100 text-amber-700 border-amber-200 hidden sm:flex">Production</Badge>
                      ) : (
                        <Badge className="text-xs bg-green-100 text-green-700 border-green-200 hidden sm:flex">Staff</Badge>
                      )}
                      {emp.gender && (
                        <Badge variant="outline" className="text-xs capitalize hidden md:flex">{emp.gender}</Badge>
                      )}
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost" size="icon"
                            className="h-7 w-7 text-gray-300 hover:text-red-500 hover:bg-red-50"
                            title="Remove from shift"
                          >
                            <UserMinus size={13} />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove from shift?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Remove <strong>{emp.employeeName}</strong> from <strong>{group.shiftName}</strong>?
                              They will have no active shift until reassigned.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => onRemove(emp.id, emp.employeeName)}
                              className="bg-red-600 hover:bg-red-700"
                            >Remove</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AssignedShiftsTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filterType, setFilterType] = useState<"all" | "production" | "staff">("all");
  const [globalSearch, setGlobalSearch] = useState("");

  const { data: assignments, isLoading } = useListShiftAssignments({ activeOnly: true });
  const deleteMutation = useDeleteShiftAssignment();

  const handleRemove = async (assignmentId: number, empName: string) => {
    try {
      await deleteMutation.mutateAsync(assignmentId);
    } catch {
      toast({ title: "Failed to remove assignment", variant: "destructive" });
      return;
    }
    toast({ title: `${empName} removed from shift` });
    queryClient.invalidateQueries({ queryKey: getShiftAssignmentsQueryKey() });
  };

  const allAssignments = assignments ?? [];
  // Filter by the employee's employment type, not the shift template's type.
  // A production employee assigned to any shift should appear under "Production".
  const byType = filterType === "all"
    ? allAssignments
    : allAssignments.filter((a) => (a.employmentType ?? "staff") === filterType);
  const bySearch = globalSearch
    ? byType.filter((a) =>
        a.employeeName.toLowerCase().includes(globalSearch.toLowerCase()) ||
        a.employeeCode.toLowerCase().includes(globalSearch.toLowerCase()) ||
        (a.shiftName ?? "").toLowerCase().includes(globalSearch.toLowerCase())
      )
    : byType;

  const groups = groupAssignments(bySearch);
  const prodCount = allAssignments.filter((a) => (a.employmentType ?? "staff") === "production").length;
  const staffCount = allAssignments.filter((a) => (a.employmentType ?? "staff") === "staff").length;

  return (
    <div className="space-y-5">
      {/* Summary pills */}
      <div className="flex items-center gap-3 flex-wrap">
        {(
          [
            { key: "all", label: "All Assignments", count: allAssignments.length, color: "bg-gray-100 text-gray-700" },
            { key: "production", label: "Production", count: prodCount, color: "bg-amber-100 text-amber-700" },
            { key: "staff", label: "Staff", count: staffCount, color: "bg-green-100 text-green-700" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setFilterType(t.key)}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-semibold transition-all border-2 ${
              filterType === t.key
                ? "border-gray-900 shadow-sm"
                : "border-transparent hover:border-gray-200"
            } ${t.color}`}
          >
            {t.label}
            <span className="text-xs font-bold opacity-70">{t.count}</span>
          </button>
        ))}

        <div className="relative ml-auto">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            className="pl-8 h-8 w-52 text-xs"
            placeholder="Search employee or shift…"
            value={globalSearch}
            onChange={(e) => setGlobalSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Groups */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="border-0 shadow-sm">
              <CardContent className="p-4 flex items-center gap-4">
                <Skeleton className="h-11 w-11 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-60" />
                </div>
                <Skeleton className="h-7 w-12 rounded-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : groups.length === 0 ? (
        <Card className="border-0 shadow-sm">
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Users size={36} className="text-muted-foreground/30 mb-3" />
            <p className="font-semibold text-gray-700">
              {globalSearch || filterType !== "all"
                ? "No assignments match your filters"
                : "No active shift assignments yet"}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {!(globalSearch || filterType !== "all") &&
                "Use the Production or Staff tab to create shifts and assign employees."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <AssignedGroupCard key={g.shiftId} group={g} onRemove={handleRemove} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Assign dialogs
// ─────────────────────────────────────────────────────────────────────────────

function AssignIndividualDialog({ staffShifts, onClose }: { staffShifts: ShiftTemplate[]; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [shiftId, setShiftId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [search, setSearch] = useState("");
  const [selectedEmpId, setSelectedEmpId] = useState<number | null>(null);
  const [selectedEmpName, setSelectedEmpName] = useState("");
  const { data: results, isFetching } = useSearchEmployees(search);
  const bulkMutation = useBulkAssignShift();

  const filteredResults = (results ?? []).filter((e) => e.employmentType !== "production");

  const assign = async () => {
    if (!shiftId || !selectedEmpId || !effectiveFrom) {
      toast({ title: "Select a shift, employee, and effective date", variant: "destructive" }); return;
    }
    let res: { assigned: number; shiftName: string } | null = null;
    try {
      res = await bulkMutation.mutateAsync({ shiftId: Number(shiftId), effectiveFrom, employeeIds: [selectedEmpId] });
    } catch {
      toast({ title: "Failed to assign shift", variant: "destructive" });
      return;
    }
    toast({ title: `${selectedEmpName} assigned to ${res!.shiftName}` });
    queryClient.invalidateQueries({ queryKey: getShiftAssignmentsQueryKey() });
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Assign Shift — Individual Employee</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Shift</Label>
            <select value={shiftId} onChange={(e) => setShiftId(e.target.value)} className="w-full h-9 rounded-md border px-3 text-sm bg-background">
              <option value="">— Select Shift —</option>
              {staffShifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.startTime}–{s.endTime})</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Effective From</Label>
            <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Search Employee (ID or Phone)</Label>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input className="pl-9" placeholder="e.g. EMP001 or 9876543210" value={search}
                onChange={(e) => { setSearch(e.target.value); setSelectedEmpId(null); setSelectedEmpName(""); }} />
            </div>
            {search.length < 2 && !selectedEmpId && <p className="text-xs text-muted-foreground">Type at least 2 characters</p>}
          </div>
          {selectedEmpId ? (
            <div className="flex items-center gap-2 p-2 rounded-lg bg-green-50 border border-green-200">
              <CheckCircle2 size={16} className="text-green-600 shrink-0" />
              <p className="text-sm font-semibold text-green-800">{selectedEmpName} selected</p>
              <button className="ml-auto text-xs text-green-600 underline" onClick={() => { setSelectedEmpId(null); setSelectedEmpName(""); setSearch(""); }}>Change</button>
            </div>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {isFetching && <p className="text-xs text-center text-muted-foreground py-3">Searching…</p>}
              {!isFetching && search.length >= 2 && filteredResults.length === 0 && <p className="text-xs text-center text-muted-foreground py-3">No staff employees found</p>}
              {filteredResults.map((emp) => (
                <div key={emp.id} className="flex items-center justify-between gap-3 p-2.5 rounded-lg border hover:bg-gray-50 cursor-pointer"
                  onClick={() => { setSelectedEmpId(emp.id); setSelectedEmpName(`${emp.firstName} ${emp.lastName}`); }}>
                  <div>
                    <p className="font-semibold text-sm">{emp.firstName} {emp.lastName}</p>
                    <p className="text-xs text-gray-400">{emp.employeeCode} · {emp.phone ?? "—"}</p>
                  </div>
                  <Button size="sm" variant="outline" className="h-6 text-xs">Select</Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={assign} disabled={bulkMutation.isPending || !selectedEmpId || !shiftId}>
            {bulkMutation.isPending ? "Assigning…" : "Assign Shift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssignDepartmentDialog({ staffShifts, onClose }: { staffShifts: ShiftTemplate[]; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [shiftId, setShiftId] = useState("");
  const [deptId, setDeptId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const { data: departments } = useListDepartments();
  const bulkMutation = useBulkAssignShift();

  const assign = async () => {
    if (!shiftId || !deptId || !effectiveFrom) { toast({ title: "Fill all fields", variant: "destructive" }); return; }
    let res: { assigned: number; shiftName: string } | null = null;
    try {
      res = await bulkMutation.mutateAsync({ shiftId: Number(shiftId), effectiveFrom, departmentId: Number(deptId) });
    } catch { toast({ title: "Failed to assign shift", variant: "destructive" }); return; }
    toast({ title: `${res!.assigned} employee${res!.assigned !== 1 ? "s" : ""} assigned to ${res!.shiftName}` });
    queryClient.invalidateQueries({ queryKey: getShiftAssignmentsQueryKey() });
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Assign Shift — Department-wide</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground">All employees in the selected department (both staff and production) will be moved to this shift.</p>
          <div className="space-y-1.5">
            <Label>Department</Label>
            <select value={deptId} onChange={(e) => setDeptId(e.target.value)} className="w-full h-9 rounded-md border px-3 text-sm bg-background">
              <option value="">— Select Department —</option>
              {(departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Shift</Label>
            <select value={shiftId} onChange={(e) => setShiftId(e.target.value)} className="w-full h-9 rounded-md border px-3 text-sm bg-background">
              <option value="">— Select Shift —</option>
              {staffShifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.startTime}–{s.endTime})</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Effective From</Label>
            <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={assign} disabled={bulkMutation.isPending || !deptId || !shiftId}>{bulkMutation.isPending ? "Assigning…" : "Assign to Department"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssignDesignationDialog({ staffShifts, onClose }: { staffShifts: ShiftTemplate[]; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [shiftId, setShiftId] = useState("");
  const [desigId, setDesigId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const { data: designations } = useListDesignations();
  const bulkMutation = useBulkAssignShift();

  const assign = async () => {
    if (!shiftId || !desigId || !effectiveFrom) { toast({ title: "Fill all fields", variant: "destructive" }); return; }
    let res: { assigned: number; shiftName: string } | null = null;
    try {
      res = await bulkMutation.mutateAsync({ shiftId: Number(shiftId), effectiveFrom, designationId: Number(desigId) });
    } catch { toast({ title: "Failed to assign shift", variant: "destructive" }); return; }
    toast({ title: `${res!.assigned} employee${res!.assigned !== 1 ? "s" : ""} assigned to ${res!.shiftName}` });
    queryClient.invalidateQueries({ queryKey: getShiftAssignmentsQueryKey() });
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Assign Shift — Designation-wide</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground">All employees with the selected designation (both staff and production) will be moved to this shift.</p>
          <div className="space-y-1.5">
            <Label>Designation</Label>
            <select value={desigId} onChange={(e) => setDesigId(e.target.value)} className="w-full h-9 rounded-md border px-3 text-sm bg-background">
              <option value="">— Select Designation —</option>
              {(designations ?? []).map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Shift</Label>
            <select value={shiftId} onChange={(e) => setShiftId(e.target.value)} className="w-full h-9 rounded-md border px-3 text-sm bg-background">
              <option value="">— Select Shift —</option>
              {staffShifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.startTime}–{s.endTime})</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Effective From</Label>
            <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={assign} disabled={bulkMutation.isPending || !desigId || !shiftId}>{bulkMutation.isPending ? "Assigning…" : "Assign to Designation"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProductionAutoAssignDialog({ shift, onClose }: { shift: ShiftTemplate; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const bulkMutation = useBulkAssignShift();

  const apply = async () => {
    if (!effectiveFrom) { toast({ title: "Select an effective date", variant: "destructive" }); return; }
    let res: { assigned: number; shiftName: string } | null = null;
    try {
      res = await bulkMutation.mutateAsync({ shiftId: shift.id, effectiveFrom, employmentType: "production", genderRule: shift.genderRule as "all" | "male" | "female" });
    } catch { toast({ title: "Failed to apply shift", variant: "destructive" }); return; }
    toast({ title: `Applied to ${res!.assigned} production employee${res!.assigned !== 1 ? "s" : ""}`, description: `${res!.shiftName} active from ${effectiveFrom}.` });
    queryClient.invalidateQueries({ queryKey: getShiftAssignmentsQueryKey() });
    onClose();
  };

  const genderLabel = shift.genderRule === "male" ? "male" : shift.genderRule === "female" ? "female" : "all";

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Apply to Production Employees</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
            <p className="font-semibold mb-1">Shift: {shift.name}</p>
            <p>{shift.startTime} – {shift.endTime} · Gender rule: <strong className="capitalize">{genderLabel}</strong></p>
            <p className="mt-1.5 text-xs">All active production employees{genderLabel !== "all" ? ` (${genderLabel} only)` : ""} will be assigned to this shift. Previous assignments will be ended.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Effective From</Label>
            <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} autoFocus />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={apply} disabled={bulkMutation.isPending} className="gap-2">
            <Zap size={14} />{bulkMutation.isPending ? "Applying…" : "Apply to Production Employees"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

type StaffAssignMode = "individual" | "department" | "designation";

export default function ManageShift() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"production" | "staff" | "assigned">("production");
  const [showDialog, setShowDialog] = useState(false);
  const [editingShift, setEditingShift] = useState<ShiftTemplate | null>(null);
  const [form, setForm] = useState({ name: "", shiftType: "production", startTime: "09:00", endTime: "17:30", genderRule: "all", gracePeriodMinutes: 15 });

  const [staffAssignMode, setStaffAssignMode] = useState<StaffAssignMode>("individual");
  const [showAssignIndividual, setShowAssignIndividual] = useState(false);
  const [showAssignDept, setShowAssignDept] = useState(false);
  const [showAssignDesig, setShowAssignDesig] = useState(false);
  const [autoAssignShift, setAutoAssignShift] = useState<ShiftTemplate | null>(null);

  const { data: shifts, isLoading } = useListShifts();
  const createMutation = useCreateShift();
  const updateMutation = useUpdateShift();
  const deleteMutation = useDeleteShift();
  const syncMutation = useSyncProductionShifts();

  const productionShifts = (shifts ?? []).filter((s) => s.shiftType === "production");
  const staffShifts = (shifts ?? []).filter((s) => s.shiftType === "staff");

  const handleSyncProduction = async () => {
    let res: { synced: number; skipped: number } | null = null;
    try {
      res = await syncMutation.mutateAsync();
    } catch {
      toast({ title: "Sync failed", variant: "destructive" });
      return;
    }
    if (res.synced === 0) {
      toast({ title: "All production employees already have shifts assigned" });
    } else {
      toast({ title: `${res.synced} production employee${res.synced !== 1 ? "s" : ""} synced to shifts` });
    }
    queryClient.invalidateQueries({ queryKey: getShiftAssignmentsQueryKey() });
  };

  const openCreate = () => {
    setEditingShift(null);
    const defaultType = activeTab === "assigned" ? "staff" : activeTab;
    setForm({ name: "", shiftType: defaultType, startTime: "09:00", endTime: "17:30", genderRule: "all", gracePeriodMinutes: 15 });
    setShowDialog(true);
  };

  const openEdit = (shift: ShiftTemplate) => {
    setEditingShift(shift);
    setForm({ name: shift.name, shiftType: shift.shiftType, startTime: shift.startTime ?? "09:00", endTime: shift.endTime ?? "17:30", genderRule: shift.genderRule, gracePeriodMinutes: shift.gracePeriodMinutes });
    setShowDialog(true);
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteMutation.mutateAsync(id);
    } catch {
      toast({ title: "Failed to delete shift", variant: "destructive" });
      return;
    }
    toast({ title: "Shift deleted" });
    queryClient.invalidateQueries({ queryKey: getListShiftsQueryKey() });
  };

  const handleSave = async () => {
    if (!form.name) { toast({ title: "Shift name is required", variant: "destructive" }); return; }
    try {
      if (editingShift) {
        await updateMutation.mutateAsync({ id: editingShift.id, data: { name: form.name, shiftType: form.shiftType, startTime: form.startTime, endTime: form.endTime, genderRule: form.genderRule, gracePeriodMinutes: form.gracePeriodMinutes } });
      } else {
        await createMutation.mutateAsync({ name: form.name, shiftType: form.shiftType, startTime: form.startTime, endTime: form.endTime, genderRule: form.genderRule, gracePeriodMinutes: form.gracePeriodMinutes });
      }
    } catch {
      toast({ title: "Failed to save shift", variant: "destructive" });
      return;
    }
    // Mutation succeeded — close dialog and toast before invalidating so a slow
    // refetch never triggers a false "failed" state.
    toast({ title: editingShift ? "Shift updated" : "Shift created" });
    setShowDialog(false);
    queryClient.invalidateQueries({ queryKey: getListShiftsQueryKey() });
  };

  const staffAssignModes: { key: StaffAssignMode; label: string; icon: React.ReactNode; desc: string }[] = [
    { key: "individual", label: "Individual", icon: <User size={14} />, desc: "One employee at a time" },
    { key: "department", label: "Department", icon: <Building2 size={14} />, desc: "All staff in a dept" },
    { key: "designation", label: "Designation", icon: <Briefcase size={14} />, desc: "All with a designation" },
  ];

  const handleStaffAssign = () => {
    if (staffAssignMode === "individual") setShowAssignIndividual(true);
    else if (staffAssignMode === "department") setShowAssignDept(true);
    else setShowAssignDesig(true);
  };

  return (
    <HrLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Manage Shifts</h2>
            <p className="text-muted-foreground text-sm mt-0.5">Configure shift templates and assign them to employees</p>
          </div>
          <Button onClick={openCreate} className="gap-2"><Plus size={16} /> New Shift</Button>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="border-0 shadow-sm"><CardContent className="p-4"><Skeleton className="h-5 w-48 mb-2" /><Skeleton className="h-4 w-64" /></CardContent></Card>
            ))}
          </div>
        ) : (
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
            <TabsList className="bg-gray-100">
              <TabsTrigger value="production" className="gap-2">
                <Factory size={14} /> Production ({productionShifts.length})
              </TabsTrigger>
              <TabsTrigger value="staff" className="gap-2">
                <Users size={14} /> Staff ({staffShifts.length})
              </TabsTrigger>
              <TabsTrigger value="assigned" className="gap-2">
                <Calendar size={14} /> Assigned Shifts
              </TabsTrigger>
            </TabsList>

            {/* ── Production Tab ── */}
            <TabsContent value="production" className="mt-4 space-y-4">
              <Card className="border-0 shadow-sm bg-blue-50/60">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <AlertCircle size={16} className="text-blue-600 mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                        <p className="text-sm font-bold text-blue-900">Default Gender-Based Shift Rules — Production Only</p>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1.5 border-blue-300 text-blue-700 hover:bg-blue-50"
                          onClick={handleSyncProduction}
                          disabled={syncMutation.isPending || productionShifts.length === 0}
                          title="Assign shifts to any production employees not yet covered"
                        >
                          <RefreshCw size={12} className={syncMutation.isPending ? "animate-spin" : ""} />
                          {syncMutation.isPending ? "Syncing…" : "Sync Unassigned"}
                        </Button>
                      </div>
                      <p className="text-xs text-blue-700 mb-3">
                        New production employees are <strong>assigned automatically</strong> when added.
                        Use <strong>Apply</strong> on a shift for the initial rollout.
                        Use <strong>Sync Unassigned</strong> anytime to catch any employees missed — no date prompt required.
                      </p>
                      <div className="grid sm:grid-cols-2 gap-3">
                        <div className="bg-white rounded-lg p-3 border border-blue-100">
                          <div className="flex items-center gap-2 mb-1"><User size={14} className="text-blue-600" /><span className="text-xs font-bold text-blue-800">Male Production Employees</span></div>
                          <p className="text-sm font-mono font-bold text-gray-800">09:00 AM – 08:00 PM</p>
                        </div>
                        <div className="bg-white rounded-lg p-3 border border-pink-100">
                          <div className="flex items-center gap-2 mb-1"><User size={14} className="text-pink-600" /><span className="text-xs font-bold text-pink-800">Female Production Employees</span></div>
                          <p className="text-sm font-mono font-bold text-gray-800">09:00 AM – 07:00 PM</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-100">
                <AlertCircle size={14} className="text-amber-600 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-700">Production employees are paid <strong>bi-weekly</strong>. Session-based pay is applied based on shift completion.</p>
              </div>

              {productionShifts.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">No production shifts yet. Click <strong>New Shift</strong> and choose "Production".</div>
              ) : (
                <div className="space-y-3">
                  {productionShifts.map((shift) => (
                    <div key={shift.id} className="relative">
                      <ShiftCard shift={shift} onEdit={() => openEdit(shift)} onDelete={() => handleDelete(shift.id)} />
                      <div className="absolute top-3 right-20">
                        <Button size="sm" variant="outline"
                          className="h-7 text-xs gap-1.5 border-amber-300 text-amber-700 hover:bg-amber-50"
                          onClick={() => setAutoAssignShift(shift)} title="Apply to all matching production employees">
                          <Zap size={12} /> Apply
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            {/* ── Staff Tab ── */}
            <TabsContent value="staff" className="mt-4 space-y-4">
              <Card className="border-0 shadow-sm bg-green-50/40">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-bold text-green-900 flex items-center gap-2">
                    <UserPlus size={15} className="text-green-700" /> Allocate Staff Shifts
                  </CardTitle>
                  <p className="text-xs text-green-700 mt-0.5">Staff shifts are customized per employee, department, or designation.</p>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="grid grid-cols-3 gap-2 mb-4">
                    {staffAssignModes.map((m) => (
                      <button key={m.key} onClick={() => setStaffAssignMode(m.key)}
                        className={`p-3 rounded-lg border-2 text-left transition-all ${staffAssignMode === m.key ? "border-green-600 bg-white shadow-sm" : "border-transparent bg-white/60 hover:border-green-200"}`}>
                        <div className={`flex items-center gap-1.5 font-semibold text-xs mb-1 ${staffAssignMode === m.key ? "text-green-800" : "text-gray-700"}`}>
                          {m.icon} {m.label}
                        </div>
                        <p className="text-xs text-muted-foreground leading-tight">{m.desc}</p>
                      </button>
                    ))}
                  </div>
                  <Button className="w-full gap-2 bg-green-700 hover:bg-green-800" onClick={handleStaffAssign} disabled={staffShifts.length === 0}>
                    <UserPlus size={14} />
                    {staffShifts.length === 0 ? "Create a staff shift first" :
                      staffAssignMode === "individual" ? "Assign to Individual Employee" :
                        staffAssignMode === "department" ? "Assign by Department" : "Assign by Designation"}
                  </Button>
                </CardContent>
              </Card>

              <Separator />
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Staff Shift Templates</p>
              <div className="flex items-start gap-2 p-3 rounded-lg bg-green-50 border border-green-100">
                <AlertCircle size={14} className="text-green-700 mt-0.5" />
                <p className="text-xs text-green-700">Staff employees are paid <strong>monthly</strong>. Shifts can be customized individually, by department, or by designation.</p>
              </div>
              {staffShifts.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">No staff shifts yet. Click <strong>New Shift</strong> and choose "Staff".</div>
              ) : (
                <div className="space-y-3">
                  {staffShifts.map((shift) => (
                    <ShiftCard key={shift.id} shift={shift} onEdit={() => openEdit(shift)} onDelete={() => handleDelete(shift.id)} />
                  ))}
                </div>
              )}
            </TabsContent>

            {/* ── Assigned Shifts Tab ── */}
            <TabsContent value="assigned" className="mt-4">
              <AssignedShiftsTab />
            </TabsContent>
          </Tabs>
        )}

        {/* Shift create/edit dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>{editingShift ? "Edit Shift" : "Create New Shift"}</DialogTitle></DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>Shift Name</Label>
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Morning Shift (Male)" autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Shift Type</Label>
                  <select value={form.shiftType} onChange={(e) => setForm((f) => ({ ...f, shiftType: e.target.value }))} className="w-full h-9 rounded-md border px-3 text-sm bg-background">
                    <option value="production">Production</option>
                    <option value="staff">Staff</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>Gender Rule</Label>
                  <select value={form.genderRule} onChange={(e) => setForm((f) => ({ ...f, genderRule: e.target.value }))} className="w-full h-9 rounded-md border px-3 text-sm bg-background">
                    <option value="all">All Genders</option>
                    <option value="male">Male Only</option>
                    <option value="female">Female Only</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Start Time</Label>
                  <Input type="time" value={form.startTime} onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>End Time</Label>
                  <Input type="time" value={form.endTime} onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Grace Period (minutes)</Label>
                <Input type="number" value={form.gracePeriodMinutes} onChange={(e) => setForm((f) => ({ ...f, gracePeriodMinutes: Number(e.target.value) }))} min={0} max={60} />
              </div>
              <div className="flex gap-3 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => setShowDialog(false)}>Cancel</Button>
                <Button className="flex-1" onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending}>
                  {editingShift ? "Update Shift" : "Create Shift"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Assignment dialogs */}
        {showAssignIndividual && <AssignIndividualDialog staffShifts={staffShifts} onClose={() => setShowAssignIndividual(false)} />}
        {showAssignDept && <AssignDepartmentDialog staffShifts={staffShifts} onClose={() => setShowAssignDept(false)} />}
        {showAssignDesig && <AssignDesignationDialog staffShifts={staffShifts} onClose={() => setShowAssignDesig(false)} />}
        {autoAssignShift && <ProductionAutoAssignDialog shift={autoAssignShift} onClose={() => setAutoAssignShift(null)} />}
      </div>
    </HrLayout>
  );
}

import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useListEmployees, useListDepartments } from "@/lib/api-client";
import {
  useListDesignations, useListPromotions, useCreatePromotion, useDeletePromotion,
  type PromotionItem,
} from "@/lib/api-client/custom-hooks";
import {
  TrendingUp, Search, User, ArrowRight, Trash2, Award, Building2, X,
} from "lucide-react";

export default function Promotion() {
  const { toast } = useToast();
  const today = new Date().toISOString().slice(0, 10);

  const [input, setInput] = useState("");
  const [selectedEmpId, setSelectedEmpId] = useState<number | null>(null);
  const [form, setForm] = useState({
    newDepartmentId: "" as string,
    newDesignationId: "" as string,
    effectiveDate: today,
    notes: "",
  });

  const { data: employees } = useListEmployees({ status: "active" });
  const { data: departments } = useListDepartments();
  const { data: designations } = useListDesignations();
  const { data: allPromotions, isLoading: promosLoading } = useListPromotions();
  const { data: empPromotions } = useListPromotions(
    selectedEmpId ? { employeeId: selectedEmpId } : undefined,
  );
  const createMutation = useCreatePromotion();
  const deleteMutation = useDeletePromotion();

  const selectedEmp = (employees ?? []).find(e => e.id === selectedEmpId) ?? null;

  const suggestions = input.trim() && !selectedEmpId
    ? (employees ?? []).filter(e =>
        e.employeeCode.toLowerCase().includes(input.toLowerCase()) ||
        `${e.firstName} ${e.lastName}`.toLowerCase().includes(input.toLowerCase()),
      ).slice(0, 6)
    : [];

  const promote = async () => {
    if (!selectedEmp) return;
    if (!form.newDepartmentId && !form.newDesignationId) {
      toast({ title: "Select a new designation or department", variant: "destructive" });
      return;
    }
    try {
      await createMutation.mutateAsync({
        employeeId: selectedEmp.id,
        newDepartmentId: form.newDepartmentId ? Number(form.newDepartmentId) : undefined,
        newDesignationId: form.newDesignationId ? Number(form.newDesignationId) : undefined,
        effectiveDate: form.effectiveDate,
        notes: form.notes || undefined,
      });
      toast({ title: `${selectedEmp.firstName} promoted successfully` });
      setForm({ newDepartmentId: "", newDesignationId: "", effectiveDate: today, notes: "" });
    } catch (err: any) {
      toast({ title: err?.message ?? "Promotion failed", variant: "destructive" });
    }
  };

  const PromotionRow = ({ p, showEmployee }: { p: PromotionItem; showEmployee?: boolean }) => (
    <div className="flex items-center gap-3 p-3 border rounded-xl hover:bg-gray-50 transition-colors">
      <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center shrink-0">
        <Award size={14} className="text-emerald-600" />
      </div>
      <div className="flex-1 min-w-0">
        {showEmployee && (
          <p className="text-sm font-bold">{p.employeeName} <span className="text-xs text-gray-400 font-mono font-normal">{p.employeeCode}</span></p>
        )}
        <div className="flex items-center gap-2 text-xs flex-wrap mt-0.5">
          <span className="text-gray-500">
            {p.previousDesignation ?? "—"}{p.previousDepartment ? ` · ${p.previousDepartment}` : ""}
          </span>
          <ArrowRight size={11} className="text-emerald-500 shrink-0" />
          <span className="font-semibold text-gray-800">
            {p.newDesignation ?? "—"}{p.newDepartment ? ` · ${p.newDepartment}` : ""}
          </span>
        </div>
        {p.notes && <p className="text-[11px] text-gray-400 mt-0.5 truncate">{p.notes}</p>}
      </div>
      <div className="text-right shrink-0">
        <p className="text-xs font-semibold text-gray-700">{p.effectiveDate}</p>
        {p.promotedBy && <p className="text-[10px] text-gray-400">by {p.promotedBy}</p>}
      </div>
      <button
        onClick={async () => {
          try {
            await deleteMutation.mutateAsync(p.id);
            toast({ title: "Promotion record deleted" });
          } catch {
            toast({ title: "Delete failed", variant: "destructive" });
          }
        }}
        className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 shrink-0"
        title="Delete record"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );

  return (
    <HrLayout>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-black text-gray-900">Promotion</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Promote employees, update designation/department, and track full promotion history
          </p>
        </div>

        {/* ── Search + Promote ── */}
        <Card className="border">
          <CardHeader className="pb-3 pt-4 px-4">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Search size={14} className="text-gray-400" /> Find Employee
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-4">
            <div className="relative max-w-md">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                className="pl-8"
                placeholder="Search by employee code or name…"
                value={input}
                onChange={e => { setInput(e.target.value); setSelectedEmpId(null); }}
              />
              {selectedEmpId && (
                <button
                  onClick={() => { setInput(""); setSelectedEmpId(null); }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X size={13} />
                </button>
              )}
              {suggestions.length > 0 && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border rounded-xl shadow-lg overflow-hidden">
                  {suggestions.map(emp => (
                    <button
                      key={emp.id}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-gray-50 text-left"
                      onMouseDown={e => {
                        e.preventDefault();
                        setSelectedEmpId(emp.id);
                        setInput(`${emp.employeeCode} — ${emp.firstName} ${emp.lastName}`);
                      }}
                    >
                      <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                        <User size={12} className="text-gray-400" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">{emp.firstName} {emp.lastName}</p>
                        <p className="text-xs text-gray-400 font-mono">{emp.employeeCode}{emp.departmentName ? ` · ${emp.departmentName}` : ""}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selectedEmp && (
              <div className="grid lg:grid-cols-2 gap-4">
                {/* Current position */}
                <div className="p-4 bg-gray-50 rounded-xl space-y-3">
                  <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Current Position</p>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
                      <User size={17} className="text-gray-500" />
                    </div>
                    <div>
                      <p className="font-bold text-sm">{selectedEmp.firstName} {selectedEmp.lastName}</p>
                      <p className="text-xs text-gray-400 font-mono">{selectedEmp.employeeCode}</p>
                    </div>
                    <Badge className="ml-auto text-xs bg-blue-50 text-blue-700 border border-blue-200 capitalize">
                      {selectedEmp.employmentType}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="p-2.5 bg-white border rounded-lg">
                      <p className="text-gray-400 mb-0.5">Designation</p>
                      <p className="font-bold text-gray-800">{selectedEmp.designationTitle ?? "—"}</p>
                    </div>
                    <div className="p-2.5 bg-white border rounded-lg">
                      <p className="text-gray-400 mb-0.5">Department</p>
                      <p className="font-bold text-gray-800">{selectedEmp.departmentName ?? "—"}</p>
                    </div>
                  </div>
                  {/* Employee's own promotion history */}
                  <div className="space-y-1.5">
                    <p className="text-xs font-bold uppercase tracking-wider text-gray-400">
                      History ({(empPromotions ?? []).length})
                    </p>
                    {(empPromotions ?? []).length === 0 ? (
                      <p className="text-xs text-gray-400">No previous promotions.</p>
                    ) : (
                      <div className="space-y-1.5 max-h-44 overflow-y-auto">
                        {(empPromotions ?? []).map(p => <PromotionRow key={p.id} p={p} />)}
                      </div>
                    )}
                  </div>
                </div>

                {/* Promote form */}
                <div className="p-4 border-2 border-emerald-100 bg-emerald-50/30 rounded-xl space-y-3">
                  <p className="text-xs font-bold uppercase tracking-wider text-emerald-600 flex items-center gap-1.5">
                    <TrendingUp size={13} /> Promote To
                  </p>
                  <div className="space-y-1.5">
                    <Label className="text-xs">New Designation</Label>
                    <select
                      value={form.newDesignationId}
                      onChange={e => setForm(f => ({ ...f, newDesignationId: e.target.value }))}
                      className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                    >
                      <option value="">— Keep current ({selectedEmp.designationTitle ?? "none"}) —</option>
                      {(designations ?? []).map(d => (
                        <option key={d.id} value={d.id}>{d.title}{d.departmentName ? ` (${d.departmentName})` : ""}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">New Department</Label>
                    <select
                      value={form.newDepartmentId}
                      onChange={e => setForm(f => ({ ...f, newDepartmentId: e.target.value }))}
                      className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                    >
                      <option value="">— Keep current ({selectedEmp.departmentName ?? "none"}) —</option>
                      {(departments ?? []).map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Effective Date</Label>
                      <Input
                        type="date"
                        value={form.effectiveDate}
                        onChange={e => setForm(f => ({ ...f, effectiveDate: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Notes</Label>
                      <Input
                        placeholder="Reason / remarks"
                        value={form.notes}
                        onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                      />
                    </div>
                  </div>
                  <Button
                    className="w-full gap-2 bg-emerald-600 hover:bg-emerald-700"
                    onClick={promote}
                    disabled={createMutation.isPending}
                  >
                    <Award size={14} />
                    {createMutation.isPending ? "Promoting…" : "Promote Employee"}
                  </Button>
                  <p className="text-[11px] text-emerald-700/70">
                    The employee's profile is updated immediately and the previous
                    designation/department is stored in the promotion history.
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── All promotions ── */}
        <Card className="border">
          <CardHeader className="pb-3 pt-4 px-4">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Building2 size={14} className="text-gray-400" /> Recent Promotions
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {promosLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
              </div>
            ) : (allPromotions ?? []).length === 0 ? (
              <p className="text-sm text-center text-muted-foreground py-8">No promotions recorded yet.</p>
            ) : (
              <div className="space-y-2">
                {(allPromotions ?? []).slice(0, 20).map(p => (
                  <PromotionRow key={p.id} p={p} showEmployee />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </HrLayout>
  );
}

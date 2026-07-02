import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useListDepartmentHeadcount,
  useSetDepartmentHeadcount,
  useUpdateDepartmentHeadcount,
  getListDepartmentHeadcountQueryKey,
  type DepartmentHeadcountItem,
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Building2,
  AlertTriangle,
  CheckCircle2,
  Pencil,
  Users,
  TrendingUp,
} from "lucide-react";

export default function RequiredRoles() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: departments, isLoading } = useListDepartmentHeadcount();
  const setHeadcount = useSetDepartmentHeadcount();
  const updateHeadcount = useUpdateDepartmentHeadcount();

  const [editTarget, setEditTarget] = useState<DepartmentHeadcountItem | null>(null);
  const [editCount, setEditCount] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const all = departments ?? [];
  const withVacancy = all.filter((d) => d.vacancy > 0);
  const fullyStaffed = all.filter((d) => d.requiredCount > 0 && d.vacancy === 0);
  const notConfigured = all.filter((d) => d.requiredCount === 0);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListDepartmentHeadcountQueryKey() });

  const openEdit = (dept: DepartmentHeadcountItem) => {
    setEditTarget(dept);
    setEditCount(String(dept.requiredCount));
    setEditNotes(dept.notes ?? "");
  };

  const handleSave = () => {
    if (!editTarget) return;
    const count = parseInt(editCount, 10);
    if (isNaN(count) || count < 0) {
      toast({ title: "Invalid count", variant: "destructive" });
      return;
    }

    const payload = { requiredCount: count, notes: editNotes || undefined };

    if (editTarget.id) {
      updateHeadcount.mutate(
        { id: editTarget.id, data: payload },
        {
          onSuccess: () => {
            toast({ title: "Headcount updated" });
            setEditTarget(null);
            refresh();
          },
          onError: () => toast({ title: "Update failed", variant: "destructive" }),
        }
      );
    } else {
      setHeadcount.mutate(
        { departmentId: editTarget.departmentId, ...payload },
        {
          onSuccess: () => {
            toast({ title: "Headcount set" });
            setEditTarget(null);
            refresh();
          },
          onError: () => toast({ title: "Save failed", variant: "destructive" }),
        }
      );
    }
  };

  return (
    <HrLayout>
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-black text-[#1a3a4a] tracking-tight">Required Roles</h1>
          <p className="text-sm text-[#006496]/60 mt-0.5">
            Set required headcount per department and track vacancies that need to be filled.
          </p>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            {
              label: "Departments with Vacancies",
              value: withVacancy.length,
              icon: AlertTriangle,
              color: "#ea580c",
              urgent: withVacancy.length > 0,
            },
            {
              label: "Fully Staffed",
              value: fullyStaffed.length,
              icon: CheckCircle2,
              color: "#059669",
            },
            {
              label: "Not Yet Configured",
              value: notConfigured.length,
              icon: Building2,
              color: "#64748b",
            },
          ].map(({ label, value, icon: Icon, color, urgent }) => (
            <Card
              key={label}
              className="rounded-2xl"
              style={{
                background: "#ffffff",
                boxShadow: "5px 5px 12px rgba(0,100,150,0.09), -3px -3px 9px rgba(255,255,255,0.9)",
                border: urgent ? "1.5px solid rgba(239,68,68,0.2)" : "1px solid rgba(0,100,150,0.06)",
              }}
            >
              <CardContent className="p-4 flex items-center gap-3">
                <div className="p-2.5 rounded-xl shrink-0" style={{ background: color + "18" }}>
                  <Icon className="w-5 h-5" style={{ color }} strokeWidth={1.8} />
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-[#006496]/50">{label}</p>
                  <p className="text-2xl font-black" style={{ color: urgent ? "#ea580c" : "#1a3a4a" }}>{value}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Vacancy Alerts */}
        {withVacancy.length > 0 && (
          <div
            className="rounded-2xl p-4"
            style={{
              background: "rgba(234,88,12,0.05)",
              border: "1.5px solid rgba(234,88,12,0.2)",
            }}
          >
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-orange-600" strokeWidth={2} />
              <span className="font-bold text-sm text-orange-800">
                Urgent: {withVacancy.length} department{withVacancy.length > 1 ? "s" : ""} need{withVacancy.length === 1 ? "s" : ""} recruitment
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {withVacancy.map((d) => (
                <div
                  key={d.departmentId}
                  className="flex items-center gap-2 bg-white rounded-xl px-3 py-1.5 border border-orange-100"
                >
                  <Building2 className="w-3.5 h-3.5 text-orange-500" strokeWidth={2} />
                  <span className="text-sm font-semibold text-orange-800">{d.departmentName}</span>
                  <Badge className="bg-red-50 text-red-600 border border-red-200 text-[10px]">
                    {d.vacancy} {d.vacancy === 1 ? "vacancy" : "vacancies"}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Main Table */}
        <Card
          className="rounded-2xl overflow-hidden"
          style={{
            background: "#ffffff",
            boxShadow: "6px 6px 14px rgba(0,100,150,0.08), -4px -4px 10px rgba(255,255,255,0.9)",
            border: "1px solid rgba(0,100,150,0.06)",
          }}
        >
          <div className="p-4 flex items-center gap-2 border-b border-[#006496]/06">
            <TrendingUp className="w-4 h-4 text-[#006496]" strokeWidth={1.8} />
            <span className="font-bold text-sm text-[#1a3a4a]">Department Headcount Configuration</span>
          </div>

          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-xl" />)}
            </div>
          ) : all.length === 0 ? (
            <div className="py-16 text-center text-[#006496]/40 text-sm">
              No departments found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow style={{ borderColor: "rgba(0,100,150,0.07)" }}>
                  <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">Department</TableHead>
                  <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <Users className="w-3 h-3" />
                      Current Staff
                    </div>
                  </TableHead>
                  <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50 text-center">Required</TableHead>
                  <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50 text-center">Vacancy</TableHead>
                  <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">Status</TableHead>
                  <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">Notes</TableHead>
                  <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {all.map((dept) => (
                  <TableRow
                    key={dept.departmentId}
                    style={{ borderColor: "rgba(0,100,150,0.05)" }}
                    className={`hover:bg-[#006496]/[0.02] ${dept.vacancy > 0 ? "bg-orange-50/40" : ""}`}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {dept.vacancy > 0 && (
                          <AlertTriangle className="w-3.5 h-3.5 text-orange-500 shrink-0" strokeWidth={2} />
                        )}
                        <span className="font-semibold text-sm text-[#1a3a4a]">{dept.departmentName}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <span className="text-sm font-bold text-[#006496]">{dept.currentCount}</span>
                    </TableCell>
                    <TableCell className="text-center">
                      {dept.requiredCount === 0 ? (
                        <span className="text-sm text-[#006496]/30 italic">—</span>
                      ) : (
                        <span className="text-sm font-bold text-[#1a3a4a]">{dept.requiredCount}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {dept.requiredCount === 0 ? (
                        <span className="text-sm text-[#006496]/30">—</span>
                      ) : dept.vacancy > 0 ? (
                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-red-100 text-red-600 font-bold text-sm">
                          {dept.vacancy}
                        </span>
                      ) : (
                        <CheckCircle2 className="w-4 h-4 text-emerald-500 mx-auto" strokeWidth={2} />
                      )}
                    </TableCell>
                    <TableCell>
                      {dept.requiredCount === 0 ? (
                        <Badge variant="outline" className="text-[10px] text-[#006496]/40 border-[#006496]/15">
                          Not configured
                        </Badge>
                      ) : dept.vacancy > 0 ? (
                        <Badge className="text-[10px] bg-red-50 text-red-600 border border-red-200">
                          Needs Hiring
                        </Badge>
                      ) : (
                        <Badge className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200">
                          Fully Staffed
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-[#006496]/50 max-w-[180px] truncate">
                      {dept.notes ?? <span className="italic text-[#006496]/25">—</span>}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => openEdit(dept)}
                      >
                        <Pencil className="w-3 h-3 mr-1" />
                        {dept.id ? "Edit" : "Set"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editTarget} onOpenChange={(o) => { if (!o) setEditTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Set Required Headcount — {editTarget?.departmentName}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div>
              <p className="text-xs font-semibold text-[#006496]/60 mb-1.5">
                Current active staff: <strong className="text-[#006496]">{editTarget?.currentCount ?? 0}</strong>
              </p>
              <label className="text-xs font-semibold text-[#006496]/60 block mb-1">Required headcount</label>
              <Input
                type="number"
                min={0}
                value={editCount}
                onChange={(e) => setEditCount(e.target.value)}
                className="text-sm"
                placeholder="e.g. 10"
              />
              {parseInt(editCount, 10) > 0 && parseInt(editCount, 10) > (editTarget?.currentCount ?? 0) && (
                <p className="text-[11px] text-orange-600 mt-1">
                  This will create {parseInt(editCount, 10) - (editTarget?.currentCount ?? 0)} vacancy{parseInt(editCount, 10) - (editTarget?.currentCount ?? 0) > 1 ? "ies" : ""}.
                </p>
              )}
            </div>
            <div>
              <label className="text-xs font-semibold text-[#006496]/60 block mb-1">Notes (optional)</label>
              <Textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="e.g. Planning to expand team by Q3..."
                rows={2}
                className="text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button
              onClick={handleSave}
              disabled={setHeadcount.isPending || updateHeadcount.isPending}
              style={{ background: "#006496" }}
            >
              {(setHeadcount.isPending || updateHeadcount.isPending) ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}
